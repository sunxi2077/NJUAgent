import { describe, expect, test } from "vitest";

import type { AgentEvent } from "../../../src/agent/events.js";
import { ConversationHistory } from "../../../src/agent/history.js";
import { AgentRunner, type ToolExecutorPort } from "../../../src/agent/runner.js";
import type {
  ModelProvider,
  ModelRequest,
  ProviderEvent,
} from "../../../src/providers/provider.js";
import type { AssistantMessage } from "../../../src/agent/messages.js";

function textAssistant(text: string): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function complete(message: AssistantMessage): ProviderEvent {
  return { type: "message_completed", message, stopReason: "end_turn" };
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
});
