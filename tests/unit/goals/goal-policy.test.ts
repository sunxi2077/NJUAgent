import { describe, expect, test } from "vitest";

import { applyGoalPolicy } from "../../../src/goals/goal-policy.js";
import type { GoalEvaluationDecision } from "../../../src/goals/goal.js";
import type { PlanState } from "../../../src/planning/plan.js";

function decision(overrides: Partial<GoalEvaluationDecision> = {}): GoalEvaluationDecision {
  return {
    satisfied: true,
    reason: "looks done",
    missingEvidence: [],
    ...overrides,
  };
}

function plan(overrides: Partial<PlanState> = {}): PlanState {
  return {
    items: [{ id: "a", content: "step a", status: "completed" }],
    ...overrides,
  };
}

function evidence(overrides: Record<string, unknown> = {}): any {
  return {
    workspaceRevision: 1,
    changedPaths: ["src/a.ts"],
    commands: [
      {
        command: "npm test",
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        isVerification: true,
        workspaceRevision: 1,
        observedAt: "2026-08-29T10:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

describe("applyGoalPolicy", () => {
  test("keeps satisfied when plan is complete and verification is fresh", () => {
    const out = applyGoalPolicy({
      modelDecision: decision(),
      plan: plan(),
      evidence: evidence(),
    });
    expect(out.satisfied).toBe(true);
    expect(out.missingEvidence).toEqual([]);
  });

  test("does not require command evidence when nothing was edited", () => {
    const out = applyGoalPolicy({
      modelDecision: decision(),
      plan: plan(),
      evidence: evidence({ changedPaths: [] }),
    });
    expect(out.satisfied).toBe(true);
  });

  test("forces incomplete when a plan item is unfinished", () => {
    const out = applyGoalPolicy({
      modelDecision: decision(),
      plan: plan({ items: [
        { id: "a", content: "done", status: "completed" },
        { id: "b", content: "todo", status: "pending" },
      ] }),
      evidence: evidence(),
    });
    expect(out.satisfied).toBe(false);
    expect(out.reason).toContain("The active plan still has unfinished items.");
    expect(out.missingEvidence).toContain("The active plan still has unfinished items.");
  });

  test("forces incomplete without fresh verification after an edit", () => {
    const out = applyGoalPolicy({
      modelDecision: decision(),
      plan: plan(),
      evidence: evidence({ commands: [
        {
          command: "npm test",
          exitCode: 0,
          timedOut: false,
          cancelled: false,
          isVerification: true,
          workspaceRevision: 0,
          observedAt: "2026-08-29T09:00:00.000Z",
        },
      ] }),
    });
    expect(out.satisfied).toBe(false);
    expect(out.missingEvidence).toContain(
      "No successful verification command has run after the latest workspace edit.",
    );
  });

  test("keeps the model's incomplete decision and deduplicates missing evidence", () => {
    const out = applyGoalPolicy({
      modelDecision: decision({
        satisfied: false,
        reason: "typecheck missing",
        missingEvidence: ["npm run typecheck has not run", "npm run typecheck has not run"],
      }),
      plan: plan(),
      evidence: evidence(),
    });
    expect(out.satisfied).toBe(false);
    expect(out.missingEvidence).toEqual(["npm run typecheck has not run"]);
  });

  test("never mutates the input objects", () => {
    const modelDecision = decision();
    const planInput = plan();
    const evidenceInput = evidence();
    applyGoalPolicy({
      modelDecision,
      plan: planInput,
      evidence: evidenceInput,
    });
    expect(modelDecision.satisfied).toBe(true);
    expect(planInput.items).toHaveLength(1);
    expect(evidenceInput.changedPaths).toEqual(["src/a.ts"]);
    expect(evidenceInput.commands).toHaveLength(1);
  });

  test("caps and deduplicates missing evidence at 8 entries", () => {
    const out = applyGoalPolicy({
      modelDecision: decision({
        satisfied: false,
        reason: "r",
        missingEvidence: Array.from({ length: 12 }, (_, i) => `missing-${i % 3}`),
      }),
      plan: plan({ items: [
        { id: "a", content: "done", status: "completed" },
        { id: "b", content: "todo", status: "in_progress" },
      ] }),
      evidence: evidence({ changedPaths: [], commands: [] }),
    });
    expect(out.missingEvidence.length).toBeLessThanOrEqual(8);
    expect(new Set(out.missingEvidence).size).toBe(out.missingEvidence.length);
  });
});
