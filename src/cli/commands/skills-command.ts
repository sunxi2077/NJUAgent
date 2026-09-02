import type { SlashCommand } from "../command.js";
import { formatSkillList } from "../../sessions/session-format.js";

export function createSkillsCommand(): SlashCommand {
  return {
    name: "skills",
    usage: "/skills",
    description: "List available skills",
    group: "context",
    async execute(_args, context) {
      await context.skillRegistry.refresh();
      const skills = context.skillRegistry.list();
      const active = context.sessionManager.activeSkill();
      const activeName = active === undefined ? null : active.name;
      if (skills.length === 0) {
        context.renderer.print(
          `No skills found. Add them under $NJU_AGENT_HOME/skills/<name>/SKILL.md or <workspace>/.nju-agent/skills/<name>/SKILL.md.`,
        );
      } else {
        context.renderer.print(
          formatSkillList(skills, {
            activeName,
            theme: context.theme,
            ...(context.display.enhanced ? { columns: context.display.columns() } : {}),
          }),
        );
      }
      for (const diagnostic of context.skillRegistry.diagnostics()) {
        context.renderer.print(
          `warning: [${diagnostic.source}] ${diagnostic.name}: ${diagnostic.message}`,
        );
      }
      return { kind: "continue", stateChanged: false };
    },
  };
}
