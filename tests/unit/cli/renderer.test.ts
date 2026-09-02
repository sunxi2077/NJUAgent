import { describe, expect, test } from "vitest";
import { stripVTControlCharacters } from "node:util";

import type { AgentEvent } from "../../../src/agent/events.js";
import type { RunResult } from "../../../src/agent/result.js";
import { summarizeToolInput, TerminalRenderer } from "../../../src/cli/renderer.js";
import { terminalWidth } from "../../../src/cli/terminal-text.js";
import { toolReference } from "../../../src/cli/tool-activity.js";
import type { ToolExecutionRequest } from "../../../src/tools/tool.js";

class MemoryStdout {
  readonly chunks: string[] = [];
  isTTY = false;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  text(): string {
    return this.chunks.join("");
  }
}

function plainRenderer(stdout: MemoryStdout) {
  return new TerminalRenderer({ stdout, isTTY: false });
}

function ttyRenderer(stdout: MemoryStdout, noColor = false) {
  return new TerminalRenderer({ stdout, isTTY: true, noColor });
}

function result(status: RunResult["status"], extra: Partial<RunResult> = {}): RunResult {
  return {
    status,
    steps: 2,
    toolCalls: 1,
    durationMs: 1234,
    ...extra,
  } as RunResult;
}

/** Deterministic textual wrappers so style-leak assertions are not ANSI-brittle. */
function markerTheme() {
  const identity = (text: string): string => text;
  return {
    enabled: true,
    brandStrong: identity,
    brandBorder: identity,
    userLabel: identity,
    assistantLabel: identity,
    heading: identity,
    code: identity,
    quote: identity,
    success: (text: string): string => `✔${text}`,
    warning: identity,
    error: identity,
    muted: identity,
    bold: (text: string): string => `«${text}»`,
    italic: identity,
    underline: identity,
    hyperlink: (text: string) => text,
  } as const;
}

const toolCall: ToolExecutionRequest = {
  id: "call-1",
  name: "run_command",
  input: { command: "npm test" },
};

