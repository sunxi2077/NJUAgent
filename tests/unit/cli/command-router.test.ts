import { describe, expect, test, vi } from "vitest";

import type { CommandResult, CommandContext, SlashCommand } from "../../../src/cli/command.js";
import { SlashCommandRouter } from "../../../src/cli/command-router.js";
import type { Renderer } from "../../../src/cli/renderer.js";
import { createTheme } from "../../../src/cli/theme.js";

class MemoryRenderer implements Renderer {
  readonly errors: string[] = [];
  readonly printed: string[] = [];
  handle(): void {}
  toolOutput(): void {}
  print(text: string): void {
    this.printed.push(text);
  }
  error(message: string): void {
    this.errors.push(message);
  }
}

function context(): CommandContext {
  return {
    renderer: new MemoryRenderer(),
    theme: createTheme({ enabled: false }),
    signal: new AbortController().signal,
    webSearchAvailable: false,
    skillRegistry: {
      refresh: async () => ({ skills: [], diagnostics: [] }),
      list: () => [],
      resolve: () => undefined,
      diagnostics: () => [],
    },

    sessionManager: {
      active: () => {
        throw new Error("unused");
      },
      isDirty: () => false,
      flush: async () => undefined,
      createNew: async () => {
        throw new Error("unused");
      },
      resume: async () => {
        throw new Error("unused");
      },
      contextStatus: () => {
        throw new Error("unused");
      },
      compact: async () => {
        throw new Error("unused");
      },
      activeSkill: () => undefined,
      activateSkill: async () => { throw new Error("unused"); },
      deactivateSkill: async () => undefined,
      plan: () => ({ items: [] }),
      clearPlan: async () => ({ items: [] }),
    },
    store: {
      list: async () => ({ sessions: [], diagnostics: [] }),
    },
  };
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
    const ctx = context();
    await expect(router.route("fix code", ctx)).resolves.toEqual({
      kind: "not_command",
      text: "fix code",
    });
  });

  test("double slash escapes to a single leading slash", async () => {
    const router = new SlashCommandRouter();
    const ctx = context();
    await expect(router.route("//literal", ctx)).resolves.toEqual({
      kind: "not_command",
      text: "/literal",
    });
  });

  test("command names are case-insensitive and arguments preserve internal spaces", async () => {
    const router = new SlashCommandRouter();
    const execute = vi.fn(async () => ({ kind: "continue" as const, stateChanged: false }));
    router.register(fakeCommand("help", execute));
    const ctx = context();

    await router.route("/HELP   extra   text ", ctx);

    expect(execute).toHaveBeenCalledWith("extra   text", ctx);
  });

  test("rejects duplicate registration", () => {
    const router = new SlashCommandRouter();
    router.register(fakeCommand("help"));
    expect(() => router.register(fakeCommand("HELP"))).toThrow(/Duplicate/);
  });

  test("unknown commands render an error and never reach the model", async () => {
    const router = new SlashCommandRouter();
    const ctx = context();
    const renderer = ctx.renderer as MemoryRenderer;
    const result = await router.route("/nope args", ctx);

    expect(result).toEqual({ kind: "handled", stateChanged: false });
    expect(renderer.errors[0]).toContain("Unknown command");
    expect(renderer.errors[0]).toContain("/nope");
  });

  test("bare slash is handled locally without reaching the model", async () => {
    const router = new SlashCommandRouter();
    const result = await router.route("/", context());
    expect(result).toEqual({ kind: "handled", stateChanged: false });
  });

  test("an exit command result surfaces as exit", async () => {
    const router = new SlashCommandRouter();
    router.register(fakeCommand("exit", async () => ({ kind: "exit" as const })));
    const result = await router.route("/exit", context());
    expect(result).toEqual({ kind: "exit" });
  });

  test("/plan is a local command that never reaches the model", async () => {
    const router = new SlashCommandRouter();
    let shown: unknown;
    let cleared = false;
    router.register({
      name: "plan",
      usage: "/plan [clear]",
      description: "Show the execution plan",
      async execute(args, ctx) {
        if (args.trim() === "clear") {
          cleared = true;
          await ctx.sessionManager.clearPlan();
          return { kind: "continue" as const, stateChanged: true };
        }
        shown = ctx.sessionManager.plan();
        return { kind: "continue" as const, stateChanged: false };
      },
    });
    const ctx = context();
    const result = await router.route("/plan", ctx);
    expect(result).toEqual({ kind: "handled", stateChanged: false });
    expect(shown).toEqual({ items: [] });
    expect(cleared).toBe(false);
  });
});
