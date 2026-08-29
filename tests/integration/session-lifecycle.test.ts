import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AppConfig } from "../../src/config.js";
import { createTheme } from "../../src/cli/theme.js";
import { SlashCommandRouter } from "../../src/cli/command-router.js";
import { registerCoreCommands } from "../../src/cli/commands/register-core-commands.js";
import { CliSession } from "../../src/cli/session.js";
import { createRuntime } from "../../src/runtime/create-runtime.js";
import { SkillRegistry } from "../../src/skills/skill-registry.js";
import { SessionManager } from "../../src/sessions/session-manager.js";
import { SessionStore } from "../../src/sessions/session-store.js";
import {
  createEmptySession,
  type PersistedSessionV1,
} from "../../src/sessions/session-schema.js";
import { resolveAppPaths } from "../../src/storage/paths.js";
import type { Renderer } from "../../src/cli/renderer.js";
import type { Prompt } from "../../src/cli/prompt.js";
import type { ModelProvider, ModelRequest, ProviderEvent } from "../../src/providers/provider.js";

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

class FakeProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(structuredClone(request));
    yield {
      type: "message_completed",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `ack-${this.requests.length}` }],
      },
      stopReason: "end_turn",
    };
  }
}

class FakePrompt implements Prompt {
  reads: Array<string | null> = [];
  closed = false;

  read(): Promise<string | null> {
    return Promise.resolve(this.reads.shift() ?? null);
  }
  confirm(): Promise<boolean> {
    return Promise.resolve(true);
  }
  onSigint(): void {}
  interrupt(): void {}
  suspendForOutput(): void {}
  resumeAfterOutput(): void {}
  close(): void {
    this.closed = true;
  }
}

class MemoryRenderer implements Renderer {
  permissionRequest(): void {}
  permissionDecision(): void {}
  readonly printed: string[] = [];
  readonly errors: string[] = [];
  handle(): void {}
  toolOutput(): void {}
  print(text: string): void {
    this.printed.push(text);
  }
  error(message: string): void {
    this.errors.push(message);
  }
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
    contextWindowTokens: 48000,
    contextCompactRatio: 0.7,
    contextRecentMessages: 12,
    contextSafetyTokens: 2048,
    workspaceRoot,
    permissionMode: "balanced",
    debug: false,
  webSearchTimeoutMs: 15000,
  webSearchMaxContentChars: 6000,
  };
}

async function makeManager(home: string, workspace: string, provider: FakeProvider) {
  const paths = resolveAppPaths({ NJU_AGENT_HOME: home }, home);
  const store = new SessionStore(paths.sessionsDirectory);
  const session = createEmptySession({
    id: crypto.randomUUID(),
    now: new Date().toISOString(),
    workspaceRoot: workspace,
    modelId: "deepseek-v4-flash",
    permissionMode: "balanced",
  });
  await store.save(session);
  const config = makeConfig(workspace);
  const renderer = new MemoryRenderer();
  const prompt = new FakePrompt();
  const deps = { env: {}, config, prompt, renderer, provider };
  const initialRuntime = await createRuntime(session, deps);
  const registry = {
    resolve: () => undefined,
    refresh: async () => ({ skills: [], diagnostics: [] }),
    list: () => [],
    diagnostics: () => [],
  } as unknown as SkillRegistry;
  const manager = new SessionManager({
    initialRuntime,
    store,
    runtimeFactory: (target) => createRuntime(target, deps),
    registry,
    clock: () => new Date("2026-08-28T12:00:00.000Z"),
  });
  return { manager, store, session, renderer, prompt, provider, paths };
}

