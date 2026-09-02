import type { CommandContext, SlashCommand } from "../command.js";
import { formatCommandPanel, type CommandPanel } from "../command-layout.js";
import { summarizeToolInput } from "../renderer.js";
import {
  findToolActivity,
  toolReference,
  type ToolActivity,
} from "../tool-activity.js";

/**
 * Local inspector for retained tool output in the active session. Looks up a
 * finished tool call by its stable `T-…` reference, full provider id, or a
 * unique provider-id prefix and prints its metadata plus the stored result
 * body; never calls the model or a Tool.
 */
export function createToolCommand(): SlashCommand {
  return {
    name: "tool",
    usage: "/tool <id>",
    description: "Show retained output for a tool call",
    group: "agent",
    async execute(args, context) {
      const prefix = args.trim();
      if (prefix === "") {
        context.renderer.print("Usage: /tool <id>");
        return { kind: "continue", stateChanged: false };
      }
      const match = findToolActivity(context.sessionManager.messages(), prefix);
      switch (match.kind) {
        case "none":
          context.renderer.print(`No tool call matches "${prefix}" in this session.`);
          break;
        case "ambiguous": {
          const lines = [`Multiple tool calls match "${prefix}":`];
          for (const candidate of match.matches) {
            lines.push(`  ${toolReference(candidate.id)}  ${candidate.name}`);
          }
          context.renderer.print(lines.join("\n"));
          break;
        }
        case "found":
          renderToolActivity(match.activity, context);
          break;
      }
      return { kind: "continue", stateChanged: false };
    },
  };
}

function renderToolActivity(activity: ToolActivity, context: CommandContext): void {
  const inputSummary = summarizeToolInput({
    id: activity.id,
    name: activity.name,
    input: activity.input,
  });
  const outcome = activity.result === undefined
    ? undefined
    : activity.result.isError
      ? "failed"
      : "ok";
  if (context.display.enhanced) {
    const rows: Array<{ label: string; value: string }> = [
      { label: "Id", value: activity.id },
      { label: "Reference", value: toolReference(activity.id) },
      ...(inputSummary === "" ? [] : [{ label: "Input", value: inputSummary }]),
      ...(outcome === undefined ? [] : [{ label: "Result", value: outcome }]),
    ];
    const panel: CommandPanel = {
      symbol: "⚙",
      title: activity.name,
      sections: [{ rows }],
    };
    context.renderer.print(
      formatCommandPanel(panel, {
        columns: context.display.columns(),
        theme: context.theme,
      }),
    );
  } else {
    const lines = [`Tool ${activity.id} (${activity.name})`];
    lines.push(`Reference: ${toolReference(activity.id)}`);
    if (inputSummary !== "") {
      lines.push(`Input: ${inputSummary}`);
    }
    if (outcome !== undefined) {
      lines.push(`Result: ${outcome}`);
    }
    context.renderer.print(lines.join("\n"));
  }
  if (activity.result !== undefined) {
    context.renderer.print("Stored result:");
    context.renderer.print(activity.result.content);
  }
}
