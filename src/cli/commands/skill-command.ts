import type { SlashCommand } from "../command.js";
import { formatError } from "../../errors/error-presenter.js";

export function createSkillCommand(): SlashCommand {
  return {
    name: "skill",
    usage: "/skill <name>|off",
    description: "Activate or deactivate a skill",
    async execute(args, context) {
      const trimmed = args.trim();
      if (trimmed === "") {
        context.renderer.print("Usage: /skill <name>|off");
        return { kind: "continue", stateChanged: false };
      }
      if (trimmed === "off") {
        await context.sessionManager.deactivateSkill();
        context.renderer.print("Skill deactivated.");
        return { kind: "continue", stateChanged: true };
      }
      await context.skillRegistry.refresh();
      const resolved = context.skillRegistry.resolve(trimmed);
      if (resolved === undefined) {
        context.renderer.error(
          `Unknown skill "${trimmed}". Type /skills to list available skills.`,
        );
        return { kind: "continue", stateChanged: false };
      }
      try {
        const activated = await context.sessionManager.activateSkill(trimmed);
        context.renderer.print(
          `Skill "${activated.name}" activated (source: ${activated.source}).`,
        );
        return { kind: "continue", stateChanged: true };
      } catch (error) {
        context.renderer.error(formatError(error, { debug: false }));
        return { kind: "continue", stateChanged: false };
      }
    },
  };
}
