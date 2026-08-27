import { describe, expect, test } from "vitest";

import type { AgentEvent } from "../../../src/agent/events.js";
import { ConversationHistory } from "../../../src/agent/history.js";
import { AgentRunner, type ToolExecutorPort } from "../../../src/agent/runner.js";
import type {
  ModelProvider,
  ModelRequest,
  ProviderEvent,
} from "../../../src/providers/provider.js";
import { ProviderError } from "../../../src/providers/provider.js";
import type { AssistantMessage } from "../../../src/agent/messages.js";

function textAssistant(text: string): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function complete(message: AssistantMessage): ProviderEvent {
  return { type: "message_completed", message, stopReason: "end_turn" };
}

function toolAssistant(
  calls: readonly { id: string; name: string; input: unknown }[],
): AssistantMessage {
  return {
    role: "assistant",
    content: calls.map((call) => ({ type: "tool_call" as const, ...call })),
  };
}

class ScriptedProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly scripts: readonly (readonly ProviderEvent[])[]) {}

  async *stream(request: ModelRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(structuredClone(request));
    const script = this.scripts[this.requests.length - 1];
    if (script === undefined) {
      throw new Error("No scripted response");
    }
    for (const event of script) {
      yield event;
    }
  }
}

const emptyTools: ToolExecutorPort = {
  definitions: () => [],
  execute: async () => {
    throw new Error("No tool should be executed in a text-only test");
  },
};

