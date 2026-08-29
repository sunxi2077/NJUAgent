import { describe, expect, test } from "vitest";

import type { CommandContext } from "../../../../src/cli/command.js";
import { SlashCommandRouter } from "../../../../src/cli/command-router.js";
import { createExitCommand } from "../../../../src/cli/commands/exit-command.js";
import { createHelpCommand } from "../../../../src/cli/commands/help-command.js";
import { createHistoryCommand } from "../../../../src/cli/commands/history-command.js";
import { createNewCommand } from "../../../../src/cli/commands/new-command.js";
import { createResumeCommand } from "../../../../src/cli/commands/resume-command.js";
import { createSessionsCommand } from "../../../../src/cli/commands/sessions-command.js";
import { createStatusCommand } from "../../../../src/cli/commands/status-command.js";
import type { Renderer } from "../../../../src/cli/renderer.js";
import { createTheme } from "../../../../src/cli/theme.js";
import { AppError } from "../../../../src/errors/app-error.js";
import {
  createEmptySession,
  type PersistedSessionV1,
} from "../../../../src/sessions/session-schema.js";

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

const ID = "3f2c9d5a-6b1e-4f80-9a2c-7d8e1f0a3b4c";

function session(overrides: Partial<PersistedSessionV1> = {}): PersistedSessionV1 {
  return {
    ...createEmptySession({
      id: ID,
      now: "2026-08-28T08:00:00.000Z",
      workspaceRoot: "/tmp/workspace",
      modelId: "deepseek-v4-flash",
      permissionMode: "balanced",
    }),
    ...overrides,
  };
}

type FakeServices = {
  renderer: MemoryRenderer;
  activeSession: PersistedSessionV1;
  dirty: boolean;
  flushCalls: number;
  flushError?: Error;
  newSession?: PersistedSessionV1;
  resumeError?: Error;
};

function makeContext(overrides: Partial<FakeServices> = {}) {
  const renderer = new MemoryRenderer();
  const activeSession = overrides.activeSession ?? session();
  const services: FakeServices = {
    renderer,
    activeSession,
    dirty: false,
    flushCalls: 0,
    ...overrides,
  };
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
      active: () => structuredClone(activeSession),
      isDirty: () => services.dirty,
      flush: async () => {
        services.flushCalls += 1;
        if (services.flushError !== undefined) {
          throw services.flushError;
        }
      },
      createNew: async () => {
        if (services.newSession === undefined) {
          throw new Error("no new session configured");
        }
        return services.newSession;
      },
      resume: async () => {
        if (services.resumeError !== undefined) {
          throw services.resumeError;
        }
        return { ...activeSession, id: "aaaaaaaa-1111-4111-8111-111111111111", title: "resumed" };
      },
      contextStatus: () => ({
        estimatedTokens: 18240,
        thresholdTokens: 33600,
        hardInputTokens: 41952,
        contextWindowTokens: 48000,
        coveredMessageCount: 24,
        totalMessageCount: 38,
        compactionCount: 2,
      }),
      compact: async () => ({ action: "compacted", systemPrompt: "", messages: [], estimatedTokens: 0, compactedToolResults: 0 }),
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
      list: async () => ({
        sessions: [
          {
            id: activeSession.id,
            title: activeSession.title,
            workspaceRoot: activeSession.workspaceRoot,
            modelId: activeSession.modelId,
            updatedAt: activeSession.updatedAt,
          },
        ],
        diagnostics: [{ file: "broken.json", message: "invalid" }],
      }),
    },
  };
  return { context, renderer, services };
}

async function run(command: { execute(args: string, context: CommandContext): Promise<unknown> }, args: string) {
  const { context, renderer } = makeContext();
  const result = await command.execute(args, context);
  return { result, renderer };
}

