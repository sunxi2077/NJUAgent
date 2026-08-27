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
