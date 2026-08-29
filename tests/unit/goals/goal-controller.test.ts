import { describe, expect, test } from "vitest";

import { GoalController } from "../../../src/goals/goal-controller.js";
import type { GoalEvaluationDecision, GoalEvaluatorPort, GoalState, EvidenceState } from "../../../src/goals/goal.js";
import type { PlanState } from "../../../src/planning/plan.js";

class FakeEvaluator implements GoalEvaluatorPort {
  decisions: GoalEvaluationDecision[] = [];
  fail = false;
  calls = 0;

  async evaluate(): Promise<GoalEvaluationDecision> {
    this.calls += 1;
    if (this.fail) {
      throw new Error("evaluator exploded");
    }
    return this.decisions.shift() ?? { satisfied: true, reason: "ok", missingEvidence: [] };
  }
}

function activeGoal(overrides: Partial<GoalState> = {}): GoalState {
  return {
    condition: "npm test exits 0",
    status: "active",
    createdAt: "2026-08-29T09:00:00.000Z",
    updatedAt: "2026-08-29T09:00:00.000Z",
    automaticContinuations: 0,
    ...overrides,
  };
}

function makeController(options: {
  goal?: () => GoalState | null;
  plan?: () => PlanState;
  evidence?: () => EvidenceState;
  evaluator?: FakeEvaluator;
  max?: number;
}) {
  const evaluator = options.evaluator ?? new FakeEvaluator();
  const events: string[] = [];
  const goal = options.goal ?? (() => activeGoal());
  const controller = new GoalController({
    goal,
    plan: options.plan ?? (() => ({ items: [{ id: "a", content: "a", status: "completed" }] })),
    evidence: options.evidence ??
      (() => ({ workspaceRevision: 0, changedPaths: [], commands: [] })),
    evaluator,
    maxAutomaticContinuations: options.max ?? 3,
    clock: () => new Date("2026-08-29T10:00:00.000Z"),
    onEvent: (event) => events.push(event.type),
  });
  return { controller, evaluator, events };
}

const input = {
  messages: [] as const,
  signal: new AbortController().signal,
};

describe("GoalController", () => {
  test("returns stop without evaluating when there is no goal", async () => {
    const { controller, evaluator } = makeController({ goal: () => null });
    await expect(controller.evaluate(input)).resolves.toEqual({ action: "stop" });
    expect(evaluator.calls).toBe(0);
  });

  test("returns stop without evaluating for a non-active goal", async () => {
    const { controller, evaluator } = makeController({
      goal: () => activeGoal({ status: "verified" }),
    });
    await expect(controller.evaluate(input)).resolves.toEqual({ action: "stop" });
    expect(evaluator.calls).toBe(0);
  });

  test("verifies when the model and host policy agree", async () => {
    const goal = activeGoal();
    const { controller, evaluator, events } = makeController({ goal: () => goal });
    evaluator.decisions = [{ satisfied: true, reason: "tests pass", missingEvidence: [] }];

    const decision = await controller.evaluate(input);

    expect(decision).toMatchObject({ action: "stop", outcome: "verified" });
    expect(goal.status).toBe("verified");
    expect(goal.lastDecision?.satisfied).toBe(true);
    expect(goal.automaticContinuations).toBe(0);
    expect(events).toEqual(["goal_evaluation_started", "goal_evaluation_completed"]);
  });

  test("host policy forces continuation when the plan is unfinished", async () => {
    const goal = activeGoal();
    const { controller, evaluator } = makeController({
      goal: () => goal,
      plan: () => ({
        items: [
          { id: "a", content: "a", status: "completed" },
          { id: "b", content: "b", status: "pending" },
        ],
      }),
    });
    evaluator.decisions = [{ satisfied: true, reason: "looks done", missingEvidence: [] }];

    const decision = await controller.evaluate(input);

    expect(decision.action).toBe("continue");
    expect(goal.status).toBe("active");
    expect(goal.automaticContinuations).toBe(1);
    expect((decision as { feedback: string }).feedback).toContain(
      "The active plan still has unfinished items.",
    );
  });

  test("incomplete decisions continue at most maxAutomaticContinuations times", async () => {
    const goal = activeGoal();
    const evaluator = new FakeEvaluator();
    evaluator.decisions = Array.from({ length: 5 }, () => ({
      satisfied: false,
      reason: "missing evidence",
      missingEvidence: ["npm run typecheck has not run"],
    }));
    const { controller } = makeController({ goal: () => goal, evaluator, max: 3 });

    const first = await controller.evaluate(input);
    expect(first.action).toBe("continue");
    expect(goal.automaticContinuations).toBe(1);
    const second = await controller.evaluate(input);
    expect(second.action).toBe("continue");
    expect(goal.automaticContinuations).toBe(2);
    const third = await controller.evaluate(input);
    expect(third.action).toBe("continue");
    expect(goal.automaticContinuations).toBe(3);
    const fourth = await controller.evaluate(input);
    expect(fourth).toMatchObject({ action: "stop", outcome: "incomplete" });
    // No further increment after the cap.
    expect(goal.automaticContinuations).toBe(3);
    expect(evaluator.calls).toBe(4);
  });

  test("beginRun resets the persisted continuation counter", async () => {
    const goal = activeGoal({ automaticContinuations: 2 });
    const { controller } = makeController({ goal: () => goal });
    controller.beginRun();
    expect(goal.automaticContinuations).toBe(0);
  });

  test("feedback carries the fixed wrapper and bounded missing evidence", async () => {
    const goal = activeGoal();
    const evaluator = new FakeEvaluator();
    evaluator.decisions = [
      {
        satisfied: false,
        reason: "r",
        missingEvidence: ["npm run typecheck has not run after the latest edit"],
        nextInstruction: "Run npm run typecheck.",
      },
    ];
    const { controller } = makeController({ goal: () => goal, evaluator });
    const decision = await controller.evaluate(input);
    const feedback = (decision as { feedback: string }).feedback;
    expect(feedback).toContain("<goal_evaluator_feedback>");
    expect(feedback).toContain("</goal_evaluator_feedback>");
    expect(feedback).toContain("The goal is not yet verified.");
    expect(feedback).toContain("- npm run typecheck has not run after the latest edit");
    expect(feedback).toContain("Continue working toward the active goal.");
    expect(feedback).toContain("Run npm run typecheck.");
  });

  test("evaluator failure fails the run and leaves the goal active", async () => {
    const goal = activeGoal();
    const evaluator = new FakeEvaluator();
    evaluator.fail = true;
    const { controller } = makeController({ goal: () => goal, evaluator });
    await expect(controller.evaluate(input)).resolves.toEqual({
      action: "fail",
      message: "Goal evaluation failed; the goal remains active.",
    });
    expect(goal.status).toBe("active");
  });
});
