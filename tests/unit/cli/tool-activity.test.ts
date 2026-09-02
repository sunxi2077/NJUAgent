import { describe, expect, test } from "vitest";

import {
  findToolActivity,
  makeToolPreview,
  toolReference,
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

describe("toolReference", () => {
  test("formats as T- plus 10 lowercase hex characters, stably", () => {
    for (const id of ["call_00_abcdef1234", "c1a2b3c4d5", "tool1234abcd"]) {
      const reference = toolReference(id);
      expect(reference).toMatch(/^T-[0-9a-f]{10}$/u);
      expect(toolReference(id)).toBe(reference);
    }
  });

  test("ids sharing a call_00_ prefix get distinct references", () => {
    const first = "call_00_aaaaaaaaaaaaaaaaaaaa";
    const second = "call_00_bbbbbbbbbbbbbbbbbbbb";
    const firstReference = toolReference(first);
    const secondReference = toolReference(second);
    expect(firstReference).not.toBe(secondReference);
  });
});

describe("findToolActivity with T- references", () => {
  const firstId = "call_00_aaaaaaaaaaaaaaaaaaaa";
  const secondId = "call_00_bbbbbbbbbbbbbbbbbbbb";
  const messages: Message[] = [
    assistantWithCalls([
      { id: firstId, name: "run_command", input: { command: "npm test" } },
      { id: secondId, name: "read_file", input: { path: "src/a.ts" } },
    ]),
    userWithResults([
      { id: firstId, content: "stdout:\nok" },
      { id: secondId, content: "contents" },
    ]),
  ];

  test("a unique T- reference resolves its provider id", () => {
    const reference = toolReference(firstId);
    const result = findToolActivity(messages, reference);
    expect(result).toEqual({
      kind: "found",
      activity: {
        id: firstId,
        name: "run_command",
        input: { command: "npm test" },
        result: { content: "stdout:\nok" },
      },
    });
  });

  test("a lowercase T- reference resolves case-insensitively", () => {
    const reference = toolReference(secondId).toLowerCase();
    const result = findToolActivity(messages, reference);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.activity.id).toBe(secondId);
    }
  });

  test("an ambiguous T- prefix lists every candidate without choosing", () => {
    const result = findToolActivity(messages, "T-");
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      const ids = result.matches.map((match) => match.id).sort();
      expect(ids).toEqual([firstId, secondId].sort());
    }
  });

  test("a provider-id prefix still resolves when unique despite call_00_ shared prefixes", () => {
    const shared = findToolActivity(messages, "call_00_");
    expect(shared.kind).toBe("ambiguous");
    if (shared.kind === "ambiguous") {
      expect(shared.matches).toHaveLength(2);
    }
    // Case-sensitive provider-id prefixes keep working for unique ids.
    const unique = findToolActivity(messages, firstId.slice(0, 12));
    expect(unique.kind).toBe("found");
    if (unique.kind === "found") {
      expect(unique.activity.id).toBe(firstId);
    }
    // The full provider id always wins by exact match.
    const exact = findToolActivity(messages, firstId);
    expect(exact.kind).toBe("found");
    if (exact.kind === "found") {
      expect(exact.activity.id).toBe(firstId);
    }
  });
});
