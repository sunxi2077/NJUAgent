import { describe, expect, test } from "vitest";
import type { Interface } from "node:readline";

import { ReadlinePrompt } from "../../../src/cli/prompt.js";

class FakeReadline {
  promptText = "";
  promptCalls: boolean[] = [];
  readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  closed = false;
  line: string | undefined;

  setPrompt(text: string): void {
    this.promptText = text;
  }

  prompt(flag?: boolean): void {
    this.promptCalls.push(flag ?? false);
  }

  on(event: string, handler: (...args: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  close(): void {
    this.closed = true;
  }

  emitLine(line: string): void {
    this.line = line;
    for (const handler of this.handlers.get("line") ?? []) {
      handler(line);
    }
  }
}

class TTYStdout {
  readonly chunks: string[] = [];
  isTTY = true;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  text(): string {
    return this.chunks.join("");
  }
}

function makePrompt() {
  const rl = new FakeReadline();
  const output = new TTYStdout();
  const prompt = new ReadlinePrompt({
    input: process.stdin,
    output: output as unknown as NodeJS.WritableStream,
    terminal: true,
    interfaceFactory: () => rl as unknown as Interface,
  });
  return { prompt, rl, output };
}

describe("ReadlinePrompt", () => {
  test("readline owns the prompt: setPrompt + prompt(true), no manual write", async () => {
    const { prompt, rl, output } = makePrompt();
    const pending = prompt.read("› ");

    expect(rl.promptText).toBe("› ");
    expect(rl.promptCalls).toEqual([true]);
    expect(output.text()).toBe("");

    rl.emitLine("hello");
    await expect(pending).resolves.toBe("hello");
  });

  test("suspendForOutput clears the prompt line and resume redraws it", async () => {
    const { prompt, rl, output } = makePrompt();
    const pending = prompt.read("› ");

    prompt.suspendForOutput();
    expect(output.text()).toContain("\x1b[");

    const callsBefore = rl.promptCalls.length;
    prompt.resumeAfterOutput();
    expect(rl.promptCalls).toHaveLength(callsBefore + 1);
    expect(rl.promptCalls.at(-1)).toBe(true);
    expect(rl.line).toBeUndefined();

    rl.emitLine("ok");
    await expect(pending).resolves.toBe("ok");
  });

  test("suspendForOutput is a no-op while no read is pending", () => {
    const { prompt, output } = makePrompt();
    prompt.suspendForOutput();
    prompt.resumeAfterOutput();
    expect(output.text()).toBe("");
  });
});
