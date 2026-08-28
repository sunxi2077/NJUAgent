#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import os from "node:os";
import { pathToFileURL } from "node:url";

import { ContextPolicy } from "./agent/context-policy.js";
import { ConversationHistory } from "./agent/history.js";
import { AgentRunner } from "./agent/runner.js";
import { buildSystemPrompt } from "./agent/system-prompt.js";
import { HELP_TEXT, isHelpRequest } from "./cli/help.js";
import {
  formatPermissionQuestion,
  ReadlinePrompt,
  type Prompt,
  type ReadlinePromptOptions,
} from "./cli/prompt.js";
import { TerminalRenderer, type Renderer, type TerminalRendererOptions } from "./cli/renderer.js";
import { runSetup } from "./cli/setup.js";
import { CliSession } from "./cli/session.js";
import { createTheme } from "./cli/theme.js";
import { formatWelcome } from "./cli/welcome.js";
import { ConfigError, resolveConfig, type AppConfig } from "./config.js";
import { AppError, isAppError } from "./errors/app-error.js";
import { formatError } from "./errors/error-presenter.js";
import { AnthropicProvider } from "./providers/anthropic-provider.js";
import {
  BalancedPermissionPolicy,
  CautiousPermissionPolicy,
} from "./security/permission-policy.js";
import { Workspace } from "./security/workspace.js";
import { ConfigStore, type PersistedConfigV1 } from "./storage/config-store.js";
import { resolveAppPaths } from "./storage/paths.js";
import { createRunCommandTool } from "./tools/command-tool.js";
import { ToolExecutor } from "./tools/executor.js";
import {
  createEditFileTool,
  createReadFileTool,
  createWriteFileTool,
} from "./tools/file-tools.js";
import { ToolRegistry } from "./tools/registry.js";
import {
  createListFilesTool,
  createSearchTextTool,
} from "./tools/search-tools.js";

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

function envNoColor(env: NodeJS.ProcessEnv): boolean {
  const value = env.NO_COLOR;
  return value !== undefined && value !== "";
}

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

async function openWorkspace(
  root: string,
  stderr: NodeJS.WritableStream,
): Promise<Workspace | undefined> {
  try {
    return await Workspace.open(root);
  } catch (error) {
    stderr.write(
      `nju-agent: cannot open workspace "${root}": ` +
        (error instanceof Error ? error.message : String(error)) +
        "\n",
    );
    return undefined;
  }
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
  const prompt = promptFactory({
    input: stdin,
    output: stdout,
    terminal: isTTY,
  });
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

  // 5. Workspace, tools, executor, provider, runner.
  const workspace = await openWorkspace(config.workspaceRoot, stderr);
  if (workspace === undefined) {
    return 1;
  }

  const registry = new ToolRegistry();
  registry.register(
    createReadFileTool({
      workspace,
      maxOutputBytes: config.toolOutputMaxBytes,
    }),
  );
  registry.register(createWriteFileTool({ workspace }));
  registry.register(createEditFileTool({ workspace }));
  registry.register(
    createListFilesTool({
      workspace,
      maxOutputBytes: config.toolOutputMaxBytes,
      maxResults: 200,
    }),
  );
  registry.register(
    createSearchTextTool({
      workspace,
      maxOutputBytes: config.toolOutputMaxBytes,
      maxResults: 200,
      maxFileBytes: 1_000_000,
    }),
  );
  registry.register(
    createRunCommandTool({
      workspace,
      defaultTimeoutMs: config.commandTimeoutMs,
      maxOutputBytes: config.toolOutputMaxBytes,
      sourceEnvironment: env,
    }),
  );

  const renderer = rendererFactory({
    stdout,
    isTTY,
    maxLiveOutputBytes: config.uiOutputMaxBytes,
    inputSurface: prompt,
  });
  const permissionPolicy = config.permissionMode === "cautious"
    ? new CautiousPermissionPolicy()
    : new BalancedPermissionPolicy();
  const executor = new ToolExecutor({
    registry,
    permissionPolicy,
    confirm: (call, reason) =>
      prompt.confirm(formatPermissionQuestion(call, reason)),
    onOutput: (call, stream, text) => renderer.toolOutput(call, stream, text),
  });

  const provider = new AnthropicProvider({
    model: config.model,
    maxTokens: config.maxTokens,
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });
  const history = new ConversationHistory();
  const runner = new AgentRunner({
    provider,
    history,
    tools: executor,
    maxSteps: config.maxSteps,
    systemPrompt: buildSystemPrompt(),
    contextPolicy: new ContextPolicy({
      maxEstimatedTokens: 48_000,
      compactAtRatio: 0.7,
      recentMessages: 10,
      charsPerToken: 4,
    }),
    retryPolicy: {
      maxAttempts: 3,
      baseDelayMs: 1_000,
      maxDelayMs: 30_000,
      jitterRatio: 0.25,
    },
    onEvent: (event) => renderer.handle(event),
  });

  // 6. One-time welcome panel.
  const sessionId = randomUUID();
  const theme = createTheme({ enabled: isTTY && !envNoColor(env) });
  stdout.write(
    `${formatWelcome(
      {
        version: APP_VERSION,
        workspace: workspace.root,
        model: config.model,
        sessionShortId: sessionId.slice(0, 8),
        permissionMode: config.permissionMode,
      },
      theme,
    )}\n`,
  );

  if (config.debug) {
    stderr.write(
      `[debug] session=${sessionId} model=${config.model} base_url=${config.baseURL} ` +
        `workspace=${workspace.root} max_steps=${config.maxSteps} ` +
        `command_timeout_ms=${config.commandTimeoutMs} ` +
        `tool_output_max_bytes=${config.toolOutputMaxBytes}\n`,
    );
  }

  // 7. Session loop.
  const session = new CliSession({
    prompt,
    renderer,
    runTurn: (text, signal) => runner.run(text, signal),
  });
  await session.start();
  return 0;
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