describe("TerminalRenderer in plain (non-TTY) mode", () => {
  test("renders text deltas as newline-safe plain records without ANSI bytes", () => {
    const stdout = new MemoryStdout();
    const renderer = plainRenderer(stdout);

    renderer.handle({ type: "model_started", step: 1 });
    renderer.handle({ type: "text_delta", text: "hello\nworld" });
    renderer.handle({ type: "text_delta", text: "!" });
    renderer.handle({ type: "model_completed", stopReason: "end_turn" });

    expect(stdout.text()).toContain("[model] step 1 started\n");
    // Complete lines are emitted during streaming; a trailing partial line is
    // flushed at completion, so "world" + "!" reconstructs as "world!".
    expect(stdout.text()).toContain("[model] hello\n[model] world!\n");
    expect(stdout.text()).not.toContain("\x1b[");
  });

  test("reassembles fragmented non-TTY model deltas", () => {
    const stdout = new MemoryStdout();
    const renderer = new TerminalRenderer({ stdout, isTTY: false });
    renderer.handle({ type: "text_delta", text: "hel" });
    renderer.handle({ type: "text_delta", text: "lo\nwor" });
    renderer.handle({ type: "text_delta", text: "ld" });
    renderer.handle({ type: "model_completed", stopReason: "end_turn" });

    expect(stdout.text()).toContain("[model] hello\n[model] world\n");
    expect(stdout.text()).not.toContain("[model] hel\n");
  });

  test("suppresses live tool output after the per-call budget", () => {
    const stdout = new MemoryStdout();
    const renderer = new TerminalRenderer({
      stdout,
      isTTY: false,
      maxLiveOutputBytes: 5,
    });
    renderer.toolOutput(toolCall, "stdout", "abc");
    renderer.toolOutput(toolCall, "stdout", "defgh");
    renderer.toolOutput(toolCall, "stdout", "ignored");

    expect(stdout.text()).toContain("abc");
    expect(stdout.text()).toContain("de");
    expect(stdout.text().match(/live output suppressed/gu)).toHaveLength(1);
    expect(stdout.text()).not.toContain("ignored");
  });

  test("renders usage, model completion, and retry records", () => {
    const stdout = new MemoryStdout();
    const renderer = plainRenderer(stdout);

    renderer.handle({ type: "usage", inputTokens: 10, outputTokens: 4 });
    renderer.handle({ type: "model_completed", stopReason: "end_turn" });
    renderer.handle({ type: "retrying", attempt: 1, delayMs: 200, reason: "rate limited" });

    expect(stdout.text()).toContain("[usage] in=10 out=4\n");
    expect(stdout.text()).toContain("[model] completed (stop: end_turn)\n");
    expect(stdout.text()).toContain("[retry] attempt 1 in 200ms: rate limited\n");
  });

  test("renders tool start and completion records", () => {
    const stdout = new MemoryStdout();
    const renderer = plainRenderer(stdout);

    renderer.handle({
      type: "tool_started",
      id: "call-1",
      name: "read_file",
      summary: '{"path":"src/a.ts"}',
    });
    renderer.handle({
      type: "tool_completed",
      id: "call-1",
      name: "read_file",
      ok: true,
      durationMs: 12,
    });

    expect(stdout.text()).toContain(
      '[tool] read_file started (call-1): {"path":"src/a.ts"}\n',
    );
    expect(stdout.text()).toContain("[tool] read_file ok in 12ms (call-1)\n");
  });

  test("renders failed tool completion with failed marker", () => {
    const stdout = new MemoryStdout();
    const renderer = plainRenderer(stdout);

    renderer.handle({
      type: "tool_completed",
      id: "call-2",
      name: "run_command",
      ok: false,
      durationMs: 300,
    });

    expect(stdout.text()).toContain("[tool] run_command failed in 300ms (call-2)\n");
  });

  test("renders run_finished with status, stats, and failure message", () => {
    const stdout = new MemoryStdout();
    const renderer = plainRenderer(stdout);

    renderer.handle({ type: "run_finished", result: result("completed") });
    renderer.handle({
      type: "run_finished",
      result: result("model_failed", { message: "connection refused" }),
    });

    expect(stdout.text()).toContain(
      "[run] completed steps=2 tool_calls=1 duration_ms=1234\n",
    );
    expect(stdout.text()).toContain(
      "[run] model_failed: connection refused steps=2 tool_calls=1 duration_ms=1234\n",
    );
  });

  test("renders command output as newline-safe stdout/stderr records", () => {
    const stdout = new MemoryStdout();
    const renderer = plainRenderer(stdout);

    renderer.toolOutput(toolCall, "stdout", "line one\nline two");
    renderer.toolOutput(toolCall, "stderr", "boom");

    expect(stdout.text()).toContain("[stdout] line one\n[stdout] line two\n");
    expect(stdout.text()).toContain("[stderr] boom\n");
    expect(stdout.text()).not.toContain("\x1b[");
  });
});

describe("TerminalRenderer in TTY mode", () => {
  test("uses ANSI colors when TTY and NO_COLOR is absent", () => {
    const stdout = new MemoryStdout();
    const renderer = ttyRenderer(stdout);

    renderer.handle({ type: "model_started", step: 1 });
    renderer.handle({ type: "text_delta", text: "hi" });
    renderer.handle({ type: "model_completed", stopReason: "end_turn" });
    renderer.handle({ type: "run_finished", result: result("completed") });

    expect(stdout.text()).toContain("\x1b[");
  });

  test("emits no ANSI bytes when NO_COLOR is set", () => {
    const stdout = new MemoryStdout();
    const renderer = ttyRenderer(stdout, true);

    renderer.handle({ type: "text_delta", text: "plain" });
    renderer.handle({ type: "run_finished", result: result("completed") });

    expect(stdout.text()).not.toContain("\x1b[");
  });

  test("keeps the permanent model text and a transient status line", () => {
    const stdout = new MemoryStdout();
    const renderer = ttyRenderer(stdout);

    renderer.handle({ type: "model_started", step: 1 });
    renderer.handle({ type: "text_delta", text: "streamed answer" });
    renderer.handle({ type: "model_completed", stopReason: "end_turn" });

    const text = stdout.text();
    expect(text).toContain("streamed answer");
    // The transient status line should be redrawn after a permanent write.
    expect(text).toContain("\r\x1b[K");
  });

  test("writes text deltas incrementally before the turn completes", () => {
    const stdout = new MemoryStdout();
    const renderer = ttyRenderer(stdout);

    renderer.handle({ type: "model_started", step: 1 });
    renderer.handle({ type: "text_delta", text: "hel" });
    renderer.handle({ type: "text_delta", text: "lo" });

    // The streamed reply is already on screen without waiting for completion.
    expect(stdout.text()).toContain("hello");
  });

  test("completes the streamed text line before rendering a tool card", () => {
    const stdout = new MemoryStdout();
    const renderer = ttyRenderer(stdout);

    renderer.handle({ type: "model_started", step: 1 });
    renderer.handle({ type: "text_delta", text: "reading now" });
    renderer.handle({ type: "model_completed", stopReason: "tool_use" });
    renderer.handle({
      type: "tool_started",
      id: "c1",
      name: "read_file",
      summary: '{"path":"a.ts"}',
    });

    const text = stdout.text();
    expect(text).toContain("reading now\n");
    expect(text).toContain("read_file");
  });

  test("renders human-readable tool activity without internal ids or raw JSON", () => {
    const stdout = new MemoryStdout();
    const renderer = ttyRenderer(stdout);

    renderer.handle({
      type: "tool_started",
      id: "internal-call-id",
      name: "read_file",
      summary: '{"path":"src/index.ts"}',
    });
    renderer.handle({
      type: "tool_completed",
      id: "internal-call-id",
      name: "read_file",
      ok: true,
      durationMs: 12,
    });
    renderer.handle({ type: "run_finished", result: result("completed") });

    const text = stdout.text();
    const visible = stripVTControlCharacters(text);
    expect(visible).toContain("⚙ read_file · succeeded · 12ms · src/index.ts");
    expect(visible).toContain("Completed · 2 steps · 1 tool call · 1.2s");
    expect(text).not.toContain("internal-call-id");
    expect(text).not.toContain('{"path"');
    expect(text).not.toContain("steps=");
    expect(text).not.toContain("duration_ms=");
  });
});

