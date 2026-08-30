import { describe, expect, test } from "vitest";
import type { Interface } from "node:readline";
import { PassThrough } from "node:stream";

import { ReadlinePrompt } from "../../../src/cli/prompt.js";
import type { TerminalKey, TerminalKeyHandler, TerminalInputRouterPort } from "../../../src/cli/terminal-input-router.js";
import type { SlashCompletionSnapshot } from "../../../src/cli/slash-completion.js";
import type { SlashMenuPresenterPort } from "../../../src/cli/slash-menu.js";
import type { SlashCommandDescriptor } from "../../../src/cli/command.js";
import { createTheme } from "../../../src/cli/theme.js";

class FakeReadline {
  promptText = "";
  promptCalls: boolean[] = [];
  readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  closed = false;
  line = "";
  cursor = 0;

  setPrompt(text: string): void {
    this.promptText = text;
  }

  prompt(flag?: boolean): void {
    this.promptCalls.push(flag ?? false);
  }

  on(event: string, handler: (...args: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  close(): void {
    this.closed = true;
  }

  /** Simulates readline editing: ctrl-U clears, strings append, backspace deletes. */
  write(data?: unknown, key?: { ctrl?: boolean; name?: string }): void {
    if (data === undefined && key?.ctrl && key.name === "u") {
      this.line = "";
      this.cursor = 0;
      return;
    }
    if (typeof data === "string") {
      if (data === "\x7f" || data === "\b") {
        this.line = this.line.slice(0, Math.max(0, this.cursor - 1)) + this.line.slice(this.cursor);
        this.cursor = Math.max(0, this.cursor - 1);
        return;
      }
      const before = this.line.slice(0, this.cursor);
      const after = this.line.slice(this.cursor);
      this.line = before + data + after;
      this.cursor += [...data].length;
    }
  }

  emitLine(line: string): void {
    for (const handler of this.handlers.get("line") ?? []) {
      handler(line);
    }
  }

  /** Emits the current line as Enter would. */
  submitLine(): void {
    this.emitLine(this.line);
  }
}

class TTYStdout {
  readonly chunks: string[] = [];
  isTTY = true;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  text(): string {
    return this.chunks.join("");
  }
}

function makePrompt() {
  const rl = new FakeReadline();
  const output = new TTYStdout();
  const prompt = new ReadlinePrompt({
    input: process.stdin,
    output: output as unknown as NodeJS.WritableStream,
    terminal: true,
    interfaceFactory: () => rl as unknown as Interface,
  });
  return { prompt, rl, output };
}

describe("ReadlinePrompt", () => {
  test("readline owns the prompt: setPrompt + prompt(true), no manual write", async () => {
    const { prompt, rl, output } = makePrompt();
    const pending = prompt.read("› ");

    expect(rl.promptText).toBe("› ");
    expect(rl.promptCalls).toEqual([true]);
    expect(output.text()).toBe("");

    rl.emitLine("hello");
    await expect(pending).resolves.toBe("hello");
  });

  test("forwards an ANSI-decorated prompt unchanged and still redraws via prompt(true)", async () => {
    const { prompt, rl, output } = makePrompt();
    const anchor = "\x1b[36m❯ You\x1b[0m  ";
    const pending = prompt.read(anchor);

    expect(rl.promptText).toBe(anchor);
    expect(rl.promptCalls).toEqual([true]);
    expect(output.text()).toBe("");

    rl.emitLine("hello");
    await expect(pending).resolves.toBe("hello");
  });

  test("suspendForOutput clears the prompt line and resume redraws it", async () => {
    const { prompt, rl, output } = makePrompt();
    const pending = prompt.read("› ");

    prompt.suspendForOutput();
    expect(output.text()).toContain("\x1b[");

    const callsBefore = rl.promptCalls.length;
    prompt.resumeAfterOutput();
    expect(rl.promptCalls).toHaveLength(callsBefore + 1);
    expect(rl.promptCalls.at(-1)).toBe(true);
    expect(rl.line).toBe("");

    rl.emitLine("ok");
    await expect(pending).resolves.toBe("ok");
  });

  test("suspendForOutput is a no-op while no read is pending", () => {
    const { prompt, output } = makePrompt();
    prompt.suspendForOutput();
    prompt.resumeAfterOutput();
    expect(output.text()).toBe("");
  });

  test("queues lines pasted before the next sequential read", async () => {
    const { prompt, rl } = makePrompt();
    const first = prompt.read("› ");

    rl.emitLine("/help");
    rl.emitLine("/status");

    await expect(first).resolves.toBe("/help");
    await expect(prompt.read("› ")).resolves.toBe("/status");
  });

  test("confirm appends (y/N) and resolves true only for y/yes", async () => {
    const { prompt, rl } = makePrompt();
    const cases: Array<[string, boolean]> = [
      ["y", true],
      ["yes", true],
      ["Y", true],
      ["YES", true],
      ["n", false],
      ["no", false],
      ["", false],
      ["maybe", false],
    ];
    for (const [input, expected] of cases) {
      const pending = prompt.confirm("Continue?");
      expect(rl.promptText).toBe("Continue? (y/N) ");
      rl.emitLine(input);
      await expect(pending).resolves.toBe(expected);
    }
  });

  test("confirm treats Enter (empty) and interrupt/EOF as deny", async () => {
    const { prompt, rl } = makePrompt();
    // Empty line, the default Enter path, is a deny.
    const empty = prompt.confirm("Continue?");
    rl.emitLine("  ");
    await expect(empty).resolves.toBe(false);
    // Interrupt (Ctrl-C) resolves the pending confirm as null -> deny.
    const interrupted = prompt.confirm("Continue?");
    prompt.interrupt();
    await expect(interrupted).resolves.toBe(false);
  });
});

const COMMANDS: readonly SlashCommandDescriptor[] = [
  { name: "help", usage: "/help", description: "Show available commands" },
  { name: "goal", usage: "/goal [text]", description: "Manage the goal" },
  { name: "status", usage: "/status", description: "Show session status" },
];

class FakeInputRouter implements TerminalInputRouterPort {
  readonly readlineInput = new PassThrough();
  handler: TerminalKeyHandler | undefined;
  closed = false;

  constructor(
    private readonly fakeReadline: FakeReadline,
    private readonly delayWrites = false,
  ) {
    // Writes to the proxy (e.g. the controller's Ctrl-U replacement) reach
    // the fake readline as keypress input.
    this.readlineInput.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      if (text === "\x15") {
        this.fakeReadline.write(undefined, { ctrl: true, name: "u" });
      } else {
        this.fakeReadline.write(text);
      }
    });
  }

