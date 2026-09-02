import type { SlashCommand } from "../command.js";
import { formatError } from "../../errors/error-presenter.js";

export function createNewCommand(): SlashCommand {
  return {
    name: "new",
    usage: "/new",
    description: "Start a new session",
    group: "session",
    async execute(_args, context) {
      try {
        const session = await context.sessionManager.createNew();
        context.renderer.print(
          `New session ${session.id.slice(0, 8)} (no active Skill)`,
        );
        return { kind: "continue", stateChanged: true };
      } catch (error) {
        context.renderer.error(formatError(error, { debug: false }));
        return { kind: "continue", stateChanged: false };
      }
    },
  };
}
