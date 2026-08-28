import { describe, expect, test } from "vitest";

import { ConversationHistory } from "../../../src/agent/history.js";
import type { RunResult } from "../../../src/agent/result.js";
import { AppError } from "../../../src/errors/app-error.js";
import { SkillRegistry } from "../../../src/skills/skill-registry.js";
import type { Skill } from "../../../src/skills/skill.js";
import { SessionManager, type ActiveRuntime } from "../../../src/sessions/session-manager.js";
import {
  createEmptySession,
  type PersistedSessionV1,
} from "../../../src/sessions/session-schema.js";

const ID = "3f2c9d5a-6b1e-4f80-9a2c-7d8e1f0a3b4c";

function baseSession(overrides: Partial<PersistedSessionV1> = {}): PersistedSessionV1 {
  return {
    ...createEmptySession({
      id: ID,
      now: "2026-08-28T08:00:00.000Z",
      workspaceRoot: "/tmp/workspace",
      modelId: "deepseek-v4-flash",
      permissionMode: "balanced",
    }),
    ...overrides,
  };
}

class FakeStore {
  readonly files = new Map<string, PersistedSessionV1>();
  saveCalls = 0;
  failNextSave = false;
  failEverySave = false;

  async save(session: PersistedSessionV1): Promise<void> {
    this.saveCalls += 1;
    if (this.failNextSave || this.failEverySave) {
      this.failNextSave = false;
      throw new AppError({ code: "SESSION_IO", userMessage: "disk full" });
    }
    this.files.set(session.id, structuredClone(session));
  }

  async load(id: string): Promise<PersistedSessionV1> {
    const found = this.files.get(id);
    if (found === undefined) {
      throw new AppError({ code: "SESSION_CORRUPT", userMessage: `No session matches ${id}` });
    }
    return structuredClone(found);
  }

  async list(): Promise<{
    sessions: {
      id: string;
      title: string;
      workspaceRoot: string;
      modelId: string;
      updatedAt: string;
    }[];
    diagnostics: Array<{ file: string; message: string }>;
  }> {
    return {
      sessions: [...this.files.values()].map((s) => ({
        id: s.id,
        title: s.title,
        workspaceRoot: s.workspaceRoot,
        modelId: s.modelId,
        updatedAt: s.updatedAt,
      })),
      diagnostics: [],
    };
  }

  async resolveId(prefix: string): Promise<string> {
    const matches = [...this.files.keys()].filter((id) => id.startsWith(prefix));
    if (matches.length === 1) {
      return matches[0]!;
    }
    throw new AppError({ code: "SESSION_CORRUPT", userMessage: "ambiguous or missing" });
  }
}

class FakeRuntime implements ActiveRuntime {
  session: PersistedSessionV1;
  readonly history: ConversationHistory;
  disposed = false;
  runCalls = 0;
  activeSkill: Skill | undefined;
  nextResult: RunResult = { status: "completed", steps: 1, toolCalls: 0, durationMs: 1 };

  constructor(session: PersistedSessionV1) {
    this.session = structuredClone(session);
    this.history = ConversationHistory.from(session.messages);
  }

  async run(text: string): Promise<RunResult> {
    this.runCalls += 1;
    this.history.appendUserText(text);
    return this.nextResult;
  }

  contextState() {
    return { compactionCount: 0 };
  }

  contextStatus() {
    return {
      estimatedTokens: 0,
      thresholdTokens: 0,
      hardInputTokens: 0,
      contextWindowTokens: 0,
      coveredMessageCount: 0,
      totalMessageCount: 0,
      compactionCount: 0,
    };
  }

  async compact() {
    return {
      action: "compacted" as const,
      systemPrompt: "",
      messages: [],
      estimatedTokens: 0,
      compactedToolResults: 0,
    };
  }

