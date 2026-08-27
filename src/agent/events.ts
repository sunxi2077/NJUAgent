import type { RunResult } from "./result.js";

export type AgentEvent =
  | { type: "model_started"; step: number }
  | { type: "text_delta"; text: string }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "model_completed"; stopReason: string }
  | { type: "run_finished"; result: RunResult };

export type AgentEventHandler = (event: AgentEvent) => void;
