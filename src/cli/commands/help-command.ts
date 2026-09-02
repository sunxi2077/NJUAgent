import {
  COMMAND_GROUP_LABELS,
  COMMAND_GROUP_ORDER,
  type CommandGroup,
  type SlashCommand,
} from "../command.js";
import { formatCommandPanel, type CommandPanel } from "../command-layout.js";

export function createHelpCommand(
  getCommands: () => readonly SlashCommand[],
): SlashCommand {
  return {
    name: "help",
    usage: "/help",
    description: "Show available commands",
    group: "configuration",
    async execute(_args, context) {
      const commands = getCommands();
      const grouped = new Map<string, SlashCommand[]>();
      for (const command of commands) {
        const key = command.group ?? "other";
        const list = grouped.get(key) ?? [];
        list.push(command);
        grouped.set(key, list);
      }
      const order = [...COMMAND_GROUP_ORDER, "other"];
      const rowsFor = (key: string): Array<{ usage: string; description: string }> =>
        (grouped.get(key) ?? []).map((command) => ({
          usage: command.usage,
          description: command.description,
        }));

      if (context.display.enhanced) {
        type PanelSection = CommandPanel["sections"][number];
        const sections: PanelSection[] = [];
        for (const key of order) {
          const rows = rowsFor(key);
          if (rows.length === 0) {
            continue;
          }
          const heading = key === "other"
            ? undefined
            : COMMAND_GROUP_LABELS[key as CommandGroup];
          sections.push({
            ...(heading === undefined ? {} : { heading }),
            rows: rows.map((row) => ({ label: row.usage, value: row.description })),
          });
        }
        sections.push({
          rows: [{ value: "Use // to send literal text beginning with /." }],
        });
        const panel: CommandPanel = {
          symbol: "◆",
          title: "Commands",
          sections,
        };
        context.renderer.print(
          formatCommandPanel(panel, {
            columns: context.display.columns(),
            theme: context.theme,
          }),
        );
        return { kind: "continue", stateChanged: false };
      }

      const lines: string[] = ["Commands:"];
      for (const key of order) {
        const rows = rowsFor(key);
        if (rows.length === 0) {
          continue;
        }
        if (key !== "other") {
          lines.push(COMMAND_GROUP_LABELS[key as CommandGroup]);
        }
        for (const row of rows) {
          lines.push(`${row.usage}  ${row.description}`);
        }
      }
      lines.push("Use // to send literal text starting with /.");
      context.renderer.print(lines.join("\n"));
      return { kind: "continue", stateChanged: false };
    },
  };
}
