import type { Message } from "../agent/messages.js";
import type { PlanState } from "../planning/plan.js";

export type GoalStatus = "active" | "verified" | "cancelled";

export type GoalState = {
  condition: string;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
  automaticContinuations: number;
  lastDecision?: {
    satisfied: boolean;
    reason: string;
    missingEvidence: string[];
    evaluatedAt: string;
  };
};

export type CommandEvidence = {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  isVerification: boolean;
  workspaceRevision: number;
  observedAt: string;
};

export type EvidenceState = {
  workspaceRevision: number;
  changedPaths: string[];
  commands: CommandEvidence[];
};

export type GoalEvaluationInput = {
  condition: string;
  plan: PlanState;
  evidence: EvidenceState;
  recentMessages: readonly Message[];
  signal: AbortSignal;
};

export type GoalEvaluationDecision = {
  satisfied: boolean;
  reason: string;
  missingEvidence: string[];
  nextInstruction?: string;
};

export function createEmptyEvidenceState(): EvidenceState {
  return { workspaceRevision: 0, changedPaths: [], commands: [] };
}
