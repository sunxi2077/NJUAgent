import type { SlashCommand } from "../command.js";
import { formatContextStatus } from "../../sessions/session-format.js";

export function createContextCommand(): SlashCommand {
  return {
    name: "context",
    usage: "/context",
    description: "Show context budget and checkpoint status",
    async execute(_args, context) {
      const status = context.sessionManager.contextStatus();
      context.renderer.print(formatContextStatus(status, context.theme));
      return { kind: "continue", stateChanged: false };
    },
  };
}
