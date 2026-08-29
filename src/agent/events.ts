import type { RunResult } from "./result.js";
import type { PlanState } from "../planning/plan.js";

export type AgentEvent =
  | { type: "model_started"; step: number }
  | { type: "text_delta"; text: string }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "model_completed"; stopReason: string }
  | { type: "retrying"; attempt: number; delayMs: number; reason: string }
  | { type: "tool_started"; id: string; name: string; summary: string }
  | {
      type: "tool_completed";
      id: string;
      name: string;
      ok: boolean;
      durationMs: number;
    }
  | { type: "plan_updated"; plan: PlanState }
  | { type: "context_compaction_started" }
  | { type: "context_compaction_completed"; summaryLength: number }
  | { type: "context_warning"; message: string }
  | { type: "run_finished"; result: RunResult };

export type AgentEventHandler = (event: AgentEvent) => void;
