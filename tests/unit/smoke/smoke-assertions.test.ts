import { describe, expect, test } from "vitest";

import type { Message } from "../../../src/agent/messages.js";
import { inspectSmokeHistory } from "../../smoke/smoke-assertions.js";

describe("inspectSmokeHistory", () => {
  test("finds assistant text and a successful read_file result", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "read it" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will read it." },
          { type: "tool_call", id: "c1", name: "read_file", input: { path: "hello.txt" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolCallId: "c1", content: "1: hello from smoke test", isError: false },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
    ];

    expect(inspectSmokeHistory(messages)).toEqual({
      hasAssistantText: true,
      hasSuccessfulRead: true,
    });
  });

  test("rejects an error tool result", () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "read_file", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolCallId: "c1", content: "failed", isError: true }] },
    ];
    expect(inspectSmokeHistory(messages).hasSuccessfulRead).toBe(false);
  });

  test("requires nonempty assistant text", () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "text", text: "   " }] },
    ];
    expect(inspectSmokeHistory(messages).hasAssistantText).toBe(false);
  });
});
