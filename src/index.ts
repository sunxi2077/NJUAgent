#!/usr/bin/env node

import { randomUUID } from "node:crypto";

import { ContextPolicy } from "./agent/context-policy.js";
import { ConversationHistory } from "./agent/history.js";
import { AgentRunner } from "./agent/runner.js";
import { buildSystemPrompt } from "./agent/system-prompt.js";
import { HELP_TEXT, isHelpRequest } from "./cli/help.js";
import { formatPermissionQuestion, ReadlinePrompt } from "./cli/prompt.js";
import { TerminalRenderer } from "./cli/renderer.js";
import { CliSession } from "./cli/session.js";
import { ConfigError, loadConfig, type AppConfig } from "./config.js";
import { AnthropicProvider } from "./providers/anthropic-provider.js";
import {
  BalancedPermissionPolicy,
  CautiousPermissionPolicy,
} from "./security/permission-policy.js";
import { Workspace } from "./security/workspace.js";
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

function tryLoadConfig(argv: readonly string[]): AppConfig | undefined {
  try {
    return loadConfig(process.env, argv);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`nju-agent: ${error.message}`);
      if (error.message.startsWith("Missing required environment variable")) {
        console.error("Set the required environment variables and try again.");
      } else {
        console.error('Run "nju-agent --help" for usage.');
      }
      process.exitCode = 1;
      return undefined;
    }
    throw error;
  }
}

async function openWorkspace(root: string): Promise<Workspace | undefined> {
  try {
    return await Workspace.open(root);
  } catch (error) {
    console.error(
      `nju-agent: cannot open workspace "${root}": ` +
        (error instanceof Error ? error.message : String(error)),
    );
    process.exitCode = 1;
    return undefined;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (isHelpRequest(argv)) {
    process.stdout.write(HELP_TEXT);
    return;
  }
  const config = tryLoadConfig(argv);
  if (config === undefined) {
    return;
  }

  const workspace = await openWorkspace(config.workspaceRoot);
  if (workspace === undefined) {
    return;
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
      sourceEnvironment: process.env,
    }),
  );

  const renderer = new TerminalRenderer({
    stdout: process.stdout,
    isTTY: process.stdout.isTTY === true,
    maxLiveOutputBytes: config.uiOutputMaxBytes,
  });
  const prompt = new ReadlinePrompt({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true && process.stdout.isTTY === true,
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

  const sessionId = randomUUID();
  console.log(`[session] ${sessionId}`);

  if (config.debug) {
    console.error(
      `[debug] session=${sessionId} model=${config.model} base_url=${config.baseURL} ` +
        `workspace=${workspace.root} max_steps=${config.maxSteps} ` +
        `command_timeout_ms=${config.commandTimeoutMs} ` +
        `tool_output_max_bytes=${config.toolOutputMaxBytes}`,
    );
  }

  const session = new CliSession({
    prompt,
    renderer,
    runTurn: (text, signal) => runner.run(text, signal),
  });
  await session.start();
}

void main().catch((error) => {
  console.error(
    `nju-agent: internal failure: ${
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    }`,
  );
  process.exitCode = 1;
});
