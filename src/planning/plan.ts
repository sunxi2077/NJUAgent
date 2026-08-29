export type PlanItemStatus = "pending" | "in_progress" | "completed";

export type PlanItem = {
  id: string;
  content: string;
  status: PlanItemStatus;
};

export type PlanState = {
  items: PlanItem[];
  updatedAt?: string;
};

export const EMPTY_PLAN_STATE: Readonly<PlanState> = { items: [] };

export type PlanValidationResult =
  | { ok: true; value: PlanItem[] }
  | { ok: false; message: string };

const PLAN_ITEM_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/u;
const MAX_PLAN_ITEMS = 12;

/**
 * Pure structural validation for a complete Plan item list. Returns cloned,
 * trimmed items on success; on failure returns a concise message and leaves
 * the caller's state untouched.
 */
export function validatePlanItems(input: readonly PlanItem[]): PlanValidationResult {
  if (input.length > MAX_PLAN_ITEMS) {
    return { ok: false, message: `Plan exceeds ${MAX_PLAN_ITEMS} items.` };
  }
  const seen = new Set<string>();
  let inProgressCount = 0;
  const value: PlanItem[] = [];
  for (const item of input) {
    if (!PLAN_ITEM_ID_PATTERN.test(item.id)) {
      return {
        ok: false,
        message: `Plan item id "${item.id}" is invalid.`,
      };
    }
    if (seen.has(item.id)) {
      return { ok: false, message: `Plan item id "${item.id}" is duplicated.` };
    }
    seen.add(item.id);
    const content = item.content.trim();
    const contentLength = [...content].length;
    if (contentLength < 1 || contentLength > 200) {
      return {
        ok: false,
        message: `Plan item "${item.id}" content must be 1-200 characters.`,
      };
    }
    if (item.status !== "pending" && item.status !== "in_progress" && item.status !== "completed") {
      return { ok: false, message: `Plan item "${item.id}" has an invalid status.` };
    }
    if (item.status === "in_progress") {
      inProgressCount += 1;
    }
    value.push({ id: item.id, content, status: item.status });
  }
  if (inProgressCount > 1) {
    return { ok: false, message: "Plan has more than one in_progress item." };
  }
  return { ok: true, value };
}