describe("AgentRunner", () => {
  test("completes after a final assistant message and preserves the completed history", async () => {
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", text: "done" },
        { type: "usage", inputTokens: 10, outputTokens: 2 },
        complete(textAssistant("done")),
      ],
    ]);
    const history = new ConversationHistory();
    const events: AgentEvent[] = [];
    const runner = new AgentRunner({
      provider,
      history,
      tools: emptyTools,
      maxSteps: 4,
      systemPrompt: "Be precise.",
      onEvent: (event) => events.push(event),
    });

    const result = await runner.run("fix it", new AbortController().signal);

    expect(result).toMatchObject({ status: "completed", steps: 1, toolCalls: 0 });
    expect(history.snapshot()).toEqual([
      { role: "user", content: [{ type: "text", text: "fix it" }] },
      textAssistant("done"),
    ]);
    expect(provider.requests[0]).toMatchObject({
      system: "Be precise.",
      messages: [{ role: "user", content: [{ type: "text", text: "fix it" }] }],
      tools: [],
    });
    expect(events.map((event) => event.type)).toEqual([
      "model_started",
      "text_delta",
      "usage",
      "model_completed",
      "run_finished",
    ]);
  });

  test("returns model_failed and does not append a partial assistant message when completion is missing", async () => {
    const provider = new ScriptedProvider([[{ type: "text_delta", text: "partial" }]]);
    const history = new ConversationHistory();
    const runner = new AgentRunner({
      provider,
      history,
      tools: emptyTools,
      maxSteps: 4,
      systemPrompt: "Be precise.",
    });

    const result = await runner.run("fix it", new AbortController().signal);

    expect(result).toMatchObject({ status: "model_failed", steps: 1, toolCalls: 0 });
    expect(history.snapshot()).toEqual([
      { role: "user", content: [{ type: "text", text: "fix it" }] },
    ]);
  });

  test("does not call the provider when already cancelled", async () => {
    const provider = new ScriptedProvider([[complete(textAssistant("unused"))]]);
    const history = new ConversationHistory();
    const controller = new AbortController();
    controller.abort();
    const runner = new AgentRunner({
      provider,
      history,
      tools: emptyTools,
      maxSteps: 4,
      systemPrompt: "Be precise.",
    });

    const result = await runner.run("fix it", controller.signal);

    expect(result).toMatchObject({ status: "cancelled", steps: 0, toolCalls: 0 });
    expect(provider.requests).toHaveLength(0);
    expect(history.snapshot()).toEqual([
      { role: "user", content: [{ type: "text", text: "fix it" }] },
    ]);
  });

  test("executes tool calls and sends their matching results in the next model request", async () => {
    const callMessage = toolAssistant([
      { id: "read-1", name: "read_file", input: { path: "src/index.ts" } },
    ]);
    const provider = new ScriptedProvider([
      [complete(callMessage)],
      [{ type: "text_delta", text: "fixed" }, complete(textAssistant("fixed"))],
    ]);
    const executed: string[] = [];
    const tools: ToolExecutorPort = {
      definitions: () => [{ name: "read_file", description: "Read", inputSchema: {} }],
      execute: async (call) => {
        executed.push(call.id);
        return {
          type: "tool_result",
          toolCallId: call.id,
          content: "source text",
          isError: false,
        };
      },
    };
    const history = new ConversationHistory();
    const runner = new AgentRunner({
      provider,
      history,
      tools,
      maxSteps: 4,
      systemPrompt: "Be precise.",
    });

    const result = await runner.run("fix it", new AbortController().signal);

    expect(result).toMatchObject({ status: "completed", steps: 2, toolCalls: 1 });
    expect(executed).toEqual(["read-1"]);
    expect(provider.requests[1]?.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "fix it" }] },
      callMessage,
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolCallId: "read-1",
            content: "source text",
            isError: false,
          },
        ],
      },
    ]);
  });

  test("preserves ordered success and failure results for a multi-tool batch", async () => {
    const calls = toolAssistant([
      { id: "first", name: "read_file", input: { path: "missing.ts" } },
      { id: "second", name: "read_file", input: { path: "ok.ts" } },
    ]);
    const provider = new ScriptedProvider([
      [complete(calls)],
      [complete(textAssistant("recovered"))],
    ]);
    const tools: ToolExecutorPort = {
      definitions: () => [],
      execute: async (call) => ({
        type: "tool_result",
        toolCallId: call.id,
        content: call.id === "first" ? "not found" : "ok",
        isError: call.id === "first",
      }),
    };
    const history = new ConversationHistory();
    const runner = new AgentRunner({
      provider,
      history,
      tools,
      maxSteps: 4,
      systemPrompt: "Be precise.",
    });

    const result = await runner.run("inspect", new AbortController().signal);

    expect(result).toMatchObject({ status: "completed", steps: 2, toolCalls: 2 });
    expect(history.snapshot()[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", toolCallId: "first", content: "not found", isError: true },
        { type: "tool_result", toolCallId: "second", content: "ok", isError: false },
      ],
    });
  });

  test("returns limit_reached after recording the final allowed step and its tool result", async () => {
    const provider = new ScriptedProvider([
      [complete(toolAssistant([{ id: "only", name: "echo", input: {} }]))],
    ]);
    const tools: ToolExecutorPort = {
      definitions: () => [],
      execute: async (call) => ({
        type: "tool_result",
        toolCallId: call.id,
        content: "ok",
        isError: false,
      }),
    };
    const history = new ConversationHistory();
    const runner = new AgentRunner({
      provider,
      history,
      tools,
      maxSteps: 1,
      systemPrompt: "Be precise.",
    });

    const result = await runner.run("loop", new AbortController().signal);

    expect(result).toMatchObject({ status: "limit_reached", steps: 1, toolCalls: 1 });
    expect(history.snapshot()).toHaveLength(3);
  });

  test("adds cancelled results for unexecuted calls when cancellation happens mid-batch", async () => {
    const controller = new AbortController();
    const provider = new ScriptedProvider([
      [
        complete(toolAssistant([
          { id: "first", name: "echo", input: {} },
          { id: "second", name: "echo", input: {} },
        ])),
      ],
    ]);
    const executed: string[] = [];
    const tools: ToolExecutorPort = {
      definitions: () => [],
      execute: async (call) => {
        executed.push(call.id);
        controller.abort();
        return {
          type: "tool_result",
          toolCallId: call.id,
          content: "cancelled while running",
          isError: true,
        };
      },
    };
    const history = new ConversationHistory();
    const runner = new AgentRunner({
      provider,
      history,
      tools,
      maxSteps: 4,
      systemPrompt: "Be precise.",
    });

    const result = await runner.run("cancel", controller.signal);

    expect(result).toMatchObject({ status: "cancelled", steps: 1, toolCalls: 2 });
    expect(executed).toEqual(["first"]);
    expect(history.snapshot()[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          toolCallId: "first",
          content: "cancelled while running",
          isError: true,
        },
        {
          type: "tool_result",
          toolCallId: "second",
          content: "Tool execution was cancelled",
          isError: true,
        },
      ],
    });
  });

  test("returns context_limit without calling the provider when context policy stops", async () => {
    const provider = new ScriptedProvider([[complete(textAssistant("unused"))]]);
    const history = new ConversationHistory();
    const runner = new AgentRunner({
      provider,
      history,
      tools: emptyTools,
      maxSteps: 4,
      systemPrompt: "Be precise.",
      contextPolicy: {
        prepare: (messages) => ({
          action: "stop",
          messages,
          estimatedTokens: 999,
          compactedToolResults: 0,
        }),
      },
    });

    const result = await runner.run("large task", new AbortController().signal);

    expect(result).toMatchObject({ status: "context_limit", steps: 0, toolCalls: 0 });
    expect(provider.requests).toHaveLength(0);
  });

  test("emits a tool_started event with a compact input summary", async () => {
    const provider = new ScriptedProvider([
      [
        complete(toolAssistant([
          { id: "read-1", name: "read_file", input: { path: "src/a.ts" } },
        ])),
      ],
      [complete(textAssistant("done"))],
    ]);
    const tools: ToolExecutorPort = {
      definitions: () => [],
      execute: async (call) => ({
        type: "tool_result",
        toolCallId: call.id,
        content: "ok",
        isError: false,
      }),
    };
    const events: AgentEvent[] = [];
    const runner = new AgentRunner({
      provider,
      history: new ConversationHistory(),
      tools,
      maxSteps: 4,
      systemPrompt: "Be precise.",
      onEvent: (event) => events.push(event),
    });

    await runner.run("read", new AbortController().signal);

    const started = events.find(
      (event): event is Extract<AgentEvent, { type: "tool_started" }> =>
        event.type === "tool_started",
    );
    expect(started).toMatchObject({
      id: "read-1",
      name: "read_file",
      summary: '{"path":"src/a.ts"}',
    });
  });

  test("retries transient provider failures and emits retry events", async () => {
    let attempts = 0;
    const provider: ModelProvider = {
      async *stream() {
        attempts += 1;
        if (attempts < 3) {
          throw new ProviderError("temporary outage", { retryable: true });
        }
        yield complete(textAssistant("recovered"));
      },
    };
    const events: AgentEvent[] = [];
    const runner = new AgentRunner({
      provider,
      history: new ConversationHistory(),
      tools: emptyTools,
      maxSteps: 4,
      systemPrompt: "Be precise.",
      retryPolicy: {
        maxAttempts: 3,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitterRatio: 0,
      },
      onEvent: (event) => events.push(event),
    });

    const result = await runner.run("retry", new AbortController().signal);

    expect(result.status).toBe("completed");
    expect(attempts).toBe(3);
    expect(events.filter((event) => event.type === "retrying")).toHaveLength(2);
  });
});
