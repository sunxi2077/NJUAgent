import {
  clearLine,
  createInterface,
  cursorTo,
  type Interface,
} from "node:readline";

import type { SlashCommandDescriptor } from "./command.js";
import { SlashCompletionModel } from "./slash-completion.js";
import { SlashMenuPresenter, type SlashMenuPresenterOptions, type SlashMenuPresenterPort } from "./slash-menu.js";
import { TerminalInputRouter, type TerminalInputRouterPort, type TerminalKey, type TerminalKeyDecision } from "./terminal-input-router.js";
import { createTheme, type TerminalTheme } from "./theme.js";

export type PromptReadOptions = {
  slashCommands?: readonly SlashCommandDescriptor[];
};

export interface Prompt {
  /** Reads one line of user input; resolves `null` on EOF or after `interrupt()`. */
  read(
    promptText: string,
    options?: PromptReadOptions,
  ): Promise<string | null>;
  /** Asks a yes/no question; resolves `false` when declined or interrupted. */
  confirm(question: string): Promise<boolean>;
  /** Registers the handler invoked on Ctrl-C (readline SIGINT or process SIGINT fallback). */
  onSigint(handler: () => void): void;
  /** Resolves any pending read as `null`, releasing a waiting prompt. */
  interrupt(): void;
  /** Clears the live prompt line so external output can be written cleanly. */
  suspendForOutput(): void;
  /** Redraws the prompt after external output; no-op when no read is pending. */
  resumeAfterOutput(): void;
  /** Releases terminal resources. */
  close(): void;
}

export type ReadlinePromptOptions = {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  terminal: boolean;
  /** Enable the slash palette (requires a real TTY). Defaults to false. */
  enhanced?: boolean;
  /** Theme used for palette styling; defaults to the disabled theme. */
  theme?: TerminalTheme;
  /** Initial terminal columns for the palette menu. */
  columns?: number;
  /** Test seam: replaces the readline interface factory. */
  interfaceFactory?: typeof createInterface;
  /** Test seam: replaces the keypress router factory. */
  inputRouterFactory?: (
    source: NodeJS.ReadableStream,
  ) => TerminalInputRouterPort;
  /** Test seam: replaces the menu presenter factory. */
  menuPresenterFactory?: (
    options: SlashMenuPresenterOptions,
  ) => SlashMenuPresenterPort;
};

type SlashInputMode = "inactive" | "active";

const COMMAND_CHUNK = /^[a-zA-Z0-9-]+$/u;
const COMPLETE_COMMAND_SEQUENCE = /^\/([a-zA-Z0-9-]*)$/u;

export class ReadlinePrompt implements Prompt {
  readonly #rl: Interface;
  readonly #output: NodeJS.WritableStream;
  readonly #installProcessSigint: boolean;
  readonly #terminal: boolean;
  readonly #inputRouter: TerminalInputRouterPort | undefined;
  readonly #presenter: SlashMenuPresenterPort | undefined;
  readonly #completion: SlashCompletionModel;
  #readOptions: PromptReadOptions | undefined;
  #pending: ((value: string | null) => void) | null = null;
  #sigintHandler: (() => void) | null = null;
  readonly #queuedLines: string[] = [];
  #suspended = false;
  #closed = false;
  #slashMode: SlashInputMode = "inactive";

