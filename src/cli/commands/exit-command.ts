import type { SlashCommand } from "../command.js";
import { formatError } from "../../errors/error-presenter.js";

export function createExitCommand(): SlashCommand {
  return {
    name: "exit",
    usage: "/exit",
    description: "Save the current session and exit",
    group: "session",
    async execute(_args, context) {
      try {
        await context.sessionManager.flush();
        return { kind: "exit" };
      } catch (error) {
        context.renderer.error(formatError(error, { debug: false }));
        return { kind: "continue", stateChanged: false };
      }
    },
  };
}
