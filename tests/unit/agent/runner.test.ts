import { describe, expect, test, vi } from "vitest";

import type { AgentEvent } from "../../../src/agent/events.js";
import { ConversationHistory } from "../../../src/agent/history.js";
import { AgentRunner, type ContextManagerPort, type ToolExecutorPort } from "../../../src/agent/runner.js";
import type { StopGate } from "../../../src/agent/stop-gate.js";
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

  test("returns model_failed and rolls back the user turn when completion is missing", async () => {
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
    expect(history.snapshot()).toEqual([]);
  });

  test("returns model_failed and rolls back the user turn when the provider throws", async () => {
    const provider = new ScriptedProvider([]);
    const history = ConversationHistory.from([
      { role: "user", content: [{ type: "text", text: "previous question" }] },
      textAssistant("previous answer"),
    ]);
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
      { role: "user", content: [{ type: "text", text: "previous question" }] },
      textAssistant("previous answer"),
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

  test("returns context_limit without calling the provider when the context manager stops", async () => {
    const provider = new ScriptedProvider([[complete(textAssistant("unused"))]]);
    const history = new ConversationHistory();
    const runner = new AgentRunner({
      provider,
      history,
      tools: emptyTools,
      maxSteps: 4,
      systemPrompt: "Be precise.",
      contextManager: {
        prepare: async (input) => ({
          action: "stop",
          systemPrompt: input.baseSystemPrompt,
          messages: input.messages,
          estimatedTokens: 999,
          compactedToolResults: 0,
        }),
        recordUsage: () => undefined,
      },
    });

    const result = await runner.run("large task", new AbortController().signal);

    expect(result).toMatchObject({ status: "context_limit", steps: 0, toolCalls: 0 });
    expect(provider.requests).toHaveLength(0);
  });

  test("awaits the context manager and forwards prepared system prompt and messages", async () => {
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", text: "done" },
        { type: "usage", inputTokens: 10, outputTokens: 2 },
        complete(textAssistant("done")),
      ],
    ]);
    const history = new ConversationHistory();
    const prepare = vi.fn<ContextManagerPort["prepare"]>(async (input) => ({
      action: "continue",
      systemPrompt: `custom ${input.baseSystemPrompt}`,
      messages: input.messages,
      estimatedTokens: 42,
      compactedToolResults: 0,
    }));
    const recordUsage = vi.fn();
    const runner = new AgentRunner({
      provider,
      history,
      tools: emptyTools,
      maxSteps: 4,
      systemPrompt: "Be precise.",
      contextManager: { prepare, recordUsage },
    });

    const result = await runner.run("task", new AbortController().signal);

    expect(result.status).toBe("completed");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(provider.requests[0]?.system).toBe("custom Be precise.");
    expect(recordUsage).toHaveBeenCalled();
  });

  test("a failing context manager returns internal_failed without calling the provider", async () => {
    const provider = new ScriptedProvider([[complete(textAssistant("unused"))]]);
    const history = new ConversationHistory();
    const events: AgentEvent[] = [];
    const runner = new AgentRunner({
      provider,
      history,
      tools: emptyTools,
      maxSteps: 4,
      systemPrompt: "Be precise.",
      contextManager: {
        prepare: async () => {
          throw new Error("context manager exploded");
        },
        recordUsage: () => undefined,
      },
      onEvent: (event) => events.push(event),
    });

    const result = await runner.run("task", new AbortController().signal);

    expect(result).toMatchObject({ status: "internal_failed", steps: 0, toolCalls: 0 });
    expect(provider.requests).toHaveLength(0);
    expect(events.some((event) => event.type === "context_warning")).toBe(true);
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
          throw new ProviderError("temporary outage", { kind: "unavailable", retryable: true });
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

  describe("stopGate", () => {
    function runnerWithGate(gate: StopGate) {
      const provider = new ScriptedProvider([
        [
          { type: "text_delta", text: "done" },
          complete(textAssistant("done")),
        ],
        [
          { type: "text_delta", text: "again" },
          complete(textAssistant("again")),
        ],
      ]);
      const history = new ConversationHistory();
      const runner = new AgentRunner({
        provider,
        history,
        tools: emptyTools,
        maxSteps: 4,
        systemPrompt: "Be precise.",
        stopGate: gate,
      });
      return { provider, history, runner };
    }

    test("without a gate the completed status is unchanged", async () => {
      const provider = new ScriptedProvider([
        [complete(textAssistant("done"))],
      ]);
      const runner = new AgentRunner({
        provider,
        history: new ConversationHistory(),
        tools: emptyTools,
        maxSteps: 4,
        systemPrompt: "p",
      });
      const result = await runner.run("task", new AbortController().signal);
      expect(result.status).toBe("completed");
    });

    test("a plain stop keeps completed", async () => {
      const gate: StopGate = {
        async evaluate() {
          return { action: "stop" };
        },
      };
      const { runner } = runnerWithGate(gate);
      const result = await runner.run("task", new AbortController().signal);
      expect(result.status).toBe("completed");
    });

    test("continue appends feedback and returns to the same loop", async () => {
      let calls = 0;
      const gate: StopGate = {
        beginRun() {
          calls += 1;
        },
        async evaluate() {
          if (calls === 1) {
            calls += 1;
            return { action: "continue", feedback: "<goal_evaluator_feedback>keep going</goal_evaluator_feedback>" };
          }
          return { action: "stop" };
        },
      };
      const { runner, provider, history } = runnerWithGate(gate);
      const result = await runner.run("task", new AbortController().signal);
      expect(result.status).toBe("completed");
      expect(provider.requests).toHaveLength(2);
      const messages = history.snapshot();
      expect(messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
      expect(JSON.stringify(messages[2])).toContain("goal_evaluator_feedback");
    });

    test("verified and incomplete outcomes map to the goal result statuses", async () => {
      const verification = { satisfied: true, reason: "r", missingEvidence: [] };
      const gate: StopGate = {
        async evaluate() {
          return { action: "stop", outcome: "verified" as const, verification };
        },
      };
      const { runner } = runnerWithGate(gate);
      const result = await runner.run("task", new AbortController().signal);
      expect(result).toMatchObject({ status: "goal_verified", verification });
    });

    test("fail maps to internal_failed", async () => {
      const gate: StopGate = {
        async evaluate() {
          return { action: "fail", message: "Goal evaluation failed; the goal remains active." };
        },
      };
      const { runner } = runnerWithGate(gate);
      const result = await runner.run("task", new AbortController().signal);
      expect(result).toMatchObject({ status: "internal_failed" });
    });

    test("cancellation during evaluation maps to cancelled", async () => {
      const controller = new AbortController();
      const gate: StopGate = {
        async evaluate() {
          controller.abort();
          return { action: "continue", feedback: "x" };
        },
      };
      const provider = new ScriptedProvider([
        [complete(textAssistant("done"))],
      ]);
      const runner = new AgentRunner({
        provider,
        history: new ConversationHistory(),
        tools: emptyTools,
        maxSteps: 4,
        systemPrompt: "p",
        stopGate: gate,
      });
      const result = await runner.run("task", controller.signal);
      expect(result.status).toBe("cancelled");
    });

    test("maxSteps still bounds the loop when the gate keeps continuing", async () => {
      const gate: StopGate = {
        async evaluate() {
          return { action: "continue", feedback: "keep going" };
        },
      };
      const provider = new ScriptedProvider(
        Array.from({ length: 8 }, () => [complete(textAssistant("again"))]),
      );
      const runner = new AgentRunner({
        provider,
        history: new ConversationHistory(),
        tools: emptyTools,
        maxSteps: 3,
        systemPrompt: "p",
        stopGate: gate,
      });
      const result = await runner.run("task", new AbortController().signal);
      expect(result.status).toBe("limit_reached");
      expect(provider.requests).toHaveLength(3);
    });
  });
});
