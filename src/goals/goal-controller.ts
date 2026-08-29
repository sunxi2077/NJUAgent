import type { AgentEvent } from "../agent/events.js";
import type { StopGate, StopGateDecision } from "../agent/stop-gate.js";
import type { Message } from "../agent/messages.js";
import { applyGoalPolicy } from "./goal-policy.js";
import type {
  EvidenceState,
  GoalEvaluationDecision,
  GoalEvaluatorPort,
  GoalState,
} from "./goal.js";
import type { PlanState } from "../planning/plan.js";

function escapeFeedbackText(text: string): string {
  return text.replace(/<\/goal_evaluator_feedback>/gu, "&lt;/goal_evaluator_feedback&gt;");
}

/**
 * StopGate implementation for the explicit Goal mode. Reads session-owned
 * state through closures so it always evaluates the current Plan and Evidence,
 * applies the host GoalPolicy after the model decision, and allows at most
 * `maxAutomaticContinuations` injected feedback messages per outer run.
 */
export class GoalController implements StopGate {
  readonly #goal: () => GoalState | null;
  readonly #plan: () => PlanState;
  readonly #evidence: () => EvidenceState;
  readonly #evaluator: GoalEvaluatorPort;
  readonly #maxContinuations: number;
  readonly #clock: () => Date;
  readonly #onEvent: ((event: AgentEvent) => void) | undefined;

  constructor(options: {
    goal: () => GoalState | null;
    plan: () => PlanState;
    evidence: () => EvidenceState;
    evaluator: GoalEvaluatorPort;
    maxAutomaticContinuations: number;
    clock?: () => Date;
    onEvent?: (event: AgentEvent) => void;
  }) {
    this.#goal = options.goal;
    this.#plan = options.plan;
    this.#evidence = options.evidence;
    this.#evaluator = options.evaluator;
    this.#maxContinuations = options.maxAutomaticContinuations;
    this.#clock = options.clock ?? (() => new Date());
    this.#onEvent = options.onEvent;
  }

  beginRun(): void {
    const goal = this.#goal();
    if (goal !== null && goal.status === "active") {
      goal.automaticContinuations = 0;
    }
  }

  async evaluate(input: {
    messages: readonly Message[];
    signal: AbortSignal;
  }): Promise<StopGateDecision> {
    const goal = this.#goal();
    if (goal === null || goal.status !== "active") {
      return { action: "stop" };
    }
    const attempt = goal.automaticContinuations + 1;
    this.#onEvent?.({ type: "goal_evaluation_started", attempt });

    let modelDecision: GoalEvaluationDecision;
    try {
      modelDecision = await this.#evaluator.evaluate({
        condition: goal.condition,
        plan: this.#plan(),
        evidence: this.#evidence(),
        recentMessages: input.messages,
        signal: input.signal,
      });
    } catch {
      // Evaluator failure: the goal stays active and the run fails closed.
      return {
        action: "fail",
        message: "Goal evaluation failed; the goal remains active.",
      };
    }

    const decision = applyGoalPolicy({
      modelDecision,
      plan: this.#plan(),
      evidence: this.#evidence(),
    });
    const now = this.#clock().toISOString();
    goal.lastDecision = {
      satisfied: decision.satisfied,
      reason: decision.reason,
      missingEvidence: decision.missingEvidence,
      evaluatedAt: now,
    };
    goal.updatedAt = now;
    this.#onEvent?.({ type: "goal_evaluation_completed", decision });

    if (decision.satisfied) {
      goal.status = "verified";
      return { action: "stop", outcome: "verified", verification: decision };
    }
    if (goal.automaticContinuations < this.#maxContinuations) {
      goal.automaticContinuations += 1;
      return { action: "continue", feedback: buildFeedback(decision) };
    }
    return { action: "stop", outcome: "incomplete", verification: decision };
  }
}

function buildFeedback(decision: GoalEvaluationDecision): string {
  const missing = decision.missingEvidence.length === 0
    ? "- No specific missing evidence was reported."
    : decision.missingEvidence.map((item) => `- ${escapeFeedbackText(item)}`).join("\n");
  const next = decision.nextInstruction === undefined
    ? []
    : [escapeFeedbackText(decision.nextInstruction)];
  return [
    "<goal_evaluator_feedback>",
    "The goal is not yet verified.",
    "Missing evidence:",
    missing,
    "Continue working toward the active goal. Do not merely restate the goal.",
    ...next,
    "</goal_evaluator_feedback>",
  ].join("\n");
}
