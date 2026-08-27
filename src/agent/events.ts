import type { RunResult } from "./result.js";

export type AgentEvent =
  | { type: "model_started"; step: number }
  | { type: "text_delta"; text: string }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "model_completed"; stopReason: string }
  | { type: "tool_started"; id: string; name: string }
  | {
      type: "tool_completed";
      id: string;
      name: string;
      ok: boolean;
      durationMs: number;
    }
  | { type: "run_finished"; result: RunResult };

export type AgentEventHandler = (event: AgentEvent) => void;
