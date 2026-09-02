import type { SlashCommand } from "../command.js";
import { formatError } from "../../errors/error-presenter.js";

export function createResumeCommand(): SlashCommand {
  return {
    name: "resume",
    usage: "/resume <id>",
    description: "Resume a saved session by full ID or unique prefix",
    group: "session",
    async execute(args, context) {
      const id = args.trim();
      if (id === "") {
        context.renderer.print("Usage: /resume <id>");
        return { kind: "continue", stateChanged: false };
      }
      try {
        const session = await context.sessionManager.resume(id);
        context.renderer.print(
          `Resumed ${session.id.slice(0, 8)} (${session.title})`,
        );
        return { kind: "continue", stateChanged: true };
      } catch (error) {
        context.renderer.error(formatError(error, { debug: false }));
        return { kind: "continue", stateChanged: false };
      }
    },
  };
}
