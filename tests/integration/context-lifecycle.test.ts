import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AppConfig } from "../../src/config.js";
import type { Prompt } from "../../src/cli/prompt.js";
import type { Renderer } from "../../src/cli/renderer.js";
import type { ModelProvider, ModelRequest, ProviderEvent } from "../../src/providers/provider.js";
import { createRuntime } from "../../src/runtime/create-runtime.js";
import { SkillRegistry } from "../../src/skills/skill-registry.js";
import { SessionManager } from "../../src/sessions/session-manager.js";
import { SessionStore } from "../../src/sessions/session-store.js";
import {
  createEmptySession,
  type PersistedSessionV1,
} from "../../src/sessions/session-schema.js";
import { resolveAppPaths } from "../../src/storage/paths.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function tempDirectory(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}

/**
 * Distinguishes compaction requests (no tools) from ordinary turns and
 * returns scripted summaries/text so we can assert what reaches the provider.
 */
class DeterministicProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];
  turnCounter = 0;
  compactionCounter = 0;

  async *stream(request: ModelRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(structuredClone(request));
    const isCompaction = request.tools.length === 0 &&
      request.system.includes("summarize a coding-agent conversation");
    if (isCompaction) {
      this.compactionCounter += 1;
      const text = `summary-${this.compactionCounter}`;
      yield {
        type: "message_completed",
        message: { role: "assistant", content: [{ type: "text", text }] },
        stopReason: "end_turn",
      };
      return;
    }
    this.turnCounter += 1;
    yield {
      type: "message_completed",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `ack-${this.turnCounter}` }],
      },
      stopReason: "end_turn",
    };
  }
}

class FakePrompt implements Prompt {
  confirm(): Promise<boolean> {
    return Promise.resolve(true);
  }
  read(): Promise<string | null> {
    return Promise.resolve(null);
  }
  onSigint(): void {}
  interrupt(): void {}
  suspendForOutput(): void {}
  resumeAfterOutput(): void {}
  close(): void {}
}

class MemoryRenderer implements Renderer {
  readonly handled: string[] = [];
  handle(): void {}
  toolOutput(): void {}
  print(text: string): void {
    this.handled.push(text);
  }
  error(): void {}
}

function makeConfig(workspaceRoot: string): AppConfig {
  return {
    apiKey: "test-key",
    baseURL: "https://api.example.com/anthropic",
    model: "deepseek-v4-flash",
    maxTokens: 512,
    maxSteps: 8,
    commandTimeoutMs: 5000,
    toolOutputMaxBytes: 8192,
    uiOutputMaxBytes: 65536,
    contextWindowTokens: 48_000,
    contextCompactRatio: 0.7,
    contextRecentMessages: 12,
    contextSafetyTokens: 2_048,
    workspaceRoot,
    permissionMode: "balanced",
    debug: false,
  };
}

async function makeSession(home: string, workspace: string): Promise<PersistedSessionV1> {
  return createEmptySession({
    id: crypto.randomUUID(),
    now: new Date().toISOString(),
    workspaceRoot: workspace,
    modelId: "deepseek-v4-flash",
    permissionMode: "balanced",
  });
}

async function buildManager(home: string, workspace: string, provider: DeterministicProvider) {
  const paths = resolveAppPaths({ NJU_AGENT_HOME: home }, home);
  const store = new SessionStore(paths.sessionsDirectory);
  const session = await makeSession(home, workspace);
  await store.save(session);
  const config = makeConfig(workspace);
  const prompt = new FakePrompt();
  const renderer = new MemoryRenderer();
  const deps = { env: {}, config, prompt, renderer, provider };
  const runtime = await createRuntime(session, deps);
  const registry = {
    resolve: () => undefined,
    refresh: async () => ({ skills: [], diagnostics: [] }),
    list: () => [],
    diagnostics: () => [],
  } as unknown as SkillRegistry;
  const manager = new SessionManager({
    initialRuntime: runtime,
    store,
    runtimeFactory: (target) => createRuntime(target, deps),
    registry,
  });
  return { manager, store, session, provider, renderer };
}

