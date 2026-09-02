import { describe, expect, test } from "vitest";

import {
  findToolActivity,
  makeToolPreview,
} from "../../../src/cli/tool-activity.js";
import type { Message } from "../../../src/agent/messages.js";

function assistantWithCalls(calls: Array<{ id: string; name: string; input: unknown }>): Message {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "working" },
      ...calls.map((call) => ({ type: "tool_call" as const, ...call })),
    ],
  };
}

function userWithResults(results: Array<{ id: string; content: string; isError?: boolean }>): Message {
  return {
    role: "user",
    content: results.map((result) => ({
      type: "tool_result" as const,
      toolCallId: result.id,
      content: result.content,
      isError: result.isError ?? false,
    })),
  };
}

describe("findToolActivity", () => {
  test("pairs a call with its matching result by id", () => {
    const messages = [
      assistantWithCalls([
        { id: "call-abc", name: "read_file", input: { path: "src/a.ts" } },
      ]),
      userWithResults([{ id: "call-abc", content: "contents of a.ts" }]),
    ];
    const result = findToolActivity(messages, "call-abc");
    expect(result).toEqual({
      kind: "found",
      activity: {
        id: "call-abc",
        name: "read_file",
        input: { path: "src/a.ts" },
        result: { content: "contents of a.ts" },
      },
    });
  });

  test("does not require the result to immediately follow the call", () => {
    const messages = [
      assistantWithCalls([{ id: "c1", name: "run_command", input: { command: "npm test" } }]),
      assistantWithCalls([{ id: "c2", name: "run_command", input: { command: "ls" } }]),
      userWithResults([{ id: "c1", content: "stdout:\nok" }, { id: "c2", content: "stdout:\nfile" }]),
    ];
    const result = findToolActivity(messages, "c1");
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.activity.result?.content).toBe("stdout:\nok");
    }
  });

  test("matches a unique id prefix case-sensitively", () => {
    const messages = [
      assistantWithCalls([{ id: "c1a2b3c4", name: "run_command", input: { command: "ls" } }]),
      userWithResults([{ id: "c1a2b3c4", content: "file" }]),
    ];
    expect(findToolActivity(messages, "c1a2").kind).toBe("found");
    expect(findToolActivity(messages, "C1A2").kind).toBe("none");
  });

  test("returns none for an unknown prefix", () => {
    const messages = [
      assistantWithCalls([{ id: "c1", name: "run_command", input: { command: "ls" } }]),
    ];
    expect(findToolActivity(messages, "nope")).toEqual({ kind: "none" });
  });

  test("reports ambiguity for two ids sharing a prefix, sorted by full id", () => {
    const messages = [
      assistantWithCalls([
        { id: "zz-1", name: "read_file", input: {} },
        { id: "aa-1", name: "read_file", input: {} },
      ]),
      userWithResults([
        { id: "zz-1", content: "z" },
        { id: "aa-1", content: "a" },
      ]),
    ];
    const result = findToolActivity(messages, "");
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.matches.map((match) => match.id)).toEqual(["aa-1", "zz-1"]);
    }
  });

  test("a call without any result still resolves with no result field", () => {
    const messages = [
      assistantWithCalls([{ id: "solo", name: "plan_write", input: { items: [] } }]),
    ];
    const result = findToolActivity(messages, "solo");
    expect(result).toEqual({
      kind: "found",
      activity: { id: "solo", name: "plan_write", input: { items: [] } },
    });
  });
});

describe("makeToolPreview", () => {
  test("keeps at most three non-empty lines across both streams, stdout first", () => {
    const preview = makeToolPreview({
      stdout: "one\n\ntwo\nthree\nfour",
      stderr: "boom",
    });
    expect(preview.lines.map((line) => line.text)).toEqual(["one", "two", "three"]);
    expect(preview.lines.map((line) => line.stream)).toEqual([
      "stdout",
      "stdout",
      "stdout",
    ]);
    expect(preview.hiddenLineCount).toBe(2);
    expect(preview.truncated).toBe(true);
  });

  test("stderr lines retain their stream label", () => {
    const preview = makeToolPreview({
      stdout: "a",
      stderr: "error1\nerror2\nerror3\nerror4",
    });
    expect(preview.lines).toEqual([
      { text: "a", stream: "stdout" },
      { text: "error1", stream: "stderr" },
      { text: "error2", stream: "stderr" },
    ]);
    expect(preview.hiddenLineCount).toBe(2);
  });

  test("reports zero hidden lines for a short result", () => {
    const preview = makeToolPreview({ stdout: "42 tests passed", stderr: "" });
    expect(preview.lines.map((line) => line.text)).toEqual(["42 tests passed"]);
    expect(preview.hiddenLineCount).toBe(0);
    expect(preview.truncated).toBe(false);
  });

  test("a single overlong line is cut with an ellipsis without splitting a surrogate pair", () => {
    const long = "x".repeat(500) + "😀tail";
    const preview = makeToolPreview({
      stdout: long,
      stderr: "",
      maxCodePoints: 100,
    });
    const text = preview.lines[0]!.text;
    expect([...text].length).toBeLessThanOrEqual(101);
    expect(text.endsWith("…")).toBe(true);
    expect(text).not.toContain("\uFFFD");
    expect(text).not.toContain("tail");
  });

  test("empty output yields no lines and nothing hidden", () => {
    const preview = makeToolPreview({ stdout: "", stderr: "" });
    expect(preview.lines).toEqual([]);
    expect(preview.hiddenLineCount).toBe(0);
  });
});
