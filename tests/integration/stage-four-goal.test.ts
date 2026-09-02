import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AppConfig } from "../../src/config.js";
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

function completeText(text: string): ProviderEvent {
  return {
    type: "message_completed",
    message: { role: "assistant", content: [{ type: "text", text }] },
    stopReason: "end_turn",
  };
}

let toolCallCounter = 0;
function toolUse(name: string, input: Record<string, unknown>): ProviderEvent {
  toolCallCounter += 1;
  return {
    type: "message_completed",
    message: {
      role: "assistant",
      content: [{ type: "tool_call", id: `c-${name}-${toolCallCounter}`, name, input }],
    },
    stopReason: "tool_use",
  };
}

/**
 * Scripted provider that distinguishes worker requests (tools present) from
 * evaluator requests (tools empty) and serves per-kind scripts.
 */
class GoalScriptedProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];
  workerIndex = 0;
  evaluatorIndex = 0;
  workerScripts: Array<() => ProviderEvent> = [];
  evaluatorScripts: Array<() => string> = [];
  failEvaluator = false;

  async *stream(request: ModelRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(structuredClone(request));
    if (request.tools.length === 0) {
      this.evaluatorIndex += 1;
      if (this.failEvaluator) {
        throw new Error("evaluator service down");
      }
      const script = this.evaluatorScripts[this.evaluatorIndex - 1];
      if (script === undefined) {
        throw new Error(`No evaluator script for index ${this.evaluatorIndex}`);
      }
      const reply = script();
      yield { type: "text_delta", text: reply };
      yield completeText(reply);
      return;
    }
    this.workerIndex += 1;
    const script = this.workerScripts[this.workerIndex - 1];
    if (script === undefined) {
      throw new Error(`No worker script for index ${this.workerIndex}`);
    }
    yield script();
  }
}

function jsonDecision(decision: {
  satisfied: boolean;
  reason: string;
  missingEvidence?: string[];
  nextInstruction?: string;
}): string {
  return JSON.stringify({
    satisfied: decision.satisfied,
    reason: decision.reason,
    missingEvidence: decision.missingEvidence ?? [],
    ...(decision.nextInstruction === undefined ? {} : { nextInstruction: decision.nextInstruction }),
  });
}

class FakePrompt implements Prompt {
  confirmResult = true;
  confirm(): Promise<boolean> {
    return Promise.resolve(this.confirmResult);
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
  permissionRequest(): void {}
  permissionDecision(): void {}
  handle(): void {}
  toolOutput(): void {}
  print(): void {}
  error(): void {}
}

function makeConfig(workspaceRoot: string, overrides: Partial<AppConfig> = {}): AppConfig {
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
    remoteFetchTimeoutMs: 15000,
    remoteFetchMaxBytes: 32768,
    ...overrides,
  };
}

async function makeManager(options: {
  workspace: string;
  provider: GoalScriptedProvider;
  maxSteps?: number;
}) {
  const paths = resolveAppPaths({ NJU_AGENT_HOME: options.workspace }, options.workspace);
  const store = new SessionStore(paths.sessionsDirectory);
  const session = createEmptySession({
    id: crypto.randomUUID(),
    now: new Date().toISOString(),
    workspaceRoot: options.workspace,
    modelId: "deepseek-v4-flash",
    permissionMode: "balanced",
  });
  await store.save(session);
  const config = makeConfig(options.workspace, { maxSteps: options.maxSteps ?? 8 });
  const renderer = new MemoryRenderer();
  const prompt = new FakePrompt();
  const deps = { env: {}, config, prompt, renderer, provider: options.provider };
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
    clock: () => new Date("2026-08-29T12:00:00.000Z"),
  });
  return { manager, store, session, initialRuntime, provider: options.provider };
}

const GOAL = "npm test and npm run typecheck exit 0 after the latest edit";