describe("context lifecycle", () => {
  test("manual compact creates a checkpoint that survives resume", async () => {
    const home = await tempDirectory("nju-ctx-");
    const workspace = await tempDirectory("nju-ctx-work-");
    const provider = new DeterministicProvider();
    const { manager, store, session } = await buildManager(home, workspace, provider);

    for (let index = 0; index < 20; index += 1) {
      await manager.runTurn(`task ${index}`, new AbortController().signal);
    }
    await manager.compact("wrap up", new AbortController().signal);
    const covered = manager.contextStatus().coveredMessageCount;
    expect(covered).toBeGreaterThan(0);
    expect(provider.compactionCounter).toBe(1);

    // Resume: a fresh manager on the same store rebuilds the checkpoint.
    const paths = resolveAppPaths({ NJU_AGENT_HOME: home }, home);
    const store2 = new SessionStore(paths.sessionsDirectory);
    const loaded = await store2.load(session.id);
    const config = makeConfig(workspace);
    const prompt = new FakePrompt();
    const renderer = new MemoryRenderer();
    const deps = { env: {}, config, prompt, renderer, provider };
    const runtime = await createRuntime(loaded, deps);
    const registry = {
      resolve: () => undefined,
      refresh: async () => ({ skills: [], diagnostics: [] }),
      list: () => [],
      diagnostics: () => [],
    } as unknown as SkillRegistry;
    const manager2 = new SessionManager({
      initialRuntime: runtime,
      store: store2,
      runtimeFactory: (target) => createRuntime(target, deps),
      registry,
    });
    expect(manager2.contextStatus().coveredMessageCount).toBe(covered);
    expect(manager2.contextStatus().compactionCount).toBe(1);
  });

  test("a request after compact carries the summary and only the post-checkpoint tail", async () => {
    const home = await tempDirectory("nju-ctx-");
    const workspace = await tempDirectory("nju-ctx-work-");
    const provider = new DeterministicProvider();
    const { manager } = await buildManager(home, workspace, provider);
    for (let index = 0; index < 10; index += 1) {
      await manager.runTurn(`task ${index}`, new AbortController().signal);
    }
    await manager.compact(undefined, new AbortController().signal);
    const before = provider.requests.length;

    await manager.runTurn("continue from here", new AbortController().signal);

    const request = provider.requests.at(-1)!;
    expect(request.system).toContain("<conversation_summary>");
    expect(request.system).toContain("summary-1");
    const covered = manager.contextStatus().coveredMessageCount;
    // 20 pre-compact messages (10 turns) + the new user message = 21 history
    // messages at request time; only the post-checkpoint tail is sent.
    expect(request.messages.length).toBe(21 - covered);
  });

  test("a second compact sends the previous summary plus only newly covered messages", async () => {
    const home = await tempDirectory("nju-ctx-");
    const workspace = await tempDirectory("nju-ctx-work-");
    const provider = new DeterministicProvider();
    const { manager } = await buildManager(home, workspace, provider);
    for (let index = 0; index < 20; index += 1) {
      await manager.runTurn(`task ${index}`, new AbortController().signal);
    }
    await manager.compact("first focus", new AbortController().signal);
    const firstCovered = manager.contextStatus().coveredMessageCount;
    // More turns beyond the checkpoint, then compact again.
    for (let index = 20; index < 30; index += 1) {
      await manager.runTurn(`task ${index}`, new AbortController().signal);
    }
    await manager.compact("second focus", new AbortController().signal);

    expect(provider.compactionCounter).toBe(2);
    const secondCovered = manager.contextStatus().coveredMessageCount;
    expect(secondCovered).toBeGreaterThan(firstCovered);
  });
});
