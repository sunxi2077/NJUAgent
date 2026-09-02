import { afterEach, describe, expect, test } from "vitest";
import type { Interface } from "node:readline";
import { PassThrough, Writable } from "node:stream";

import { SlashCommandRouter } from "../../src/cli/command-router.js";
import { ReadlinePrompt } from "../../src/cli/prompt.js";
import type { TerminalKey, TerminalKeyHandler, TerminalInputRouterPort } from "../../src/cli/terminal-input-router.js";
import type { SlashCompletionSnapshot } from "../../src/cli/slash-completion.js";
import type { SlashMenuPresenterPort } from "../../src/cli/slash-menu.js";
import type { SlashCommandDescriptor } from "../../src/cli/command.js";
import type { CommandContext } from "../../src/cli/command.js";
import { createTheme } from "../../src/cli/theme.js";

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

  submitLine(): void {
    this.emitLine(this.line);
  }
}

class RecordingOutput {
  readonly chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  text(): string {
    return this.chunks.join("");
  }
}

class FakeInputRouter implements TerminalInputRouterPort {
  readonly readlineInput = new PassThrough();
  handler: TerminalKeyHandler | undefined;
  closed = false;

  constructor(private readonly fakeReadline: FakeReadline) {
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

  press(text: string, key: TerminalKey): void {
    if (this.handler === undefined) {
      this.fakeReadline.write(text);
      return;
    }
    const decision = this.handler(text, key);
    if (decision !== "forward") {
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      this.fakeReadline.submitLine();
    } else if (key.name === "backspace") {
      this.fakeReadline.write("\x7f");
    } else if (key.name === undefined) {
      this.fakeReadline.write(text !== "" ? text : key.sequence);
    }
  }
}

class RecordingPresenter implements SlashMenuPresenterPort {
  readonly events: string[] = [];
  lastSnapshot: SlashCompletionSnapshot | undefined;
  closed = false;
  throwOnRender = false;

  render(snapshot: SlashCompletionSnapshot): void {
    if (this.throwOnRender) {
      throw new Error("presenter render exploded");
    }
    this.events.push("render");
    this.lastSnapshot = snapshot;
  }

  clear(): void {
    this.events.push("clear");
  }

  suspend(): void {
    this.events.push("suspend");
  }

  resume(snapshot: SlashCompletionSnapshot): void {
    this.events.push("resume");
    this.lastSnapshot = snapshot;
  }

