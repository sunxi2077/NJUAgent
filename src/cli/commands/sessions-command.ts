import type { SlashCommand } from "../command.js";
import { formatSessionList } from "../../sessions/session-format.js";

export function createSessionsCommand(): SlashCommand {
  return {
    name: "sessions",
    usage: "/sessions",
    description: "List saved sessions",
    async execute(_args, context) {
      const { sessions, diagnostics } = await context.store.list();
      context.renderer.print(
        formatSessionList({
          sessions,
          currentId: context.sessionManager.active().id,
          theme: context.theme,
        }),
      );
      for (const diagnostic of diagnostics) {
        context.renderer.print(
          `warning: ${diagnostic.file}: ${diagnostic.message}`,
        );
      }
      return { kind: "continue", stateChanged: false };
    },
  };
}
