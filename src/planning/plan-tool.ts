import { AppError, isAppError } from "../errors/app-error.js";
import { PlanManager } from "./plan-manager.js";
import type { PlanItem, PlanState } from "./plan.js";
import type { Tool } from "../tools/tool.js";

const PLAN_ITEM_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,31}$" },
    content: { type: "string", minLength: 1, maxLength: 200 },
    status: { enum: ["pending", "in_progress", "completed"] },
  },
  required: ["id", "content", "status"],
  additionalProperties: false,
} as const;

const PLAN_WRITE_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      maxItems: 12,
      items: PLAN_ITEM_SCHEMA,
    },
  },
  required: ["items"],
  additionalProperties: false,
} as const;

function formatPlan(plan: PlanState): string {
  const completed = plan.items.filter((item) => item.status === "completed").length;
  const lines = plan.items.map((item) => `  [${item.status}] ${item.id}: ${item.content}`);
  return [`Plan updated (${completed}/${plan.items.length} complete):`, ...lines].join("\n");
}

/**
 * Model-facing `plan_write` tool. It only mutates session metadata, so it
 * needs no permission confirmation and no session I/O of its own; runtime
 * checkpointing happens on the existing `SessionManager.runTurn()` path.
 */
export function createPlanWriteTool(options: {
  manager: PlanManager;
  onUpdated?: (plan: PlanState) => void;
}): Tool<{ items: PlanItem[] }> {
  return {
    name: "plan_write",
    description:
      "Create or replace the structured execution plan for the current task. " +
      "Submit the complete list of steps each time. Use it for multi-step tasks " +
      "before reading or editing many files.",
    inputSchema: PLAN_WRITE_SCHEMA,
    async execute(input): Promise<{ content: string; isError?: boolean }> {
      try {
        const plan = options.manager.replace(input.items);
        options.onUpdated?.(plan);
        return { content: formatPlan(plan) };
      } catch (error) {
        if (isAppError(error) && error.code === "PLAN_INVALID") {
          return { content: error.userMessage, isError: true };
        }
        if (error instanceof AppError) {
          return { content: error.userMessage, isError: true };
        }
        throw error;
      }
    },
  };
}