describe("TerminalRenderer tool cards (TTY)", () => {
  function commandCall(id: string, command: string): ToolExecutionRequest {
    return { id, name: "run_command", input: { command } };
  }

  test("buffers command output and renders one bordered card per finished tool", () => {
    const stdout = new MemoryStdout();
    const renderer = ttyRenderer(stdout);
    renderer.handle({
      type: "tool_started",
      id: "c1a2b3c4d5",
      name: "run_command",
      summary: '{"command":"npm test"}',
    });
    renderer.toolOutput(commandCall("c1a2b3c4d5", "npm test"), "stdout", "Running tests...\n");
    renderer.toolOutput(commandCall("c1a2b3c4d5", "npm test"), "stdout", "✓ 42 tests passed\n");
    renderer.toolOutput(commandCall("c1a2b3c4d5", "npm test"), "stderr", "warning: 1 deprecation\n");
    renderer.toolOutput(commandCall("c1a2b3c4d5", "npm test"), "stderr", "second warning\n");

    // No command output or input summary becomes permanent before completion.
    const before = stripVTControlCharacters(stdout.text());
    expect(before).not.toContain("npm test");
    expect(before).not.toContain("42 tests passed");
    expect(before).not.toContain("│");

    renderer.handle({
      type: "tool_completed",
      id: "c1a2b3c4d5",
      name: "run_command",
      ok: true,
      durationMs: 2300,
    });

    const visible = stripVTControlCharacters(stdout.text());
    expect(visible).toContain("╭─ ⚙ run_command · succeeded · 2.3s");
    expect(visible).toContain("│ npm test");
    expect(visible).toContain("│ stdout  Running tests...");
    expect(visible).toContain("│ stdout  ✓ 42 tests passed");
    expect(visible).toContain("│ stderr  warning: 1 deprecation");
    expect(visible).toContain(
      `… 1 more lines hidden · /tool ${toolReference("c1a2b3c4d5")}`,
    );
    expect(visible).toContain("╰");
    expect(visible).toContain("╯");
    // Hidden lines and the full id never leak into the card.
    expect(visible).not.toContain("second warning");
    expect(visible).not.toContain("c1a2b3c4d5");
    expect(visible).not.toContain('{"command"');

    // Every framed line (top border, rows, bottom border) shares one width.
    const frame = visible.split("\n").filter((line) => /^[╭│╰]/u.test(line));
    expect(frame.length).toBeGreaterThan(2);
    for (const line of frame) {
      expect(terminalWidth(line), line).toBe(terminalWidth(frame[0]!));
    }
  });

  test("a short result card omits the inspector hint", () => {
    const stdout = new MemoryStdout();
    const renderer = ttyRenderer(stdout);
    renderer.handle({
      type: "tool_started",
      id: "c2",
      name: "run_command",
      summary: '{"command":"ls"}',
    });
    renderer.toolOutput(commandCall("c2", "ls"), "stdout", "src\n");
    renderer.handle({
      type: "tool_completed",
      id: "c2",
      name: "run_command",
      ok: true,
      durationMs: 1,
    });
    const visible = stripVTControlCharacters(stdout.text());
    expect(visible).toContain("╭─ ⚙ run_command · succeeded · 1ms");
    expect(visible).toContain("│ ls");
    expect(visible).toContain("│ stdout  src");
    expect(visible).not.toContain("hidden");
    expect(visible).not.toContain("/tool");
  });

  test("a finished read call renders a compact one-line card", () => {
    const stdout = new MemoryStdout();
    const renderer = ttyRenderer(stdout);
    renderer.handle({
      type: "tool_started",
      id: "c3",
      name: "read_file",
      summary: '{"path":"src/a.ts"}',
    });
    renderer.handle({
      type: "tool_completed",
      id: "c3",
      name: "read_file",
      ok: true,
      durationMs: 12,
    });
    const visible = stripVTControlCharacters(stdout.text());
    expect(visible).toContain("⚙ read_file · succeeded · 12ms · src/a.ts");
    expect(visible).not.toContain("╭");
    expect(visible).not.toContain("│");
  });

  test("a failed command renders an error-coloured card with its preview", () => {
    const stdout = new MemoryStdout();
    const renderer = ttyRenderer(stdout);
    renderer.handle({
      type: "tool_started",
      id: "c4deadbeef",
      name: "run_command",
      summary: '{"command":"npm run build"}',
    });
    renderer.toolOutput(commandCall("c4deadbeef", "npm run build"), "stdout", "error TS2307: cannot find module\n");
    renderer.toolOutput(commandCall("c4deadbeef", "npm run build"), "stderr", "build failed\n");
    renderer.handle({
      type: "tool_completed",
      id: "c4deadbeef",
      name: "run_command",
      ok: false,
      durationMs: 3400,
    });
    const visible = stripVTControlCharacters(stdout.text());
    expect(visible).toContain("╭─ ⚙ run_command · failed · 3.4s");
    expect(visible).toContain("│ npm run build");
    expect(visible).toContain("│ stdout  error TS2307: cannot find module");
    expect(visible).toContain("│ stderr  build failed");
    expect(stdout.text()).toContain("\x1b[31m");
  });

  test("a completion without a preceding start still renders a compact card", () => {
    const stdout = new MemoryStdout();
    const renderer = ttyRenderer(stdout);
    renderer.handle({
      type: "tool_completed",
      id: "c5",
      name: "web_search",
      ok: true,
      durationMs: 200,
    });
    const visible = stripVTControlCharacters(stdout.text());
    expect(visible).toContain("⚙ web_search · succeeded · 200ms");
    expect(visible).not.toContain("╭");
  });

  test("each finished tool renders only its own buffered output", () => {
    const stdout = new MemoryStdout();
    const renderer = ttyRenderer(stdout);
    renderer.handle({
      type: "tool_started",
      id: "c6",
      name: "run_command",
      summary: '{"command":"echo one"}',
    });
    renderer.toolOutput(commandCall("c6", "echo one"), "stdout", "one\n");
    renderer.handle({
      type: "tool_completed",
      id: "c6",
      name: "run_command",
      ok: true,
      durationMs: 1,
    });
    renderer.handle({
      type: "tool_started",
      id: "c7",
      name: "run_command",
      summary: '{"command":"echo two"}',
    });
    renderer.toolOutput(commandCall("c7", "echo two"), "stdout", "two\n");
    renderer.handle({
      type: "tool_completed",
      id: "c7",
      name: "run_command",
      ok: true,
      durationMs: 1,
    });
    const visible = stripVTControlCharacters(stdout.text());
    expect(visible).toContain("│ stdout  one");
    expect(visible).toContain("│ stdout  two");
    // The second call's output must not leak into the first call's card.
    const firstCard = visible.slice(0, visible.indexOf("echo two"));
    expect(firstCard).toContain("│ stdout  one");
    expect(firstCard).not.toContain("two");
  });
});

