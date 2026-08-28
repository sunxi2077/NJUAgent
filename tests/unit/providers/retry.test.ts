import { describe, expect, test } from "vitest";

import { ProviderError, type ProviderEvent } from "../../../src/providers/provider.js";
import { withModelRetry } from "../../../src/providers/retry.js";

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

const policy = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 1000,
  jitterRatio: 0,
};

describe("withModelRetry", () => {
  test("retries two transient failures and yields the third successful stream", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const retries: number[] = [];
    const events = await collect(withModelRetry(
      () => {
        attempts += 1;
        return (async function* () {
          if (attempts < 3) {
            throw new ProviderError("temporary", { kind: "unavailable", retryable: true });
          }
          yield { type: "text_delta", text: "ok" } as const;
        })();
      },
      policy,
      new AbortController().signal,
      (event) => retries.push(event.attempt),
      async (delay) => { delays.push(delay); },
      () => 0.5,
    ));

    expect(attempts).toBe(3);
    expect(delays).toEqual([100, 200]);
    expect(retries).toEqual([2, 3]);
    expect(events).toEqual([{ type: "text_delta", text: "ok" }]);
  });

  test("does not retry a non-retryable provider error", async () => {
    let attempts = 0;
    const stream = withModelRetry(
      () => {
        attempts += 1;
        return (async function* () {
          throw new ProviderError("invalid api key", { kind: "invalid_request", retryable: false });
        })();
      },
      policy,
      new AbortController().signal,
      () => undefined,
      async () => undefined,
      () => 0.5,
    );

    await expect(collect(stream)).rejects.toThrow(/invalid api key/);
    expect(attempts).toBe(1);
  });

  test("never exceeds maxAttempts", async () => {
    let attempts = 0;
    const stream = withModelRetry(
      () => {
        attempts += 1;
        return (async function* () {
          throw new ProviderError("still down", { kind: "unavailable", retryable: true });
        })();
      },
      policy,
      new AbortController().signal,
      () => undefined,
      async () => undefined,
      () => 0.5,
    );

    await expect(collect(stream)).rejects.toThrow(/still down/);
    expect(attempts).toBe(3);
  });

  test("uses a larger Retry-After delay and stops immediately when aborted", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const delays: number[] = [];
    const stream = withModelRetry(
      () => {
        attempts += 1;
        return (async function* () {
          throw new ProviderError("limited", { kind: "rate_limit", retryable: true, retryAfterMs: 750 });
        })();
      },
      policy,
      controller.signal,
      () => controller.abort(),
      async (delay) => { delays.push(delay); },
      () => 0.5,
    );

    await expect(collect(stream)).rejects.toMatchObject({ name: "AbortError" });
    expect(attempts).toBe(1);
    expect(delays).toEqual([]);
  });
});
