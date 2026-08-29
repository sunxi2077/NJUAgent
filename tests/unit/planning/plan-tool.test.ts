import { describe, expect, test } from "vitest";

import { PlanManager } from "../../../src/planning/plan-manager.js";
import { createPlanWriteTool } from "../../../src/planning/plan-tool.js";
import type { PlanItem, PlanState } from "../../../src/planning/plan.js";
import type { ToolContext } from "../../../src/tools/tool.js";

function makeTool() {
  const state: PlanState = { items: [] };
  const manager = new PlanManager({ state });
  const updated: PlanState[] = [];
  const tool = createPlanWriteTool({ manager, onUpdated: (plan) => updated.push(plan) });
  const context: ToolContext = {
    signal: new AbortController().signal,
    emitOutput: () => {},
  };
  return { state, manager, tool, updated, context };
}

const items: PlanItem[] = [
  { id: "inspect", content: "Read implementation", status: "completed" },
  { id: "fix", content: "Implement validation", status: "in_progress" },
];

describe("createPlanWriteTool", () => {
  test("exposes the exact plan_write schema", () => {
    const { tool } = makeTool();
    expect(tool.name).toBe("plan_write");
    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {
        items: {
          type: "array",
          maxItems: 12,
          items: {
            type: "object",
            properties: {
              id: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,31}$" },
              content: { type: "string", minLength: 1, maxLength: 200 },
              status: { enum: ["pending", "in_progress", "completed"] },
            },
            required: ["id", "content", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    });
  });

  test("returns the complete normalized plan and fires onUpdated", async () => {
    const { tool, updated, context } = makeTool();
    const result = await tool.execute({ items }, context);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("[completed] inspect: Read implementation");
    expect(result.content).toContain("[in_progress] fix: Implement validation");
    expect(updated).toHaveLength(1);
    expect(updated[0]!.items).toHaveLength(2);
  });

  test("returns an execution error for cross-item validation failures", async () => {
    const { tool, updated, context } = makeTool();
    const result = await tool.execute(
      {
        items: [
          { id: "dup", content: "one", status: "pending" },
          { id: "dup", content: "two", status: "pending" },
        ],
      },
      context,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("duplicated");
    expect(updated).toHaveLength(0);
  });

  test("empty items clear the plan", async () => {
    const { tool, state, updated, context } = makeTool();
    state.items = items;
    const result = await tool.execute({ items: [] }, context);
    expect(result.isError).toBeUndefined();
    expect(state.items).toEqual([]);
    expect(updated).toHaveLength(1);
    expect(updated[0]!.items).toEqual([]);
  });
});
