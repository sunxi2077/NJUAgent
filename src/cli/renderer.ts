import pc from "picocolors";

import type { AgentEvent } from "../agent/events.js";
import type { RunResult } from "../agent/result.js";
import type { ToolExecutionRequest, ToolOutputStream } from "../tools/tool.js";

export interface Renderer {
  handle(event: AgentEvent): void;
  toolOutput(
    call: ToolExecutionRequest,
    stream: ToolOutputStream,
    text: string,
  ): void;
  error(message: string): void;
}

export interface TextWriter {
  write(text: string): unknown;
}

export type TerminalRendererOptions = {
  stdout: TextWriter;
  isTTY: boolean;
  /** Force fully plain output even on a TTY (e.g. NO_COLOR). */
  noColor?: boolean;
};

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function envNoColor(): boolean {
  const value = process.env.NO_COLOR;
  return value !== undefined && value !== "";
}

export class TerminalRenderer implements Renderer {
  readonly #stdout: TextWriter;
  /** Interactive rendering: colors, spinner and transient status line. */
  readonly #interactive: boolean;
  #transient = "";
  /** Whether streamed model text is on screen without a trailing newline. */
  #streamingText = false;
  #spinnerIndex = 0;

  constructor(options: TerminalRendererOptions) {
    this.#stdout = options.stdout;
    this.#interactive = options.isTTY && !(options.noColor ?? envNoColor());
  }

  handle(event: AgentEvent): void {
    switch (event.type) {
      case "model_started":
        if (this.#interactive) {
          this.#status(`model step ${event.step}…`);
        } else {
          this.#write(`[model] step ${event.step} started\n`);
        }
        break;
      case "text_delta":
        if (this.#interactive) {
          // Stream text inline as it arrives so the reply visibly grows
          // instead of jumping into the scrollback only at completion.
          if (this.#transient !== "") {
            this.#clearLine();
            this.#transient = "";
          }
          this.#stdout.write(event.text);
          this.#streamingText = true;
        } else {
          this.#plainLines("[model]", event.text);
        }
        break;
      case "usage":
        if (this.#interactive) {
          this.#status(`in=${event.inputTokens} out=${event.outputTokens} tokens`);
        } else {
          this.#write(`[usage] in=${event.inputTokens} out=${event.outputTokens}\n`);
        }
        break;
      case "model_completed":
        this.#flushStreamingText();
        if (this.#interactive) {
          this.#status(`${pc.green("✓")} model completed (${event.stopReason})`);
        } else {
          this.#write(`[model] completed (stop: ${event.stopReason})\n`);
        }
        break;
      case "retrying":
        if (this.#interactive) {
          this.#permanent(
            pc.yellow(`↻ retry attempt ${event.attempt} in ${event.delayMs}ms: ${event.reason}`),
          );
        } else {
          this.#write(`[retry] attempt ${event.attempt} in ${event.delayMs}ms: ${event.reason}\n`);
        }
        break;
      case "tool_started":
        this.#flushStreamingText();
        if (this.#interactive) {
          this.#permanent(
            `${pc.cyan(`⚙ ${event.name}`)} ${pc.dim(event.summary)} (${event.id})`,
          );
          this.#status(`${event.name}…`);
        } else {
          this.#write(`[tool] ${event.name} started (${event.id}): ${event.summary}\n`);
        }
        break;
      case "tool_completed":
        if (this.#interactive) {
          const mark = event.ok ? pc.green("✓") : pc.red("✗");
          const name = event.ok ? event.name : pc.red(event.name);
          this.#permanent(`  ${mark} ${name} ${event.durationMs}ms`);
          this.#status("");
        } else {
          const outcome = event.ok ? "ok" : "failed";
          this.#write(
            `[tool] ${event.name} ${outcome} in ${event.durationMs}ms (${event.id})\n`,
          );
        }
        break;
      case "run_finished":
        this.#flushStreamingText();
        this.#renderRunResult(event.result);
        break;
    }
  }

  toolOutput(
    _call: ToolExecutionRequest,
    stream: ToolOutputStream,
    text: string,
  ): void {
    if (text.length === 0) {
      return;
    }
    if (this.#interactive) {
      for (const line of text.split("\n")) {
        if (line !== "") {
          this.#permanent(stream === "stderr" ? pc.red(line) : line);
        }
      }
      return;
    }
    this.#plainLines(`[${stream}]`, text);
  }

  error(message: string): void {
    if (this.#interactive) {
      this.#permanent(pc.red(`✖ ${message}`));
      this.#status("");
    } else {
      this.#write(`[error] ${message}\n`);
    }
  }

  #renderRunResult(result: RunResult): void {
    const stats = `steps=${result.steps} tool_calls=${result.toolCalls} duration_ms=${result.durationMs}`;
    if (this.#interactive) {
      const status = this.#statusColor(result.status)(result.status);
      this.#permanent(`${status} ${stats}`);
      if ("message" in result && result.message !== "") {
        this.#permanent(`  ${pc.red(result.message)}`);
      }
      this.#status("");
      return;
    }
    const message = "message" in result && result.message !== ""
      ? `${result.status}: ${result.message}`
      : result.status;
    this.#write(`[run] ${message} ${stats}\n`);
  }

  #statusColor(status: RunResult["status"]): (text: string) => string {
    switch (status) {
      case "completed":
        return pc.green;
      case "limit_reached":
      case "context_limit":
        return pc.yellow;
      case "cancelled":
        return pc.cyan;
      case "model_failed":
      case "internal_failed":
        return pc.red;
    }
  }

  /** Completes an in-progress streamed text line so the next write starts fresh. */
  #flushStreamingText(): void {
    if (this.#streamingText) {
      this.#stdout.write("\n");
      this.#streamingText = false;
    }
  }

  #status(text: string): void {
    if (!this.#interactive) {
      return;
    }
    this.#flushStreamingText();
    this.#transient = text;
    this.#clearLine();
    if (text === "") {
      return;
    }
    this.#stdout.write(`${this.#spinner()} ${text}`);
  }

  #spinner(): string {
    const frame = SPINNER_FRAMES[this.#spinnerIndex % SPINNER_FRAMES.length] ?? "|";
    this.#spinnerIndex += 1;
    return pc.cyan(frame);
  }

  #permanent(text: string): void {
    this.#flushStreamingText();
    if (this.#transient !== "") {
      this.#clearLine();
    }
    this.#stdout.write(`${text}\n`);
    if (this.#transient !== "") {
      this.#stdout.write(`${this.#spinner()} ${this.#transient}`);
    }
  }

  #clearLine(): void {
    this.#stdout.write("\r\x1b[K");
  }

  #plainLines(prefix: string, text: string): void {
    for (const line of text.split("\n")) {
      this.#write(`${prefix} ${line}\n`);
    }
  }

  #write(text: string): void {
    this.#stdout.write(text);
  }
}
