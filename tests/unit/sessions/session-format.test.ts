import { describe, expect, test } from "vitest";

import { createTheme } from "../../../src/cli/theme.js";
import {
  formatContextStatus,
  formatHistory,
  formatSessionList,
  formatSessionStatus,
} from "../../../src/sessions/session-format.js";
import {
  createEmptySession,
  type PersistedSessionV1,
} from "../../../src/sessions/session-schema.js";

const plain = createTheme({ enabled: false });

function strip(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/gu, "");
}

function session(overrides: Partial<PersistedSessionV1> = {}): PersistedSessionV1 {
  return {
    ...createEmptySession({
      id: "3f2c9d5a-6b1e-4f80-9a2c-7d8e1f0a3b4c",
      now: "2026-08-28T08:00:00.000Z",
      workspaceRoot: "/tmp/workspace",
      modelId: "deepseek-v4-flash",
      permissionMode: "balanced",
    }),
    ...overrides,
  };
}

describe("formatSessionList", () => {
  test("renders one row per session with the current marker once", () => {
    const entries = [
      {
        id: "aaaaaaaa-1111-4111-8111-111111111111",
        title: "first",
        workspaceRoot: "/tmp/a",
        modelId: "m",
        updatedAt: "2026-08-28T08:00:00.000Z",
      },
      {
        id: "3f2c9d5a-6b1e-4f80-9a2c-7d8e1f0a3b4c",
        title: "second",
        workspaceRoot: "/tmp/b",
        modelId: "m",
        updatedAt: "2026-08-28T09:00:00.000Z",
      },
    ];
    const text = formatSessionList({
      sessions: entries,
      currentId: "3f2c9d5a-6b1e-4f80-9a2c-7d8e1f0a3b4c",
      theme: plain,
    });
    expect(text.match(/current/gu)).toHaveLength(1);
    expect(text).toContain("aaaaaaaa");
    expect(text).toContain("3f2c9d5a");
  });
});

describe("formatSessionStatus", () => {
  test("contains model, workspace, permission, skill, message count, and dirty", () => {
    const s = session({
      title: "my session",
      stats: { turns: 3, toolCalls: 5, lastRunStatus: "completed", usage: { requests: 0, inputTokens: 0, outputTokens: 0 } },
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
      ],
    });
    const text = formatSessionStatus(s, { dirty: true, theme: plain });
    expect(text).toContain("deepseek-v4-flash");
    expect(text).toContain("/tmp/workspace");
    expect(text).toContain("balanced");
    expect(text).toContain("none");
    expect(text).toContain("Messages: 2");
    expect(text).toContain("Dirty: yes");
    expect(text).not.toContain("\x1b[");
  });
});

describe("formatHistory", () => {
  test("shows roles, tool call names, and result status with bounded content", () => {
    const longOutput = "x".repeat(10_000);
    const s = session({
      messages: [
        { role: "user", content: [{ type: "text", text: "inspect" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "let me read" },
            { type: "tool_call", id: "c1", name: "read_file", input: { path: "a.ts" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolCallId: "c1",
              content: longOutput,
              isError: false,
            },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "tool_call", id: "c2", name: "run_command", input: { command: "npm test" } }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", toolCallId: "c2", content: "boom", isError: true },
          ],
        },
      ],
    });
    const text = formatHistory(s, { theme: plain });
    expect(text).toContain("user");
    expect(text).toContain("assistant");
    expect(text).toContain("read_file");
    expect(text).toContain("run_command");
    expect(text).toContain("failed");
    expect(text).toContain("ok");
    expect(text).not.toContain("x".repeat(1000));
    for (const line of text.split("\n")) {
      expect([...line].length).toBeLessThanOrEqual(240);
    }
  });

  test("plain theme emits no ANSI", () => {
    const s = session({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
    expect(formatHistory(s, { theme: plain })).not.toContain("\x1b[");
  });
});

describe("formatSessionStatus cards", () => {
  const enhanced = createTheme({ enabled: true });

  const context = {
    estimatedTokens: 1400,
    thresholdTokens: 33600,
    hardInputTokens: 41952,
    contextWindowTokens: 48000,
    coveredMessageCount: 0,
    totalMessageCount: 4,
    compactionCount: 0,
  };

  test("enhanced status shows a card with context bar and usage totals", () => {
    const s = session();
    const text = formatSessionStatus(s, {
      dirty: false,
      theme: enhanced,
      context,
      columns: 80,
    });
    expect(text).toContain("Session status");
    expect(strip(text)).toContain("deepseek-v4-flash");
    expect(strip(text)).toContain("3f2c9d5a");
    expect(strip(text)).toContain("requests");
    expect(strip(text)).toContain("input");
    expect(strip(text)).toContain("output");
    expect(strip(text)).toContain("Estimate");
    expect(strip(text)).toContain("not configured");
  });

  test("enhanced status marks dirty and keeps web search availability visible", () => {
    const s = session({ workspaceRoot: "/same" });
    const text = formatSessionStatus(s, {
      dirty: true,
      theme: enhanced,
      context,
      columns: 80,
      cwd: "/same",
    });
    expect(strip(text)).toContain("· dirty");
    expect(strip(text)).toContain("Web search unavailable");
  });

  test("enhanced context shows ratio bar, limits, summary, and last input", () => {
    const text = formatContextStatus(
      { ...context, lastInputTokens: 21800 },
      enhanced,
      80,
    );
    const visible = strip(text);
    expect(visible).toContain("Context budget");
    expect(visible).toContain("%");
    expect(visible).toContain("Compact at");
    expect(visible).toContain("Summary 0/4 messages");
    expect(visible).toContain("Last provider input");
  });
});