  setActiveSkill(skill: Skill | undefined): void {
    this.activeSkill = skill;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

function setup(overrides: { store?: FakeStore; factory?: (s: PersistedSessionV1) => Promise<ActiveRuntime> } = {}) {
  const store = overrides.store ?? new FakeStore();
  const initial = baseSession();
  const initialRuntime = new FakeRuntime(initial);
  const factoryCalls: PersistedSessionV1[] = [];
  const factory = overrides.factory ??
    (async (session: PersistedSessionV1) => {
      factoryCalls.push(session);
      return new FakeRuntime(session);
    });
  const registry = {
    resolve: () => undefined,
    refresh: async () => ({ skills: [], diagnostics: [] }),
    list: () => [],
    diagnostics: () => [],
  } as unknown as SkillRegistry;
  const manager = new SessionManager({
    initialRuntime,
    store,
    runtimeFactory: factory,
    registry,
    clock: () => new Date("2026-08-28T10:00:00.000Z"),
    idFactory: () => "99999999-9999-4999-8999-999999999999",
  });
  return { manager, store, initial, initialRuntime, factoryCalls };
}

describe("SessionManager", () => {
  test("repairs a missing persisted Skill on the next explicit flush", async () => {
    const store = new FakeStore();
    const runtime = new FakeRuntime(baseSession({ activeSkill: "missing" }));
    const registry = { resolve: () => undefined } as unknown as SkillRegistry;
    const manager = new SessionManager({
      initialRuntime: runtime,
      store,
      runtimeFactory: async (session) => new FakeRuntime(session),
      registry,
    });

    expect(manager.isDirty()).toBe(true);
    expect(store.saveCalls).toBe(0);
    await manager.flush();
    expect(manager.active().activeSkill).toBeNull();
    expect(store.saveCalls).toBe(1);
  });

  test("first user text changes New session to a deterministic title", async () => {
    const { manager, store } = setup();
    await manager.runTurn("fix   the   parser", new AbortController().signal);
    expect(store.files.get(ID)?.title).toBe("fix the parser");
  });

  test.each([
    ["completed", "completed"],
    ["model_failed", "model_failed"],
    ["cancelled", "cancelled"],
    ["limit_reached", "limit_reached"],
    ["context_limit", "context_limit"],
  ] as const)("a %s result updates stats and saves", async (_label, status) => {
    const { manager, store, initialRuntime } = setup();
    initialRuntime.nextResult = { status, steps: 2, toolCalls: 3, durationMs: 10 } as RunResult;
    await manager.runTurn("task", new AbortController().signal);

    const saved = store.files.get(ID)!;
    expect(saved.stats).toMatchObject({ turns: 1, toolCalls: 3, lastRunStatus: status });
    expect(saved.messages).toHaveLength(1);
  });

  test("a save failure leaves the runtime active and dirty", async () => {
    const { manager, store, initialRuntime } = setup();
    store.failNextSave = true;
    await expect(
      manager.runTurn("task", new AbortController().signal),
    ).rejects.toMatchObject({ code: "SESSION_IO" });

    expect(manager.isDirty()).toBe(true);
    expect(manager.active().id).toBe(ID);
    expect(initialRuntime.disposed).toBe(false);
  });

  test("flush clears dirty only after a successful save", async () => {
    const { manager, store } = setup();
    store.failEverySave = true;
    await expect(
      manager.runTurn("task", new AbortController().signal),
    ).rejects.toMatchObject({ code: "SESSION_IO" });
    expect(manager.isDirty()).toBe(true);

    store.failEverySave = false;
    await manager.flush();
    expect(manager.isDirty()).toBe(false);
  });

  test("createNew refuses to switch when flush fails", async () => {
    const { manager, store, initialRuntime, factoryCalls } = setup();
    store.failEverySave = true;
    await expect(
      manager.runTurn("task", new AbortController().signal),
    ).rejects.toMatchObject({ code: "SESSION_IO" });

    await expect(manager.createNew()).rejects.toMatchObject({ code: "SESSION_IO" });
    expect(manager.active().id).toBe(ID);
    expect(initialRuntime.disposed).toBe(false);
    expect(factoryCalls).toHaveLength(0);
  });

  test("createNew builds and saves the target before replacing", async () => {
    const { manager, store, initialRuntime, factoryCalls } = setup();
    await manager.runTurn("task", new AbortController().signal);
    const next = await manager.createNew();

    expect(next.id).toBe("99999999-9999-4999-8999-999999999999");
    expect(next.title).toBe("New session");
    expect(next.activeSkill).toBeNull();
    expect(initialRuntime.disposed).toBe(true);
    expect(manager.active().id).toBe("99999999-9999-4999-8999-999999999999");
    expect(store.files.has("99999999-9999-4999-8999-999999999999")).toBe(true);
    expect(factoryCalls).toHaveLength(1);
  });

  test("resume loads and builds the target before replacing the original", async () => {
    const { manager, store } = setup();
    const target = baseSession({
      id: "aaaaaaaa-1111-4111-8111-111111111111",
      title: "resumed session",
    });
    store.files.set(target.id, target);

    const resumed = await manager.resume("aaaaaaaa");

    expect(resumed.id).toBe(target.id);
    expect(manager.active().id).toBe(target.id);
    expect(manager.active().title).toBe("resumed session");
  });

  test("resume restores the target session Skill on the replacement runtime", async () => {
    const skill: Skill = {
      name: "fmt",
      description: "format code",
      instructions: "Use the project formatter.",
      source: "project",
      filePath: "/tmp/workspace/.nju-agent/skills/fmt/SKILL.md",
    };
    const store = new FakeStore();
    const initialRuntime = new FakeRuntime(baseSession());
    let replacement: FakeRuntime | undefined;
    const registry = {
      resolve: (name: string) => name === "fmt" ? skill : undefined,
    } as unknown as SkillRegistry;
    const manager = new SessionManager({
      initialRuntime,
      store,
      runtimeFactory: async (session) => {
        replacement = new FakeRuntime(session);
        return replacement;
      },
      registry,
    });
    const target = baseSession({
      id: "aaaaaaaa-1111-4111-8111-111111111111",
      activeSkill: "fmt",
    });
    store.files.set(target.id, target);

    await manager.resume("aaaaaaaa");

    expect(replacement?.activeSkill).toEqual(skill);
  });

  test("reconfigure rebuilds the active runtime while preserving history", async () => {
    const { manager, initialRuntime, factoryCalls } = setup();
    await manager.runTurn("keep this task", new AbortController().signal);

    const updated = await manager.reconfigure({
      modelId: "deepseek-next",
      permissionMode: "cautious",
    });

    expect(initialRuntime.disposed).toBe(true);
    expect(updated.modelId).toBe("deepseek-next");
    expect(updated.permissionMode).toBe("cautious");
    expect(updated.messages).toHaveLength(1);
    expect(factoryCalls.at(-1)?.messages).toHaveLength(1);
  });

  test("failed target runtime creation leaves the original active", async () => {
    const { manager, store, initialRuntime } = setup({
      factory: async () => {
        throw new AppError({ code: "CONFIG_INVALID", userMessage: "workspace missing" });
      },
    });
    const target = baseSession({ id: "bbbbbbbb-2222-4222-8222-222222222222" });
    store.files.set(target.id, target);

    await expect(manager.resume("bbbbbbbb")).rejects.toThrow("workspace missing");
    expect(manager.active().id).toBe(ID);
    expect(initialRuntime.disposed).toBe(false);
  });
});
