import type { SlashCommand } from "../command.js";
import { formatContextStatus } from "../../sessions/session-format.js";

export function createContextCommand(): SlashCommand {
  return {
    name: "context",
    usage: "/context",
    description: "Show context budget and checkpoint status",
    group: "context",
    async execute(_args, context) {
      const status = context.sessionManager.contextStatus();
      context.renderer.print(
        formatContextStatus(
          status,
          context.theme,
          context.display.enhanced ? context.display.columns() : undefined,
        ),
      );
      return { kind: "continue", stateChanged: false };
    },
  };
}
