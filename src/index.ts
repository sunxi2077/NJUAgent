#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { HELP_TEXT, isHelpRequest } from "./cli/help.js";
import {
  ReadlinePrompt,
  type Prompt,
  type ReadlinePromptOptions,
} from "./cli/prompt.js";
import { TerminalRenderer, type Renderer, type TerminalRendererOptions } from "./cli/renderer.js";
import { runSetup } from "./cli/setup.js";
import { CliSession } from "./cli/session.js";
import { SlashCommandRouter } from "./cli/command-router.js";
import { registerCoreCommands } from "./cli/commands/register-core-commands.js";
import type { CommandContext } from "./cli/command.js";
import { createTheme, shouldEnableTerminalTheme } from "./cli/theme.js";
import { formatWelcome } from "./cli/welcome.js";
import { ConfigError, resolveConfig, type AppConfig } from "./config.js";
import { AppError, isAppError } from "./errors/app-error.js";
import { formatError } from "./errors/error-presenter.js";
import { createRuntime } from "./runtime/create-runtime.js";
import { SkillRegistry } from "./skills/skill-registry.js";
import { SessionManager } from "./sessions/session-manager.js";
import { SessionStore } from "./sessions/session-store.js";
import {
  createEmptySession,
  type PersistedSessionV1,
} from "./sessions/session-schema.js";
import { ConfigStore } from "./storage/config-store.js";
import { resolveAppPaths } from "./storage/paths.js";
import type { PersistedConfigV1 } from "./storage/config-store.js";

const APP_VERSION = "0.2.0";

export type BootstrapDeps = {
  env: NodeJS.ProcessEnv;
  argv: readonly string[];
  cwd: string;
  homeDirectory: string;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  isTTY: boolean;
  promptFactory?: (options: ReadlinePromptOptions) => Prompt;
  rendererFactory?: (options: TerminalRendererOptions) => Renderer;
  configStoreFactory?: (file: string) => ConfigStore;
};

function toInternalError(error: unknown): AppError {
  if (isAppError(error)) {
    return error;
  }
  return new AppError({
    code: "INTERNAL",
    userMessage: error instanceof Error ? error.message : String(error),
    cause: error,
  });
}

