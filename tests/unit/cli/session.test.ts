import { describe, expect, test } from "vitest";

import type { RunResult } from "../../../src/agent/result.js";
import type { Prompt } from "../../../src/cli/prompt.js";
import type { Renderer } from "../../../src/cli/renderer.js";
import { SlashCommandRouter } from "../../../src/cli/command-router.js";
import { createTheme } from "../../../src/cli/theme.js";
import { CliSession, type RunTurn } from "../../../src/cli/session.js";

class FakePrompt implements Prompt {
  readonly #pendingReads: Array<(value: string | null) => void> = [];
  readonly #queuedInputs: Array<string | null> = [];
  readCount = 0;
  confirmQuestions: string[] = [];
  confirmResult = true;
  sigintHandler: (() => void) | undefined;
  interrupted = false;
  closed = false;

  read(_promptText: string): Promise<string | null> {
    this.readCount += 1;
    const queued = this.#queuedInputs.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    if (this.interrupted) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      this.#pendingReads.push(resolve);
    });
  }

  pushInput(text: string | null): void {
    const pending = this.#pendingReads.shift();
    if (pending !== undefined) {
      pending(text);
    } else {
      this.#queuedInputs.push(text);
    }
  }

  confirm(question: string): Promise<boolean> {
    this.confirmQuestions.push(question);
    return Promise.resolve(this.confirmResult);
  }

  onSigint(handler: () => void): void {
    this.sigintHandler = handler;
  }

  interrupt(): void {
    this.interrupted = true;
    const pending = this.#pendingReads.shift();
    if (pending !== undefined) {
      pending(null);
    }
  }

  suspendForOutput(): void {}

  resumeAfterOutput(): void {}

  close(): void {
    this.closed = true;
  }

  pressCtrlC(): void {
    this.sigintHandler?.();
  }
}

class MemoryRenderer implements Renderer {
  readonly errors: string[] = [];
  readonly printed: string[] = [];
  readonly events: string[] = [];

  handle(event: { type: string }): void {
    this.events.push(event.type);
  }

  toolOutput(): void {}

  print(text: string): void {
    this.printed.push(text);
  }

  error(message: string): void {
    this.errors.push(message);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await delay(1);
  }
}

function cancelledResult(): RunResult {
  return { status: "cancelled", steps: 1, toolCalls: 0, durationMs: 5 };
}

describe("CliSession", () => {
  test("reads a task, runs it, and exits on /exit", async () => {
    const prompt = new FakePrompt();
    const renderer = new MemoryRenderer();
    const turns: string[] = [];
    const runTurn: RunTurn = async (text) => {
      turns.push(text);
      return { status: "completed", steps: 1, toolCalls: 0, durationMs: 10 };
    };
    prompt.pushInput("fix the bug");
    prompt.pushInput("/exit");
    const session = new CliSession({ prompt, renderer, runTurn });

    await session.start();

    expect(turns).toEqual(["fix the bug"]);
    expect(prompt.closed).toBe(true);
  });

  test("skips blank input and exits on EOF (null)", async () => {
    const prompt = new FakePrompt();
    const renderer = new MemoryRenderer();
    const turns: string[] = [];
    const runTurn: RunTurn = async (text) => {
      turns.push(text);
      return { status: "completed", steps: 1, toolCalls: 0, durationMs: 10 };
    };
    prompt.pushInput("   ");
    prompt.pushInput("task");
    prompt.pushInput(null);
    let flushCalls = 0;
    const session = new CliSession({
      prompt,
      renderer,
      runTurn,
      flushBeforeExit: async () => {
        flushCalls += 1;
      },
    });

    await session.start();

    expect(turns).toEqual(["task"]);
    expect(flushCalls).toBe(1);
    expect(prompt.closed).toBe(true);
  });

  test("first Ctrl-C during a run aborts that run and returns to input", async () => {
    const prompt = new FakePrompt();
    const renderer = new MemoryRenderer();
    let releaseRun!: () => void;
    let receivedSignal: AbortSignal | undefined;
    const runTurn: RunTurn = async (_text, signal) => {
      receivedSignal = signal;
      await new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
      return cancelledResult();
    };
    prompt.pushInput("long task");
    const session = new CliSession({ prompt, renderer, runTurn });
    const started = session.start();

    await waitFor(() => prompt.readCount === 1);
    await waitFor(() => receivedSignal !== undefined);

    prompt.pressCtrlC();

    expect(receivedSignal?.aborted).toBe(true);

    releaseRun();
    prompt.pushInput("/exit");
    await started;

    expect(prompt.closed).toBe(true);
  });

  test("Ctrl-C at the idle input prompt exits the session", async () => {
    const prompt = new FakePrompt();
    const renderer = new MemoryRenderer();
    const runTurn: RunTurn = async () => cancelledResult();
    let flushCalls = 0;
    const session = new CliSession({
      prompt,
      renderer,
      runTurn,
      flushBeforeExit: async () => {
        flushCalls += 1;
      },
    });
    const started = session.start();

    await waitFor(() => prompt.readCount === 1);

    prompt.pressCtrlC();
    await started;

    expect(flushCalls).toBe(1);
    expect(prompt.closed).toBe(true);
  });

  test("does not start a second run while one is in progress", async () => {
    const prompt = new FakePrompt();
    const renderer = new MemoryRenderer();
    let releaseRun!: () => void;
    const turnStarts: string[] = [];
    const runTurn: RunTurn = async (text) => {
      turnStarts.push(text);
      await new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
      return { status: "completed", steps: 1, toolCalls: 0, durationMs: 10 };
    };
    prompt.pushInput("first");
    prompt.pushInput("second");
    const session = new CliSession({ prompt, renderer, runTurn });
    const started = session.start();

    await waitFor(() => turnStarts.length === 1);
    await delay(10);

    expect(turnStarts).toEqual(["first"]);
    expect(prompt.readCount).toBe(1);

    releaseRun();
    await waitFor(() => turnStarts.length === 2);
    releaseRun();
    prompt.pushInput("/exit");
    await started;
  });

  test("renders an internal error when the turn runner throws", async () => {
    const prompt = new FakePrompt();
    const renderer = new MemoryRenderer();
    const runTurn: RunTurn = async () => {
      throw new Error("boom");
    };
    prompt.pushInput("task");
    prompt.pushInput("/exit");
    const session = new CliSession({ prompt, renderer, runTurn });

    await session.start();

    expect(renderer.errors).toEqual(["boom"]);
    expect(prompt.closed).toBe(true);
  });
});

