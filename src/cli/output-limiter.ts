import { takeUtf8Prefix } from "../tools/output-budget.js";

export type LimitedLiveOutput = {
  text: string;
  suppressionStarted: boolean;
};

type CallBudget = { usedBytes: number; suppressionAnnounced: boolean };

/**
 * Enforces a per-tool-call byte budget on live terminal output. Each call id
 * has an independent budget; once a call exceeds it, remaining chunks are
 * dropped and suppression is announced exactly once per call.
 */
export class LiveOutputLimiter {
  readonly #calls = new Map<string, CallBudget>();

  constructor(private readonly maxBytes: number) {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("maxBytes must be a positive integer");
    }
  }

  consume(callId: string, text: string): LimitedLiveOutput {
    const state = this.#calls.get(callId) ?? {
      usedBytes: 0,
      suppressionAnnounced: false,
    };
    const remaining = Math.max(0, this.maxBytes - state.usedBytes);
    const visible = takeUtf8Prefix(text, remaining);
    state.usedBytes += Buffer.byteLength(visible, "utf8");
    const suppressed = Buffer.byteLength(visible, "utf8") < Buffer.byteLength(text, "utf8");
    const suppressionStarted = suppressed && !state.suppressionAnnounced;
    if (suppressionStarted) {
      state.suppressionAnnounced = true;
    }
    this.#calls.set(callId, state);
    return { text: visible, suppressionStarted };
  }

  finish(callId: string): void {
    this.#calls.delete(callId);
  }
}
