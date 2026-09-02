import type { RunResult } from "../agent/result.js";
import type { CommandContext } from "./command.js";
import type { SlashCommandRouter } from "./command-router.js";
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
  router?: SlashCommandRouter;
  commandContext?: CommandContext;
  inputPrompt?: string;
  flushBeforeExit?: () => Promise<void>;
};

const DEFAULT_INPUT_PROMPT = "› ";
const EXIT_COMMAND = "/exit";

export class CliSession {
  readonly #prompt: Prompt;
  readonly #renderer: Renderer;
  readonly #runTurn: RunTurn;
  readonly #router: SlashCommandRouter | undefined;
  readonly #commandContext: CommandContext | undefined;
  readonly #flushBeforeExit: (() => Promise<void>) | undefined;
  readonly #inputPrompt: string;
  #current: AbortController | undefined;
  #exitRequested = false;
  #resumeAfterSigint = false;
  #exitConfirmationPending = false;

  constructor(options: CliSessionOptions) {
    this.#prompt = options.prompt;
    this.#renderer = options.renderer;
    this.#runTurn = options.runTurn;
    this.#router = options.router;
    this.#commandContext = options.commandContext;
    this.#flushBeforeExit = options.flushBeforeExit;
    this.#inputPrompt = options.inputPrompt ?? DEFAULT_INPUT_PROMPT;
  }

  async start(): Promise<void> {
    this.#prompt.onSigint(() => this.#handleSigint());
    try {
      for (;;) {
      if (this.#exitRequested) {
        break;
      }
      const readOptions = this.#router === undefined
        ? undefined
        : { slashCommands: this.#router.descriptors() };
      const text = await this.#prompt.read(this.#inputPrompt, readOptions);
      if (this.#exitRequested) {
        break;
      }
      if (text === null) {
        if (this.#resumeAfterSigint) {
          this.#resumeAfterSigint = false;
          continue;
        }
        break;
      }
      const trimmed = text.trim();
      if (trimmed === "") {
        continue;
      }
      this.#exitConfirmationPending = false;
      if (this.#router !== undefined && this.#commandContext !== undefined) {
        const controller = new AbortController();
        this.#current = controller;
        let routed;
        try {
          routed = await this.#router.route(trimmed, {
            ...this.#commandContext,
            signal: controller.signal,
          });
        } finally {
          this.#current = undefined;
        }
        if (routed.kind === "exit") {
          break;
        }
        if (routed.kind === "handled") {
          continue;
        }
        await this.#runTurnSafe(routed.text);
      } else if (trimmed === EXIT_COMMAND) {
        break;
      } else {
        await this.#runTurnSafe(trimmed);
      }
      }
      await this.#flushBeforeExit?.();
    } finally {
      this.#prompt.close();
    }
  }

  #handleSigint(): void {
    if (this.#current !== undefined) {
      this.#renderer.print("Cancelling current task…");
      this.#current.abort();
      this.#prompt.interrupt();
      return;
    }

    if (this.#exitConfirmationPending) {
      this.#exitRequested = true;
      this.#prompt.interrupt();
      return;
    }

    this.#exitConfirmationPending = true;
    this.#resumeAfterSigint = true;
    this.#prompt.interrupt();
    this.#renderer.print("Press Ctrl-C again to exit.");
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
