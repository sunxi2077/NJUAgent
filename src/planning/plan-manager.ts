import { AppError } from "../errors/app-error.js";
import { validatePlanItems, type PlanItem, type PlanState } from "./plan.js";

/**
 * Owns the session's Plan state. Whole-list replacement is atomic: the
 * session-owned `state` object is only mutated after validation succeeds, so
 * the in-memory runtime and the persisted session can never diverge.
 */
export class PlanManager {
  readonly #state: PlanState;
  readonly #clock: () => Date;
  readonly #onChanged: ((state: PlanState) => void) | undefined;

  constructor(options: {
    state: PlanState;
    clock?: () => Date;
    onChanged?: (state: PlanState) => void;
  }) {
    this.#state = options.state;
    this.#clock = options.clock ?? (() => new Date());
    this.#onChanged = options.onChanged;
  }

  snapshot(): PlanState {
    return structuredClone(this.#state);
  }

  replace(items: readonly PlanItem[]): PlanState {
    const result = validatePlanItems(items);
    if (!result.ok) {
      throw new AppError({ code: "PLAN_INVALID", userMessage: result.message });
    }
    this.#state.items = structuredClone(result.value);
    this.#state.updatedAt = this.#clock().toISOString();
    const snapshot = this.snapshot();
    this.#onChanged?.(snapshot);
    return snapshot;
  }

  clear(): PlanState {
    return this.replace([]);
  }
}