describe("CliSession with command router", () => {
  test("a handled command does not call runTurn", async () => {
    const prompt = new FakePrompt();
    const renderer = new MemoryRenderer();
    const router = new SlashCommandRouter();
    router.register({
      name: "status",
      usage: "/status",
      description: "show status",
      execute: async () => ({ kind: "continue" as const, stateChanged: false }),
    });
    router.register({
      name: "exit",
      usage: "/exit",
      description: "exit",
      execute: async () => ({ kind: "exit" as const }),
    });
    const turns: string[] = [];
    prompt.pushInput("/status");
    prompt.pushInput("/exit");
    const session = new CliSession({
      prompt,
      renderer,
      runTurn: async (text) => {
        turns.push(text);
        return { status: "completed", steps: 1, toolCalls: 0, durationMs: 1 };
      },
      router,
      commandContext: {
        renderer,
        theme: createTheme({ enabled: false }),
        signal: new AbortController().signal,
        sessionManager: {
          active: () => { throw new Error("unused"); },
          isDirty: () => false,
          flush: async () => undefined,
          createNew: async () => { throw new Error("unused"); },
          resume: async () => { throw new Error("unused"); },
          contextStatus: () => { throw new Error("unused"); },
          compact: async () => { throw new Error("unused"); },
          activeSkill: () => undefined,
          activateSkill: async () => { throw new Error("unused"); },
          deactivateSkill: async () => undefined,
        },
        store: { list: async () => ({ sessions: [], diagnostics: [] }) },
        skillRegistry: {
          refresh: async () => ({ skills: [], diagnostics: [] }),
          list: () => [],
          resolve: () => undefined,
          diagnostics: () => [],
        },
      },
    });

    await session.start();

    expect(turns).toEqual([]);
    expect(prompt.closed).toBe(true);
  });

  test("an escaped command reaches runTurn with one leading slash", async () => {
    const prompt = new FakePrompt();
    const renderer = new MemoryRenderer();
    const router = new SlashCommandRouter();
    const turns: string[] = [];
    prompt.pushInput("//help");
    prompt.pushInput(null);
    const session = new CliSession({
      prompt,
      renderer,
      runTurn: async (text) => {
        turns.push(text);
        return { status: "completed", steps: 1, toolCalls: 0, durationMs: 1 };
      },
      router,
      commandContext: {
        renderer,
        theme: createTheme({ enabled: false }),
        signal: new AbortController().signal,
        sessionManager: {
          active: () => { throw new Error("unused"); },
          isDirty: () => false,
          flush: async () => undefined,
          createNew: async () => { throw new Error("unused"); },
          resume: async () => { throw new Error("unused"); },
          contextStatus: () => { throw new Error("unused"); },
          compact: async () => { throw new Error("unused"); },
      activeSkill: () => undefined,
      activateSkill: async () => { throw new Error("unused"); },
      deactivateSkill: async () => undefined,
        },
        store: { list: async () => ({ sessions: [], diagnostics: [] }) },
        skillRegistry: {
          refresh: async () => ({ skills: [], diagnostics: [] }),
          list: () => [],
          resolve: () => undefined,
          diagnostics: () => [],
        },
      },
    });

    await session.start();

    expect(turns).toEqual(["/help"]);
  });
});
