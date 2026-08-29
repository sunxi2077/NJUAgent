import { describe, expect, test } from "vitest";

import { EvidenceLedger } from "../../../src/goals/evidence-ledger.js";
import type { EvidenceState } from "../../../src/goals/goal.js";
import type { ToolExecutionRequest, ToolExecutionResult } from "../../../src/tools/tool.js";

function call(name: string, input: Record<string, unknown>): ToolExecutionRequest {
  return { id: `call-${name}`, name, input };
}

function result(overrides: Partial<ToolExecutionResult> = {}): ToolExecutionResult {
  return {
    type: "tool_result",
    toolCallId: "call-x",
    content: "ok",
    isError: false,
    durationMs: 1,
    ...overrides,
  } as ToolExecutionResult;
}

function commandResult(exitCode: number | null, extra: Record<string, unknown> = {}): ToolExecutionResult {
  return result({ metadata: { exitCode, timedOut: false, cancelled: false, ...extra } });
}

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

function makeLedger(overrides: Partial<EvidenceState> = {}) {
  const state: EvidenceState = {
    workspaceRevision: 0,
    changedPaths: [],
    commands: [],
    ...overrides,
  };
  const ledger = new EvidenceLedger({ state, clock: fixedClock("2026-08-29T10:00:00.000Z") });
  return { state, ledger };
}

describe("EvidenceLedger", () => {
  test("successful write_file increments revision and records the path once", () => {
    const { ledger, state } = makeLedger();
    ledger.observe(
      call("write_file", { path: "src/a.ts", content: "x" }),
      result({ metadata: { path: "src/a.ts", bytes: 1, truncated: false } }),
    );
    ledger.observe(
      call("write_file", { path: "src/a.ts", content: "y" }),
      result({ metadata: { path: "src/a.ts", bytes: 1, truncated: false } }),
    );
    expect(state.workspaceRevision).toBe(2);
    expect(state.changedPaths).toEqual(["src/a.ts"]);
  });

  test("failed writes do not increment revision", () => {
    const { ledger, state } = makeLedger();
    ledger.observe(
      call("edit_file", { path: "src/a.ts", oldText: "x", newText: "y" }),
      result({ isError: true, code: "execution_failed", content: "no match" }),
    );
    expect(state.workspaceRevision).toBe(0);
    expect(state.changedPaths).toEqual([]);
  });

  test("run_command records command evidence with host-classified verification", () => {
    const { ledger, state } = makeLedger();
    ledger.observe(
      call("run_command", { command: "npm test" }),
      commandResult(0),
    );
    expect(state.commands).toHaveLength(1);
    expect(state.commands[0]).toMatchObject({
      command: "npm test",
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      isVerification: true,
      workspaceRevision: 0,
      observedAt: "2026-08-29T10:00:00.000Z",
    });
  });

  test("non-verification commands are recorded but never fresh evidence", () => {
    const { ledger, state } = makeLedger();
    ledger.observe(call("run_command", { command: "cat package.json" }), commandResult(0));
    expect(state.commands[0]!.isVerification).toBe(false);
    expect(ledger.hasFreshSuccessfulVerification()).toBe(false);
  });

  test("fresh verification requires exit 0, no timeout/cancel, and current revision", () => {
    const { ledger } = makeLedger();
    // A pass recorded before any edit references revision 0 and is stale
    // once the workspace moves to revision 1.
    ledger.observe(call("run_command", { command: "npm test" }), commandResult(0));
    ledger.observe(
      call("write_file", { path: "a.ts", content: "x" }),
      result({ metadata: { path: "a.ts" } }),
    );
    expect(ledger.hasFreshSuccessfulVerification()).toBe(false);
    // A pass after the latest edit is fresh.
    ledger.observe(call("run_command", { command: "npm test" }), commandResult(0));
    expect(ledger.hasFreshSuccessfulVerification()).toBe(true);
  });

  test.each([
    ["non-zero exit", { exitCode: 1 }],
    ["timeout", { exitCode: null, timedOut: true }],
    ["cancelled", { exitCode: null, cancelled: true }],
  ])("never treats %s as successful evidence", (_name, extra) => {
    const { ledger } = makeLedger();
    ledger.observe(
      call("run_command", { command: "npm test" }),
      commandResult(null, { workspaceRevision: 0, ...extra }),
    );
    expect(ledger.hasFreshSuccessfulVerification()).toBe(false);
  });

  test("malformed command metadata records conservative values", () => {
    const { ledger, state } = makeLedger();
    ledger.observe(call("run_command", { command: "npm test" }), result({ metadata: {} }));
    expect(state.commands[0]).toMatchObject({
      command: "npm test",
      exitCode: null,
      timedOut: false,
      cancelled: false,
      isVerification: true,
    });
    expect(ledger.hasFreshSuccessfulVerification()).toBe(false);
  });

  test("keeps only the newest 20 command records", () => {
    const { ledger, state } = makeLedger();
    for (let index = 0; index < 25; index += 1) {
      ledger.observe(call("run_command", { command: "npm test" }), commandResult(0));
    }
    expect(state.commands).toHaveLength(20);
    expect(state.commands[0]!.observedAt).toBeDefined();
  });

  test("search and plan tools never count as edits or verification", () => {
    const { ledger, state } = makeLedger();
    ledger.observe(call("search_text", { query: "x" }), result());
    ledger.observe(call("plan_write", { items: [] }), result());
    expect(state.workspaceRevision).toBe(0);
    expect(state.commands).toHaveLength(0);
  });

  test("snapshot is a defensive clone", () => {
    const { ledger, state } = makeLedger();
    ledger.observe(
      call("write_file", { path: "a.ts", content: "x" }),
      result({ metadata: { path: "a.ts" } }),
    );
    const snapshot = ledger.snapshot();
    snapshot.changedPaths.push("mutated");
    expect(state.changedPaths).toEqual(["a.ts"]);
  });
});
