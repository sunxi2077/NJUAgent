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
      plan: { items: [] },
      goal: null,
      evidence: { workspaceRevision: 0, changedPaths: [], commands: [] },
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
    parsed.plan.items.push({ id: "x", content: "y", status: "pending" });
    parsed.evidence.changedPaths.push("z");
    expect(valid.title).toBe("New session");
    expect(valid.plan.items).toHaveLength(0);
    expect(valid.evidence.changedPaths).toHaveLength(0);
  });

  test("normalizes an old V1 document missing plan, goal, and evidence", () => {
    const raw = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
    delete raw.plan;
    delete raw.goal;
    delete raw.evidence;
    const parsed = parseSession(raw);
    expect(parsed.plan).toEqual({ items: [] });
    expect(parsed.goal).toBeNull();
    expect(parsed.evidence).toEqual({ workspaceRevision: 0, changedPaths: [], commands: [] });
  });

  test("accepts persisted plan, goal, and evidence fields", () => {
    const withState = {
      ...valid,
      plan: {
        items: [
          { id: "read", content: "read code", status: "completed" },
          { id: "fix", content: "implement", status: "in_progress" },
        ],
        updatedAt: "2026-08-29T08:00:00.000Z",
      },
      goal: {
        condition: "npm test exits 0",
        status: "active",
        createdAt: "2026-08-29T08:00:00.000Z",
        updatedAt: "2026-08-29T08:00:00.000Z",
        automaticContinuations: 1,
        lastDecision: {
          satisfied: false,
          reason: "missing verification",
          missingEvidence: ["npm test has not run"],
          evaluatedAt: "2026-08-29T08:05:00.000Z",
        },
      },
      evidence: {
        workspaceRevision: 3,
        changedPaths: ["src/a.ts"],
        commands: [
          {
            command: "npm test",
            exitCode: 0,
            timedOut: false,
            cancelled: false,
            isVerification: true,
            workspaceRevision: 3,
            observedAt: "2026-08-29T08:05:00.000Z",
          },
        ],
      },
    };
    const parsed = parseSession(withState);
    expect(parsed.plan.items).toHaveLength(2);
    expect(parsed.goal?.status).toBe("active");
    expect(parsed.evidence.workspaceRevision).toBe(3);
  });

  test.each([
    [
      "plan with two in_progress items",
      { ...valid, plan: { items: [
        { id: "a", content: "a", status: "in_progress" },
        { id: "b", content: "b", status: "in_progress" },
      ] } },
    ],
    [
      "plan with unknown nested field",
      { ...valid, plan: { items: [], extra: true } },
    ],
    [
      "goal with invalid status",
      {
        ...valid,
        goal: {
          condition: "x",
          status: "done",
          createdAt: "2026-08-29T08:00:00.000Z",
          updatedAt: "2026-08-29T08:00:00.000Z",
          automaticContinuations: 0,
        },
      },
    ],
    [
      "goal with unknown nested field",
      {
        ...valid,
        goal: {
          condition: "x",
          status: "active",
          createdAt: "2026-08-29T08:00:00.000Z",
          updatedAt: "2026-08-29T08:00:00.000Z",
          automaticContinuations: 0,
          extra: 1,
        },
      },
    ],
    [
      "evidence with negative revision",
      { ...valid, evidence: { workspaceRevision: -1, changedPaths: [], commands: [] } },
    ],
    [
      "evidence with unknown nested field",
      {
        ...valid,
        evidence: { workspaceRevision: 0, changedPaths: [], commands: [], extra: 1 },
      },
    ],
    [
      "more than 20 persisted commands",
      {
        ...valid,
        evidence: {
          workspaceRevision: 0,
          changedPaths: [],
          commands: Array.from({ length: 21 }, (_, index) => ({
            command: `cmd ${index}`,
            exitCode: 0,
            timedOut: false,
            cancelled: false,
            isVerification: false,
            workspaceRevision: 0,
            observedAt: "2026-08-29T08:00:00.000Z",
          })),
        },
      },
    ],
    [
      "non-ISO plan.updatedAt",
      { ...valid, plan: { items: [], updatedAt: "yesterday" } },
    ],
    [
      "non-ISO goal.createdAt",
      {
        ...valid,
        goal: {
          condition: "x",
          status: "active",
          createdAt: "yesterday",
          updatedAt: "2026-08-29T08:00:00.000Z",
          automaticContinuations: 0,
        },
      },
    ],
    [
      "non-ISO lastDecision.evaluatedAt",
      {
        ...valid,
        goal: {
          condition: "x",
          status: "active",
          createdAt: "2026-08-29T08:00:00.000Z",
          updatedAt: "2026-08-29T08:00:00.000Z",
          automaticContinuations: 0,
          lastDecision: {
            satisfied: false,
            reason: "r",
            missingEvidence: [],
            evaluatedAt: "yesterday",
          },
        },
      },
    ],
    [
      "non-ISO command observedAt",
      {
        ...valid,
        evidence: {
          workspaceRevision: 0,
          changedPaths: [],
          commands: [
            {
              command: "npm test",
              exitCode: 0,
              timedOut: false,
              cancelled: false,
              isVerification: true,
              workspaceRevision: 0,
              observedAt: "yesterday",
            },
          ],
        },
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
