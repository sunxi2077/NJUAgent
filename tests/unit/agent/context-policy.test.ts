import { describe, expect, test } from "vitest";

import { ContextPolicy } from "../../../src/agent/context-policy.js";
import type { Message } from "../../../src/agent/messages.js";

function toolBatch(id: string, result: string): Message[] {
  return [
    {
      role: "assistant",
      content: [{ type: "tool_call", id, name: "read_file", input: { path: `${id}.txt` } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", toolCallId: id, content: result, isError: false }],
    },
  ];
}

describe("ContextPolicy", () => {
  test("compacts only old tool results while preserving ids, calls, and recent messages", () => {
    const oldOutput = "old-output-".repeat(80);
    const recentOutput = "recent-output-".repeat(20);
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "fix the project" }] },
      ...toolBatch("old-call", oldOutput),
      ...toolBatch("recent-call", recentOutput),
    ];
    const original = structuredClone(messages);
    const policy = new ContextPolicy({
      maxEstimatedTokens: 250,
      compactAtRatio: 0.5,
      recentMessages: 2,
      charsPerToken: 4,
    });

    const decision = policy.prepare(messages);

    expect(decision.action).toBe("compacted");
    expect(decision.messages[1]).toEqual(original[1]);
    expect(decision.messages[2]).toMatchObject({
      role: "user",
      content: [
        {
          type: "tool_result",
          toolCallId: "old-call",
          isError: false,
        },
      ],
    });
    expect(JSON.stringify(decision.messages[2])).toContain("older tool output omitted");
    expect(decision.messages.slice(-2)).toEqual(original.slice(-2));
    expect(messages).toEqual(original);
  });

  test("stops when non-tool conversation text remains over the hard limit", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "x".repeat(2000) }] },
    ];
    const policy = new ContextPolicy({
      maxEstimatedTokens: 100,
      compactAtRatio: 0.8,
      recentMessages: 2,
      charsPerToken: 4,
    });

    const decision = policy.prepare(messages);

    expect(decision).toMatchObject({ action: "stop", compactedToolResults: 0 });
  });

  test("continues without cloning or changing messages below the compaction threshold", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "small" }] },
    ];
    const policy = new ContextPolicy({
      maxEstimatedTokens: 1000,
      compactAtRatio: 0.8,
      recentMessages: 2,
      charsPerToken: 4,
    });

    const decision = policy.prepare(messages);

    expect(decision.action).toBe("continue");
    expect(decision.messages).toBe(messages);
  });
});
