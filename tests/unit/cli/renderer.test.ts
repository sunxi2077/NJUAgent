import { describe, expect, test } from "vitest";

import type { AgentEvent } from "../../../src/agent/events.js";
import type { RunResult } from "../../../src/agent/result.js";
import { TerminalRenderer } from "../../../src/cli/renderer.js";
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

    expect(stdout.text()).toContain("[model] step 1 started\n");
    expect(stdout.text()).toContain("[model] hello\n[model] world\n[model] !\n");
    expect(stdout.text()).not.toContain("\x1b[");
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
});

describe("TerminalRenderer tool output", () => {
  test("accepts an empty output chunk without emitting garbage", () => {
    const stdout = new MemoryStdout();
    const renderer = plainRenderer(stdout);

    renderer.toolOutput(toolCall, "stdout", "");

    expect(stdout.text()).toBe("");
  });
});
