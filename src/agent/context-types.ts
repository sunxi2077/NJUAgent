/**
 * Shared context checkpoint/state subset persisted in Session V1 and extended
 * by the context-management plan.
 */
export type ContextCheckpoint = {
  summary: string;
  coveredMessageCount: number;
  createdAt: string;
  sourceEstimatedTokens: number;
};

export type ContextState = {
  checkpoint?: ContextCheckpoint;
  lastInputTokens?: number;
  compactionCount: number;
};