  setHandler(handler: TerminalKeyHandler | undefined): void {
    this.handler = handler;
  }

  close(): void {
    this.closed = true;
    this.handler = undefined;
  }

  /** Feeds a key to the controller; forwards into the fake readline on forward. */
  press(text: string, key: TerminalKey): void {
    if (this.handler === undefined) {
      this.fakeReadline.write(text);
      return;
    }
    const decision = this.handler(text, key);
    if (decision !== "forward") {
      return;
    }
    const deliver = () => {
      if (key.name === "return" || key.name === "enter") {
        this.fakeReadline.submitLine();
      } else if (key.name === "backspace") {
        this.fakeReadline.write("\x7f");
      } else if (key.name === undefined) {
        // Plain printable input appends; named editing keys are handled by
        // readline itself and are not simulated here.
        this.fakeReadline.write(text !== "" ? text : key.sequence);
      }
    };
    if (this.delayWrites) {
      setImmediate(deliver);
    } else {
      deliver();
    }
  }
}

class FakeSlashMenuPresenter implements SlashMenuPresenterPort {
  readonly renders: SlashCompletionSnapshot[] = [];
  clearCalls = 0;
  suspendCalls = 0;
  resumeCalls = 0;
  closed = false;
  lastResumed: SlashCompletionSnapshot | undefined;
  redrawInput: (() => void) | undefined;
  onDisable: (() => void) | undefined;
  disabled = false;

  render(snapshot: SlashCompletionSnapshot): void {
    this.renders.push(snapshot);
    this.redrawInput?.();
  }

  clear(): void {
    if (this.disabled) {
      return;
    }
    this.clearCalls += 1;
    this.redrawInput?.();
  }

  suspend(): void {
    this.suspendCalls += 1;
  }

