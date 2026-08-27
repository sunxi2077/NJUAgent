import { spawn, type ChildProcess } from "node:child_process";

import { createCommandEnvironment } from "../security/command-environment.js";
import type { Workspace } from "../security/workspace.js";
import { truncateUtf8 } from "./output-budget.js";
import type { Tool, ToolContext, ToolOutputStream } from "./tool.js";

type RunCommandOptions = {
  workspace: Workspace;
  defaultTimeoutMs: number;
  maxOutputBytes: number;
  sourceEnvironment?: NodeJS.ProcessEnv;
};

type RunCommandInput = {
  command: string;
  timeoutMs?: number;
};

class BoundedCapture {
  readonly #headLimit: number;
  readonly #tailLimit: number;
  #head = Buffer.alloc(0);
  #tail = Buffer.alloc(0);
  #totalBytes = 0;

  constructor(maxBytes: number) {
    this.#headLimit = Math.ceil(maxBytes / 2);
    this.#tailLimit = Math.floor(maxBytes / 2);
  }

  push(chunk: Buffer): void {
    this.#totalBytes += chunk.length;
    let remainder = chunk;
    if (this.#head.length < this.#headLimit) {
      const needed = this.#headLimit - this.#head.length;
      const headPart = remainder.subarray(0, needed);
      this.#head = Buffer.concat([this.#head, headPart]);
      remainder = remainder.subarray(headPart.length);
    }
    if (remainder.length > 0 && this.#tailLimit > 0) {
      const combined = Buffer.concat([this.#tail, remainder]);
      this.#tail = combined.subarray(Math.max(0, combined.length - this.#tailLimit));
    }
  }

  get totalBytes(): number {
    return this.#totalBytes;
  }

  text(): string {
    const keptBytes = this.#head.length + this.#tail.length;
    if (this.#totalBytes <= keptBytes) {
      return Buffer.concat([this.#head, this.#tail]).toString("utf8");
    }
    const omitted = this.#totalBytes - keptBytes;
    return Buffer.concat([
      this.#head,
      Buffer.from(`\n... [${omitted} bytes omitted] ...\n`),
      this.#tail,
    ]).toString("utf8");
  }
}

function terminateProcess(child: ChildProcess, force = false): void {
  const signal = force ? "SIGKILL" : "SIGTERM";
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through when the process group has already exited.
    }
  }
  child.kill(signal);
}

function cancelledOutput(cancelled: boolean, timedOut: boolean) {
  return {
    content: [
      "exit_code: null",
      `timed_out: ${String(timedOut)}`,
      `cancelled: ${String(cancelled)}`,
      "stdout:",
      "",
      "stderr:",
      "",
    ].join("\n"),
    isError: true,
    metadata: {
      exitCode: null,
      signal: null,
      timedOut,
      cancelled,
      truncated: false,
      stdoutBytes: 0,
      stderrBytes: 0,
    },
  };
}

export function createRunCommandTool(options: RunCommandOptions): Tool<RunCommandInput> {
  return {
    name: "run_command",
    description: "Run a shell command in the workspace and return stdout, stderr, and exit status.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", minLength: 1 },
        timeoutMs: { type: "integer", minimum: 1, maximum: 600000 },
      },
      required: ["command"],
      additionalProperties: false,
    },
    async execute(input, context) {
      if (context.signal.aborted) {
        return cancelledOutput(true, false);
      }
      if (input.command.includes("\0")) {
        throw new Error("Command cannot contain NUL bytes");
      }

      const timeoutMs = input.timeoutMs ?? options.defaultTimeoutMs;
      const shell = process.platform === "win32"
        ? process.env.ComSpec ?? "cmd.exe"
        : "/bin/sh";
      const args = process.platform === "win32"
        ? ["/d", "/s", "/c", input.command]
        : ["-lc", input.command];
      const commandEnvironment = createCommandEnvironment(
        options.sourceEnvironment ?? process.env,
      );
      const child = spawn(shell, args, {
        cwd: options.workspace.root,
        env: commandEnvironment,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const captureBudget = Math.max(options.maxOutputBytes * 2, 4096);
      const stdout = new BoundedCapture(captureBudget);
      const stderr = new BoundedCapture(captureBudget);
      const startedAt = performance.now();
      let timedOut = false;
      let cancelled = false;

      const record = (
        stream: ToolOutputStream,
        capture: BoundedCapture,
        chunk: Buffer,
      ) => {
        capture.push(chunk);
        context.emitOutput(stream, chunk.toString("utf8"));
      };
      child.stdout.on("data", (chunk: Buffer) => record("stdout", stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => record("stderr", stderr, chunk));

      const outcome = await new Promise<{
        exitCode: number | null;
        exitSignal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        let forceTimer: NodeJS.Timeout | undefined;
        const timeout = setTimeout(() => {
          timedOut = true;
          terminateProcess(child);
          forceTimer = setTimeout(() => terminateProcess(child, true), 500);
          forceTimer.unref();
        }, timeoutMs);
        timeout.unref();

        const onAbort = () => {
          cancelled = true;
          terminateProcess(child);
          forceTimer = setTimeout(() => terminateProcess(child, true), 500);
          forceTimer.unref();
        };
        context.signal.addEventListener("abort", onAbort, { once: true });

        const cleanup = () => {
          clearTimeout(timeout);
          if (forceTimer !== undefined) {
            clearTimeout(forceTimer);
          }
          context.signal.removeEventListener("abort", onAbort);
        };
        child.once("error", (error) => {
          cleanup();
          reject(error);
        });
        child.once("close", (exitCode, exitSignal) => {
          cleanup();
          resolve({ exitCode, exitSignal });
        });
      });

      const raw = [
        `exit_code: ${outcome.exitCode === null ? "null" : String(outcome.exitCode)}`,
        `signal: ${outcome.exitSignal ?? "none"}`,
        `timed_out: ${String(timedOut)}`,
        `cancelled: ${String(cancelled)}`,
        "stdout:",
        stdout.text(),
        "stderr:",
        stderr.text(),
      ].join("\n");
      const limited = truncateUtf8(raw, options.maxOutputBytes);
      const isError = timedOut || cancelled || outcome.exitCode !== 0;
      return {
        content: limited.text,
        isError,
        metadata: {
          exitCode: outcome.exitCode,
          signal: outcome.exitSignal,
          timedOut,
          cancelled,
          durationMs: performance.now() - startedAt,
          truncated: limited.truncated,
          stdoutBytes: stdout.totalBytes,
          stderrBytes: stderr.totalBytes,
        },
      };
    },
  };
}
