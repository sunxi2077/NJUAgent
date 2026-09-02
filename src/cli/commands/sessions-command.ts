import type { SlashCommand } from "../command.js";
import { formatSessionList } from "../../sessions/session-format.js";

const DEFAULT_LIST_LIMIT = 12;

export function createSessionsCommand(): SlashCommand {
  return {
    name: "sessions",
    usage: "/sessions [all]",
    description: "List saved sessions",
    group: "session",
    async execute(args, context) {
      const argument = args.trim();
      if (argument !== "" && argument !== "all") {
        context.renderer.error("Usage: /sessions [all]");
        return { kind: "continue", stateChanged: false };
      }
      const showAll = argument === "all";
      const { sessions, diagnostics } = await context.store.list();
      const total = sessions.length;
      const shown = showAll ? sessions : sessions.slice(0, DEFAULT_LIST_LIMIT);
      context.renderer.print(
        formatSessionList({
          sessions: shown,
          currentId: context.sessionManager.active().id,
          theme: context.theme,
          ...(context.display.enhanced ? { columns: context.display.columns() } : {}),
          ...(total > shown.length ? { totalCount: total, truncated: true } : {}),
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
