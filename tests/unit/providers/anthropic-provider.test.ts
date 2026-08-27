import { describe, expect, test } from "vitest";
import { APIConnectionError, APIError } from "@anthropic-ai/sdk";

import { AnthropicProvider, type AnthropicClientPort } from "../../../src/providers/anthropic-provider.js";
import type { ModelRequest, ProviderEvent } from "../../../src/providers/provider.js";

function messageStart(inputTokens = 12) {
  return {
    type: "message_start",
    message: {
      id: "msg-1",
      type: "message",
      role: "assistant",
      model: "deepseek-test",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: 0,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        cache_creation: null,
        server_tool_use: null,
        service_tier: null,
      },
    },
  };
}

function messageDelta(stopReason: "end_turn" | "tool_use", outputTokens = 4) {
  return {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: {
      input_tokens: null,
      output_tokens: outputTokens,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
    },
  };
}

class FixtureClient implements AnthropicClientPort {
  readonly requests: Record<string, unknown>[] = [];

  constructor(
    private readonly events: readonly unknown[],
    private readonly failure?: unknown,
  ) {}

  async create(params: Record<string, unknown>): Promise<AsyncIterable<unknown>> {
    this.requests.push(structuredClone(params));
    if (this.failure !== undefined) {
      throw this.failure;
    }
    const events = this.events;
    return (async function* () {
      for (const event of events) {
        yield event;
      }
    })();
  }
}

async function collect(provider: AnthropicProvider, request: ModelRequest): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream(request, new AbortController().signal)) {
    events.push(event);
  }
  return events;
}

function request(): ModelRequest {
  return {
    system: "Be precise.",
    messages: [
      { role: "user", content: [{ type: "text", text: "read it" }] },
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "old-call", name: "read_file", input: { path: "a.ts" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", toolCallId: "old-call", content: "source", isError: false }],
      },
    ],
    tools: [
      {
        name: "read_file",
        description: "Read a file.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ],
  };
}

describe("AnthropicProvider", () => {
  test("maps internal messages and a streamed text response without leaking SDK shapes", async () => {
    const client = new FixtureClient([
      messageStart(),
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "", citations: null },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hello" },
      },
      { type: "content_block_stop", index: 0 },
      messageDelta("end_turn"),
      { type: "message_stop" },
    ]);
    const provider = new AnthropicProvider({
      model: "deepseek-test",
      maxTokens: 2048,
      client,
    });

    const events = await collect(provider, request());

    expect(client.requests[0]).toEqual({
      model: "deepseek-test",
      max_tokens: 2048,
      stream: true,
      system: "Be precise.",
      messages: [
        { role: "user", content: [{ type: "text", text: "read it" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "old-call", name: "read_file", input: { path: "a.ts" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "old-call", content: "source", is_error: false }],
        },
      ],
      tools: [
        {
          name: "read_file",
          description: "Read a file.",
          input_schema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
    });
    expect(events).toEqual([
      { type: "text_delta", text: "hello" },
      { type: "usage", inputTokens: 12, outputTokens: 4 },
      {
        type: "message_completed",
        message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
        stopReason: "end_turn",
      },
    ]);
  });

  test("assembles streamed partial JSON into an internal tool call", async () => {
    const client = new FixtureClient([
      messageStart(20),
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "call-1", name: "read_file", input: {} },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{\"path\":" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "\"a.ts\"}" },
      },
      { type: "content_block_stop", index: 0 },
      messageDelta("tool_use", 8),
      { type: "message_stop" },
    ]);
    const events = await collect(
      new AnthropicProvider({ model: "deepseek-test", maxTokens: 2048, client }),
      request(),
    );

    expect(events.at(-1)).toEqual({
      type: "message_completed",
      message: {
        role: "assistant",
        content: [
          { type: "tool_call", id: "call-1", name: "read_file", input: { path: "a.ts" } },
        ],
      },
      stopReason: "tool_use",
    });
  });

  test("rejects malformed tool JSON as a non-retryable protocol error", async () => {
    const client = new FixtureClient([
      messageStart(),
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "call-1", name: "read_file", input: {} },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{" },
      },
      messageDelta("tool_use"),
      { type: "message_stop" },
    ]);
    const provider = new AnthropicProvider({ model: "deepseek-test", maxTokens: 2048, client });

    await expect(collect(provider, request())).rejects.toMatchObject({
      name: "ProviderError",
      retryable: false,
    });
  });

  test.each([
    [APIError.generate(401, {}, "unauthorized", new Headers()), false],
    [APIError.generate(429, {}, "limited", new Headers({ "retry-after": "2" })), true],
    [APIError.generate(500, {}, "server", new Headers()), true],
    [new APIConnectionError({ message: "offline", cause: new Error("network") }), true],
  ])("maps SDK failure %# to retryable=%s", async (failure, retryable) => {
    const provider = new AnthropicProvider({
      model: "deepseek-test",
      maxTokens: 2048,
      client: new FixtureClient([], failure),
    });

    await expect(collect(provider, request())).rejects.toMatchObject({
      name: "ProviderError",
      retryable,
    });
  });
});