describe("session lifecycle", () => {
  test("an ordinary turn creates a saved session with full history", async () => {
    const home = await tempDirectory("nju-lifecycle-");
    const workspace = await tempDirectory("nju-lifecycle-work-");
    const { manager, store, session } = await makeManager(home, workspace, new FakeProvider());

    await manager.runTurn("first task", new AbortController().signal);

    const saved = await store.load(session.id);
    expect(saved.messages).toHaveLength(2);
    expect(saved.stats.turns).toBe(1);
    expect(saved.title).toBe("first task");
  });

  test("a goal and plan survive checkpoint, resume, and clear; /new starts empty", async () => {
    const home = await tempDirectory("nju-lifecycle-");
    const workspace = await tempDirectory("nju-lifecycle-work-");
    const provider = new FakeProvider();
    const { manager, store, session } = await makeManager(home, workspace, provider);

    await manager.setGoal("npm test exits 0 after the requested validation");
    expect(manager.goal()?.condition).toContain("npm test");

    const created = await manager.createNew();
    expect(manager.goal()).toBeNull();
    expect(manager.plan().items).toEqual([]);

    await manager.resume(session.id.slice(0, 8));
    expect(manager.goal()?.condition).toContain("npm test");

    await manager.clearGoal();
    expect(manager.goal()).toBeNull();
    const saved = await store.load(session.id);
    expect(saved.goal).toBeNull();
    expect(created.plan.items).toEqual([]);
  });

  test("a second runtime can list and resume the saved session", async () => {
    const home = await tempDirectory("nju-lifecycle-");
    const workspace = await tempDirectory("nju-lifecycle-work-");
    const provider = new FakeProvider();
    const { manager, store, session } = await makeManager(home, workspace, provider);
    await manager.runTurn("first task", new AbortController().signal);

    const paths = resolveAppPaths({ NJU_AGENT_HOME: home }, home);
    const store2 = new SessionStore(paths.sessionsDirectory);
    const list = await store2.list();
    expect(list.sessions.map((entry) => entry.id)).toContain(session.id);

    const config = makeConfig(workspace);
    const renderer = new MemoryRenderer();
    const prompt = new FakePrompt();
    const deps = { env: {}, config, prompt, renderer, provider };
    const resumedSession = await store2.load(session.id);
    const runtime = await createRuntime(resumedSession, deps);
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
    await manager2.resume(session.id.slice(0, 8));
    await manager2.runTurn("second task", new AbortController().signal);

    const saved = await store2.load(session.id);
    expect(saved.messages).toHaveLength(4);
  });

  test("/new starts a second file without appending to the first", async () => {
    const home = await tempDirectory("nju-lifecycle-");
    const workspace = await tempDirectory("nju-lifecycle-work-");
    const { manager, store, session } = await makeManager(home, workspace, new FakeProvider());
    await manager.runTurn("first task", new AbortController().signal);

    const created = await manager.createNew();
    await manager.runTurn("second task", new AbortController().signal);

    const first = await store.load(session.id);
    expect(first.messages).toHaveLength(2);
    const second = await store.load(created.id);
    expect(second.messages).toHaveLength(2);
    expect((await store.list()).sessions).toHaveLength(2);
  });

  test("/resume switches back and the next turn appends only to the resumed session", async () => {
    const home = await tempDirectory("nju-lifecycle-");
    const workspace = await tempDirectory("nju-lifecycle-work-");
    const { manager, store, session } = await makeManager(home, workspace, new FakeProvider());
    await manager.runTurn("first task", new AbortController().signal);
    const created = await manager.createNew();
    await manager.runTurn("second task", new AbortController().signal);

    await manager.resume(session.id.slice(0, 8));
    await manager.runTurn("third task", new AbortController().signal);

    const first = await store.load(session.id);
    expect(first.messages).toHaveLength(4);
    const second = await store.load(created.id);
    expect(second.messages).toHaveLength(2);
  });

  test("unknown slash input never reaches the provider and // escapes to /help", async () => {
    const home = await tempDirectory("nju-lifecycle-");
    const workspace = await tempDirectory("nju-lifecycle-work-");
    const provider = new FakeProvider();
    const { manager, store, renderer, prompt, paths } = await makeManager(home, workspace, provider);

    const router = new SlashCommandRouter();
    registerCoreCommands(router);
    const session = new CliSession({
      prompt,
      renderer,
      runTurn: (text, signal) => manager.runTurn(text, signal),
      router,
      commandContext: {
        renderer,
        theme: createTheme({ enabled: false }),
        sessionManager: manager,
        store,
        signal: new AbortController().signal,
        webSearchAvailable: false,
        skillRegistry: {
      refresh: async () => ({ skills: [], diagnostics: [] }),
      list: () => [],
      resolve: () => undefined,
      diagnostics: () => [],
    },

      },
    });
    prompt.reads = ["/totally-unknown", "//help", null];
    await session.start();

    expect(provider.requests).toHaveLength(1);
    const first = provider.requests[0]!.messages[0];
    expect(first).toEqual({ role: "user", content: [{ type: "text", text: "/help" }] });
  });

  test("a corrupt third file produces a warning while the two valid sessions remain usable", async () => {
    const home = await tempDirectory("nju-lifecycle-");
    const workspace = await tempDirectory("nju-lifecycle-work-");
    const { manager, store, session } = await makeManager(home, workspace, new FakeProvider());
    await manager.runTurn("first task", new AbortController().signal);
    const created = await manager.createNew();
    await manager.runTurn("second task", new AbortController().signal);

    const { sessionsDirectory } = resolveAppPaths({ NJU_AGENT_HOME: home }, home);
    await writeFile(
      path.join(sessionsDirectory, "cccccccc-cccc-4ccc-8ccc-cccccccccccc.json"),
      "{broken",
      "utf8",
    );

    const { sessions, diagnostics } = await store.list();
    expect(sessions).toHaveLength(2);
    expect(diagnostics).toHaveLength(1);
    expect(await store.load(session.id)).toBeDefined();
    expect(await store.load(created.id)).toBeDefined();
  });
});
