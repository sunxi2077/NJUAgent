import type { GoalEvaluationDecision } from "../goals/goal.js";
import type { Message } from "./messages.js";

export type StopGateDecision =
  | {
      action: "stop";
      outcome?: "verified" | "incomplete";
      verification?: GoalEvaluationDecision;
    }
  | { action: "continue"; feedback: string }
  | { action: "fail"; message: string };

/**
 * Generic seam evaluated only when the worker would otherwise stop with no
 * tool calls. A gate may verify completion (Goal), ask the loop to continue
 * with host-authored feedback, or fail the run. `beginRun()` resets per-run
 * state once, before the user's ordinary message is appended.
 */
export interface StopGate {
  beginRun?(): void;
  evaluate(input: {
    messages: readonly Message[];
    signal: AbortSignal;
  }): Promise<StopGateDecision>;
}
