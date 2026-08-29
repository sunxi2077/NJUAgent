import { describe, expect, test } from "vitest";

import type { CommandContext } from "../../../../src/cli/command.js";
import { createSkillCommand } from "../../../../src/cli/commands/skill-command.js";
import { createSkillsCommand } from "../../../../src/cli/commands/skills-command.js";
import type { Renderer } from "../../../../src/cli/renderer.js";
import { createTheme } from "../../../../src/cli/theme.js";
import type { Skill, SkillSource } from "../../../../src/skills/skill.js";
import { AppError } from "../../../../src/errors/app-error.js";

class MemoryRenderer implements Renderer {
  readonly printed: string[] = [];
  readonly errors: string[] = [];
  handle(): void {}
  toolOutput(): void {}
  print(text: string): void {
    this.printed.push(text);
  }
  error(message: string): void {
    this.errors.push(message);
  }
}

const userSkill: Skill = {
  name: "test-first",
  description: "Require a failing test",
  instructions: "write a test",
  source: "user",
  filePath: "/u/test-first/SKILL.md",
};

const projectSkill: Skill = {
  ...userSkill,
  description: "project version",
  source: "project",
  filePath: "/p/test-first/SKILL.md",
};

function makeContext(overrides: {
  skills?: Skill[];
  diagnostics?: Array<{ source: SkillSource; name: string; message: string }>;
  active?: Skill | undefined;
  activateResult?: Skill;
  activateCalls?: string[];
  deactivateCalls?: number[];
  deactivateError?: Error;
} = {}) {
  const renderer = new MemoryRenderer();
  const services = {
    active: overrides.active,
    activateCalls: overrides.activateCalls ?? [],
    deactivateCalls: overrides.deactivateCalls ?? [],
  };
  const context: CommandContext = {
    renderer,
    theme: createTheme({ enabled: false }),
    signal: new AbortController().signal,
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
      activeSkill: () => services.active,
      activateSkill: async (name: string) => {
        services.activateCalls.push(name);
        return overrides.activateResult ?? { ...userSkill, name };
      },
      deactivateSkill: async () => {
        services.deactivateCalls.push(1);
        if (overrides.deactivateError !== undefined) {
          throw overrides.deactivateError;
        }
      },
      plan: () => ({ items: [] }),
      clearPlan: async () => ({ items: [] }),
    },
    store: {
      list: async () => ({ sessions: [], diagnostics: [] }),
    },
    skillRegistry: {
      refresh: async () => ({
        skills: overrides.skills ?? [],
        diagnostics: overrides.diagnostics ?? [],
      }),
      list: () => overrides.skills ?? [],
      resolve: (name: string) => {
        const found = (overrides.skills ?? []).find((skill) => skill.name === name);
        return found === undefined ? undefined : structuredClone(found);
      },
      diagnostics: () => overrides.diagnostics ?? [],
    },
  };
  return { context, renderer, services };
}

describe("/skills", () => {
  test("renders sorted rows with source, description, and active marker", async () => {
    const command = createSkillsCommand();
    const { context, renderer } = makeContext({
      skills: [
        { ...projectSkill, name: "alpha" },
        { ...userSkill, name: "zeta" },
      ],
      active: { ...projectSkill, name: "alpha" },
    });
    await command.execute("", context);
    const text = renderer.printed[0]!;
    expect(text.indexOf("alpha")).toBeLessThan(text.indexOf("zeta"));
    expect(text.indexOf("alpha")).toBeLessThan(text.indexOf("zeta"));
    expect(text).toContain("[project]");
    expect(text).toContain("[user]");
    expect(text).toContain("(active)");
    expect(text).toContain("Require a failing test");
  });

  test("invalid diagnostics appear after valid skills", async () => {
    const command = createSkillsCommand();
    const { context, renderer } = makeContext({
      skills: [userSkill],
      diagnostics: [{ source: "user", name: "broken", message: "invalid frontmatter" }],
    });
    await command.execute("", context);
    const listIndex = renderer.printed.findIndex((line) => line.startsWith("Skills"));
    const warningIndex = renderer.printed.findIndex((line) => line.startsWith("warning:"));
    expect(listIndex).toBeGreaterThanOrEqual(0);
    expect(warningIndex).toBeGreaterThan(listIndex);
    expect(renderer.printed[warningIndex]).toContain("broken");
    // Diagnostics never dump the skill file body.
    expect(renderer.printed[warningIndex]).not.toContain("---");
  });

  test("no skills gives actionable roots", async () => {
    const command = createSkillsCommand();
    const { context, renderer } = makeContext();
    await command.execute("", context);
    expect(renderer.printed[0]).toContain("$NJU_AGENT_HOME/skills");
    expect(renderer.printed[0]).toContain("<workspace>/.nju-agent/skills");
  });
});

describe("/skill", () => {
  test("renders usage for missing arguments", async () => {
    const command = createSkillCommand();
    const { context, renderer } = makeContext();
    const result = await command.execute("", context);
    expect(result).toEqual({ kind: "continue", stateChanged: false });
    expect(renderer.printed[0]).toContain("Usage: /skill <name>|off");
  });

  test("unknown name does not change activation and suggests /skills", async () => {
    const command = createSkillCommand();
    const { context, renderer, services } = makeContext({
      skills: [userSkill],
      active: undefined,
    });
    const result = await command.execute("missing", context);
    expect(result).toEqual({ kind: "continue", stateChanged: false });
    expect(renderer.errors[0]).toContain("Unknown skill");
    expect(renderer.errors[0]).toContain("/skills");
    expect(services.activateCalls).toHaveLength(0);
  });

  test("project override is the activated object", async () => {
    const command = createSkillCommand();
    const { context, renderer, services } = makeContext({
      skills: [userSkill, projectSkill],
      activateResult: projectSkill,
    });
    const result = await command.execute("test-first", context);
    expect(result).toEqual({ kind: "continue", stateChanged: true });
    expect(services.activateCalls).toEqual(["test-first"]);
    expect(renderer.printed[0]).toContain("source: project");
  });

  test("/skill off twice remains successful and null", async () => {
    const command = createSkillCommand();
    const { context, renderer, services } = makeContext();
    await command.execute("off", context);
    await command.execute("off", context);
    expect(services.deactivateCalls).toHaveLength(2);
    expect(renderer.printed.filter((line) => line.includes("deactivated"))).toHaveLength(2);
  });

  test("/skill off reports a persistence error without throwing", async () => {
    const command = createSkillCommand();
    const { context, renderer } = makeContext({
      deactivateError: new AppError({ code: "SESSION_IO", userMessage: "disk full" }),
    });

    const result = await command.execute("off", context);

    expect(result).toEqual({ kind: "continue", stateChanged: false });
    expect(renderer.errors[0]).toContain("[SESSION_IO]");
  });
});
