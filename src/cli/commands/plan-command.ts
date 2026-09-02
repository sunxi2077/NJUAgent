import type { SlashCommand } from "../command.js";
import type { PlanState } from "../../planning/plan.js";
import type { TerminalTheme } from "../theme.js";

function formatPlanPanel(plan: PlanState, theme: TerminalTheme): string {
  if (plan.items.length === 0) {
    return "No active plan.";
  }
  const completed = plan.items.filter((item) => item.status === "completed").length;
  const idWidth = Math.max(...plan.items.map((item) => [...item.id].length));
  const lines: string[] = [theme.brandStrong(`◆ Plan ${completed}/${plan.items.length}`)];
  for (const item of plan.items) {
    const symbol = item.status === "completed"
      ? "✓"
      : item.status === "in_progress"
        ? "◐"
        : "○";
    const id = item.status === "completed"
      ? theme.success(`${symbol} ${item.id}`)
      : item.status === "in_progress"
        ? theme.warning(`${symbol} ${item.id}`)
        : `${symbol} ${item.id}`;
    const padding = " ".repeat(Math.max(1, idWidth - [...item.id].length + 4));
    lines.push(`  ${id}${padding}${item.content}`);
  }
  return lines.join("\n");
}

function formatPlanRecords(plan: PlanState): string {
  if (plan.items.length === 0) {
    return "No active plan.";
  }
  const completed = plan.items.filter((item) => item.status === "completed").length;
  const lines = [`[plan] ${completed}/${plan.items.length}`];
  for (const item of plan.items) {
    lines.push(`[plan] ${item.status} ${item.id}: ${item.content}`);
  }
  return lines.join("\n");
}

export function createPlanCommand(): SlashCommand {
  return {
    name: "plan",
    usage: "/plan [clear]",
    description: "Show or clear the model-maintained execution plan",
    group: "agent",
    async execute(args, context) {
      const argument = args.trim();
      if (argument === "") {
        const plan = context.sessionManager.plan();
        context.renderer.print(
          context.theme.enabled
            ? formatPlanPanel(plan, context.theme)
            : formatPlanRecords(plan),
        );
        return { kind: "continue", stateChanged: false };
      }
      if (argument === "clear") {
        const cleared = await context.sessionManager.clearPlan();
        if (context.theme.enabled) {
          context.renderer.print(formatPlanPanel(cleared, context.theme));
        } else {
          context.renderer.print(formatPlanRecords(cleared));
        }
        return { kind: "continue", stateChanged: true };
      }
      context.renderer.error("Usage: /plan [clear]");
      return { kind: "continue", stateChanged: false };
    },
  };
}