  constructor(options: ReadlinePromptOptions) {
    this.#output = options.output;
    this.#terminal = options.terminal;
    this.#installProcessSigint = !options.terminal;
    const theme = options.theme ?? createTheme({ enabled: false });
    this.#completion = new SlashCompletionModel();

    const enhanced = options.enhanced === true && options.terminal;
    if (enhanced) {
      try {
        const routerFactory = options.inputRouterFactory ??
          ((source: NodeJS.ReadableStream) => new TerminalInputRouter(source));
        const presenterFactory = options.menuPresenterFactory ??
          ((presenterOptions: SlashMenuPresenterOptions) =>
            new SlashMenuPresenter(presenterOptions));
        this.#inputRouter = routerFactory(options.input);
        try {
          this.#presenter = presenterFactory({
            output: options.output,
            theme,
            ...(options.columns === undefined
              ? {}
              : { fallbackColumns: options.columns }),
          });
        } catch (error) {
          this.#inputRouter.close();
          throw error;
        }
      } catch {
        // The optional palette must never block the CLI: fall back to a plain
        // readline over the real input.
        this.#inputRouter = undefined;
        this.#presenter = undefined;
      }
    } else {
      this.#inputRouter = undefined;
      this.#presenter = undefined;
    }

    const factory = options.interfaceFactory ?? createInterface;
    const readlineInput = this.#inputRouter?.readlineInput ?? options.input;
    this.#rl = factory({
      input: readlineInput,
      output: options.output,
      terminal: options.terminal,
    });
    this.#rl.on("line", (line) => {
      const pending = this.#pending;
      if (pending === null) {
        this.#queuedLines.push(line);
      } else {
        this.#pending = null;
        this.#finishRead();
        pending(line);
      }
    });
    this.#rl.on("close", () => {
      this.#finishRead();
      const pending = this.#pending;
      this.#pending = null;
      pending?.(null);
    });
    // In terminal (raw) mode readline consumes Ctrl-C and emits 'SIGINT';
    // registering a listener prevents readline from closing on its own.
    this.#rl.on("SIGINT", () => {
      this.#sigintHandler?.();
    });
    if (this.#installProcessSigint) {
      process.on("SIGINT", this.#onProcessSigint);
    }
  }

  readonly #onProcessSigint = (): void => {
    this.#sigintHandler?.();
  };

  read(promptText: string, options?: PromptReadOptions): Promise<string | null> {
    if (this.#closed) {
      return Promise.resolve(null);
    }
    const queued = this.#queuedLines.shift();
    if (queued !== undefined) {
      // A queued line resolves immediately; the palette is never shown.
      return Promise.resolve(queued);
    }
    this.#readOptions = options;
    if (
      this.#inputRouter !== undefined &&
      options?.slashCommands !== undefined &&
      options.slashCommands.length > 0
    ) {
      this.#inputRouter.setHandler((text, key) => this.#onKey(text, key));
    }
    this.#rl.setPrompt(promptText);
    this.#rl.prompt(true);
    return new Promise((resolve) => {
      this.#pending = resolve;
    });
  }

  confirm(question: string): Promise<boolean> {
    return this.read(`${question} (y/N) `).then((answer) => {
      if (answer === null) {
        return false;
      }
      const normalized = answer.trim().toLowerCase();
      return normalized === "y" || normalized === "yes";
    });
  }

  onSigint(handler: () => void): void {
    this.#sigintHandler = handler;
  }

  interrupt(): void {
    this.#presenter?.clear();
    this.#completion.close();
    this.#readOptions = undefined;
    this.#inputRouter?.setHandler(undefined);
    const pending = this.#pending;
    this.#pending = null;
    pending?.(null);
  }

  suspendForOutput(): void {
    if (!this.#terminal || this.#pending === null || this.#suspended) {
      return;
    }
    this.#presenter?.suspend();
    clearLine(this.#output, 0);
    cursorTo(this.#output, 0);
    this.#suspended = true;
  }

  resumeAfterOutput(): void {
    if (!this.#suspended) {
      return;
    }
    this.#suspended = false;
    this.#rl.prompt(true);
    if (this.#presenter !== undefined && this.#completion.snapshot().active) {
      this.#presenter.resume(this.#completion.snapshot());
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#presenter?.close();
    this.#inputRouter?.close();
    if (this.#installProcessSigint) {
      process.off("SIGINT", this.#onProcessSigint);
    }
    this.#rl.close();
  }

  #onKey(text: string, key: TerminalKey): TerminalKeyDecision {
    try {
      const active = this.#slashMode === "active";
      const name = key.name;

      // Ctrl-C / Ctrl-D always clear the menu and keep the existing semantics.
      if (key.ctrl && (name === "c" || name === "d")) {
        this.#closePalette();
        return "forward";
      }

      if (!active) {
        // Open only from an untouched empty line and only for a complete
        // command sequence; anything else fails open to readline.
        const sequence = key.sequence !== "" ? key.sequence : text;
        if (
          this.#hasCommands() &&
          this.#currentLine() === "" &&
          this.#currentCursor() === 0
        ) {
          const match = COMPLETE_COMMAND_SEQUENCE.exec(sequence);
          if (match !== null) {
            this.#openPalette(match[1]!);
            return "forward";
          }
        }
        return "forward";
      }

      switch (name) {
        case "up":
          this.#completion.move(-1);
          this.#renderMenu();
          return "consume";
        case "down":
          this.#completion.move(1);
          this.#renderMenu();
          return "consume";
        case "tab":
          return this.#handleTab();
        case "escape":
          this.#closePalette();
          return "consume";
        case "return":
        case "enter":
          return this.#handleEnter();
        case "backspace": {
          const prefix = this.#completion.snapshot().prefix;
          if (prefix !== "") {
            this.#completion.updatePrefix(prefix.slice(0, -1));
            this.#renderMenu();
            return "forward";
          }
          // Prefix is empty: close so readline deletes the "/".
          this.#closePalette();
          return "forward";
        }
        default: {
          if (COMMAND_CHUNK.test(text)) {
            // Track the prefix ourselves; never read readline line-by-key.
            const next = `${this.#completion.snapshot().prefix}${text}`;
            this.#completion.updatePrefix(next);
            this.#renderMenu();
            return "forward";
          }
          // Space, a second slash, editing keys, CJK, or anything unknown:
          // close the palette and hand the key back to readline verbatim.
          this.#closePalette();
          return "forward";
        }
      }
    } catch {
      // A broken palette must never trap user input.
      this.#disablePalette();
      return "forward";
    }
  }

  #handleTab(): TerminalKeyDecision {
    const selected = this.#completion.selected();
    if (selected === undefined) {
      // Consume the tab so readline does not insert one, keep the menu open.
      return "consume";
    }
    this.#replaceCurrentLine(`/${selected.name} `);
    this.#closePalette();
    return "consume";
  }

  #handleEnter(): TerminalKeyDecision {
    const prefix = this.#completion.snapshot().prefix;
    const commands = this.#readOptions?.slashCommands ?? [];
    const exact = prefix !== "" && commands.some(
      (command) => command.name.toLowerCase() === prefix.toLowerCase(),
    );
    if (exact) {
      // The full command is typed: submit it to readline as-is.
      this.#closePalette();
      return "forward";
    }
    const selected = this.#completion.selected();
    if (selected !== undefined && prefix !== "") {
      // A prefix with a selection completes without submitting.
      this.#replaceCurrentLine(`/${selected.name} `);
      this.#closePalette();
      return "consume";
    }
    // No match: submit the original input (the Router reports Unknown Command).
    this.#closePalette();
    return "forward";
  }

  #openPalette(prefix: string): void {
    const commands = this.#readOptions?.slashCommands;
    if (commands === undefined || commands.length === 0) {
      return;
    }
    this.#completion.open(commands);
    this.#slashMode = "active";
    this.#completion.updatePrefix(prefix);
    this.#renderMenu();
  }

  #renderMenu(): void {
    this.#presenter?.render(this.#completion.snapshot());
  }

  #closePalette(): void {
    if (this.#slashMode === "inactive" && !this.#completion.snapshot().active) {
      return;
    }
    this.#presenter?.clear();
    this.#completion.close();
    this.#slashMode = "inactive";
  }

  #disablePalette(): void {
    try {
      this.#presenter?.clear();
    } catch {
      // Ignore presenter cleanup failures; the user must stay able to type.
    }
    try {
      this.#completion.close();
    } catch {
      // Ignore model cleanup failures.
    }
    this.#slashMode = "inactive";
    this.#inputRouter?.setHandler(undefined);
  }

  #finishRead(): void {
    this.#closePalette();
    this.#readOptions = undefined;
    this.#inputRouter?.setHandler(undefined);
  }

  #hasCommands(): boolean {
    const commands = this.#readOptions?.slashCommands;
    return commands !== undefined && commands.length > 0;
  }

  #replaceCurrentLine(text: string): void {
    // While active the readline line is exactly "/" + prefix, so completing
    // only needs to append the remaining part. Programmatic control-key
    // writes (Ctrl-U/backspace) are unreliable on real readline; plain string
    // insertion is the one dependable primitive.
    const prefix = this.#completion.snapshot().prefix;
    const current = `/${prefix}`;
    if (text.startsWith(current)) {
      this.#rl.write(text.slice(current.length));
    } else {
      // Abnormal state: fall back to inserting nothing; the palette is closed
      // by the caller so the user's line stays intact.
    }
  }

  #currentLine(): string {
    return (this.#rl as unknown as { line: string }).line;
  }

  #currentCursor(): number {
    return (this.#rl as unknown as { cursor: number }).cursor;
  }
}
