/**
 * Opt-in real API smoke test. Run with `npm run test:smoke`.
 *
 * Skips with exit code 0 when the model environment variables are absent, so
 * the default test suite never touches the network. When credentials are
 * present it performs one short text turn and one harmless `read_file` tool
 * turn against a temporary workspace, then inspects the conversation history
 * and prints only model ID, statuses, tool-call count, latency and PASS/FAIL.
 * It never prints request headers, response text, file content or
 * environment values, and always removes the temporary workspace.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { ConversationHistory } from "../../src/agent/history.js";
import { AgentRunner } from "../../src/agent/runner.js";
import { AnthropicProvider } from "../../src/providers/anthropic-provider.js";
import { AllowAllPermissionPolicy } from "../../src/security/permission-policy.js";
import { Workspace } from "../../src/security/workspace.js";
import { ToolExecutor } from "../../src/tools/executor.js";
import { createReadFileTool } from "../../src/tools/file-tools.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { inspectSmokeHistory } from "./smoke-assertions.js";

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value;
}

async function withSmokeWorkspace<T>(
  run: (tempDir: string) => Promise<T>,
): Promise<T> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "njuagent-smoke-"));
  await writeFile(path.join(tempDir, "hello.txt"), "hello from smoke test\n", "utf8");
  try {
    return await run(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runSmokeInWorkspace(tempDir: string): Promise<void> {
  const workspace = await Workspace.open(tempDir);
  const registry = new ToolRegistry();
  registry.register(createReadFileTool({ workspace, maxOutputBytes: 4096 }));
  const executor = new ToolExecutor({
    registry,
    permissionPolicy: new AllowAllPermissionPolicy(),
    confirm: async () => true,
  });
  const provider = new AnthropicProvider({
    model: env("MODEL_ID") as string,
    maxTokens: 512,
    apiKey: env("ANTHROPIC_API_KEY") as string,
    baseURL: env("ANTHROPIC_BASE_URL") as string,
  });
  const history = new ConversationHistory();
  const runner = new AgentRunner({
    provider,
    history,
    tools: executor,
    maxSteps: 4,
    systemPrompt:
      "You are a smoke test. Reply briefly, and when asked, use read_file to read hello.txt.",
  });

  const startedAt = performance.now();
  const textResult = await runner.run(
    "Reply with exactly: OK",
    new AbortController().signal,
  );
  const toolResult = await runner.run(
    "Use the read_file tool to read hello.txt, then report its content.",
    new AbortController().signal,
  );
  const durationMs = Math.round(performance.now() - startedAt);

  const evidence = inspectSmokeHistory(history.snapshot());
  const ok = textResult.status === "completed" &&
    toolResult.status === "completed" &&
    toolResult.toolCalls >= 1 &&
    evidence.hasAssistantText &&
    evidence.hasSuccessfulRead;
  console.log(
    `SMOKE model=${env("MODEL_ID")} text_turn=${textResult.status} ` +
      `tool_turn=${toolResult.status} tool_calls=${toolResult.toolCalls} ` +
      `duration_ms=${durationMs} ${ok ? "PASS" : "FAIL"}`,
  );
  process.exitCode = ok ? 0 : 1;
}

async function main(): Promise<void> {
  const apiKey = env("ANTHROPIC_API_KEY");
  const baseURL = env("ANTHROPIC_BASE_URL");
  const model = env("MODEL_ID");
  if (apiKey === undefined || baseURL === undefined || model === undefined) {
    console.log(
      "SMOKE SKIPPED: set ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL and MODEL_ID " +
        "to run the real API smoke test.",
    );
    return;
  }
  await withSmokeWorkspace(runSmokeInWorkspace);
}

main().catch((error) => {
  console.error(
    `SMOKE FAIL: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
