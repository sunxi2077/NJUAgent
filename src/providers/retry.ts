import { ProviderError, type ProviderEvent } from "./provider.js";

export type RetryPolicy = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
};

export type RetryEvent = {
  attempt: number;
  delayMs: number;
  reason: string;
};

export type OpenProviderStream = () => AsyncIterable<ProviderEvent>;
export type RetryListener = (event: RetryEvent) => void;
export type Sleep = (delayMs: number, signal: AbortSignal) => Promise<void>;

function abortError(): DOMException {
  return new DOMException("Model request was cancelled", "AbortError");
}

export async function sleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw abortError();
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function* withModelRetry(
  openStream: OpenProviderStream,
  policy: RetryPolicy,
  signal: AbortSignal,
  onRetry: RetryListener,
  wait: Sleep = sleep,
  random: () => number = Math.random,
): AsyncIterable<ProviderEvent> {
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    if (signal.aborted) {
      throw abortError();
    }
    try {
      for await (const event of openStream()) {
        yield event;
      }
      return;
    } catch (error) {
      if (signal.aborted) {
        throw abortError();
      }
      if (
        !(error instanceof ProviderError) ||
        !error.retryable ||
        attempt >= policy.maxAttempts
      ) {
        throw error;
      }

      const exponential = Math.min(
        policy.maxDelayMs,
        policy.baseDelayMs * 2 ** (attempt - 1),
      );
      const jitter = exponential * policy.jitterRatio * (random() * 2 - 1);
      const delayMs = Math.ceil(Math.max(error.retryAfterMs ?? 0, exponential + jitter));
      onRetry({ attempt: attempt + 1, delayMs, reason: error.message });
      if (signal.aborted) {
        throw abortError();
      }
      await wait(delayMs, signal);
    }
  }
}
