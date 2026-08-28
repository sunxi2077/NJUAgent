import type { SlashCommand } from "../command.js";
import { formatHistory } from "../../sessions/session-format.js";

export function createHistoryCommand(): SlashCommand {
  return {
    name: "history",
    usage: "/history [1-100]",
    description: "Show recent messages",
    async execute(args, context) {
      let count = 20;
      const trimmed = args.trim();
      if (trimmed !== "") {
        const parsed = Number(trimmed);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
          context.renderer.print("Usage: /history [1-100]");
          return { kind: "continue", stateChanged: false };
        }
        count = parsed;
      }
      context.renderer.print(
        formatHistory(context.sessionManager.active(), {
          theme: context.theme,
          count,
        }),
      );
      return { kind: "continue", stateChanged: false };
    },
  };
}