describe("TerminalRenderer tool output", () => {
  test("accepts an empty output chunk without emitting garbage", () => {
    const stdout = new MemoryStdout();
    const renderer = plainRenderer(stdout);

    renderer.toolOutput(toolCall, "stdout", "");

    expect(stdout.text()).toBe("");
  });
});

describe("TerminalRenderer assistant anchors", () => {
  test("prints one assistant anchor lazily for a text-producing model step", () => {
    const stdout = new MemoryStdout();
    const renderer = ttyRenderer(stdout);
    renderer.handle({ type: "model_started", step: 1 });
    renderer.handle({ type: "text_delta", text: "" });
    renderer.handle({ type: "text_delta", text: "hello " });
    renderer.handle({ type: "text_delta", text: "**world**" });
    renderer.handle({ type: "model_completed", stopReason: "end_turn" });

    const visible = stripVTControlCharacters(stdout.text());
    expect(visible.match(/◆ NJUAgent/gu)).toHaveLength(1);
    expect(visible).toContain("hello world");
    expect(visible).not.toContain("**");
    expect(stdout.text()).toContain("\x1b[38;5;141m");
  });

  test("does not print an empty assistant anchor for direct tool use", () => {
    const stdout = new MemoryStdout();
    const renderer = ttyRenderer(stdout);
    renderer.handle({ type: "model_started", step: 1 });
    renderer.handle({ type: "model_completed", stopReason: "tool_use" });
    renderer.handle({ type: "tool_started", id: "c1", name: "read_file", summary: "{\"path\":\"a.ts\"}" });
    expect(stripVTControlCharacters(stdout.text())).not.toContain("◆ NJUAgent");
  });

  test("tool-separated text steps receive separate assistant anchors", () => {
    const stdout = new MemoryStdout();
    const renderer = ttyRenderer(stdout);
    renderer.handle({ type: "model_started", step: 1 });
    renderer.handle({ type: "text_delta", text: "I will inspect." });
    renderer.handle({ type: "model_completed", stopReason: "tool_use" });
    renderer.handle({ type: "tool_started", id: "c1", name: "read_file", summary: "{\"path\":\"a.ts\"}" });
    renderer.handle({ type: "tool_completed", id: "c1", name: "read_file", ok: true, durationMs: 1 });
    renderer.handle({ type: "model_started", step: 2 });
    renderer.handle({ type: "text_delta", text: "Found it." });
    expect(stripVTControlCharacters(stdout.text()).match(/◆ NJUAgent/gu)).toHaveLength(2);
  });

  test("plain mode keeps raw markdown delimiters in model records", () => {
    const stdout = new MemoryStdout();
    const renderer = plainRenderer(stdout);
    renderer.handle({ type: "text_delta", text: "**bold**" });
    renderer.handle({ type: "model_completed", stopReason: "end_turn" });
    expect(stdout.text()).toContain("[model] **bold**\n");
    expect(stdout.text()).not.toContain("\x1b[");
  });

  test("an unclosed inline style cannot color the run summary", () => {
    const stdout = new MemoryStdout();
    const renderer = new TerminalRenderer({
      stdout,
      isTTY: true,
      noColor: false,
      theme: markerTheme(),
    });
    renderer.handle({ type: "model_started", step: 1 });
    renderer.handle({ type: "text_delta", text: "**open" });
    renderer.handle({ type: "model_completed", stopReason: "end_turn" });
    renderer.handle({ type: "run_finished", result: result("completed") });
    const raw = stdout.text();
    // The bold marker is opened and closed within the streamed text itself.
    expect(raw).toContain("«open»");
    // No open style marker may leak into the run summary.
    const summary = raw.slice(raw.indexOf("Completed"));
    expect(summary).not.toContain("«");
  });

  test("an unclosed fence is flushed before a tool card", () => {
    const stdout = new MemoryStdout();
    const renderer = ttyRenderer(stdout);
    renderer.handle({ type: "model_started", step: 1 });
    renderer.handle({ type: "text_delta", text: "```ts\nconst x = 1;" });
    renderer.handle({ type: "model_completed", stopReason: "tool_use" });
    renderer.handle({
      type: "tool_started",
      id: "c1",
      name: "read_file",
      summary: "{\"path\":\"a.ts\"}",
    });
    renderer.handle({
      type: "tool_completed",
      id: "c1",
      name: "read_file",
      ok: true,
      durationMs: 1,
    });
    const visible = stripVTControlCharacters(stdout.text());
    // The pending code fence is flushed onto its own line before the card.
    expect(visible).toContain("  │ const x = 1;");
    expect(visible).toContain("⚙ read_file · succeeded · 1ms · a.ts");
    expect(visible).not.toContain("╭");
  });

  test("retry permanent text follows flushed model text", () => {
    const stdout = new MemoryStdout();
    const renderer = ttyRenderer(stdout);
    renderer.handle({ type: "model_started", step: 1 });
    renderer.handle({ type: "text_delta", text: "**pending" });
    renderer.handle({ type: "retrying", attempt: 1, delayMs: 100, reason: "busy" });
    const visible = stripVTControlCharacters(stdout.text());
    expect(visible).toContain("pending");
    expect(visible).toContain("↻ retry attempt 1");
    expect(visible.indexOf("pending")).toBeLessThan(visible.indexOf("retry attempt"));
  });

  test("multiple delta chunks still appear before run_finished", () => {
    const stdout = new MemoryStdout();
    const renderer = ttyRenderer(stdout);
    renderer.handle({ type: "model_started", step: 1 });
    renderer.handle({ type: "text_delta", text: "one " });
    renderer.handle({ type: "text_delta", text: "two " });
    renderer.handle({ type: "run_finished", result: result("completed") });
    expect(stripVTControlCharacters(stdout.text())).toContain("one two");
  });

  test("a response already ending in newline does not gain duplicate model newlines", () => {
    const stdout = new MemoryStdout();
    const renderer = ttyRenderer(stdout);
    renderer.handle({ type: "model_started", step: 1 });
    renderer.handle({ type: "text_delta", text: "done\n" });
    renderer.handle({ type: "model_completed", stopReason: "end_turn" });
    expect(stripVTControlCharacters(stdout.text())).not.toContain("done\n\n\n");
  });

  test("renders plan_updated as a compact TTY panel with progress", () => {
    const stdout = new MemoryStdout();
    const renderer = ttyRenderer(stdout);
    renderer.handle({
      type: "plan_updated",
      plan: {
        items: [
          { id: "inspect", content: "Read implementation and tests", status: "completed" },
          { id: "fix", content: "Implement validation", status: "in_progress" },
          { id: "test", content: "Run focused tests", status: "pending" },
          { id: "verify", content: "Run full verification", status: "pending" },
        ],
      },
    });
    const visible = stripVTControlCharacters(stdout.text());
    expect(visible).toContain("◆ Plan 1/4");
    expect(visible).toContain("✓ inspect    Read implementation and tests");
    expect(visible).toContain("◐ fix        Implement validation");
    expect(visible).toContain("○ test       Run focused tests");
    expect(visible).toContain("○ verify     Run full verification");
    expect(stdout.text()).toContain("\x1b[38;5;141m");
    expect(stdout.text()).toContain("\x1b[32m");
    expect(stdout.text()).toContain("\x1b[33m");
  });

  test("renders an empty plan update as cleared in TTY", () => {
    const stdout = new MemoryStdout();
    const renderer = ttyRenderer(stdout);
    renderer.handle({ type: "plan_updated", plan: { items: [] } });
    expect(stripVTControlCharacters(stdout.text())).toContain("◆ Plan cleared");
  });

  test("renders plan_updated as [plan] records in non-TTY", () => {
    const stdout = new MemoryStdout();
    const renderer = plainRenderer(stdout);
    renderer.handle({
      type: "plan_updated",
      plan: {
        items: [
          { id: "inspect", content: "Read implementation", status: "completed" },
          { id: "fix", content: "Implement validation", status: "in_progress" },
        ],
      },
    });
    const text = stdout.text();
    expect(text).toContain("[plan] 1/2\n");
    expect(text).toContain("[plan] completed inspect: Read implementation\n");
    expect(text).toContain("[plan] in_progress fix: Implement validation\n");
    expect(text).not.toContain("\x1b[");
  });

  test("renders an empty plan update as cleared in non-TTY", () => {
    const stdout = new MemoryStdout();
    const renderer = plainRenderer(stdout);
    renderer.handle({ type: "plan_updated", plan: { items: [] } });
    expect(stdout.text()).toContain("[plan] cleared\n");
  });

  test("renders goal evaluation events in TTY", () => {
    const stdout = new MemoryStdout();
    const renderer = ttyRenderer(stdout);
    renderer.handle({ type: "goal_evaluation_started", attempt: 1 });
    renderer.handle({
      type: "goal_evaluation_completed",
      decision: {
        satisfied: false,
        reason: "no verification",
        missingEvidence: [
          "npm run typecheck has not run after the latest edit",
          "second missing item",
          "third missing item",
          "fourth missing item",
        ],
      },
    });
    const visible = stripVTControlCharacters(stdout.text());
    expect(visible).toContain("◇ Checking goal evidence…");
    expect(visible).toContain("◇ Goal incomplete");
    expect(visible).toContain("Missing: npm run typecheck has not run after the latest edit");
    expect(visible).toContain("… and 1 more");
    expect(stdout.text()).toContain("\x1b[33m");
  });

  test("renders a verified goal verdict in TTY with success color", () => {
    const stdout = new MemoryStdout();
    const renderer = ttyRenderer(stdout);
    renderer.handle({
      type: "goal_evaluation_completed",
      decision: { satisfied: true, reason: "npm test passed after the latest edit", missingEvidence: [] },
    });
    const visible = stripVTControlCharacters(stdout.text());
    expect(visible).toContain("✓ Goal verified");
    expect(visible).toContain("npm test passed after the latest edit");
    expect(stdout.text()).toContain("\x1b[32m");
  });

  test("renders goal evaluation events as [goal] records in non-TTY", () => {
    const stdout = new MemoryStdout();
    const renderer = plainRenderer(stdout);
    renderer.handle({ type: "goal_evaluation_started", attempt: 2 });
    renderer.handle({
      type: "goal_evaluation_completed",
      decision: {
        satisfied: false,
        reason: "no verification",
        missingEvidence: ["npm run typecheck has not run"],
      },
    });
    const text = stdout.text();
    expect(text).toContain("[goal] evaluating attempt=2\n");
    expect(text).toContain('[goal] incomplete missing="npm run typecheck has not run"\n');
    expect(text).not.toContain("\x1b[");
  });
});

