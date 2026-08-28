import type { AssistantMessage, Message } from "../agent/messages.js";

export type ModelToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ModelRequest = {
  system: string;
  messages: readonly Message[];
  tools: readonly ModelToolDefinition[];
};

export type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | {
      type: "message_completed";
      message: AssistantMessage;
      stopReason: string;
    };

export interface ModelProvider {
  stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent>;
}

export type ProviderErrorKind =
  | "auth"
  | "rate_limit"
  | "unavailable"
  | "protocol"
  | "invalid_request";

export type ProviderErrorOptions = {
  kind: ProviderErrorKind;
  retryable: boolean;
  retryAfterMs?: number;
  cause?: unknown;
};

export class ProviderError extends Error {
  override readonly name = "ProviderError";
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, options: ProviderErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.kind = options.kind;
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** Stable application error codes for each provider failure kind. */
export function providerKindToAppCode(kind: ProviderErrorKind): string {
  switch (kind) {
    case "auth":
      return "PROVIDER_AUTH";
    case "rate_limit":
      return "PROVIDER_RATE_LIMIT";
    case "unavailable":
      return "PROVIDER_UNAVAILABLE";
    case "protocol":
    case "invalid_request":
      return "PROVIDER_PROTOCOL";
  }
}
