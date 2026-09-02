import type { ModelProvider, ModelRequest, ProviderEvent } from "./provider.js";

export type UsageRecord = { inputTokens: number; outputTokens: number };

/**
 * Wraps a provider and reports one usage record per completed stream: the
 * final `usage` event the provider reported. Ordinary worker turns,
 * compaction calls, and goal-evaluator calls all pass through one wrapper, so
 * accounting is uniform and never derived from rendered text.
 */
export class UsageTrackingProvider implements ModelProvider {
  readonly #inner: ModelProvider;
  readonly #onUsage: (usage: UsageRecord) => void;

  constructor(
    inner: ModelProvider,
    onUsage: (usage: UsageRecord) => void,
  ) {
    this.#inner = inner;
    this.#onUsage = onUsage;
  }

  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    let latest: UsageRecord | undefined;
    try {
      for await (const event of this.#inner.stream(request, signal)) {
        if (event.type === "usage") {
          latest = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
        }
        yield event;
      }
    } finally {
      // Record even when the stream threw after reporting usage: the work may
      // have been billed. No usage event means no record.
      if (latest !== undefined) {
        this.#onUsage(latest);
      }
    }
  }
}
