import { describe, expect, test } from "vitest";

import { AppError } from "../../../src/errors/app-error.js";
import { PlanManager } from "../../../src/planning/plan-manager.js";
import type { PlanItem, PlanState } from "../../../src/planning/plan.js";

function items(overrides: Array<Partial<PlanItem>> = []): PlanItem[] {
  return overrides.map((entry, index) => ({
    id: `step-${index}`,
    content: `Step ${index}`,
    status: "pending",
    ...entry,
  }));
}

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

describe("PlanManager", () => {
  test("replace commits a whole-list snapshot with a timestamp", () => {
    const state: PlanState = { items: [] };
    const manager = new PlanManager({
      state,
      clock: fixedClock("2026-08-29T09:00:00.000Z"),
    });
    const result = manager.replace(items([{ id: "a" }, { id: "b" }]));
    expect(result.items).toHaveLength(2);
    expect(result.updatedAt).toBe("2026-08-29T09:00:00.000Z");
    expect(state.items).toHaveLength(2);
    expect(state.updatedAt).toBe("2026-08-29T09:00:00.000Z");
  });

  test("returns defensive copies so callers cannot mutate internal state", () => {
    const state = { items: items([{ id: "a" }]) };
    const manager = new PlanManager({ state });
    const snapshot = manager.snapshot();
    snapshot.items[0]!.content = "mutated";
    expect(state.items[0]!.content).toBe("Step 0");
    const replaced = manager.replace(items([{ id: "b", content: "original" }]));
    replaced.items[0]!.content = "mutated";
    expect(state.items[0]!.content).toBe("original");
  });

  test("clear empties the plan and records the timestamp", () => {
    const state = { items: items([{ id: "a" }]) };
    const manager = new PlanManager({
      state,
      clock: fixedClock("2026-08-29T09:10:00.000Z"),
    });
    const cleared = manager.clear();
    expect(cleared.items).toEqual([]);
    expect(cleared.updatedAt).toBe("2026-08-29T09:10:00.000Z");
    expect(state.items).toEqual([]);
  });

  test("invalid replacement preserves the previous state", () => {
    const state = { items: items([{ id: "keep" }]) };
    const manager = new PlanManager({ state });
    let error: unknown;
    try {
      manager.replace([
        { id: "dup", content: "one", status: "pending" },
        { id: "dup", content: "two", status: "pending" },
      ]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "PLAN_INVALID" });
    expect(state.items).toHaveLength(1);
    expect(state.items[0]!.id).toBe("keep");
    expect(manager.snapshot().items).toHaveLength(1);
  });

  test("onChanged fires once with a snapshot only after a successful mutation", () => {
    const state: PlanState = { items: [] };
    const changed: Array<{ items: number }> = [];
    const manager = new PlanManager({
      state,
      onChanged: (next) => changed.push({ items: next.items.length }),
    });
    manager.replace(items([{ id: "a" }]));
    expect(changed).toEqual([{ items: 1 }]);
    manager.clear();
    expect(changed).toEqual([{ items: 1 }, { items: 0 }]);
  });

  test("onChanged is not invoked for an invalid replacement", () => {
    const state: PlanState = { items: [] };
    let calls = 0;
    const manager = new PlanManager({ state, onChanged: () => { calls += 1; } });
    try {
      manager.replace([{ id: "x", content: "", status: "pending" }]);
    } catch {
      // expected
    }
    expect(calls).toBe(0);
  });
});
