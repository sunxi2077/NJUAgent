import type { SlashCommand } from "../command.js";

export function createHelpCommand(
  getCommands: () => readonly SlashCommand[],
): SlashCommand {
  return {
    name: "help",
    usage: "/help",
    description: "Show available commands",
    async execute(_args, context) {
      const rows = getCommands().map(
        (command) => `${command.usage}  ${command.description}`,
      );
      context.renderer.print(
        `Commands:\n${rows.join("\n")}\nUse // to send literal text starting with /.`,
      );
      return { kind: "continue", stateChanged: false };
    },
  };
}
