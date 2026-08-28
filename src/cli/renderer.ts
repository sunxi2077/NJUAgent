import { createTheme, type TerminalTheme } from "./theme.js";
import { StreamingMarkdownRenderer } from "./streaming-markdown.js";

import type { AgentEvent } from "../agent/events.js";
import type { RunResult } from "../agent/result.js";
import type { ToolExecutionRequest, ToolOutputStream } from "../tools/tool.js";
import { LiveOutputLimiter } from "./output-limiter.js";
import type { Prompt } from "./prompt.js";

export interface Renderer {
  handle(event: AgentEvent): void;
  toolOutput(
    call: ToolExecutionRequest,
    stream: ToolOutputStream,
    text: string,
  ): void;
  /** Writes a permanent, non-error text line (e.g. slash-command output). */
  print(text: string): void;
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
  /** Per-tool-call live terminal output budget in bytes. */
  maxLiveOutputBytes?: number;
  /** Terminal styles; defaults to the interactive decision. */
  theme?: TerminalTheme;
  /** Coordinates writes with a live readline prompt (suspend/resume redraw). */
  inputSurface?: Pick<Prompt, "suspendForOutput" | "resumeAfterOutput">;
};

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DEFAULT_MAX_LIVE_OUTPUT_BYTES = 65_536;

function conciseToolSummary(summary: string): string {
  try {
    const parsed = JSON.parse(summary) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      for (const key of ["path", "command", "query", "pattern"] as const) {
        const value = record[key];
        if (typeof value === "string" && value.trim() !== "") {
          return value.length > 100 ? `${value.slice(0, 99)}…` : value;
        }
      }
    }
  } catch {
    // Some tools already provide a human-readable summary.
  }
  return summary.length > 100 ? `${summary.slice(0, 99)}…` : summary;
}

function duration(ms: number): string {
  return ms < 1_000 ? `${ms}ms` : `${(ms / 1_000).toFixed(1)}s`;
}

function envNoColor(): boolean {
  const value = process.env.NO_COLOR;
  return value !== undefined && value !== "";
}

export class TerminalRenderer implements Renderer {
  readonly #stdout: TextWriter;
  /** Interactive rendering: colors, spinner and transient status line. */
  readonly #interactive: boolean;
  readonly #liveOutputLimiter: LiveOutputLimiter;
  readonly #liveOutputLimit: number;
  readonly #theme: TerminalTheme;
  readonly #inputSurface: TerminalRendererOptions["inputSurface"];
  readonly #markdown: StreamingMarkdownRenderer;
  #transient = "";
  /** Whether the `◆ NJUAgent` anchor has been written for the current step. */
  #assistantLabelShown = false;
  /** Whether streamed model text is on screen without a trailing newline. */
  #modelLineOpen = false;
  /** Partial plain-mode model line waiting for a newline or completion. */
  #plainModelBuffer = "";
  #spinnerIndex = 0;

  constructor(options: TerminalRendererOptions) {
    this.#stdout = options.stdout;
    this.#interactive = options.isTTY && !(options.noColor ?? envNoColor());
    this.#liveOutputLimit = options.maxLiveOutputBytes ?? DEFAULT_MAX_LIVE_OUTPUT_BYTES;
    this.#liveOutputLimiter = new LiveOutputLimiter(this.#liveOutputLimit);
    this.#theme = options.theme ?? createTheme({ enabled: this.#interactive });
    this.#inputSurface = options.inputSurface;
    this.#markdown = new StreamingMarkdownRenderer(this.#theme);
  }

