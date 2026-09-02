import { describe, expect, test } from "vitest";
import { stripVTControlCharacters } from "node:util";

import type { CommandContext } from "../../../../src/cli/command.js";
import { createToolCommand } from "../../../../src/cli/commands/tool-command.js";
import type { Renderer } from "../../../../src/cli/renderer.js";
import { createTheme } from "../../../../src/cli/theme.js";
import { toolReference } from "../../../../src/cli/tool-activity.js";
import type { Message } from "../../../../src/agent/messages.js";
import {
  createEmptySession,
  type PersistedSessionV1,
} from "../../../../src/sessions/session-schema.js";

class MemoryRenderer implements Renderer {
  permissionRequest(): void {}
  permissionDecision(): void {}
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

function session(): PersistedSessionV1 {
  return createEmptySession({
    id: ID,
    now: "2026-08-28T08:00:00.000Z",
    workspaceRoot: "/tmp/workspace",
    modelId: "deepseek-v4-flash",
    permissionMode: "balanced",
  });
}

/** One assistant tool_call paired with its stored tool_result. */
function callAndResult(): Message[] {
  return [
    {
      role: "assistant",
      content: [
        { type: "text", text: "running the tests" },
        {
          type: "tool_call",
          id: "call-abc123def456",
          name: "run_command",
          input: { command: "npm test" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolCallId: "call-abc123def456",
          content: "exit_code: 0\nstdout:\n✓ 42 tests passed",
          isError: false,
        },
      ],
    },
  ];
}

function makeContext(options: { messages?: Message[]; enhanced?: boolean } = {}) {
  const renderer = new MemoryRenderer();
  const context: CommandContext = {
    renderer,
    theme: createTheme({ enabled: false }),
    signal: new AbortController().signal,
    webSearchAvailable: false,
    display: { enhanced: options.enhanced ?? false, columns: () => 80 },
    skillRegistry: {
      refresh: async () => ({ skills: [], diagnostics: [] }),
      list: () => [],
      resolve: () => undefined,
      diagnostics: () => [],
    },
    sessionManager: {
      messages: () => options.messages ?? [],
      active: () => session(),
      isDirty: () => false,
      flush: async () => undefined,
      createNew: async () => session(),
      resume: async () => session(),
      contextStatus: () => ({
        estimatedTokens: 0,
        thresholdTokens: 0,
        hardInputTokens: 0,
        contextWindowTokens: 0,
        coveredMessageCount: 0,
        totalMessageCount: 0,
        compactionCount: 0,
      }),
      compact: async () => ({
        action: "compacted",
        systemPrompt: "",
        messages: [],
        estimatedTokens: 0,
        compactedToolResults: 0,
      }),
      activeSkill: () => undefined,
      activateSkill: async () => { throw new Error("unused"); },
      deactivateSkill: async () => undefined,
      plan: () => ({ items: [] }),
      clearPlan: async () => ({ items: [] }),
      goal: () => null,
      setGoal: async () => ({
        condition: "x",
        status: "active",
        createdAt: "",
        updatedAt: "",
        automaticContinuations: 0,
      }),
      clearGoal: async () => undefined,
    },
    store: {
      list: async () => ({ sessions: [], diagnostics: [] }),
    },
  };
  return { context, renderer };
}

describe("createToolCommand", () => {
  const command = createToolCommand();

  test("/tool with no argument prints its usage", async () => {
    const { context, renderer } = makeContext();
    const result = await command.execute("", context);
    expect(result).toEqual({ kind: "continue", stateChanged: false });
    expect(renderer.printed).toEqual(["Usage: /tool <id>"]);
  });

  test("a unique prefix prints name, full id, reference, input summary, and the stored result", async () => {
    const { context, renderer } = makeContext({ messages: callAndResult() });
    const result = await command.execute("call-abc", context);
    expect(result).toEqual({ kind: "continue", stateChanged: false });
    expect(renderer.errors).toEqual([]);
    const text = renderer.printed.join("\n");
    expect(text).toContain("Tool call-abc123def456 (run_command)");
    expect(text).toContain(`Reference: ${toolReference("call-abc123def456")}`);
    expect(text).toContain("Input: npm test");
    expect(text).toContain("Stored result:");
    expect(text).toContain("✓ 42 tests passed");
  });

  test("a T- reference resolves the same tool call", async () => {
    const { context, renderer } = makeContext({ messages: callAndResult() });
    const result = await command.execute(
      toolReference("call-abc123def456"),
      context,
    );
    expect(result).toEqual({ kind: "continue", stateChanged: false });
    const text = renderer.printed.join("\n");
    expect(text).toContain("Tool call-abc123def456 (run_command)");
    expect(text).toContain("Stored result:");
    expect(text).toContain("✓ 42 tests passed");
  });

  test("a lowercase T- reference still resolves", async () => {
    const { context, renderer } = makeContext({ messages: callAndResult() });
    const reference = toolReference("call-abc123def456").toLowerCase();
    await command.execute(reference, context);
    const text = renderer.printed.join("\n");
    expect(text).toContain("Tool call-abc123def456 (run_command)");
  });

  test("a found call without a stored result still shows the call details", async () => {
    const messages = callAndResult();
    messages[1] = {
      role: "user",
      content: [{ type: "text", text: "please continue" }],
    };
    const { context, renderer } = makeContext({ messages });
    await command.execute("call-abc", context);
    const text = renderer.printed.join("\n");
    expect(text).toContain("Tool call-abc123def456 (run_command)");
    expect(text).toContain("Input: npm test");
    expect(text).not.toContain("Stored result:");
  });

  test("an unknown prefix is reported without crashing", async () => {
    const { context, renderer } = makeContext();
    const result = await command.execute("zzz", context);
    expect(result).toEqual({ kind: "continue", stateChanged: false });
    expect(renderer.printed).toEqual([
      'No tool call matches "zzz" in this session.',
    ]);
  });

  test("an ambiguous prefix lists only short ids and tool names", async () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "c1a2b3c4d5e6f7",
            name: "run_command",
            input: { command: "npm test" },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "c1a2deadbeef00",
            name: "read_file",
            input: { path: "src/a.ts" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolCallId: "c1a2b3c4d5e6f7",
            content: "exit_code: 0",
            isError: false,
          },
        ],
      },
    ];
    const { context, renderer } = makeContext({ messages });
    const result = await command.execute("c1a2", context);
    expect(result).toEqual({ kind: "continue", stateChanged: false });
    const text = renderer.printed.join("\n");
    expect(text).toContain('Multiple tool calls match "c1a2":');
    const referenceRows = [
      `${toolReference("c1a2b3c4d5e6f7")}  run_command`,
      `${toolReference("c1a2deadbeef00")}  read_file`,
    ];
    for (const row of referenceRows) {
      expect(text).toContain(row);
    }
    // Never picks one arbitrarily or prints stored output.
    expect(text).not.toContain("Stored result:");
    expect(text).not.toContain("npm test");
  });

  test("enhanced mode renders a bordered detail panel", async () => {
    const { context, renderer } = makeContext({
      messages: callAndResult(),
      enhanced: true,
    });
    context.theme = createTheme({ enabled: true });
    await command.execute("call-abc", context);
    const visible = stripVTControlCharacters(renderer.printed.join("\n"));
    expect(visible).toContain("╭─ ⚙ run_command");
    expect(visible).toContain("call-abc123def456");
    expect(visible).toContain(toolReference("call-abc123def456"));
    expect(visible).toMatch(/Input\s+npm test/u);
    expect(visible).toContain("Stored result:");
    expect(visible).toContain("✓ 42 tests passed");
  });
});