  resume(snapshot: SlashCompletionSnapshot): void {
    this.resumeCalls += 1;
    this.lastResumed = snapshot;
    this.redrawInput?.();
  }

  close(): void {
    this.closed = true;
  }

  disable(): void {
    this.disabled = true;
    this.onDisable?.();
  }
}

function enhancedPrompt(options?: { delayWrites?: boolean }) {
  const rl = new FakeReadline();
  const output = new TTYStdout();
  const router = new FakeInputRouter(rl, options?.delayWrites === true);
  const presenter = new FakeSlashMenuPresenter();
  const prompt = new ReadlinePrompt({
    input: process.stdin,
    output: output as unknown as NodeJS.WritableStream,
    terminal: true,
    enhanced: true,
    theme: createTheme({ enabled: true }),
    interfaceFactory: () => rl as unknown as Interface,
    inputRouterFactory: () => router,
    menuPresenterFactory: (options) => {
      presenter.redrawInput = (options as typeof options & {
        redrawInput?: () => void;
      }).redrawInput;
      presenter.onDisable = (options as typeof options & {
        onDisable?: () => void;
      }).onDisable;
      return presenter;
    },
  });
  return { prompt, rl, output, router, presenter };
}

function pressText(router: FakeInputRouter, text: string): void {
  router.press(text, { sequence: text, ctrl: false, meta: false, shift: false });
}

function pressKey(router: FakeInputRouter, name: string, sequence = ""): void {
  router.press("", { sequence, name, ctrl: false, meta: false, shift: false });
}

