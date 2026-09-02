import { createTheme, type TerminalTheme } from "./theme.js";
import { StreamingMarkdownRenderer } from "./streaming-markdown.js";
import { terminalWidth } from "./terminal-text.js";
import type { PlanState } from "../planning/plan.js";
import type { GoalEvaluationDecision } from "../goals/goal.js";

import type { AgentEvent } from "../agent/events.js";
import type { RunResult } from "../agent/result.js";
import type { ToolExecutionRequest, ToolOutputStream } from "../tools/tool.js";
import { LiveOutputLimiter } from "./output-limiter.js";
import { makeToolPreview, toolReference } from "./tool-activity.js";
import type { Prompt } from "./prompt.js";

export interface Renderer {
  handle(event: AgentEvent): void;
  toolOutput(
    call: ToolExecutionRequest,
    stream: ToolOutputStream,
    text: string,
  ): void;
  /** Shows a permission prompt card/records before the user is asked. */
  permissionRequest(call: ToolExecutionRequest, reason: string): void;
  /** Records whether a permission prompt was allowed or denied. */
  permissionDecision(call: ToolExecutionRequest, approved: boolean): void;
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
const MAX_PERMISSION_SUMMARY_CODE_POINTS = 100;
const PERMISSION_LABEL_WIDTH = 8;

/**
 * Bounded stdout/stderr retained for one in-flight tool call so the finished
 * interactive card can show a preview without re-streaming output.
 */
type ToolCardBuffer = {
  name: string;
  /** Concise human-readable input summary captured at tool start. */
  summary: string;
  stdout: string;
  stderr: string;
};

/** Bounds one text run to a single line of at most 100 code points. */
function oneLineBounded(text: string): string {
  const single = text.replace(/\s+/gu, " ").trim();
  const codePoints = [...single];
  if (codePoints.length <= MAX_PERMISSION_SUMMARY_CODE_POINTS) {
    return single;
  }
  return `${codePoints.slice(0, MAX_PERMISSION_SUMMARY_CODE_POINTS).join("")}…`;
}

/**
 * Human-readable one-line summary of a tool call for permission prompts.
 * Prefers the most actionable single value (path, command, query, pattern),
 * collapses whitespace, and bounds the length.
 */
export function summarizeToolInput(call: ToolExecutionRequest): string {
  const input = call.input;
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    for (const key of ["path", "command", "query", "pattern"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.trim() !== "") {
        return oneLineBounded(value);
      }
    }
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    serialized = String(input);
  }
  return oneLineBounded(serialized ?? "");
}

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
  /** Bounded per-call output retained for interactive tool cards. */
  readonly #toolBuffers = new Map<string, ToolCardBuffer>();
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
          this.#toolBuffers.set(event.id, {
            name: event.name,
            summary: conciseToolSummary(event.summary),
            stdout: "",
            stderr: "",
          });
          this.#status(`${event.name}…`);
        } else {
          this.#write(`[tool] ${event.name} started (${event.id}): ${event.summary}\n`);
        }
        break;
      case "tool_completed":
        this.#liveOutputLimiter.finish(event.id);
        if (this.#interactive) {
          this.#flushModelText();
          const buffer = this.#toolBuffers.get(event.id) ?? {
            name: event.name,
            summary: "",
            stdout: "",
            stderr: "",
          };
          this.#toolBuffers.delete(event.id);
          this.#permanent(this.#toolCard(buffer, event.id, event.ok, event.durationMs));
          this.#status("");
        } else {
          const outcome = event.ok ? "ok" : "failed";
          this.#write(
            `[tool] ${event.name} ${outcome} in ${event.durationMs}ms (${event.id})\n`,
          );
        }
        break;
      case "plan_updated":
        this.#renderPlan(event.plan);
        break;
      case "goal_evaluation_started":
        if (this.#interactive) {
          this.#permanent(this.#theme.brandStrong("◇ Checking goal evidence…"));
        } else {
          this.#write(`[goal] evaluating attempt=${event.attempt}\n`);
        }
        break;
      case "goal_evaluation_completed":
        this.#renderGoalEvaluation(event.decision);
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
    if (!this.#interactive) {
      if (limited.suppressionStarted) {
        this.#write(`[output] live output suppressed after ${this.#liveOutputLimit} bytes\n`);
      }
      if (limited.text.length === 0) {
        return;
      }
      this.#plainLines(`[${stream}]`, limited.text);
      return;
    }
    // Interactive mode: nothing becomes permanent while the tool runs. The
    // bounded text is kept for the compact card rendered on completion; if no
    // start was seen (e.g. a mid-run attach) there is no card to fill.
    if (limited.text.length === 0) {
      return;
    }
    const buffer = this.#toolBuffers.get(call.id);
    if (buffer === undefined) {
      return;
    }
    if (stream === "stderr") {
      buffer.stderr += limited.text;
    } else {
      buffer.stdout += limited.text;
    }
  }

  print(text: string): void {
    this.#permanent(text);
  }

  permissionRequest(call: ToolExecutionRequest, reason: string): void {
    if (this.#interactive) {
      this.#writePermissionCard(call, reason);
    } else {
      const lines = [
        `[permission] tool=${call.name}`,
        `[permission] action=${summarizeToolInput(call)}`,
        `[permission] reason=${oneLineBounded(reason)}`,
      ];
      this.#write(`${lines.join("\n")}\n`);
    }
  }

  permissionDecision(call: ToolExecutionRequest, approved: boolean): void {
    if (this.#interactive) {
      const label = approved
        ? this.#theme.success(`✓ Allowed ${call.name} once`)
        : this.#theme.error(`✗ Denied ${call.name}`);
      this.#permanent(label);
      // Approval must not leave a silent gap: restore a visible running
      // status immediately and keep it until tool_completed replaces it with
      // the compact result card. A denial never claims the tool is running.
      this.#status(
        approved ? `${call.name} running… Ctrl-C cancels` : "",
      );
      return;
    }
    this.#write(`[permission] decision=${approved ? "allowed" : "denied"}\n`);
  }

  /**
   * Writes the permission card without redrawing a transient status: the
   * spinner line is cleared and stays cleared while the user answers.
   */
  #writePermissionCard(call: ToolExecutionRequest, reason: string): void {
    this.#inputSurface?.suspendForOutput();
    try {
      if (this.#transient !== "") {
        this.#clearLine();
        this.#transient = "";
      }
      const label = (text: string): string => text.padEnd(PERMISSION_LABEL_WIDTH);
      const rows = [
        this.#theme.warning("⚠ Permission required"),
        `${label("Tool")}${this.#theme.brandStrong(call.name)}`,
        `${label("Action")}${this.#theme.brandStrong(summarizeToolInput(call))}`,
        `${label("Reason")}${oneLineBounded(reason)}`,
      ];
      // All rows share one width: pad every body to the widest visible row so
      // the box closes cleanly even with CJK or ANSI content.
      const contentWidth = Math.max(...rows.map((row) => terminalWidth(row)));
      const padTo = (row: string): string => {
        const visible = terminalWidth(row);
        return visible >= contentWidth
          ? row
          : `${row}${" ".repeat(contentWidth - visible)}`;
      };
      const border = this.#theme.warning(`╭${"─".repeat(contentWidth + 2)}╮`);
      const bottom = this.#theme.warning(`╰${"─".repeat(contentWidth + 2)}╯`);
      const card = [
        border,
        ...rows.map((row) => `│ ${padTo(row)} │`),
        bottom,
      ];
      this.#stdout.write(`${card.join("\n")}\n`);
    } finally {
      this.#inputSurface?.resumeAfterOutput();
    }
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
        goal_verified: { symbol: "✓", label: "Goal verified" },
        goal_incomplete: { symbol: "◇", label: "Goal incomplete" },
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
      case "goal_verified":
        return this.#theme.success;
      case "goal_incomplete":
        return this.#theme.warning;
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
   * Builds the interactive card for a finished tool call. Tools with visible
   * output get a bordered card (input row, bounded preview, and an inspector
   * hint when lines were omitted); output-free calls render a compact one-line
   * record so the action stays observable. A completion without a buffered
   * start falls into the compact form.
   */
  #toolCard(
    buffer: ToolCardBuffer,
    id: string,
    ok: boolean,
    durationMs: number,
  ): string {
    const outcome = ok
      ? this.#theme.success("succeeded")
      : this.#theme.error("failed");
    const title = `${this.#theme.brandStrong("⚙")} ${buffer.name} · ${outcome} · ${duration(durationMs)}`;
    const preview = makeToolPreview({
      stdout: buffer.stdout,
      stderr: buffer.stderr,
    });
    if (preview.lines.length === 0) {
      // No output to show (e.g. read/write/list/search): keep the record to a
      // single compact line so the finished action stays observable.
      return buffer.summary === "" ? title : `${title} · ${buffer.summary}`;
    }
    const rows: string[] = [];
    if (buffer.summary !== "") {
      rows.push(buffer.summary);
    }
    for (const line of preview.lines) {
      rows.push(
        line.stream === "stderr"
          ? this.#theme.error(`stderr  ${line.text}`)
          : `${this.#theme.muted("stdout")}  ${line.text}`,
      );
    }
    if (preview.hiddenLineCount > 0) {
      rows.push(
        this.#theme.muted(
          `… ${preview.hiddenLineCount} more lines hidden · /tool ${toolReference(id)}`,
        ),
      );
    }
    const border = ok ? this.#theme.brandBorder : this.#theme.error;
    const titleWidth = terminalWidth(title);
    const contentWidth = Math.max(
      1,
      titleWidth + 2,
      ...rows.map((row) => terminalWidth(row)),
    );
    const padTo = (row: string): string => {
      const visible = terminalWidth(row);
      return visible >= contentWidth
        ? row
        : `${row}${" ".repeat(contentWidth - visible)}`;
    };
    const dashWidth = contentWidth - titleWidth - 1;
    const top = `${border("╭─ ")}${title} ${border(`${"─".repeat(dashWidth)}╮`)}`;
    const body = rows.map((row) => `│ ${padTo(row)} │`).join("\n");
    const bottom = border(`╰${"─".repeat(contentWidth + 2)}╯`);
    return `${top}\n${body}\n${bottom}`;
  }

  /**
   * Renders a Plan snapshot update: a compact progress panel in TTY mode and
   * stable `[plan]` records in non-TTY mode.
   */
  #renderPlan(plan: PlanState): void {
    if (plan.items.length === 0) {
      if (this.#interactive) {
        this.#permanent(this.#theme.brandStrong("◆ Plan cleared"));
      } else {
        this.#write("[plan] cleared\n");
      }
      return;
    }
    const completed = plan.items.filter((item) => item.status === "completed").length;
    if (this.#interactive) {
      const idWidth = Math.max(...plan.items.map((item) => [...item.id].length));
      const lines: string[] = [
        this.#theme.brandStrong(`◆ Plan ${completed}/${plan.items.length}`),
      ];
      for (const item of plan.items) {
        const symbol = item.status === "completed"
          ? "✓"
          : item.status === "in_progress"
            ? "◐"
            : "○";
        const id = item.status === "completed"
          ? this.#theme.success(`${symbol} ${item.id}`)
          : item.status === "in_progress"
            ? this.#theme.warning(`${symbol} ${item.id}`)
            : `${symbol} ${item.id}`;
        const padding = " ".repeat(Math.max(1, idWidth - [...item.id].length + 4));
        lines.push(`  ${id}${padding}${item.content}`);
      }
      this.#permanent(lines.join("\n"));
      return;
    }
    const lines = [`[plan] ${completed}/${plan.items.length}`];
    for (const item of plan.items) {
      lines.push(`[plan] ${item.status} ${item.id}: ${item.content}`);
    }
    this.#write(`${lines.join("\n")}\n`);
  }

  /**
   * Renders a Goal evaluation verdict: a compact verdict panel in TTY mode and
   * stable `[goal]` records in non-TTY mode. Missing evidence stays bounded.
   */
  #renderGoalEvaluation(decision: GoalEvaluationDecision): void {
    if (this.#interactive) {
      const lines = decision.satisfied
        ? [this.#theme.success("✓ Goal verified")]
        : [this.#theme.warning("◇ Goal incomplete")];
      if (decision.satisfied && decision.reason !== "") {
        lines.push(`  ${decision.reason}`);
      }
      if (!decision.satisfied) {
        for (const item of decision.missingEvidence.slice(0, 3)) {
          lines.push(`  Missing: ${item}`);
        }
        const extra = decision.missingEvidence.length - 3;
        if (extra > 0) {
          lines.push(`  … and ${extra} more`);
        }
      }
      this.#permanent(lines.join("\n"));
      return;
    }
    if (decision.satisfied) {
      this.#write("[goal] verified\n");
      return;
    }
    const missing = decision.missingEvidence
      .slice(0, 3)
      .map((item) => `"${item}"`)
      .join(", ");
    this.#write(`[goal] incomplete missing=${missing}\n`);
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
