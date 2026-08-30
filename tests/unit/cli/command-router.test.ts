import { describe, expect, test, vi } from "vitest";

import type { CommandResult, CommandContext, SlashCommand } from "../../../src/cli/command.js";
import { SlashCommandRouter } from "../../../src/cli/command-router.js";
import type { Renderer } from "../../../src/cli/renderer.js";
import { createTheme } from "../../../src/cli/theme.js";

class MemoryRenderer implements Renderer {
  permissionRequest(): void {}
  permissionDecision(): void {}
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
      goal: () => null,
      setGoal: async (condition: string) => ({
        condition,
        status: "active" as const,
        createdAt: "",
        updatedAt: "",
        automaticContinuations: 0,
      }),
      clearGoal: async () => undefined,
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

  test("/goal create, view, and clear stay entirely local", async () => {
    const router = new SlashCommandRouter();
    let created: string | undefined;
    let viewed = false;
    let cleared = false;
    router.register({
      name: "goal",
      usage: "/goal [clear|<completion condition>]",
      description: "Manage the completion goal",
      async execute(args, ctx) {
        const sessionManager = ctx.sessionManager as unknown as {
          setGoal: (c: string) => Promise<{ condition: string }>;
          clearGoal: () => Promise<void>;
          goal: () => { condition: string } | null;
        };
        const argument = args.trim();
        if (argument === "") {
          viewed = sessionManager.goal() !== null;
          return { kind: "continue" as const, stateChanged: false };
        }
        if (argument === "clear") {
          cleared = true;
          await sessionManager.clearGoal();
          return { kind: "continue" as const, stateChanged: true };
        }
        const goal = await sessionManager.setGoal(argument);
        created = goal.condition;
        return { kind: "continue" as const, stateChanged: true };
      },
    });
    const ctx = context();
    await router.route("/goal fix the parser and run npm test", ctx);
    expect(created).toBe("fix the parser and run npm test");
    await router.route("/goal", ctx);
    expect(viewed).toBe(false);
    await router.route("/goal clear", ctx);
    expect(cleared).toBe(true);
  });

  describe("descriptors", () => {
    test("returns only name, usage, and description in registration order", () => {
      const router = new SlashCommandRouter();
      router.register(fakeCommand("Help"));
      router.register(fakeCommand("GOAL"));

      const first = router.descriptors();

      expect(first).toEqual([
        { name: "help", usage: "/Help", description: "the Help command" },
        { name: "goal", usage: "/GOAL", description: "the GOAL command" },
      ]);
      expect("execute" in first[0]!).toBe(false);
      expect(first[0]).not.toHaveProperty("execute");
    });

    test("returns fresh arrays and objects on every call", () => {
      const router = new SlashCommandRouter();
      router.register(fakeCommand("help"));
      const first = router.descriptors();
      const second = router.descriptors();

      expect(first).not.toBe(second);
      expect(first[0]).not.toBe(second[0]);
    });

    test("callers cannot mutate the router's commands through descriptors", () => {
      const router = new SlashCommandRouter();
      router.register(fakeCommand("help"));
      const descriptors = router.descriptors() as unknown as Array<{
        name: string;
        usage: string;
        description: string;
      }>;
      descriptors[0]!.description = "mutated";
      descriptors.push({ name: "injected", usage: "/injected", description: "injected" });

      expect(router.commands()).toHaveLength(1);
      expect(router.commands()[0]!.description).toBe("the help command");
    });

    test("commands() still returns the full commands for /help", () => {
      const router = new SlashCommandRouter();
      router.register(fakeCommand("help"));
      expect(router.commands()).toHaveLength(1);
      expect(router.commands()[0]!.execute).toBeTypeOf("function");
    });
  });
});
