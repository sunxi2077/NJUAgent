import type { RunResult } from "../agent/result.js";
import type { Prompt } from "./prompt.js";
import type { Renderer } from "./renderer.js";

export type RunTurn = (
  userText: string,
  signal: AbortSignal,
) => Promise<RunResult>;

export type CliSessionOptions = {
  prompt: Prompt;
  renderer: Renderer;
  runTurn: RunTurn;
};

const INPUT_PROMPT = "› ";
const EXIT_COMMAND = "/exit";

export class CliSession {
  readonly #prompt: Prompt;
  readonly #renderer: Renderer;
  readonly #runTurn: RunTurn;
  #current: AbortController | undefined;
  #exitRequested = false;

  constructor(options: CliSessionOptions) {
    this.#prompt = options.prompt;
    this.#renderer = options.renderer;
    this.#runTurn = options.runTurn;
  }

  async start(): Promise<void> {
    this.#prompt.onSigint(() => this.#handleSigint());
    for (;;) {
      if (this.#exitRequested) {
        break;
      }
      const text = await this.#prompt.read(INPUT_PROMPT);
      if (text === null || this.#exitRequested) {
        break;
      }
      const trimmed = text.trim();
      if (trimmed === "") {
        continue;
      }
      if (trimmed === EXIT_COMMAND) {
        break;
      }
      await this.#runTurnSafe(trimmed);
    }
    this.#prompt.close();
  }

  #handleSigint(): void {
    if (this.#current !== undefined) {
      // First Ctrl-C during a run cancels the current turn and returns to input.
      this.#current.abort();
      this.#prompt.interrupt();
    } else {
      // Ctrl-C at the idle prompt (or while no turn is running) exits the session.
      this.#exitRequested = true;
      this.#prompt.interrupt();
    }
  }

  async #runTurnSafe(text: string): Promise<void> {
    if (this.#current !== undefined) {
      // A run is already in progress; never start a second concurrent turn.
      return;
    }
    const controller = new AbortController();
    this.#current = controller;
    try {
      await this.#runTurn(text, controller.signal);
    } catch (error) {
      this.#renderer.error(error instanceof Error ? error.message : String(error));
    } finally {
      this.#current = undefined;
    }
  }
}
