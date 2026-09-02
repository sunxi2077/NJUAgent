import type { SlashCommand } from "../command.js";
import { formatError } from "../../errors/error-presenter.js";

export function createSetupCommand(): SlashCommand {
  return {
    name: "setup",
    usage: "/setup",
    description: "Update model and permission configuration",
    group: "configuration",
    async execute(_args, context) {
      try {
        if (context.runSetup === undefined) {
          throw new Error("Setup is unavailable in this session.");
        }
        const updated = await context.runSetup();
        if (!updated) {
          context.renderer.print("Setup cancelled; configuration unchanged.");
          return { kind: "continue", stateChanged: false };
        }
        context.renderer.print("Configuration updated; the active session is ready.");
        return { kind: "continue", stateChanged: true };
      } catch (error) {
        context.renderer.error(formatError(error, { debug: false }));
        return { kind: "continue", stateChanged: false };
      }
    },
  };
}
