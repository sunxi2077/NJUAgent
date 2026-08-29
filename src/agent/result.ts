import type { GoalEvaluationDecision } from "../goals/goal.js";

export type RunStats = {
  steps: number;
  toolCalls: number;
  durationMs: number;
};

export type RunResult = RunStats &
  (
    | { status: "completed" }
    | { status: "goal_verified"; verification: GoalEvaluationDecision }
    | { status: "goal_incomplete"; verification: GoalEvaluationDecision }
    | { status: "limit_reached" }
    | { status: "context_limit" }
    | { status: "cancelled" }
    | { status: "model_failed"; message: string }
    | { status: "internal_failed"; message: string }
  );
