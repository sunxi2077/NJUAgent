import Anthropic, {
  APIConnectionError,
  APIError,
  APIUserAbortError,
} from "@anthropic-ai/sdk";
import type {
  MessageCreateParamsStreaming,
  RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages/messages";

import type {
  AssistantBlock,
  AssistantMessage,
  Message,
} from "../agent/messages.js";
import {
  ProviderError,
  type ModelProvider,
  type ModelRequest,
  type ProviderEvent,
} from "./provider.js";

export interface AnthropicClientPort {
  create(
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<AsyncIterable<unknown>>;
}

export type AnthropicProviderOptions = {
  model: string;
  maxTokens: number;
  apiKey?: string;
  baseURL?: string;
  client?: AnthropicClientPort;
};

type PendingText = {
  type: "text";
  text: string;
};

type PendingTool = {
  type: "tool";
  id: string;
  name: string;
  initialInput: unknown;
  partialJson: string;
};

type PendingBlock = PendingText | PendingTool;

function mapMessages(messages: readonly Message[]) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content.map((block) => {
      if (block.type === "text") {
        return { type: "text" as const, text: block.text };
      }
      if (block.type === "tool_call") {
        return {
          type: "tool_use" as const,
          id: block.id,
          name: block.name,
          input: block.input,
        };
      }
      return {
        type: "tool_result" as const,
        tool_use_id: block.toolCallId,
        content: block.content,
        is_error: block.isError,
      };
    }),
  }));
}

function mapRequest(
  request: ModelRequest,
  model: string,
  maxTokens: number,
): Record<string, unknown> {
  return {
    model,
    max_tokens: maxTokens,
    stream: true,
    system: request.system,
    messages: mapMessages(request.messages),
    tools: request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: structuredClone(tool.inputSchema),
    })),
  };
}

function retryAfterMs(headers: Headers | undefined): number | undefined {
  const value = headers?.get("retry-after");
  if (value === null || value === undefined) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }
  const date = Date.parse(value);
  if (Number.isNaN(date)) {
    return undefined;
  }
  return Math.max(0, date - Date.now());
}

function mapError(error: unknown, signal: AbortSignal): Error {
  if (error instanceof ProviderError) {
    return error;
  }
  if (signal.aborted || error instanceof APIUserAbortError) {
    return new DOMException("Model request was cancelled", "AbortError");
  }
  if (error instanceof APIConnectionError) {
    return new ProviderError("Model service unavailable", {
      kind: "unavailable",
      retryable: true,
      cause: error,
    });
  }
  if (error instanceof APIError) {
    const status = error.status;
    const retryAfter = retryAfterMs(error.headers);
    if (status === 401 || status === 403) {
      return new ProviderError("Model authentication failed", {
        kind: "auth",
        retryable: false,
        cause: error,
      });
    }
    if (status === 429) {
      return new ProviderError("Model rate limit reached", {
        kind: "rate_limit",
        retryable: true,
        ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
        cause: error,
      });
    }
    if (status === 408 || status === 409 || (typeof status === "number" && status >= 500)) {
      return new ProviderError("Model service unavailable", {
        kind: "unavailable",
        retryable: true,
        ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
        cause: error,
      });
    }
    return new ProviderError("Model request rejected", {
      kind: "invalid_request",
      retryable: false,
      cause: error,
    });
  }
  return new ProviderError(
    error instanceof Error ? error.message : String(error),
    { kind: "protocol", retryable: false, cause: error },
  );
}

function assembleMessage(blocks: ReadonlyMap<number, PendingBlock>): AssistantMessage {
  const content: AssistantBlock[] = [];
  const ordered = [...blocks.entries()].sort(([left], [right]) => left - right);
  for (const [, block] of ordered) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
      continue;
    }
    let input = block.initialInput;
    if (block.partialJson.length > 0) {
      try {
        input = JSON.parse(block.partialJson) as unknown;
      } catch (error) {
        throw new ProviderError(`Malformed tool input JSON for ${block.name}`, {
          kind: "protocol",
          retryable: false,
          cause: error,
        });
      }
    }
    content.push({
      type: "tool_call",
      id: block.id,
      name: block.name,
      input,
    });
  }
  return { role: "assistant", content };
}

export class AnthropicProvider implements ModelProvider {
  readonly #client: AnthropicClientPort;

  constructor(private readonly options: AnthropicProviderOptions) {
    if (options.client !== undefined) {
      this.#client = options.client;
      return;
    }
    const client = new Anthropic({
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
      maxRetries: 0,
    });
    this.#client = {
      create: async (params, signal) => {
        return await client.messages.create(
          params as unknown as MessageCreateParamsStreaming,
          { signal },
        );
      },
    };
  }

  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    const blocks = new Map<number, PendingBlock>();
    let inputTokens = 0;
    let stopReason: string | undefined;
    let completed = false;

    try {
      const rawStream = await this.#client.create(
        mapRequest(request, this.options.model, this.options.maxTokens),
        signal,
      );
      for await (const unknownEvent of rawStream) {
        const event = unknownEvent as RawMessageStreamEvent;
        switch (event.type) {
          case "message_start": {
            const usage = event.message.usage;
            inputTokens = usage.input_tokens +
              (usage.cache_creation_input_tokens ?? 0) +
              (usage.cache_read_input_tokens ?? 0);
            break;
          }
          case "content_block_start": {
            if (event.content_block.type === "text") {
              blocks.set(event.index, { type: "text", text: event.content_block.text });
              if (event.content_block.text.length > 0) {
                yield { type: "text_delta", text: event.content_block.text };
              }
            } else if (event.content_block.type === "tool_use") {
              blocks.set(event.index, {
                type: "tool",
                id: event.content_block.id,
                name: event.content_block.name,
                initialInput: event.content_block.input,
                partialJson: "",
              });
            }
            break;
          }
          case "content_block_delta": {
            const block = blocks.get(event.index);
            if (event.delta.type === "text_delta" && block?.type === "text") {
              block.text += event.delta.text;
              yield { type: "text_delta", text: event.delta.text };
            } else if (event.delta.type === "input_json_delta" && block?.type === "tool") {
              block.partialJson += event.delta.partial_json;
            }
            break;
          }
          case "message_delta": {
            stopReason = event.delta.stop_reason ?? stopReason;
            yield {
              type: "usage",
              inputTokens: event.usage.input_tokens ?? inputTokens,
              outputTokens: event.usage.output_tokens,
            };
            break;
          }
          case "message_stop": {
            if (stopReason === undefined) {
              throw new ProviderError("Message stopped without a stop reason", {
                kind: "protocol",
                retryable: false,
              });
            }
            yield {
              type: "message_completed",
              message: assembleMessage(blocks),
              stopReason,
            };
            completed = true;
            break;
          }
          case "content_block_stop":
            break;
        }
      }
      if (!completed) {
        throw new ProviderError("Model stream ended unexpectedly", {
          kind: "protocol",
          retryable: false,
        });
      }
    } catch (error) {
      throw mapError(error, signal);
    }
  }
}
