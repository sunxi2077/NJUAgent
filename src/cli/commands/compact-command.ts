import type { SlashCommand } from "../command.js";
import { formatError } from "../../errors/error-presenter.js";

export function createCompactCommand(): SlashCommand {
  return {
    name: "compact",
    usage: "/compact [focus]",
    description: "Summarize the covered conversation",
    async execute(args, context) {
      const focus = args.trim() === "" ? undefined : args.trim();
      context.renderer.print(
        context.theme.muted("Compacting conversation… (Ctrl-C to cancel)"),
      );
      try {
        const prepared = await context.sessionManager.compact(
          focus,
          context.signal,
        );
        if (prepared.action === "continue" && prepared.reason !== undefined) {
          context.renderer.print(prepared.reason);
          return { kind: "continue", stateChanged: false };
        }
        const covered = prepared.checkpoint?.coveredMessageCount ?? 0;
        context.renderer.print(
          `Compacted: ${covered} messages covered, ${context.sessionManager.contextStatus().compactionCount} total compactions.`,
        );
        return { kind: "continue", stateChanged: true };
      } catch (error) {
        context.renderer.error(formatError(error, { debug: false }));
        return { kind: "continue", stateChanged: false };
      }
    },
  };
}
