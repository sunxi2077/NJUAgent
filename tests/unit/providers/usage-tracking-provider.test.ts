import { describe, expect, test } from "vitest";

import { UsageTrackingProvider } from "../../../src/providers/usage-tracking-provider.js";
import type { ModelProvider, ModelRequest, ProviderEvent } from "../../../src/providers/provider.js";

class ScriptedProvider implements ModelProvider {
  readonly events: ProviderEvent[];
  throwAt = -1;
  constructor(events: ProviderEvent[] = []) {
    this.events = events;
  }

  async *stream(): AsyncIterable<ProviderEvent> {
    let index = 0;
    for (const event of this.events) {
      if (index === this.throwAt) {
        throw new Error("provider exploded");
      }
      index += 1;
      yield event;
      if (index === this.throwAt) {
        throw new Error("provider exploded");
      }
    }
  }
}

function usageEvent(inputTokens: number, outputTokens: number): ProviderEvent {
  return { type: "usage", inputTokens, outputTokens };
}

function completed(): ProviderEvent {
  return {
    type: "message_completed",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    },
    stopReason: "end_turn",
  };
}

const request: ModelRequest = { system: "s", messages: [], tools: [] };

describe("UsageTrackingProvider", () => {
  test("forwards every event unchanged", async () => {
    const inner = new ScriptedProvider([usageEvent(10, 2), completed()]);
    const tracked: Array<{ inputTokens: number; outputTokens: number }> = [];
    const wrapper = new UsageTrackingProvider(inner, (record) => tracked.push(record));
    const seen: ProviderEvent[] = [];
    for await (const event of wrapper.stream(request, new AbortController().signal)) {
      seen.push(event);
    }
    expect(seen).toEqual([usageEvent(10, 2), completed()]);
    expect(tracked).toEqual([{ inputTokens: 10, outputTokens: 2 }]);
  });

  test("a stream with multiple usage events records only the final one", async () => {
    const inner = new ScriptedProvider([
      usageEvent(100, 20),
      usageEvent(200, 40),
      completed(),
    ]);
    const tracked: Array<{ inputTokens: number; outputTokens: number }> = [];
    const wrapper = new UsageTrackingProvider(inner, (record) => tracked.push(record));
    for await (const _event of wrapper.stream(request, new AbortController().signal)) {
      // consume
    }
    expect(tracked).toEqual([{ inputTokens: 200, outputTokens: 40 }]);
  });

  test("no usage event means no record", async () => {
    const inner = new ScriptedProvider([completed()]);
    const tracked: Array<{ inputTokens: number; outputTokens: number }> = [];
    const wrapper = new UsageTrackingProvider(inner, (record) => tracked.push(record));
    for await (const _event of wrapper.stream(request, new AbortController().signal)) {
      // consume
    }
    expect(tracked).toEqual([]);
  });

  test("usage followed by a provider exception still records the usage", async () => {
    const usage = usageEvent(50, 5);
    const inner = new ScriptedProvider([usage, completed()]);
    inner.throwAt = 1;
    const tracked: Array<{ inputTokens: number; outputTokens: number }> = [];
    const wrapper = new UsageTrackingProvider(inner, (record) => tracked.push(record));
    await expect(async () => {
      for await (const _event of wrapper.stream(request, new AbortController().signal)) {
        // consume
      }
    }).rejects.toThrow("provider exploded");
    expect(tracked).toEqual([{ inputTokens: 50, outputTokens: 5 }]);
  });
});
