import { describe, expect, test } from "vitest";

import { ContextPolicy } from "../../../src/agent/context-policy.js";
import type { Message, ToolCallBlock, ToolResultBlock } from "../../../src/agent/messages.js";
import type { ModelToolDefinition } from "../../../src/providers/provider.js";

function policy(overrides: {
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  safetyTokens?: number;
  compactAtRatio?: number;
  recentMessages?: number;
  charsPerToken?: number;
} = {}) {
  return new ContextPolicy({
    contextWindowTokens: overrides.contextWindowTokens ?? 48_000,
    maxOutputTokens: overrides.maxOutputTokens ?? 4_096,
    safetyTokens: overrides.safetyTokens ?? 2_048,
    compactAtRatio: overrides.compactAtRatio ?? 0.7,
    recentMessages: overrides.recentMessages ?? 12,
    charsPerToken: overrides.charsPerToken ?? 4,
  });
}

const textUser = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
});

const textAssistant = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

function toolCallMessage(calls: Array<Pick<ToolCallBlock, "id" | "name">>): Message {
  return {
    role: "assistant",
    content: calls.map((call) => ({ type: "tool_call" as const, id: call.id, name: call.name, input: {} })),
  };
}

function toolResultMessage(results: Array<Pick<ToolResultBlock, "toolCallId" | "content" | "isError">>): Message {
  return {
    role: "user",
    content: results.map((result) => ({ type: "tool_result" as const, ...result })),
  };
}

const tools: readonly ModelToolDefinition[] = [
  { name: "read_file", description: "Read a file", inputSchema: { type: "object" } },
];

describe("ContextPolicy.estimate", () => {
  test("counts system prompt, tools, and messages with charsPerToken 1", () => {
    const p = policy({ charsPerToken: 1 });
    const base = p.estimate({ systemPrompt: "sys", messages: [textUser("hi")], tools });
    expect(base).toBe(
      JSON.stringify({ system: "sys", tools, messages: [textUser("hi")] }).length,
    );
  });

  test("increasing any component increases the estimate", () => {
    const p = policy({ charsPerToken: 1 });
    const base = p.estimate({ systemPrompt: "x", messages: [], tools: [] });
    expect(p.estimate({ systemPrompt: "xxxx", messages: [], tools: [] })).toBeGreaterThan(base);
    expect(p.estimate({ systemPrompt: "x", messages: [textUser("more")], tools: [] })).toBeGreaterThan(base);
    expect(
      p.estimate({
        systemPrompt: "x",
        messages: [],
        tools: [{ name: "a", description: "long description here", inputSchema: {} }],
      }),
    ).toBeGreaterThan(base);
  });

  test("lastInputTokens acts as a floor", () => {
    const p = policy({ charsPerToken: 1 });
    expect(
      p.estimate({ systemPrompt: "x", messages: [], tools: [], lastInputTokens: 999 }),
    ).toBeGreaterThanOrEqual(999);
  });

  test("threshold and hard input tokens follow the budget", () => {
    const p = policy();
    expect(p.thresholdTokens()).toBe(Math.floor(48_000 * 0.7));
    expect(p.hardInputTokens()).toBe(48_000 - 4_096 - 2_048);
  });
});

describe("ContextPolicy.prepareDeterministic", () => {
  test("shrinks only old tool results and leaves the source unchanged", () => {
    // Small window so the estimate crosses the threshold and triggers shrinking.
    const p = policy({
      recentMessages: 12,
      contextWindowTokens: 500,
      maxOutputTokens: 50,
      safetyTokens: 50,
      compactAtRatio: 1,
      charsPerToken: 1,
    });
    const oldResult = "x".repeat(5_000);
    // The tool batch sits at the very front so it falls inside the compacted
    // prefix (index < length - 12).
    const messages: Message[] = [
      toolCallMessage([{ id: "c1", name: "read_file" }]),
      toolResultMessage([{ toolCallId: "c1", content: oldResult, isError: false }]),
      textAssistant("done"),
      textUser("pad1"),
      textAssistant("a1"),
      textUser("pad2"),
      textAssistant("a2"),
      textUser("pad3"),
      textAssistant("a3"),
      textUser("pad4"),
      textAssistant("a4"),
      textUser("pad5"),
      textAssistant("a5"),
      textUser("pad6"),
    ];
    const snapshot = structuredClone(messages);

    const view = p.prepareDeterministic({ systemPrompt: "s", messages, tools });

    expect(view.compactedToolResults).toBe(1);
    const oldResultMessage = view.messages[1] as { content: ToolResultBlock[] };
    expect(oldResultMessage.content[0]?.content).toMatch(
      /^\[older tool output omitted: tool_call_id=c1, original_bytes=5000, is_error=false\]$/u,
    );
    expect(messages).toEqual(snapshot);
  });

  test("keeps recent results intact", () => {
    const p = policy({ recentMessages: 2 });
    const messages: Message[] = [
      toolCallMessage([{ id: "c1", name: "read_file" }]),
      toolResultMessage([{ toolCallId: "c1", content: "old".repeat(100), isError: false }]),
      textUser("recent"),
      textAssistant("ok"),
    ];
    const view = p.prepareDeterministic({ systemPrompt: "s", messages, tools });
    expect(view.messages[2]).toEqual(textUser("recent"));
  });
});

describe("ContextPolicy.selectCompactionCut", () => {
  test("moves the cut backward to keep tool-call/result pairs intact", () => {
    const p = policy({ recentMessages: 2 });
    const messages: Message[] = [
      textUser("t1"),
      toolCallMessage([{ id: "c1", name: "read_file" }]),
      toolResultMessage([{ toolCallId: "c1", content: "r1", isError: false }]),
      textUser("t2"),
      toolCallMessage([{ id: "c2", name: "read_file" }]),
      toolResultMessage([{ toolCallId: "c2", content: "r2", isError: false }]),
      textUser("t3"),
    ];
    // naive cut = 7 - 2 = 5 lands on the c2 tool-result batch; the cut must
    // move backward to 4 so the c2 tool-call/result pair stays intact.
    const cut = p.selectCompactionCut(messages, 0);
    expect(cut).toBe(4);
    const kept = messages.slice(cut!);
    expect(kept[0]).toEqual(toolCallMessage([{ id: "c2", name: "read_file" }]));
    expect(kept[1]).toEqual(toolResultMessage([{ toolCallId: "c2", content: "r2", isError: false }]));
    expect(kept[2]).toEqual(textUser("t3"));
  });

  test("returns null when there is no newly compactable prefix", () => {
    const p = policy({ recentMessages: 12 });
    const messages: Message[] = [
      textUser("t1"),
      textAssistant("a1"),
      textUser("t2"),
      textAssistant("a2"),
    ];
    expect(p.selectCompactionCut(messages, 0)).toBeNull();
  });

  test("respects an existing covered prefix", () => {
    const p = policy({ recentMessages: 2 });
    const messages: Message[] = [
      textUser("t1"),
      textUser("t2"),
      textUser("t3"),
      textAssistant("a3"),
    ];
    expect(p.selectCompactionCut(messages, 3)).toBeNull();
  });
});
