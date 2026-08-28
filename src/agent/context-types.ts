import type { Message } from "./messages.js";
import type { ModelToolDefinition } from "../providers/provider.js";

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

export type ContextBudget = {
  contextWindowTokens: number;
  maxOutputTokens: number;
  safetyTokens: number;
  compactAtRatio: number;
  recentMessages: number;
  charsPerToken: number;
};

/** The per-request context view handed to AgentRunner. */
export type PreparedContext = {
  action: "continue" | "compacted" | "stop";
  systemPrompt: string;
  messages: readonly Message[];
  estimatedTokens: number;
  compactedToolResults: number;
  checkpoint?: ContextCheckpoint;
  reason?: string;
};

export type ContextStatus = {
  estimatedTokens: number;
  thresholdTokens: number;
  hardInputTokens: number;
  contextWindowTokens: number;
  coveredMessageCount: number;
  totalMessageCount: number;
  compactionCount: number;
  lastInputTokens?: number;
};

export type ContextPrepareInput = {
  baseSystemPrompt: string;
  messages: readonly Message[];
  tools: readonly ModelToolDefinition[];
  signal: AbortSignal;
};
