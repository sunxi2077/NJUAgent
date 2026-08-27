import { describe, expect, test } from "vitest";

import {
  assertValidHistory,
  type Message,
} from "../../../src/agent/messages.js";

describe("assertValidHistory", () => {
  test("accepts a text turn followed by an ordered tool call and result batch", () => {
    const history: Message[] = [
      { role: "user", content: [{ type: "text", text: "inspect files" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will inspect them." },
          { type: "tool_call", id: "call-1", name: "read_file", input: { path: "a.ts" } },
          { type: "tool_call", id: "call-2", name: "read_file", input: { path: "b.ts" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolCallId: "call-1", content: "a", isError: false },
          { type: "tool_result", toolCallId: "call-2", content: "b", isError: false },
        ],
      },
    ];

    expect(() => assertValidHistory(history)).not.toThrow();
  });

  test("rejects a tool result whose id was not requested by the preceding assistant message", () => {
    const history: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "call-1",
            name: "read_file",
            input: { path: "src/index.ts" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolCallId: "call-2",
            content: "file contents",
            isError: false,
          },
        ],
      },
    ];

    expect(() => assertValidHistory(history)).toThrow(/call-2/);
  });

  test("rejects duplicate tool-call ids", () => {
    const history: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "same", name: "read_file", input: {} },
          { type: "tool_call", id: "same", name: "read_file", input: {} },
        ],
      },
    ];

    expect(() => assertValidHistory(history)).toThrow(/duplicate.*same/i);
  });

  test("rejects a tool batch with a missing result", () => {
    const history: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "call-1", name: "read_file", input: {} },
          { type: "tool_call", id: "call-2", name: "read_file", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolCallId: "call-1", content: "a", isError: false },
        ],
      },
    ];

    expect(() => assertValidHistory(history)).toThrow(/call-2/);
  });

  test("rejects tool results that are not in call order", () => {
    const history: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "call-1", name: "read_file", input: {} },
          { type: "tool_call", id: "call-2", name: "read_file", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolCallId: "call-2", content: "b", isError: false },
          { type: "tool_result", toolCallId: "call-1", content: "a", isError: false },
        ],
      },
    ];

    expect(() => assertValidHistory(history)).toThrow(/order.*call-2/i);
  });
});