describe("session slash commands", () => {
  test("/history defaults to 20 and accepts 1", async () => {
    const history = createHistoryCommand();
    const { context, renderer } = makeContext({
      activeSession: session({
        messages: [
          { role: "user", content: [{ type: "text", text: "hello" }] },
          { role: "assistant", content: [{ type: "text", text: "hi" }] },
        ],
      }),
    });
    await history.execute("", context);
    expect(renderer.printed[0]).toContain("user");
    await history.execute("1", context);
    expect(renderer.printed[1]).toContain("assistant");
    expect(renderer.printed[1]).not.toContain("user");
  });

  test.each(["0", "101", "1.5", "abc"])(
    "/history rejects %s with usage without throwing",
    async (value) => {
      const history = createHistoryCommand();
      const { context, renderer } = makeContext();
      const result = await history.execute(value, context);
      expect(result).toEqual({ kind: "continue", stateChanged: false });
      expect(renderer.printed[0]).toContain("Usage: /history [1-100]");
    },
  );

  test("/resume with blank args renders usage", async () => {
    const resume = createResumeCommand();
    const { context, renderer } = makeContext();
    const result = await resume.execute("   ", context);
    expect(result).toEqual({ kind: "continue", stateChanged: false });
    expect(renderer.printed[0]).toContain("Usage: /resume <id>");
  });

  test("/resume success renders the target short id and title", async () => {
    const resume = createResumeCommand();
    const { context, renderer } = makeContext();
    const result = await resume.execute("aaaaaaaa", context);
    expect(result).toEqual({ kind: "continue", stateChanged: true });
    expect(renderer.printed[0]).toContain("aaaaaaaa");
    expect(renderer.printed[0]).toContain("resumed");
  });

  test("/resume failure renders a safe AppError and keeps context unchanged", async () => {
    const resume = createResumeCommand();
    const { context, renderer, services } = makeContext();
    services.resumeError = new AppError({
      code: "SESSION_CORRUPT",
      userMessage: "No session matches zzzz",
    });
    const result = await resume.execute("zzzz", context);
    expect(result).toEqual({ kind: "continue", stateChanged: false });
    expect(renderer.errors[0]).toContain("[SESSION_CORRUPT]");
    expect(renderer.errors[0]).toContain("No session matches zzzz");
  });

  test("/new reports the new id and no active skill", async () => {
    const fresh = createNewCommand();
    const { context, renderer, services } = makeContext();
    services.newSession = session({
      id: "99999999-9999-4999-8999-999999999999",
      title: "New session",
      activeSkill: null,
    });
    const result = await fresh.execute("", context);
    expect(result).toEqual({ kind: "continue", stateChanged: true });
    expect(renderer.printed[0]).toContain("99999999");
    expect(renderer.printed[0]).toContain("no active Skill");
  });

  test("/sessions renders corrupt-file diagnostics as warnings after valid rows", async () => {
    const sessionsCmd = createSessionsCommand();
    const { context, renderer } = makeContext();
    await sessionsCmd.execute("", context);
    const text = renderer.printed[0];
    const warningIndex = renderer.printed.findIndex((line) => line.startsWith("warning:"));
    expect(text).toContain("Sessions (1):");
    expect(warningIndex).toBeGreaterThan(0);
    expect(renderer.printed[warningIndex]).toContain("broken.json");
  });

  test("/exit flushes and returns exit on success", async () => {
    const exit = createExitCommand();
    const { context, services } = makeContext();
    const result = await exit.execute("", context);
    expect(result).toEqual({ kind: "exit" });
    expect(services.flushCalls).toBe(1);
  });

  test("/exit keeps the CLI alive when flush fails", async () => {
    const exit = createExitCommand();
    const { context, renderer, services } = makeContext();
    services.flushError = new AppError({ code: "SESSION_IO", userMessage: "disk full" });
    const result = await exit.execute("", context);
    expect(result).toEqual({ kind: "continue", stateChanged: false });
    expect(renderer.errors[0]).toContain("[SESSION_IO]");
  });

  test("/status shows the session state", async () => {
    const status = createStatusCommand();
    const { context, renderer } = makeContext();
    await status.execute("", context);
    expect(renderer.printed[0]).toContain("Model: deepseek-v4-flash");
    expect(renderer.printed[0]).toContain("Dirty: no");
  });

  test("help is generated from registered command metadata", async () => {
    const router = new SlashCommandRouter();
    router.register(createHelpCommand(() => router.commands()));
    router.register(createStatusCommand());
    router.register(createExitCommand());
    const { context, renderer } = makeContext();
    await router.route("/help", context);
    expect(renderer.printed[0]).toContain("/status");
    expect(renderer.printed[0]).toContain("/exit");
    expect(renderer.printed[0]).toContain("/help");
  });
});