describe("ReadlinePrompt slash palette", () => {
  test("menu render and clear redraw the readline input at the live-region anchor", async () => {
    const { prompt, rl, router } = enhancedPrompt();
    const pending = prompt.read("› ", { slashCommands: COMMANDS });
    expect(rl.promptCalls).toHaveLength(1);

    pressText(router, "/");
    expect(rl.promptCalls).toHaveLength(2);
    pressText(router, "g");
    expect(rl.promptCalls).toHaveLength(3);
    pressKey(router, "escape", "\x1b");
    expect(rl.promptCalls).toHaveLength(4);

    rl.emitLine("/g");
    await pending;
  });

  test("a disabled presenter exits palette mode and later resumes plain readline", async () => {
    const { prompt, rl, router, presenter } = enhancedPrompt();
    const pending = prompt.read("› ", { slashCommands: COMMANDS });
    pressText(router, "/");
    expect(router.handler).toBeDefined();

    const beforeDisable = rl.promptCalls.length;
    presenter.disable();
    expect(router.handler).toBeUndefined();
    expect(rl.promptCalls).toHaveLength(beforeDisable + 1);

    const beforeResume = rl.promptCalls.length;
    prompt.suspendForOutput();
    prompt.resumeAfterOutput();
    expect(rl.promptCalls).toHaveLength(beforeResume + 1);

    rl.emitLine("/");
    await pending;
  });

  test("enhanced TTY wires the router as the readline input and opens on /", async () => {
    const { prompt, rl, router, presenter } = enhancedPrompt();
    const pending = prompt.read("› ", { slashCommands: COMMANDS });
    pressText(router, "/");
    await Promise.resolve();
    expect(rl.line).toBe("/");
    expect(presenter.renders).toHaveLength(1);
    expect(presenter.renders[0]!.active).toBe(true);
    expect(presenter.renders[0]!.matches.map((match) => match.name)).toEqual([
      "help",
      "goal",
      "status",
    ]);
    // Cleanup so the pending read does not leak.
    rl.emitLine("/exit");
    await pending;
  });

  test("typing a prefix filters synchronously and Enter completes without executing", async () => {
    const { prompt, rl, router, presenter } = enhancedPrompt();
    const pending = prompt.read("› ", { slashCommands: COMMANDS });
    pressText(router, "/");
    expect(presenter.renders.at(-1)?.prefix).toBe("");
    expect(presenter.renders.at(-1)?.visibleMatches.map(({ name }) => name)).toEqual([
      "help",
      "goal",
      "status",
    ]);
    pressText(router, "g");
    expect(presenter.renders.at(-1)?.prefix).toBe("g");
    expect(presenter.renders.at(-1)?.visibleMatches.map(({ name }) => name)).toEqual(["goal"]);
    pressText(router, "o");
    expect(presenter.renders.at(-1)?.prefix).toBe("go");
    pressKey(router, "return", "\r");
    expect(rl.line).toBe("/goal ");
    expect(presenter.clearCalls).toBeGreaterThan(0);
    // Pending is not resolved by the completion.
    let resolved = false;
    void pending.then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    rl.emitLine("/goal ");
    await pending;
  });

  test("exact command Enter resolves the read", async () => {
    const { prompt, rl, router } = enhancedPrompt();
    const pending = prompt.read("› ", { slashCommands: COMMANDS });
    for (const char of "/help") {
      pressText(router, char);
      await Promise.resolve();
    }
    pressKey(router, "return", "\r");
    await expect(pending).resolves.toBe("/help");
  });

  test("Enter with no match resolves the original input", async () => {
    const { prompt, rl, router } = enhancedPrompt();
    const pending = prompt.read("› ", { slashCommands: COMMANDS });
    for (const char of "/zzz") {
      pressText(router, char);
      await Promise.resolve();
    }
    pressKey(router, "return", "\r");
    await expect(pending).resolves.toBe("/zzz");
  });

  test("Up/Down move the selection and are consumed", async () => {
    const { prompt, rl, router, presenter } = enhancedPrompt();
    const pending = prompt.read("› ", { slashCommands: COMMANDS });
    pressText(router, "/");
    await Promise.resolve();
    pressKey(router, "down", "\x1b[B");
    pressKey(router, "down", "\x1b[B");
    expect(presenter.renders.at(-1)!.selectedIndex).toBe(2);
    expect(rl.line).toBe("/");
    pressKey(router, "up", "\x1b[A");
    expect(presenter.renders.at(-1)!.selectedIndex).toBe(1);
    rl.emitLine("/");
    await pending;
  });

  test("Tab completes the selected command with a trailing space", async () => {
    const { prompt, rl, router, presenter } = enhancedPrompt();
    const pending = prompt.read("› ", { slashCommands: COMMANDS });
    pressText(router, "/");
    await Promise.resolve();
    for (const char of "go") {
      pressText(router, char);
      await Promise.resolve();
    }
    pressKey(router, "tab", "\t");
    expect(rl.line).toBe("/goal ");
    expect(presenter.clearCalls).toBeGreaterThan(0);
    rl.emitLine("/goal ");
    await pending;
  });

  test("Esc closes the palette and keeps the input", async () => {
    const { prompt, rl, router, presenter } = enhancedPrompt();
    const pending = prompt.read("› ", { slashCommands: COMMANDS });
    pressText(router, "/");
    await Promise.resolve();
    for (const char of "go") {
      pressText(router, char);
      await Promise.resolve();
    }
    pressKey(router, "escape", "\x1b");
    expect(presenter.clearCalls).toBeGreaterThan(0);
    expect(rl.line).toBe("/go");
    rl.emitLine("/go");
    await pending;
  });

  test("Backspace to an empty line closes the palette", async () => {
    const { prompt, rl, router, presenter } = enhancedPrompt();
    const pending = prompt.read("› ", { slashCommands: COMMANDS });
    pressText(router, "/");
    await Promise.resolve();
    pressKey(router, "backspace", "\x7f");
    await Promise.resolve();
    expect(rl.line).toBe("");
    expect(presenter.clearCalls).toBeGreaterThan(0);
    rl.emitLine("");
    await pending;
  });

  test("a second slash closes the palette and keeps the // escape", async () => {
    const { prompt, rl, router, presenter } = enhancedPrompt();
    const pending = prompt.read("› ", { slashCommands: COMMANDS });
    pressText(router, "/");
    await Promise.resolve();
    pressText(router, "/");
    await Promise.resolve();
    expect(rl.line).toBe("//");
    expect(presenter.clearCalls).toBeGreaterThan(0);
    rl.emitLine("//literal");
    await pending;
  });

  test("a space closes the palette and CJK args flow to readline", async () => {
    const { prompt, rl, router, presenter } = enhancedPrompt();
    const pending = prompt.read("› ", { slashCommands: COMMANDS });
    for (const char of "/goal ") {
      pressText(router, char);
      await Promise.resolve();
    }
    expect(presenter.clearCalls).toBeGreaterThan(0);
    pressText(router, "完成测试");
    expect(rl.line).toBe("/goal 完成测试");
    rl.emitLine(rl.line);
    await pending;
  });

  test("a pasted multi-character sequence keeps every character once", async () => {
    const { prompt, rl, router, presenter } = enhancedPrompt();
    const pending = prompt.read("› ", { slashCommands: COMMANDS });
    pressText(router, "/goal 完成测试");
    await Promise.resolve();
    expect(rl.line).toBe("/goal 完成测试");
    expect(presenter.renders).toHaveLength(0);
    rl.emitLine(rl.line);
    await pending;
  });

  test("Left/Right and non-ASCII exit the palette and forward", async () => {
    const { prompt, rl, router, presenter } = enhancedPrompt();
    const pending = prompt.read("› ", { slashCommands: COMMANDS });
    pressText(router, "/");
    await Promise.resolve();
    for (const char of "go") {
      pressText(router, char);
      await Promise.resolve();
    }
    pressKey(router, "left", "\x1b[D");
    expect(presenter.clearCalls).toBeGreaterThan(0);
    // A CJK char typed after exiting stays in the line.
    pressText(router, "完");
    expect(rl.line).toBe("/go完");
    rl.emitLine(rl.line);
    await pending;
  });

  test("Ctrl-C clears the palette and forwards to readline", async () => {
    const { prompt, rl, router, presenter } = enhancedPrompt();
    const pending = prompt.read("› ", { slashCommands: COMMANDS });
    pressText(router, "/");
    await Promise.resolve();
    for (const char of "go") {
      pressText(router, char);
      await Promise.resolve();
    }
    router.press("", { sequence: "\x03", name: "c", ctrl: true, meta: false, shift: false });
    expect(presenter.clearCalls).toBeGreaterThan(0);
    // The forwarded Ctrl-C reaches readline; emulate its SIGINT handling.
    rl.emitLine("/go");
    await pending;
  });

  test("queued lines resolve without installing the palette handler", async () => {
    const { prompt, rl, router, presenter } = enhancedPrompt();
    const first = prompt.read("› ", { slashCommands: COMMANDS });
    rl.emitLine("/help");
    rl.emitLine("/status");
    await first;
    // The next read resolves from the queue without touching the router.
    const second = prompt.read("› ", { slashCommands: COMMANDS });
    await expect(second).resolves.toBe("/status");
    expect(router.handler).toBeUndefined();
    expect(presenter.renders).toHaveLength(0);
  });

  test("confirm never opens the palette", async () => {
    const { prompt, rl, router, presenter } = enhancedPrompt();
    const pending = prompt.confirm("Continue?");
    pressText(router, "/");
    await Promise.resolve();
    expect(presenter.renders).toHaveLength(0);
    rl.emitLine("y");
    await pending;
  });

  test("suspend clears the menu and resume redraws the active snapshot", async () => {
    const { prompt, rl, router, presenter } = enhancedPrompt();
    const pending = prompt.read("› ", { slashCommands: COMMANDS });
    pressText(router, "/");
    await Promise.resolve();
    for (const char of "go") {
      pressText(router, char);
      await Promise.resolve();
    }
    prompt.suspendForOutput();
    expect(presenter.suspendCalls).toBe(1);
    prompt.resumeAfterOutput();
    expect(presenter.resumeCalls).toBe(1);
    expect(presenter.lastResumed?.active).toBe(true);
    rl.emitLine("/go");
    await pending;
  });

  test("interrupt clears the palette and allows a later read", async () => {
    const { prompt, rl, router, presenter } = enhancedPrompt();
    const pending = prompt.read("› ", { slashCommands: COMMANDS });
    pressText(router, "/go");
    await Promise.resolve();
    prompt.interrupt();
    await expect(pending).resolves.toBeNull();
    expect(presenter.clearCalls).toBeGreaterThan(0);
    expect(router.handler).toBeUndefined();
    // A later read still works.
    const again = prompt.read("› ", { slashCommands: COMMANDS });
    rl.emitLine("/status");
    await expect(again).resolves.toBe("/status");
  });

  test("close is idempotent and closes the router and presenter", async () => {
    const { prompt, router, presenter } = enhancedPrompt();
    prompt.close();
    prompt.close();
    expect(router.closed).toBe(true);
    expect(presenter.closed).toBe(true);
  });

  test("no descriptors means no palette on /", async () => {
    const { prompt, rl, router, presenter } = enhancedPrompt();
    const pending = prompt.read("› ");
    pressText(router, "/");
    await Promise.resolve();
    expect(presenter.renders).toHaveLength(0);
    rl.emitLine("/");
    await pending;
  });

  test("the palette never reads a stale readline line for its prefix", async () => {
    const { prompt, rl, router, presenter } = enhancedPrompt({ delayWrites: true });
    const pending = prompt.read("› ", { slashCommands: COMMANDS });
    // Writes are deferred, so during key handling readline still shows the old
    // line; the palette must track its own prefix, not read readline.
    pressText(router, "/");
    pressText(router, "g");
    expect(presenter.renders.at(-1)?.prefix).toBe("g");
    expect(presenter.renders.at(-1)?.visibleMatches.map(({ name }) => name)).toEqual(["goal"]);
    rl.emitLine("/g");
    await pending;
  });

  test("Backspace shrinks the prefix and an empty prefix closes the palette", async () => {
    const { prompt, rl, router, presenter } = enhancedPrompt();
    const pending = prompt.read("› ", { slashCommands: COMMANDS });
    pressText(router, "/");
    for (const char of "go") {
      pressText(router, char);
    }
    expect(presenter.renders.at(-1)?.prefix).toBe("go");
    pressKey(router, "backspace", "\x7f");
    expect(presenter.renders.at(-1)?.prefix).toBe("g");
    pressKey(router, "backspace", "\x7f");
    expect(presenter.renders.at(-1)?.prefix).toBe("");
    pressKey(router, "backspace", "\x7f");
    // Prefix was already empty: the palette closed and the backspace forwards.
    expect(presenter.clearCalls).toBeGreaterThan(0);
    rl.emitLine("");
    await pending;
  });

  test("a single /go sequence opens the palette with prefix go", async () => {
    const { prompt, rl, router, presenter } = enhancedPrompt();
    const pending = prompt.read("› ", { slashCommands: COMMANDS });
    pressText(router, "/go");
    expect(presenter.renders.at(-1)?.prefix).toBe("go");
    expect(presenter.renders.at(-1)?.visibleMatches.map(({ name }) => name)).toEqual(["goal"]);
    rl.emitLine("/go");
    await pending;
  });

  test("a pasted /goal sequence with args never opens the palette and keeps every char", async () => {
    const { prompt, rl, router, presenter } = enhancedPrompt();
    const pending = prompt.read("› ", { slashCommands: COMMANDS });
    pressText(router, "/goal 完成测试");
    expect(presenter.renders).toHaveLength(0);
    expect(rl.line).toBe("/goal 完成测试");
    rl.emitLine(rl.line);
    await pending;
  });

  test("a chunk typed while active extends the prefix", async () => {
    const { prompt, rl, router, presenter } = enhancedPrompt();
    const pending = prompt.read("› ", { slashCommands: COMMANDS });
    pressText(router, "/go");
    expect(presenter.renders.at(-1)?.prefix).toBe("go");
    pressText(router, "al");
    expect(presenter.renders.at(-1)?.prefix).toBe("goal");
    expect(presenter.renders.at(-1)?.visibleMatches.map(({ name }) => name)).toEqual(["goal"]);
    rl.emitLine("/goal");
    await pending;
  });

  test.each([
    ["space", " ", "space"],
    ["second slash", "/", "slash"],
    ["CJK", "完", "cjk"],
    ["Left", "\x1b[D", "left"],
    ["Ctrl-A", "\x01", "a"],
  ])("%s exits the palette and forwards", async (_label, text, name) => {
    const { prompt, rl, router, presenter } = enhancedPrompt();
    const pending = prompt.read("› ", { slashCommands: COMMANDS });
    pressText(router, "/go");
    expect(presenter.renders.at(-1)?.active).toBe(true);
    router.press("", { sequence: text, name, ctrl: false, meta: false, shift: false });
    expect(presenter.clearCalls).toBeGreaterThan(0);
    rl.emitLine("/go");
    await pending;
  });
});
