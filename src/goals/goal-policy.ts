import type { GoalEvaluationDecision } from "./goal.js";
import type { EvidenceState } from "./goal.js";
import type { PlanState } from "../planning/plan.js";

const MAX_MISSING_EVIDENCE = 8;
const MAX_MISSING_ITEM_LENGTH = 300;

const UNFINISHED_PLAN = "The active plan still has unfinished items.";
const STALE_VERIFICATION =
  "No successful verification command has run after the latest workspace edit.";

/**
 * Host-side evidence rules that run after the evaluator model. These cannot
 * understand every natural-language condition, but they stop the most common
 * false completions: unfinished plans and edits without fresh verification.
 * Pure: inputs are never mutated.
 */
export function applyGoalPolicy(input: {
  modelDecision: GoalEvaluationDecision;
  plan: PlanState;
  evidence: EvidenceState;
}): GoalEvaluationDecision {
  const { modelDecision, plan, evidence } = input;
  let satisfied = modelDecision.satisfied;
  const reasons: string[] = [];
  const missing = [...modelDecision.missingEvidence];

  if (!satisfied && modelDecision.reason !== "") {
    reasons.push(modelDecision.reason);
  }

  const unfinished = plan.items.some((item) => item.status !== "completed");
  if (unfinished) {
    satisfied = false;
    reasons.push(UNFINISHED_PLAN);
    if (!missing.includes(UNFINISHED_PLAN)) {
      missing.push(UNFINISHED_PLAN);
    }
  }

  const hasEdits = evidence.changedPaths.length > 0;
  if (hasEdits && !evidence.commands.some(
    (command) =>
      command.exitCode === 0 &&
      !command.timedOut &&
      !command.cancelled &&
      command.isVerification &&
      command.workspaceRevision === evidence.workspaceRevision,
  )) {
    satisfied = false;
    reasons.push(STALE_VERIFICATION);
    if (!missing.includes(STALE_VERIFICATION)) {
      missing.push(STALE_VERIFICATION);
    }
  }

  const deduped = [...new Set(missing)]
    .map((item) => [...item].slice(0, MAX_MISSING_ITEM_LENGTH).join(""))
    .slice(0, MAX_MISSING_EVIDENCE);
  const reason = reasons
    .filter((entry, index) => reasons.indexOf(entry) === index)
    .map((entry) => [...entry].slice(0, 500).join(""))
    .join("; ") || "The goal is not yet verified.";
  return {
    satisfied,
    reason,
    missingEvidence: deduped,
    ...(modelDecision.nextInstruction === undefined
      ? {}
      : { nextInstruction: [...modelDecision.nextInstruction].slice(0, 500).join("") }),
  };
}
