import { describe, expect, test, vi } from "vitest";

import type { CommandResult, SlashCommand } from "../../../src/cli/command.js";
import type { Renderer } from "../../../src/cli/renderer.js";
import { SlashCommandRouter } from "../../../src/cli/command-router.js";

class MemoryRenderer implements Renderer {
  readonly errors: string[] = [];
  handle(): void {}
  toolOutput(): void {}
  error(message: string): void {
    this.errors.push(message);
  }
}

function fakeCommand(
  name: string,
  execute: () => Promise<CommandResult> = async () => ({ kind: "continue" as const, stateChanged: false }),
): SlashCommand {
  return {
    name,
    usage: `/${name}`,
    description: `the ${name} command`,
    execute,
  };
}

describe("SlashCommandRouter", () => {
  test("ordinary input returns not_command", async () => {
    const router = new SlashCommandRouter();
    const context = { renderer: new MemoryRenderer() };
    await expect(router.route("fix code", context)).resolves.toEqual({
      kind: "not_command",
      text: "fix code",
    });
  });

  test("double slash escapes to a single leading slash", async () => {
    const router = new SlashCommandRouter();
    const context = { renderer: new MemoryRenderer() };
    await expect(router.route("//literal", context)).resolves.toEqual({
      kind: "not_command",
      text: "/literal",
    });
  });

  test("command names are case-insensitive and arguments preserve internal spaces", async () => {
    const router = new SlashCommandRouter();
    const execute = vi.fn(async () => ({ kind: "continue" as const, stateChanged: false }));
    router.register(fakeCommand("help", execute));
    const context = { renderer: new MemoryRenderer() };

    await router.route("/HELP   extra   text ", context);

    expect(execute).toHaveBeenCalledWith("extra   text", context);
  });

  test("rejects duplicate registration", () => {
    const router = new SlashCommandRouter();
    router.register(fakeCommand("help"));
    expect(() => router.register(fakeCommand("HELP"))).toThrow(/Duplicate/);
  });

  test("unknown commands render an error and never reach the model", async () => {
    const router = new SlashCommandRouter();
    const renderer = new MemoryRenderer();
    const result = await router.route("/nope args", { renderer });

    expect(result).toEqual({ kind: "handled", stateChanged: false });
    expect(renderer.errors[0]).toContain("Unknown command");
    expect(renderer.errors[0]).toContain("/nope");
  });

  test("bare slash is handled locally without reaching the model", async () => {
    const router = new SlashCommandRouter();
    const result = await router.route("/", { renderer: new MemoryRenderer() });
    expect(result).toEqual({ kind: "handled", stateChanged: false });
  });

  test("an exit command result surfaces as exit", async () => {
    const router = new SlashCommandRouter();
    router.register(fakeCommand("exit", async () => ({ kind: "exit" as const })));
    const result = await router.route("/exit", { renderer: new MemoryRenderer() });
    expect(result).toEqual({ kind: "exit" });
  });
});
