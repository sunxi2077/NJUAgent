import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Workspace } from "../../../src/security/workspace.js";
import { createRunCommandTool } from "../../../src/tools/command-tool.js";
import type { ToolContext } from "../../../src/tools/tool.js";

const temporaryDirectories: string[] = [];

async function fixture(
  maxOutputBytes = 4096,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
) {
  const root = await mkdtemp(path.join(tmpdir(), "nju-command-tool-"));
  temporaryDirectories.push(root);
  const workspace = await Workspace.open(root);
  return {
    workspace,
    tool: createRunCommandTool({
      workspace,
      defaultTimeoutMs: 2000,
      maxOutputBytes,
      sourceEnvironment,
    }),
  };
}

function nodeCommand(source: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("run_command", () => {
  test("runs in the canonical workspace and captures stdout, stderr, and exit code", async () => {
    const { workspace, tool } = await fixture();
    const chunks: { stream: string; text: string }[] = [];
    const context: ToolContext = {
      signal: new AbortController().signal,
      emitOutput: (stream, text) => chunks.push({ stream, text }),
    };

    const result = await tool.execute(
      {
        command: nodeCommand(
          "console.log(process.cwd()); process.stderr.write('warning\\n')",
        ),
      },
      context,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain(`stdout:\n${workspace.root}`);
    expect(result.content).toContain("stderr:\nwarning");
    expect(result.metadata).toMatchObject({ exitCode: 0, timedOut: false, cancelled: false });
    expect(chunks.some((chunk) => chunk.stream === "stdout" && chunk.text.includes(workspace.root))).toBe(true);
    expect(chunks.some((chunk) => chunk.stream === "stderr" && chunk.text.includes("warning"))).toBe(true);
  });

  test("returns an unsuccessful result for a nonzero exit", async () => {
    const { tool } = await fixture();
    const result = await tool.execute(
      { command: nodeCommand("process.stderr.write('bad\\n'); process.exit(7)") },
      { signal: new AbortController().signal, emitOutput: () => undefined },
    );
    expect(result.isError).toBe(true);
    expect(result.metadata).toMatchObject({ exitCode: 7, timedOut: false });
    expect(result.content).toContain("exit_code: 7");
  });

  test("terminates and reports a command that exceeds its timeout", async () => {
    const { tool } = await fixture();
    const started = performance.now();
    const result = await tool.execute(
      { command: nodeCommand("setTimeout(() => {}, 5000)"), timeoutMs: 50 },
      { signal: new AbortController().signal, emitOutput: () => undefined },
    );
    expect(result.isError).toBe(true);
    expect(result.metadata).toMatchObject({ timedOut: true, cancelled: false });
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("terminates and reports cancellation from the shared AbortSignal", async () => {
    const { tool } = await fixture();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const result = await tool.execute(
      { command: nodeCommand("setTimeout(() => {}, 5000)") },
      { signal: controller.signal, emitOutput: () => undefined },
    );
    expect(result.isError).toBe(true);
    expect(result.metadata).toMatchObject({ timedOut: false, cancelled: true });
  });

  test("limits captured output while keeping live chunks available", async () => {
    const { tool } = await fixture(120);
    let liveBytes = 0;
    const result = await tool.execute(
      { command: nodeCommand("process.stdout.write('x'.repeat(2000))") },
      {
        signal: new AbortController().signal,
        emitOutput: (_stream, text) => liveBytes += Buffer.byteLength(text),
      },
    );
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(120);
    expect(result.content).toContain("bytes omitted");
    expect(result.metadata).toMatchObject({ truncated: true });
    expect(liveBytes).toBe(2000);
  });

  test("does not expose model credentials to the child process", async () => {
    const { tool } = await fixture(4096, {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ANTHROPIC_API_KEY: "must-not-reach-child",
    });
    const result = await tool.execute(
      { command: nodeCommand("console.log(process.env.ANTHROPIC_API_KEY ?? 'missing')") },
      { signal: new AbortController().signal, emitOutput: () => undefined },
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("stdout:\nmissing");
    expect(result.content).not.toContain("must-not-reach-child");
  });
});