  close(): void {
    this.closed = true;
  }
}

function descriptor(name: string, description = `the ${name} command`): SlashCommandDescriptor {
  return { name, usage: `/${name}`, description };
}

const COMMANDS = [
  descriptor("help"),
  descriptor("goal", "Set the completion goal"),
  descriptor("status"),
] as const;

const FOURTEEN_COMMANDS = [
  "help", "status", "sessions", "resume", "new", "history", "context",
  "compact", "plan", "goal", "skills", "skill", "setup", "exit",
].map((name) => descriptor(name));

function makeHarness(options?: { presenter?: SlashMenuPresenterPort }) {
  const router = new SlashCommandRouter();
  const executed: Array<{ name: string; args: string }> = [];
  for (const command of COMMANDS) {
    router.register({
      name: command.name,
      usage: command.usage,
      description: command.description,
      execute: async (args) => {
        executed.push({ name: command.name, args });
        return { kind: "continue" as const, stateChanged: false };
      },
    });
  }
  const rl = new FakeReadline();
  const output = new RecordingOutput();
  const inputRouter = new FakeInputRouter(rl);
  const presenter = (options?.presenter ?? new RecordingPresenter()) as RecordingPresenter;
  const prompt = new ReadlinePrompt({
    input: process.stdin,
    output: output as unknown as NodeJS.WritableStream,
    terminal: true,
    enhanced: true,
    theme: createTheme({ enabled: true }),
    interfaceFactory: () => rl as unknown as Interface,
    inputRouterFactory: () => inputRouter,
    menuPresenterFactory: () => presenter,
  });
  const renderer = { error: (_message: string) => {} };
  const context = {
    renderer,
    theme: createTheme({ enabled: false }),
    signal: new AbortController().signal,
    sessionManager: {} as never,
    store: {} as never,
    skillRegistry: {} as never,
    webSearchAvailable: false,
  } as unknown as CommandContext;
  return { router, executed, rl, output, inputRouter, presenter, prompt, context };
}

function pressText(router: FakeInputRouter, text: string): void {
  router.press(text, { sequence: text, ctrl: false, meta: false, shift: false });
}

function pressEnter(router: FakeInputRouter): void {
  router.press("", { sequence: "\r", name: "return", ctrl: false, meta: false, shift: false });
}

async function typeCommand(router: FakeInputRouter, text: string): Promise<void> {
  for (const char of text) {
    pressText(router, char);
    await Promise.resolve();
  }
}

describe("slash palette integration", () => {
  test("scenario one: /, go, Enter completes; Chinese args reach the router once", async () => {
    const { router, executed, rl, inputRouter, prompt, context } = makeHarness();
    const pending = prompt.read("› ", { slashCommands: router.descriptors() });
    await typeCommand(inputRouter, "/go");
    pressEnter(inputRouter);
    await Promise.resolve();
    // Completed but not executed, read still pending.
    expect(rl.line).toBe("/goal ");
    expect(executed).toHaveLength(0);

    pressText(inputRouter, "完成测试");
    expect(rl.line).toBe("/goal 完成测试");
    pressEnter(inputRouter);
    const text = await pending;
    const result = await router.route(text!, context);
    expect(result).toEqual({ kind: "handled", stateChanged: false });
    expect(executed).toEqual([{ name: "goal", args: "完成测试" }]);
  });

  test("scenario two: Down then Tab completes the selected command; Enter executes once", async () => {
    const { router, executed, rl, inputRouter, prompt, context } = makeHarness();
    const pending = prompt.read("› ", { slashCommands: router.descriptors() });
    await typeCommand(inputRouter, "/");
    inputRouter.press("", { sequence: "\x1b[B", name: "down", ctrl: false, meta: false, shift: false });
    inputRouter.press("", { sequence: "\x1b[B", name: "down", ctrl: false, meta: false, shift: false });
    inputRouter.press("", { sequence: "\t", name: "tab", ctrl: false, meta: false, shift: false });
    expect(rl.line).toBe("/status ");
    pressEnter(inputRouter);
    const text = await pending;
    await router.route(text!, context);
    expect(executed).toEqual([{ name: "status", args: "" }]);
  });

  test("scenario three: typing the exact command and Enter executes without a second Enter", async () => {
    const { router, executed, inputRouter, prompt, context } = makeHarness();
    const pending = prompt.read("› ", { slashCommands: router.descriptors() });
    await typeCommand(inputRouter, "/help");
    pressEnter(inputRouter);
    const text = await pending;
    await router.route(text!, context);
    expect(executed).toEqual([{ name: "help", args: "" }]);
  });

  test("scenario four: //literal keeps the escape semantics", async () => {
    const { router, inputRouter, prompt } = makeHarness();
    const pending = prompt.read("› ", { slashCommands: router.descriptors() });
    pressText(inputRouter, "//literal slash text");
    pressEnter(inputRouter);
    const text = await pending;
    const result = await router.route(text!, contextOf(router));
    expect(result).toEqual({ kind: "not_command", text: "/literal slash text" });
  });

  test("scenario five: an unknown command still reports Unknown Command", async () => {
    const errors: string[] = [];
    const { router, inputRouter, prompt } = makeHarness();
    const pending = prompt.read("› ", { slashCommands: router.descriptors() });
    await typeCommand(inputRouter, "/zzz");
    pressEnter(inputRouter);
    const text = await pending;
    const result = await router.route(text!, {
      renderer: { error: (message: string) => errors.push(message) },
      theme: createTheme({ enabled: false }),
      signal: new AbortController().signal,
      sessionManager: {} as never,
      store: {} as never,
      skillRegistry: {} as never,
      webSearchAvailable: false,
      display: { enhanced: false, columns: () => 80 },
    } as unknown as CommandContext);
    expect(result).toEqual({ kind: "handled", stateChanged: false });
    expect(errors.join("")).toContain("Unknown command");
  });

  test("scenario six: suspend clears the menu, resume redraws it after output", async () => {
    const { router, inputRouter, prompt, presenter } = makeHarness();
    const pending = prompt.read("› ", { slashCommands: router.descriptors() });
    await typeCommand(inputRouter, "/");
    prompt.suspendForOutput();
    const suspendAt = presenter.events.indexOf("suspend");
    prompt.resumeAfterOutput();
    const resumeAt = presenter.events.indexOf("resume");
    expect(suspendAt).toBeGreaterThanOrEqual(0);
    expect(resumeAt).toBeGreaterThan(suspendAt);
    expect(presenter.lastSnapshot?.active).toBe(true);
    inputRouter.press("", { sequence: "\x1b", name: "escape", ctrl: false, meta: false, shift: false });
    pressEnter(inputRouter);
    await pending;
  });

  test("a throwing presenter factory falls back to plain readline input", async () => {
    const rl = new FakeReadline();
    const output = new RecordingOutput();
    const prompt = new ReadlinePrompt({
      input: process.stdin,
      output: output as unknown as NodeJS.WritableStream,
      terminal: true,
      enhanced: true,
      theme: createTheme({ enabled: true }),
      interfaceFactory: () => rl as unknown as Interface,
      inputRouterFactory: () => new FakeInputRouter(rl),
      menuPresenterFactory: () => {
        throw new Error("no presenter");
      },
    });
    const pending = prompt.read("› ", { slashCommands: COMMANDS });
    rl.emitLine("plain text");
    await expect(pending).resolves.toBe("plain text");
  });

  test("a throwing presenter render fails open to readline input", async () => {
    const { rl, inputRouter, prompt } = makeHarness({
      presenter: Object.assign(new RecordingPresenter(), { throwOnRender: true }),
    });
    const pending = prompt.read("› ", { slashCommands: COMMANDS });
    pressText(inputRouter, "/");
    await Promise.resolve();
    pressText(inputRouter, "go");
    await Promise.resolve();
    expect(rl.line).toBe("/go");
    rl.emitLine("/go");
    await pending;
  });

  test("interrupt clears the palette and a later read still works", async () => {
    const { router, rl, inputRouter, prompt } = makeHarness();
    const first = prompt.read("› ", { slashCommands: router.descriptors() });
    pressText(inputRouter, "/go");
    await Promise.resolve();
    prompt.interrupt();
    await expect(first).resolves.toBeNull();
    const again = prompt.read("› ", { slashCommands: router.descriptors() });
    rl.emitLine("/status");
    await expect(again).resolves.toBe("/status");
  });

  test("close is idempotent and does not throw", async () => {
    const { prompt } = makeHarness();
    prompt.close();
    prompt.close();
  });

  test("EOF resolves null and clears the palette", async () => {
    const { router, rl, inputRouter, prompt } = makeHarness();
    const pending = prompt.read("› ", { slashCommands: router.descriptors() });
    pressText(inputRouter, "/go");
    await Promise.resolve();
    for (const handler of rl.handlers.get("close") ?? []) {
      handler();
    }
    await expect(pending).resolves.toBeNull();
  });

  test("enhanced false never builds a palette and emits no menu ANSI", async () => {
    const rl = new FakeReadline();
    const output = new RecordingOutput();
    const prompt = new ReadlinePrompt({
      input: process.stdin,
      output: output as unknown as NodeJS.WritableStream,
      terminal: true,
      enhanced: false,
      theme: createTheme({ enabled: false }),
      interfaceFactory: () => rl as unknown as Interface,
    });
    const pending = prompt.read("› ", { slashCommands: COMMANDS });
    rl.emitLine("/help");
    await expect(pending).resolves.toBe("/help");
    expect(output.text()).not.toContain("\x1b[s");
    expect(output.text()).not.toContain("Commands");
  });
});

function contextOf(_router: SlashCommandRouter): CommandContext {
  return {
    renderer: { error: () => {} },
    theme: createTheme({ enabled: false }),
    signal: new AbortController().signal,
    sessionManager: {} as never,
    store: {} as never,
    skillRegistry: {} as never,
    webSearchAvailable: false,
  } as unknown as CommandContext;
}

describe("slash palette real streams", () => {
  class TtyInput extends PassThrough {
    readonly rawModeCalls: boolean[] = [];

    get isTTY(): boolean {
      return true;
    }

    setRawMode(value: boolean): this {
      this.rawModeCalls.push(value);
      return this;
    }
  }

  class TtyOutput extends Writable {
    columns = 80;
    readonly chunks: string[] = [];

    get isTTY(): boolean {
      return true;
    }

    override _write(
      chunk: Buffer | string,
      _encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ): void {
      this.chunks.push(chunk.toString());
      callback();
    }
  }

  async function waitFor(predicate: () => boolean, message: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (predicate()) {
        return;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error(message);
  }

  function makeRealPrompt(presenter: RecordingPresenter, commands: readonly SlashCommandDescriptor[]) {
    const input = new TtyInput();
    const output = new TtyOutput();
    const prompt = new ReadlinePrompt({
      input,
      output,
      terminal: true,
      enhanced: true,
      theme: createTheme({ enabled: false }),
      menuPresenterFactory: () => presenter,
    });
    return { input, output, prompt };
  }

  test("real readline: / then g filters to goal and Enter completes goal, not help", async () => {
    const presenter = new RecordingPresenter();
    const { input, output, prompt } = makeRealPrompt(presenter, COMMANDS);
    const pending = prompt.read("\u203a ", { slashCommands: COMMANDS });

    input.write("/");
    await waitFor(() => presenter.lastSnapshot?.prefix === "", "palette open");
    expect(presenter.lastSnapshot?.visibleMatches.map(({ name }) => name)).toEqual([
      "help",
      "goal",
      "status",
    ]);

    input.write("g");
    await waitFor(() => presenter.lastSnapshot?.prefix === "g", "prefix g");
    expect(presenter.lastSnapshot?.visibleMatches.map(({ name }) => name)).toEqual(["goal"]);

    // Enter completes to "/goal " without submitting.
    input.write("\r");
    await waitFor(() => presenter.events.at(-1) === "clear", "complete on first Enter");
    // Second Enter submits the completed line.
    input.write("\r");
    const text = await pending;
    expect(text).toBe("/goal ");

    prompt.close();
    expect(input.rawModeCalls.at(-1)).toBe(false);
  });

  test("real readline: all fourteen commands are reachable and wrap around", async () => {
    const presenter = new RecordingPresenter();
    const { input, prompt } = makeRealPrompt(presenter, FOURTEEN_COMMANDS);
    const pending = prompt.read("\u203a ", { slashCommands: FOURTEEN_COMMANDS });

    input.write("/");
    await waitFor(() => presenter.lastSnapshot?.active === true, "palette open");
    for (let index = 0; index < 13; index += 1) {
      input.write("\x1b[B");
      await waitFor(
        () => presenter.lastSnapshot?.selectedIndex === index + 1,
        `down to ${index + 1}`,
      );
    }
    expect(presenter.lastSnapshot?.selectedIndex).toBe(13);
    expect(presenter.lastSnapshot?.visibleMatches.at(-1)?.name).toBe("exit");

    // Wraps from exit back to help.
    input.write("\x1b[B");
    await waitFor(() => presenter.lastSnapshot?.selectedIndex === 0, "wrap to help");
    expect(presenter.lastSnapshot?.visibleMatches[0]?.name).toBe("help");

    // Back down to exit, then Tab + Enter reads "/exit ".
    for (let index = 0; index < 13; index += 1) {
      input.write("\x1b[B");
      await waitFor(
        () => presenter.lastSnapshot?.selectedIndex === index + 1,
        `down again to ${index + 1}`,
      );
    }
    input.write("\t");
    await waitFor(() => presenter.events.at(-1) === "clear", "tab complete");
    input.write("\r");
    const text = await pending;
    expect(text).toBe("/exit ");

    prompt.close();
  });

  test("close restores keypress listeners and disables raw mode", async () => {
    const presenter = new RecordingPresenter();
    const input = new TtyInput();
    const output = new TtyOutput();
    const baseline = input.listenerCount("keypress");
    const prompt = new ReadlinePrompt({
      input,
      output,
      terminal: true,
      enhanced: true,
      theme: createTheme({ enabled: false }),
      menuPresenterFactory: () => presenter,
    });
    const pending = prompt.read("\u203a ", { slashCommands: COMMANDS });
    expect(input.listenerCount("keypress")).toBeGreaterThan(baseline);
    prompt.close();
    expect(input.listenerCount("keypress")).toBe(baseline);
    expect(input.rawModeCalls.at(-1)).toBe(false);
    await pending.catch(() => {});
  });
});
