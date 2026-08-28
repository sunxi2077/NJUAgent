import { describe, expect, test } from "vitest";

import { ContextManager } from "../../../src/agent/context-manager.js";
import { ContextPolicy } from "../../../src/agent/context-policy.js";
import type { CompactorPort } from "../../../src/agent/compactor.js";
import type { ContextState } from "../../../src/agent/context-types.js";
import type { Message } from "../../../src/agent/messages.js";
import { AppError } from "../../../src/errors/app-error.js";

const textUser = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
});

const textAssistant = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

function makePolicy(overrides: Partial<ConstructorParameters<typeof ContextPolicy>[0]> = {}) {
  return new ContextPolicy({
    contextWindowTokens: 1_000,
    maxOutputTokens: 100,
    safetyTokens: 100,
    compactAtRatio: 0.7,
    recentMessages: 4,
    charsPerToken: 1,
    ...overrides,
  });
}

class FakeCompactor implements CompactorPort {
  calls: Array<{ previousSummary?: string; messages: Message[]; focus?: string }> = [];
  result = "summary of prefix";
  error: Error | undefined;

  async compact(input: {
    previousSummary?: string | undefined;
    messages: readonly Message[];
    focus?: string | undefined;
  }): Promise<string> {
    this.calls.push({
      ...(input.previousSummary === undefined ? {} : { previousSummary: input.previousSummary }),
      messages: input.messages.map((message) => structuredClone(message)),
      ...(input.focus === undefined ? {} : { focus: input.focus }),
    });
    if (this.error !== undefined) {
      throw this.error;
    }
    return this.result;
  }
}

function makeManager(options: {
  compactor?: FakeCompactor;
  initialState?: ContextState | undefined;
  policy?: ContextPolicy;
  clock?: () => Date;
} = {}) {
  const compactor = options.compactor ?? new FakeCompactor();
  const manager = new ContextManager({
    policy: options.policy ?? makePolicy(),
    compactor,
    ...(options.initialState === undefined ? {} : { initialState: options.initialState }),
    clock: options.clock ?? (() => new Date("2026-08-28T09:00:00.000Z")),
  });
  return { manager, compactor };
}

const base = (messages: Message[]) => ({
  baseSystemPrompt: "base prompt",
  messages,
  tools: [],
  signal: new AbortController().signal,
});

describe("ContextManager.prepare", () => {
  test("under threshold returns continue and never calls the compactor", async () => {
    const { manager, compactor } = makeManager();
    const prepared = await manager.prepare(base([textUser("hi")]));
    expect(prepared.action).toBe("continue");
    expect(prepared.messages).toEqual([textUser("hi")]);
    expect(compactor.calls).toHaveLength(0);
  });

  test("over threshold first shrinks tool results and continues without a semantic call", async () => {
    // Four messages with recentMessages 2 place the 5000-char tool result in
    // the compacted prefix; shrinking brings the estimate back under threshold.
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "c1", name: "read_file", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", toolCallId: "c1", content: "x".repeat(5_000), isError: false }],
      },
      textUser("recent task"),
      textAssistant("recent answer"),
    ];
    const { manager, compactor } = makeManager({ policy: makePolicy({ recentMessages: 2 }) });
    const prepared = await manager.prepare(base(messages));

    expect(prepared.action).toBe("continue");
    expect(prepared.compactedToolResults).toBe(1);
    expect(compactor.calls).toHaveLength(0);
  });
});

describe("ContextManager.compactNow", () => {
  test("compacts only the newly covered prefix and passes the previous summary", async () => {
    const clock = () => new Date("2026-08-28T10:00:00.000Z");
    const { manager, compactor } = makeManager({
      clock,
      policy: makePolicy({ recentMessages: 2 }),
      initialState: {
        compactionCount: 1,
        checkpoint: {
          summary: "previous",
          coveredMessageCount: 2,
          createdAt: "2026-08-28T08:00:00.000Z",
          sourceEstimatedTokens: 100,
        },
      },
    });
    const messages: Message[] = [
      textUser("old-1"),
      textAssistant("old-2"),
      textUser("new-3"),
      textAssistant("new-4"),
      textUser("new-5"),
    ];

    const prepared = await manager.compactNow({ ...base(messages), focus: "finish the fix" });

    expect(compactor.calls).toHaveLength(1);
    expect(compactor.calls[0]!.previousSummary).toBe("previous");
    // oldCovered=2, cut = 5-2=3 → compacts messages[2..3) = ["new-3"]
    expect(compactor.calls[0]!.messages).toEqual([textUser("new-3")]);
    expect(compactor.calls[0]!.focus).toBe("finish the fix");
    expect(prepared.action).toBe("compacted");
    expect(prepared.checkpoint).toMatchObject({
      summary: "summary of prefix",
      coveredMessageCount: 3,
      createdAt: "2026-08-28T10:00:00.000Z",
    });
    expect(manager.state().compactionCount).toBe(2);
    expect(manager.state().checkpoint?.coveredMessageCount).toBe(3);
    expect(prepared.systemPrompt).toContain("<conversation_summary>");
    expect(prepared.systemPrompt).toContain("summary of prefix");
    expect(prepared.messages).toEqual([textAssistant("new-4"), textUser("new-5")]);
    expect(messages).toHaveLength(5);
  });

  test("no prefix returns a distinct safe reason without a model call", async () => {
    const { manager, compactor } = makeManager({ initialState: { compactionCount: 0 } });
    const prepared = await manager.compactNow(base([textUser("only")]));
    expect(prepared.action).toBe("continue");
    expect(prepared.reason).toBe("Nothing to compact yet.");
    expect(compactor.calls).toHaveLength(0);
  });

  test("compactor failure leaves state unchanged and continues below the hard limit", async () => {
    const compactor = new FakeCompactor();
    compactor.error = new AppError({
      code: "COMPACTION_FAILED",
      userMessage: "summarizer down",
    });
    const before = { compactionCount: 0 };
    // Six messages of ~60 chars keep the serialized estimate between the
    // threshold (~700) and the hard limit (~800) when the compactor fails.
    const messages = Array.from({ length: 6 }, (_, index) =>
      textUser(`${index}-${"x".repeat(57)}`),
    );
    const { manager } = makeManager({ compactor, initialState: before });
    const prepared = await manager.prepare(base(messages));

    expect(compactor.calls).toHaveLength(1);
    expect(prepared.action).toBe("continue");
    expect(manager.state()).toEqual(before);
  });
});

describe("ContextManager.state", () => {
  test("returns a clone that cannot mutate internal state", () => {
    const { manager } = makeManager();
    const state = manager.state();
    state.compactionCount = 99;
    expect(manager.state().compactionCount).toBe(0);
  });
});
