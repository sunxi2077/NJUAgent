import { createInterface, type Interface } from "node:readline";

import type { ToolExecutionRequest } from "../tools/tool.js";

export interface Prompt {
  /** Reads one line of user input; resolves `null` on EOF or after `interrupt()`. */
  read(promptText: string): Promise<string | null>;
  /** Asks a yes/no question; resolves `false` when declined or interrupted. */
  confirm(question: string): Promise<boolean>;
  /** Registers the handler invoked on Ctrl-C (readline SIGINT or process SIGINT fallback). */
  onSigint(handler: () => void): void;
  /** Resolves any pending read as `null`, releasing a waiting prompt. */
  interrupt(): void;
  /** Releases terminal resources. */
  close(): void;
}

export type ReadlinePromptOptions = {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  terminal: boolean;
};

export class ReadlinePrompt implements Prompt {
  readonly #rl: Interface;
  readonly #output: NodeJS.WritableStream;
  readonly #installProcessSigint: boolean;
  #pending: ((value: string | null) => void) | null = null;
  #sigintHandler: (() => void) | null = null;
  #closed = false;

  constructor(options: ReadlinePromptOptions) {
    this.#output = options.output;
    this.#installProcessSigint = !options.terminal;
    this.#rl = createInterface({
      input: options.input,
      output: options.output,
      terminal: options.terminal,
    });
    this.#rl.on("line", (line) => {
      const pending = this.#pending;
      this.#pending = null;
      pending?.(line);
    });
    this.#rl.on("close", () => {
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

  read(promptText: string): Promise<string | null> {
    this.#output.write(promptText);
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
    const pending = this.#pending;
    this.#pending = null;
    pending?.(null);
  }

  close(): void {
    if (!this.#closed) {
      this.#closed = true;
      if (this.#installProcessSigint) {
        process.off("SIGINT", this.#onProcessSigint);
      }
      this.#rl.close();
    }
  }
}

const MAX_SUMMARY_CHARS = 120;

function summarizeInput(input: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    serialized = String(input);
  }
  if (serialized === undefined) {
    serialized = String(input);
  }
  if (serialized.length <= MAX_SUMMARY_CHARS) {
    return serialized;
  }
  return `${serialized.slice(0, MAX_SUMMARY_CHARS)}…`;
}

/** Formats the permission question shown to the user before an `ask` decision. */
export function formatPermissionQuestion(
  call: ToolExecutionRequest,
  reason: string,
): string {
  return `Allow ${call.name}(${summarizeInput(call.input)})? ${reason}`;
}