  handle(event: AgentEvent): void {
    switch (event.type) {
      case "model_started":
        if (this.#interactive) {
          this.#assistantLabelShown = false;
          this.#markdown.reset();
          this.#modelLineOpen = false;
          this.#status(`model step ${event.step}…`);
        } else {
          this.#write(`[model] step ${event.step} started\n`);
        }
        break;
      case "text_delta":
        if (this.#interactive) {
          if (event.text === "") {
            break;
          }
          if (!this.#assistantLabelShown) {
            this.#assistantLabelShown = true;
            this.#writeModelStream(`${this.#theme.assistantLabel("◆ NJUAgent")}\n\n`);
          }
          const rendered = this.#markdown.push(event.text);
          this.#writeModelStream(rendered.text);
          this.#modelLineOpen = rendered.lineOpen;
        } else {
          this.#writePlainModelDelta(event.text);
        }
        break;
      case "usage":
        if (this.#interactive) {
          this.#flushModelText();
          this.#status(`in=${event.inputTokens} out=${event.outputTokens} tokens`);
        } else {
          this.#write(`[usage] in=${event.inputTokens} out=${event.outputTokens}\n`);
        }
        break;
      case "model_completed":
        this.#flushModelText();
        this.#flushPlainModelText();
        if (this.#interactive) {
          this.#status(`${this.#theme.success("✓")} model completed (${event.stopReason})`);
        } else {
          this.#write(`[model] completed (stop: ${event.stopReason})\n`);
        }
        break;
      case "retrying":
        if (this.#interactive) {
          this.#flushModelText();
          this.#permanent(
            this.#theme.warning(`↻ retry attempt ${event.attempt} in ${event.delayMs}ms: ${event.reason}`),
          );
        } else {
          this.#write(`[retry] attempt ${event.attempt} in ${event.delayMs}ms: ${event.reason}\n`);
        }
        break;
      case "tool_started":
        this.#flushModelText();
        if (this.#interactive) {
          const summary = conciseToolSummary(event.summary);
          this.#permanent(
            `${this.#theme.brandStrong("⚙")} ${event.name}${summary === "" ? "" : ` · ${summary}`}`,
          );
          this.#status(`${event.name}…`);
        } else {
          this.#write(`[tool] ${event.name} started (${event.id}): ${event.summary}\n`);
        }
        break;
      case "tool_completed":
        this.#liveOutputLimiter.finish(event.id);
        if (this.#interactive) {
          const mark = event.ok ? this.#theme.success("✓") : this.#theme.error("✗");
          const name = event.ok ? event.name : this.#theme.error(event.name);
          this.#permanent(`  ${mark} ${name} · ${duration(event.durationMs)}`);
          this.#status("");
        } else {
          const outcome = event.ok ? "ok" : "failed";
          this.#write(
            `[tool] ${event.name} ${outcome} in ${event.durationMs}ms (${event.id})\n`,
          );
        }
        break;
      case "run_finished":
        this.#flushModelText();
        this.#flushPlainModelText();
        this.#renderRunResult(event.result);
        break;
    }
  }

  toolOutput(
    call: ToolExecutionRequest,
    stream: ToolOutputStream,
    text: string,
  ): void {
    if (text.length === 0) {
      return;
    }
    const limited = this.#liveOutputLimiter.consume(call.id, text);
    if (limited.suppressionStarted) {
      const message = `[output] live output suppressed after ${this.#liveOutputLimit} bytes`;
      if (this.#interactive) {
        this.#permanent(this.#theme.muted(message));
      } else {
        this.#write(`${message}\n`);
      }
    }
    if (limited.text.length === 0) {
      return;
    }
    if (this.#interactive) {
      for (const line of limited.text.split("\n")) {
        if (line !== "") {
          const content = stream === "stderr" ? this.#theme.error(line) : line;
          this.#permanent(`  │ ${content}`);
        }
      }
      return;
    }
    this.#plainLines(`[${stream}]`, limited.text);
  }

  print(text: string): void {
    this.#permanent(text);
  }

  error(message: string): void {
    if (this.#interactive) {
      this.#flushModelText();
      this.#permanent(this.#theme.error(`✖ ${message}`));
      this.#status("");
    } else {
      this.#write(`[error] ${message}\n`);
    }
  }

  #renderRunResult(result: RunResult): void {
    const stats = `steps=${result.steps} tool_calls=${result.toolCalls} duration_ms=${result.durationMs}`;
    if (this.#interactive) {
      const labels: Record<RunResult["status"], { symbol: string; label: string }> = {
        completed: { symbol: "✓", label: "Completed" },
        cancelled: { symbol: "–", label: "Cancelled" },
        limit_reached: { symbol: "!", label: "Step limit reached" },
        context_limit: { symbol: "!", label: "Context limit reached" },
        model_failed: { symbol: "✗", label: "Model failed" },
        internal_failed: { symbol: "✗", label: "Internal failure" },
      };
      const view = labels[result.status];
      const toolLabel = `${result.toolCalls} tool call${result.toolCalls === 1 ? "" : "s"}`;
      const summary = `${view.label} · ${result.steps} steps · ${toolLabel} · ${duration(result.durationMs)}`;
      this.#permanent(`${this.#statusColor(result.status)(view.symbol)} ${summary}`);
      if ("message" in result && result.message !== "") {
        this.#permanent(`  ${this.#theme.error(result.message)}`);
      }
      // One blank line separates the run summary from the next readline prompt.
      this.#permanent("");
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
        return this.#theme.success;
      case "limit_reached":
      case "context_limit":
        return this.#theme.warning;
      case "cancelled":
        return this.#theme.brandStrong;
      case "model_failed":
      case "internal_failed":
        return this.#theme.error;
    }
  }

  /**
   * Flushes the streaming Markdown renderer at an output boundary: any pending
   * inline style or fence is closed, and an unterminated model line gains its
   * trailing newline so the next permanent write starts on a fresh line.
   */
  #flushModelText(): void {
    if (!this.#interactive) {
      return;
    }
    const remainder = this.#markdown.flush();
    if (remainder.text !== "") {
      this.#stdout.write(remainder.text);
    }
    this.#modelLineOpen = remainder.lineOpen;
    if (this.#modelLineOpen) {
      this.#stdout.write("\n");
    }
    this.#modelLineOpen = false;
  }

  /** Writes interactive model-stream bytes without forcing a newline. */
  #writeModelStream(text: string): void {
    if (text === "") {
      return;
    }
    this.#inputSurface?.suspendForOutput();
    try {
      if (this.#transient !== "") {
        this.#clearLine();
        this.#transient = "";
      }
      this.#stdout.write(text);
    } finally {
      this.#inputSurface?.resumeAfterOutput();
    }
  }

  #status(text: string): void {
    if (!this.#interactive) {
      return;
    }
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
    return this.#theme.brandStrong(frame);
  }

  #permanent(text: string): void {
    this.#inputSurface?.suspendForOutput();
    try {
      if (this.#transient !== "") {
        this.#clearLine();
      }
      this.#stdout.write(`${text}\n`);
      if (this.#transient !== "") {
        this.#stdout.write(`${this.#spinner()} ${this.#transient}`);
      }
    } finally {
      this.#inputSurface?.resumeAfterOutput();
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

  /** Buffers plain-mode model deltas and emits only complete lines. */
  #writePlainModelDelta(text: string): void {
    this.#plainModelBuffer += text;
    let newline = this.#plainModelBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#plainModelBuffer.slice(0, newline);
      this.#write(`[model] ${line}\n`);
      this.#plainModelBuffer = this.#plainModelBuffer.slice(newline + 1);
      newline = this.#plainModelBuffer.indexOf("\n");
    }
  }

  /** Flushes a trailing partial plain-mode model line at completion. */
  #flushPlainModelText(): void {
    if (this.#plainModelBuffer !== "") {
      this.#write(`[model] ${this.#plainModelBuffer}\n`);
      this.#plainModelBuffer = "";
    }
  }

  #write(text: string): void {
    this.#stdout.write(text);
  }
}