describe("stage four goal mode", () => {
  test("an ordinary task with no goal makes one worker request and no evaluator request", async () => {
    const workspace = await tempDirectory("nju-goal-plain-");
    const provider = new GoalScriptedProvider();
    provider.workerScripts = [() => completeText("answer")];
    const { manager } = await makeManager({ workspace, provider });

    const result = await manager.runTurn("hello", new AbortController().signal);

    expect(result.status).toBe("completed");
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.tools.length).toBeGreaterThan(0);
  });

  test("an active goal verified immediately returns goal_verified with zero-tool evaluator", async () => {
    const workspace = await tempDirectory("nju-goal-verify-");
    const provider = new GoalScriptedProvider();
    provider.workerScripts = [() => completeText("all done")];
    provider.evaluatorScripts = [
      () => jsonDecision({ satisfied: true, reason: "tests pass", missingEvidence: [] }),
    ];
    const { manager } = await makeManager({ workspace, provider });
    await manager.setGoal(GOAL);

    const result = await manager.runTurn("finish the work", new AbortController().signal);

    expect(result.status).toBe("goal_verified");
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]!.tools).toEqual([]);
    expect(manager.goal()?.status).toBe("verified");
    expect(manager.goal()?.lastDecision?.satisfied).toBe(true);
  });

  test("incomplete feedback makes the worker continue until verified", async () => {
    const workspace = await tempDirectory("nju-goal-continue-");
    const provider = new GoalScriptedProvider();
    provider.workerScripts = [
      () => completeText("I think it is done"),
      () => completeText("typecheck passes now"),
    ];
    provider.evaluatorScripts = [
      () => jsonDecision({ satisfied: false, reason: "no typecheck", missingEvidence: ["npm run typecheck has not run"] }),
      () => jsonDecision({ satisfied: true, reason: "typecheck passes", missingEvidence: [] }),
    ];
    const { manager } = await makeManager({ workspace, provider });
    await manager.setGoal(GOAL);

    const result = await manager.runTurn("fix and verify", new AbortController().signal);

    expect(result.status).toBe("goal_verified");
    // worker, evaluator, worker(feedback), evaluator
    expect(provider.requests).toHaveLength(4);
    const feedback = JSON.stringify(provider.requests[2]!.messages);
    expect(feedback).toContain("goal_evaluator_feedback");
    expect(feedback).toContain("npm run typecheck has not run");
  });

  test("a model that claims satisfied with an unfinished plan is forced to continue", async () => {
    const workspace = await tempDirectory("nju-goal-plan-");
    const provider = new GoalScriptedProvider();
    provider.workerScripts = [
      () => toolUse("plan_write", {
        items: [
          { id: "a", content: "read", status: "completed" },
          { id: "b", content: "fix", status: "completed" },
        ],
      }),
      () => completeText("all steps done"),
    ];
    provider.evaluatorScripts = [
      () => jsonDecision({ satisfied: true, reason: "looks done", missingEvidence: [] }),
    ];
    const { manager, initialRuntime } = await makeManager({ workspace, provider });
    initialRuntime.planManager.replace([
      { id: "a", content: "read", status: "completed" },
      { id: "b", content: "fix", status: "pending" },
    ]);
    await manager.setGoal(GOAL);

    const result = await manager.runTurn("work", new AbortController().signal);

    // The host policy refuses the first satisfied claim because the plan is
    // unfinished; only after the worker completes the plan via plan_write
    // does a later evaluation verify.
    expect(provider.requests).toHaveLength(3);
    expect(result.status).toBe("goal_verified");
  });

  test("three continuations then a fourth incomplete evaluation returns goal_incomplete and keeps the goal active", async () => {
    const workspace = await tempDirectory("nju-goal-exhaust-");
    const provider = new GoalScriptedProvider();
    provider.workerScripts = Array.from({ length: 4 }, () => () => completeText("still working"));
    provider.evaluatorScripts = Array.from({ length: 4 }, () => () =>
      jsonDecision({ satisfied: false, reason: "not yet", missingEvidence: ["missing check"] }),
    );
    const { manager } = await makeManager({ workspace, provider });
    await manager.setGoal(GOAL);

    const result = await manager.runTurn("keep going", new AbortController().signal);

    expect(result.status).toBe("goal_incomplete");
    expect(provider.requests).toHaveLength(8);
    expect(manager.goal()?.status).toBe("active");
    expect(manager.goal()?.automaticContinuations).toBe(3);
  });

  test("evaluator failure returns internal_failed and leaves the goal active", async () => {
    const workspace = await tempDirectory("nju-goal-fail-");
    const provider = new GoalScriptedProvider();
    provider.workerScripts = [() => completeText("done")];
    provider.failEvaluator = true;
    const { manager } = await makeManager({ workspace, provider });
    await manager.setGoal(GOAL);

    const result = await manager.runTurn("work", new AbortController().signal);

    expect(result.status).toBe("internal_failed");
    expect(manager.goal()?.status).toBe("active");
    expect(manager.goal()?.automaticContinuations).toBe(0);
  });

  test("cancellation during a run keeps the goal active", async () => {
    const workspace = await tempDirectory("nju-goal-cancel-");
    const provider = new GoalScriptedProvider();
    provider.workerScripts = [() => completeText("done")];
    provider.evaluatorScripts = [
      () => jsonDecision({ satisfied: true, reason: "ok", missingEvidence: [] }),
    ];
    const { manager } = await makeManager({ workspace, provider });
    await manager.setGoal(GOAL);

    const controller = new AbortController();
    const pending = manager.runTurn("work", controller.signal);
    // Abort before the model finishes the first request.
    setTimeout(() => controller.abort(), 5);
    const result = await pending;

    expect(["cancelled", "goal_verified"]).toContain(result.status);
    if (result.status === "cancelled") {
      expect(manager.goal()?.status).toBe("active");
    }
  });

  test("reaching maxSteps returns limit_reached and keeps the goal active", async () => {
    const workspace = await tempDirectory("nju-goal-steps-");
    const provider = new GoalScriptedProvider();
    // The worker keeps calling tools until the step budget is exhausted.
    provider.workerScripts = Array.from({ length: 10 }, () => () =>
      toolUse("run_command", { command: "npm test" }),
    );
    const { manager } = await makeManager({ workspace, provider, maxSteps: 3 });
    await manager.setGoal(GOAL);

    const result = await manager.runTurn("work", new AbortController().signal);

    expect(result.status).toBe("limit_reached");
    expect(manager.goal()?.status).toBe("active");
  });
});