describe("TerminalRenderer permission prompts", () => {
  const webCall: ToolExecutionRequest = {
    id: "c1",
    name: "web_search",
    input: { query: "AbortSignal timeout" },
  };
  const reason = "Web search sends the query to an external service";

  test("TTY permissionRequest renders a closed warning box with title, tool, action, and reason", () => {
    const stdout = new MemoryStdout();
    const renderer = ttyRenderer(stdout);
    renderer.permissionRequest(webCall, reason);
    const visible = stripVTControlCharacters(stdout.text());
    expect(visible).toContain("╭");
    expect(visible).toContain("╮");
    expect(visible).toContain("╰");
    expect(visible).toContain("╯");
    expect(visible).toContain("⚠ Permission required");
    expect(visible).toContain("│ Tool    web_search");
    expect(visible).toContain("│ Action  AbortSignal timeout");
    expect(visible).toContain("│ Reason  Web search sends the query to an external service");
    // Every framed row (borders included) has the same visible width.
    const lines = visible.split("\n");
    const frame = lines.filter((line) => /^[╭│╰]/u.test(line));
    expect(frame.length).toBeGreaterThan(2);
    for (const line of frame) {
      expect(terminalWidth(line), line).toBe(terminalWidth(frame[0]!));
    }
    expect(stdout.text()).toContain("\x1b[33m");
    expect(stdout.text()).toContain("\x1b[38;5;141m");
  });

  test("TTY permissionRequest clears a transient status line before the card", () => {
    const stdout = new MemoryStdout();
    const renderer = ttyRenderer(stdout);
    renderer.handle({ type: "model_started", step: 1 });
    renderer.permissionRequest(webCall, reason);
    const visible = stripVTControlCharacters(stdout.text());
    // The spinner status was printed once at model_started and is not redrawn
    // after the permission card.
    expect(visible.lastIndexOf("model step 1")).toBeLessThan(
      visible.indexOf("Permission required"),
    );
  });

  test("TTY permissionRequest collapses multi-line input into one bounded action line", () => {
    const stdout = new MemoryStdout();
    const renderer = ttyRenderer(stdout);
    renderer.permissionRequest(
      {
        id: "c2",
        name: "run_command",
        input: { command: "npm test\n--reporter\n" + "x".repeat(300) },
      },
      reason,
    );
    const visible = stripVTControlCharacters(stdout.text());
    const actionLine = visible.split("\n").find((line) => line.startsWith("│ Action"));
    expect(actionLine).toBeDefined();
    // Single line, no embedded newline, bounded length with an ellipsis.
    expect(actionLine!.split("\n")).toHaveLength(1);
    expect(actionLine!.length).toBeLessThan(160);
    expect(actionLine!).toMatch(/…\s*│$/u);
    expect(actionLine!).not.toContain("x".repeat(300));
  });

  test("TTY permissionDecision records an allow and a deny", () => {
    const allowedOut = new MemoryStdout();
    const allowed = ttyRenderer(allowedOut);
    allowed.permissionDecision(webCall, true);
    const allowedVisible = stripVTControlCharacters(allowedOut.text());
    expect(allowedVisible).toContain("✓ Allowed web_search once");
    expect(allowedOut.text()).toContain("\x1b[32m");

    const deniedOut = new MemoryStdout();
    const denied = ttyRenderer(deniedOut);
    denied.permissionDecision(webCall, false);
    const deniedVisible = stripVTControlCharacters(deniedOut.text());
    expect(deniedVisible).toContain("✗ Denied web_search");
    expect(deniedOut.text()).toContain("\x1b[31m");
  });

  test("TTY approval restores a visible running status immediately", () => {
    const stdout = new MemoryStdout();
    const renderer = ttyRenderer(stdout);
    renderer.handle({
      type: "tool_started",
      id: "c1",
      name: "run_command",
      summary: '{"command":"npm test"}',
    });
    renderer.permissionRequest(toolCall, reason);
    renderer.permissionDecision(toolCall, true);
    const visible = stripVTControlCharacters(stdout.text());
    expect(visible).toContain("✓ Allowed run_command once");
    expect(visible).toContain("run_command running… Ctrl-C cancels");
    // The running status appears after the approval record, never before it.
    expect(visible.indexOf("Allowed")).toBeLessThan(
      visible.indexOf("running… Ctrl-C cancels"),
    );
  });

  test("TTY denial does not restore a running status", () => {
    const stdout = new MemoryStdout();
    const renderer = ttyRenderer(stdout);
    renderer.handle({
      type: "tool_started",
      id: "c1",
      name: "run_command",
      summary: '{"command":"npm test"}',
    });
    renderer.permissionRequest(toolCall, reason);
    renderer.permissionDecision(toolCall, false);
    const visible = stripVTControlCharacters(stdout.text());
    expect(visible).toContain("✗ Denied run_command");
    expect(visible).not.toContain("running… Ctrl-C cancels");
  });

  test("non-TTY permissionRequest and decision emit stable [permission] records", () => {
    const stdout = new MemoryStdout();
    const renderer = plainRenderer(stdout);
    renderer.permissionRequest(webCall, reason);
    renderer.permissionDecision(webCall, true);
    const text = stdout.text();
    expect(text).toContain("[permission] tool=web_search\n");
    expect(text).toContain("[permission] action=AbortSignal timeout\n");
    expect(text).toContain(
      "[permission] reason=Web search sends the query to an external service\n",
    );
    expect(text).toContain("[permission] decision=allowed\n");
    expect(text).not.toContain("\x1b[");
  });

  test("non-TTY denial emits decision=denied", () => {
    const stdout = new MemoryStdout();
    const renderer = plainRenderer(stdout);
    renderer.permissionDecision(webCall, false);
    expect(stdout.text()).toContain("[permission] decision=denied\n");
  });

  test("NO_COLOR permission card contains no ANSI", () => {
    const stdout = new MemoryStdout();
    const renderer = ttyRenderer(stdout, true);
    renderer.permissionRequest(webCall, reason);
    renderer.permissionDecision(webCall, false);
    expect(stdout.text()).not.toContain("\x1b[");
    expect(stdout.text()).toContain("[permission] tool=web_search\n");
    expect(stdout.text()).toContain("[permission] decision=denied\n");
  });
});

describe("summarizeToolInput", () => {
  test("prefers path, command, query, then pattern and collapses whitespace", () => {
    expect(
      summarizeToolInput({ id: "c", name: "run_command", input: { command: "npm  test\n--x" } }),
    ).toBe("npm test --x");
    expect(
      summarizeToolInput({ id: "c", name: "read_file", input: { path: "src/a.ts" } }),
    ).toBe("src/a.ts");
    expect(
      summarizeToolInput({ id: "c", name: "web_search", input: { query: "abort timeout" } }),
    ).toBe("abort timeout");
    expect(
      summarizeToolInput({ id: "c", name: "search_text", input: { pattern: "parsePort" } }),
    ).toBe("parsePort");
  });

  test("bounds the summary and adds an ellipsis", () => {
    const long = "y".repeat(400);
    const summary = summarizeToolInput({ id: "c", name: "run_command", input: { command: long } });
    expect(summary.length).toBeLessThan(150);
    expect(summary).toMatch(/…$/u);
  });

  test("falls back to a JSON serialization for other inputs", () => {
    const summary = summarizeToolInput({ id: "c", name: "plan_write", input: { items: [] } });
    expect(summary).toBe('{"items":[]}');
  });
});
