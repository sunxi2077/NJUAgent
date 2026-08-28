import { describe, expect, test } from "vitest";

import {
  createEmptySession,
  deriveSessionTitle,
  parseSession,
} from "../../../src/sessions/session-schema.js";
import { AppError } from "../../../src/errors/app-error.js";

const baseInput = {
  id: "3f2c9d5a-6b1e-4f80-9a2c-7d8e1f0a3b4c",
  now: "2026-08-28T08:00:00.000Z",
  workspaceRoot: "/tmp/workspace",
  modelId: "deepseek-v4-flash",
  permissionMode: "balanced" as const,
};

describe("createEmptySession", () => {
  test("applies defaults for a brand-new session", () => {
    const session = createEmptySession(baseInput);
    expect(session).toEqual({
      schemaVersion: 1,
      id: baseInput.id,
      title: "New session",
      createdAt: baseInput.now,
      updatedAt: baseInput.now,
      workspaceRoot: "/tmp/workspace",
      modelId: "deepseek-v4-flash",
      permissionMode: "balanced",
      activeSkill: null,
      messages: [],
      context: { compactionCount: 0 },
      stats: { turns: 0, toolCalls: 0 },
    });
  });
});

describe("deriveSessionTitle", () => {
  test("collapses whitespace and trims", () => {
    expect(deriveSessionTitle("  fix\n  the   parser  ")).toBe("fix the parser");
  });

  test("limits to 48 code points", () => {
    expect([...deriveSessionTitle("x".repeat(80))]).toHaveLength(48);
  });

  test("blank input returns New session", () => {
    expect(deriveSessionTitle("   \n  ")).toBe("New session");
  });
});

describe("parseSession", () => {
  const valid = createEmptySession(baseInput);

  test("accepts a valid session and returns a clone", () => {
    const parsed = parseSession(valid);
    expect(parsed).toEqual(valid);
    parsed.title = "mutated";
    expect(valid.title).toBe("New session");
  });

  test.each([
    ["unknown property", { ...valid, extra: true }],
    ["invalid UUID", { ...valid, id: "not-a-uuid" }],
    ["non-ISO createdAt", { ...valid, createdAt: "yesterday" }],
    ["negative counter", { ...valid, stats: { turns: -1, toolCalls: 0 } }],
    [
      "checkpoint covering more messages than exist",
      {
        ...valid,
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        context: {
          compactionCount: 1,
          checkpoint: {
            summary: "s",
            coveredMessageCount: 5,
            createdAt: "2026-08-28T08:00:00.000Z",
            sourceEstimatedTokens: 10,
          },
        },
      },
    ],
    [
      "invalid tool pairing",
      {
        ...valid,
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", toolCallId: "missing", content: "x", isError: false },
            ],
          },
        ],
      },
    ],
  ])("rejects %s with SESSION_CORRUPT", (_name, value) => {
    let error: unknown;
    try {
      parseSession(value);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "SESSION_CORRUPT" });
    // The diagnostic must not dump the whole session document.
    expect(String(error)).not.toContain("deepseek-v4-flash");
  });
});
