import { describe, expect, test } from "vitest";

import type { CommandContext } from "../../../../src/cli/command.js";
import type { PreparedContext } from "../../../../src/agent/context-types.js";
import { createCompactCommand } from "../../../../src/cli/commands/compact-command.js";
import { createContextCommand } from "../../../../src/cli/commands/context-command.js";
import type { Renderer } from "../../../../src/cli/renderer.js";
import { createTheme } from "../../../../src/cli/theme.js";
import { AppError } from "../../../../src/errors/app-error.js";

class MemoryRenderer implements Renderer {
  readonly printed: string[] = [];
  readonly errors: string[] = [];
  handle(): void {}
  toolOutput(): void {}
  print(text: string): void {
    this.printed.push(text);
  }
  error(message: string): void {
    this.errors.push(message);
  }
}

function makeContext(overrides: {
  compactError?: Error;
  compactResult?: PreparedContext;
  compactCalls?: string[];
} = {}) {
  const renderer = new MemoryRenderer();
  const context: CommandContext = {
    renderer,
    theme: createTheme({ enabled: false }),
    signal: new AbortController().signal,
    webSearchAvailable: false,
    skillRegistry: {
      refresh: async () => ({ skills: [], diagnostics: [] }),
      list: () => [],
      resolve: () => undefined,
      diagnostics: () => [],
    },

    sessionManager: {
      active: () => {
        throw new Error("unused");
      },
      isDirty: () => false,
      flush: async () => undefined,
      createNew: async () => {
        throw new Error("unused");
      },
      resume: async () => {
        throw new Error("unused");
      },
      contextStatus: () => ({
        estimatedTokens: 18_240,
        thresholdTokens: 33_600,
        hardInputTokens: 41_952,
        contextWindowTokens: 48_000,
        coveredMessageCount: 24,
        totalMessageCount: 38,
        compactionCount: 2,
      }),
      compact: async (focus?: string) => {
        overrides.compactCalls?.push(focus ?? "");
        if (overrides.compactError !== undefined) {
          throw overrides.compactError;
        }
        if (overrides.compactResult !== undefined) {
          return overrides.compactResult;
        }
        return {
          action: "compacted" as const,
          systemPrompt: "",
          messages: [],
          estimatedTokens: 0,
          compactedToolResults: 0,
          checkpoint: {
            summary: "s",
            coveredMessageCount: 30,
            createdAt: "2026-08-28T10:00:00.000Z",
            sourceEstimatedTokens: 100,
          },
        };
      },
      activeSkill: () => undefined,
      activateSkill: async () => { throw new Error("unused"); },
      deactivateSkill: async () => undefined,
      plan: () => ({ items: [] }),
      clearPlan: async () => ({ items: [] }),
      goal: () => null,
      setGoal: async () => { throw new Error("unused"); },
      clearGoal: async () => undefined,
    },
    store: {
      list: async () => ({ sessions: [], diagnostics: [] }),
    },
  };
  return { context, renderer };
}

describe("/context", () => {
  test("renders estimated/current/threshold/hard/window tokens and coverage", async () => {
    const command = createContextCommand();
    const { context, renderer } = makeContext();
    await command.execute("", context);
    const text = renderer.printed[0]!;
    expect(text).toContain("18,240");
    expect(text).toContain("33,600");
    expect(text).toContain("41,952");
    expect(text).toContain("48,000");
    expect(text).toContain("estimate");
    expect(text).toContain("24/38 messages");
    expect(text).toContain("2 compactions");
  });
});

describe("/compact", () => {
  test("passes the complete remainder as focus and renders success", async () => {
    const command = createCompactCommand();
    const calls: string[] = [];
    const { context, renderer } = makeContext({ compactCalls: calls });
    const result = await command.execute("  finish the parser  ", context);
    expect(calls).toEqual(["finish the parser"]);
    expect(result).toEqual({ kind: "continue", stateChanged: true });
    expect(renderer.printed.join("\n")).toContain("30 messages covered");
  });

  test("renders nothing-to-compact without changing the checkpoint", async () => {
    const command = createCompactCommand();
    const { context, renderer } = makeContext({
      compactResult: {
        action: "continue",
        systemPrompt: "",
        messages: [],
        estimatedTokens: 0,
        compactedToolResults: 0,
        reason: "Nothing to compact yet.",
      },
    });
    const result = await command.execute("", context);
    expect(result).toEqual({ kind: "continue", stateChanged: false });
    expect(renderer.printed.join("\n")).toContain("Nothing to compact yet.");
  });

  test("safely renders COMPACTION_FAILED", async () => {
    const command = createCompactCommand();
    const { context, renderer } = makeContext({
      compactError: new AppError({
        code: "COMPACTION_FAILED",
        userMessage: "summarizer down",
      }),
    });
    const result = await command.execute("", context);
    expect(result).toEqual({ kind: "continue", stateChanged: false });
    expect(renderer.errors[0]).toContain("[COMPACTION_FAILED]");
  });
});
