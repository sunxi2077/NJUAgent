import { describe, expect, test } from "vitest";

import { validatePlanItems, type PlanItem } from "../../../src/planning/plan.js";

function item(overrides: Partial<PlanItem> = {}): PlanItem {
  return { id: "step-1", content: "Read implementation", status: "pending", ...overrides };
}

describe("validatePlanItems", () => {
  test("accepts an empty plan", () => {
    expect(validatePlanItems([])).toEqual({ ok: true, value: [] });
  });

  test("accepts a legal plan and returns trimmed clones", () => {
    const input = [
      item({ id: "read", content: "  read code  ", status: "pending" }),
      item({ id: "fix", content: "implement", status: "in_progress" }),
      item({ id: "verify", content: "run tests", status: "completed" }),
    ];
    const result = validatePlanItems(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        { id: "read", content: "read code", status: "pending" },
        { id: "fix", content: "implement", status: "in_progress" },
        { id: "verify", content: "run tests", status: "completed" },
      ]);
      // The returned items must not alias the input.
      result.value[0]!.content = "mutated";
      expect(input[0]!.content).toBe("  read code  ");
    }
  });

  test("accepts a 200-character CJK content but rejects 201", () => {
    const okItem = item({ content: "设".repeat(200) });
    expect(validatePlanItems([okItem]).ok).toBe(true);
    const tooLong = item({ content: "设".repeat(201) });
    expect(validatePlanItems([tooLong].map((entry) => ({ ...entry }))).ok).toBe(false);
  });

  test("rejects more than 12 items", () => {
    const items = Array.from({ length: 13 }, (_, index) => item({ id: `s${index}` }));
    expect(validatePlanItems(items).ok).toBe(false);
  });

  test("rejects duplicate ids", () => {
    expect(validatePlanItems([item(), item()]).ok).toBe(false);
  });

  test("rejects more than one in_progress item", () => {
    expect(
      validatePlanItems([
        item({ id: "a", status: "in_progress" }),
        item({ id: "b", status: "in_progress" }),
      ]).ok,
    ).toBe(false);
  });

  test.each([
    ["uppercase", item({ id: "Step-1" })],
    ["leading digit ok but leading dash no", item({ id: "-step" })],
    ["space", item({ id: "step one" })],
    ["too long", item({ id: "s".repeat(33) })],
  ])("rejects invalid id (%s)", (_name, entry) => {
    expect(validatePlanItems([entry]).ok).toBe(false);
  });

  test("accepts valid id shapes", () => {
    for (const id of ["s", "step-1", "step_2", "a1-b_c"]) {
      expect(validatePlanItems([item({ id })]).ok, id).toBe(true);
    }
  });

  test("rejects blank or overlong content", () => {
    expect(validatePlanItems([item({ content: "   " })]).ok).toBe(false);
    expect(validatePlanItems([item({ content: "x".repeat(201) })]).ok).toBe(false);
  });
});