export async function main(deps: BootstrapDeps): Promise<number> {
  const { env, argv, cwd, homeDirectory, stdin, stdout, stderr, isTTY } = deps;
  const promptFactory = deps.promptFactory ??
    ((options: ReadlinePromptOptions) => new ReadlinePrompt(options));
  const rendererFactory = deps.rendererFactory ??
    ((options: TerminalRendererOptions) => new TerminalRenderer(options));

  // 1. Help runs before any configuration or credential access.
  if (isHelpRequest(argv)) {
    stdout.write(HELP_TEXT);
    return 0;
  }

  // 2. Resolve paths and load persisted non-secret configuration.
  const paths = resolveAppPaths(env, homeDirectory);
  const store = deps.configStoreFactory?.(paths.configFile) ??
    new ConfigStore(paths.configFile);
  let persisted: PersistedConfigV1 | undefined;
  try {
    persisted = await store.load();
  } catch (error) {
    stderr.write(`nju-agent: ${formatError(error, { debug: false })}\n`);
    return 1;
  }

  // 3. First-run setup for missing non-secret configuration (TTY only).
  const missingNonSecret = persisted === undefined &&
    ((env.ANTHROPIC_BASE_URL?.trim() ?? "") === "" ||
      (env.MODEL_ID?.trim() ?? "") === "");
  // One enhanced-mode decision shared by the prompt, renderer, welcome, and
  // command context; prompt and renderer must never infer different modes.
  const interactive = shouldEnableTerminalTheme({ isTTY, env });
  const theme = createTheme({ enabled: interactive });
  const stdoutColumns = (stdout as NodeJS.WritableStream & { columns?: number }).columns;
  const prompt = promptFactory({
    input: stdin,
    output: stdout,
    terminal: isTTY,
    enhanced: interactive,
    theme,
    ...(stdoutColumns === undefined ? {} : { columns: stdoutColumns }),
  });
  try {
  if (isTTY && missingNonSecret) {
    const saved = await runSetup({
      prompt,
      store,
      defaults: {
        ...(env.ANTHROPIC_BASE_URL?.trim() === "" ||
        env.ANTHROPIC_BASE_URL === undefined
          ? {}
          : { baseURL: env.ANTHROPIC_BASE_URL.trim() }),
        ...(env.MODEL_ID?.trim() === "" || env.MODEL_ID === undefined
          ? {}
          : { model: env.MODEL_ID.trim() }),
      },
    });
    if (saved !== null) {
      persisted = saved;
    }
  }

  // 4. Resolve the full configuration; API Key is environment-only.
  let config: AppConfig;
  try {
    config = resolveConfig({ env, argv, persisted, cwd });
  } catch (error) {
    if (error instanceof ConfigError) {
      stderr.write(`nju-agent: ${formatError(error, { debug: false })}\n`);
      if (error.code === "CONFIG_MISSING_API_KEY") {
        stderr.write("Set ANTHROPIC_API_KEY in the environment and try again.\n");
      } else {
        stderr.write('Run "nju-agent --help" for usage.\n');
      }
      return 1;
    }
    throw error;
  }

  // 5. Session store, default session, and the active runtime.
  const sessionStore = new SessionStore(paths.sessionsDirectory);
  const { sessions: existingSessions } = await sessionStore.list();
  const sessionId = randomUUID();
  const initialSession = createEmptySession({
    id: sessionId,
    now: new Date().toISOString(),
    workspaceRoot: config.workspaceRoot,
    modelId: config.model,
    permissionMode: config.permissionMode,
  });
  await sessionStore.save(initialSession);

  const renderer = rendererFactory({
    stdout,
    isTTY,
    theme,
    maxLiveOutputBytes: config.uiOutputMaxBytes,
    inputSurface: prompt,
  });
  let activeConfig = config;
  const buildRuntime = (target: PersistedSessionV1) =>
    createRuntime(target, { env, config: activeConfig, prompt, renderer });
  let initialRuntime;
  try {
    initialRuntime = await buildRuntime(initialSession);
  } catch (error) {
    stderr.write(
      `nju-agent: cannot open workspace "${config.workspaceRoot}": ` +
        (error instanceof Error ? error.message : String(error)) +
        "\n",
    );
    return 1;
  }
  const skillRegistry = new SkillRegistry(
    paths.userSkillsDirectory,
    path.join(config.workspaceRoot, ".nju-agent", "skills"),
  );
  const sessionManager = new SessionManager({
    initialRuntime,
    store: sessionStore,
    runtimeFactory: buildRuntime,
    registry: skillRegistry,
  });

  // 6. One-time welcome panel with an optional recent-session hint.
  // Clear the visible screen once before the welcome box, but only in a real
  // TTY without NO_COLOR/dumb TERM; never emit the control sequence in non-TTY,
  // piped, or color-disabled output. `2J` clears the visible area without
  // wiping the terminal scrollback.
  if (interactive) {
    stdout.write("\x1b[2J\x1b[H");
  }
  const recent = existingSessions[0];
  stdout.write(
    `${formatWelcome(
      {
        version: APP_VERSION,
        workspace: config.workspaceRoot,
        model: config.model,
        sessionShortId: sessionId.slice(0, 8),
        permissionMode: config.permissionMode,
        recentSession: recent === undefined
          ? undefined
          : `${recent.id.slice(0, 8)} (${recent.title})`,
      },
      theme,
      ((stdout as NodeJS.WritableStream & { columns?: number }).columns === undefined
        ? {}
        : { columns: (stdout as NodeJS.WritableStream & { columns: number }).columns }),
    )}\n`,
  );

  if (config.debug) {
    stderr.write(
      `[debug] session=${sessionId} model=${config.model} base_url=${config.baseURL} ` +
        `workspace=${config.workspaceRoot} max_steps=${config.maxSteps} ` +
        `command_timeout_ms=${config.commandTimeoutMs} ` +
        `tool_output_max_bytes=${config.toolOutputMaxBytes}\n`,
    );
  }

  // 7. Commands and the session loop.
  const router = new SlashCommandRouter();
  registerCoreCommands(router);
  const commandContext: CommandContext = {
    renderer,
    theme,
    sessionManager,
    store: sessionStore,
    skillRegistry,
    webSearchAvailable: activeConfig.tavilyApiKey !== undefined,
    runSetup: async () => {
      const saved = await runSetup({
        prompt,
        store,
        defaults: {
          baseURL: activeConfig.baseURL,
          model: activeConfig.model,
          permissionMode: activeConfig.permissionMode,
        },
      });
      if (saved === null) {
        return false;
      }
      const nextConfig = resolveConfig({ env, argv, persisted: saved, cwd });
      activeConfig = nextConfig;
      await sessionManager.reconfigure({
        modelId: nextConfig.model,
        permissionMode: nextConfig.permissionMode,
      });
      return true;
    },
    signal: new AbortController().signal,
  };
  const session = new CliSession({
    prompt,
    renderer,
    runTurn: (text, signal) => sessionManager.runTurn(text, signal),
    router,
    commandContext,
    inputPrompt: `${theme.userLabel("❯ You")}  `,
    flushBeforeExit: () => sessionManager.flush(),
  });
  await session.start();
  return 0;
  } finally {
    prompt.close();
  }
}

const deps: BootstrapDeps = {
  env: process.env,
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  homeDirectory: os.homedir(),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
};

// Only start the process when this module is the entry point; importing it in
// tests must not run the executable.
const isDirectRun = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  void main(deps).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error) => {
      process.stderr.write(
        `nju-agent: ${formatError(toInternalError(error), { debug: false })}\n`,
      );
      process.exitCode = 1;
    },
  );
}
