import type { SlashCommand } from "../command.js";
import { formatSessionStatus } from "../../sessions/session-format.js";

export function createStatusCommand(): SlashCommand {
  return {
    name: "status",
    usage: "/status",
    description: "Show current session status",
    async execute(_args, context) {
      context.renderer.print(
        formatSessionStatus(context.sessionManager.active(), {
          dirty: context.sessionManager.isDirty(),
          theme: context.theme,
        }),
      );
      return { kind: "continue", stateChanged: false };
    },
  };
}
