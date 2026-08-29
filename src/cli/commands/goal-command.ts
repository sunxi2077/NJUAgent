import type { SlashCommand } from "../command.js";
import type { GoalState } from "../../goals/goal.js";

function formatGoalView(goal: GoalState): string {
  const lines = [
    `Goal: ${goal.status}`,
    `  ${goal.condition}`,
    `  automatic continuations used: ${goal.automaticContinuations}`,
  ];
  if (goal.lastDecision !== undefined) {
    const verdict = goal.lastDecision.satisfied ? "satisfied" : "not satisfied";
    lines.push(`  last decision: ${verdict} - ${goal.lastDecision.reason}`);
    for (const missing of goal.lastDecision.missingEvidence) {
      lines.push(`    missing: ${missing}`);
    }
  }
  return lines.join("\n");
}

export function createGoalCommand(): SlashCommand {
  return {
    name: "goal",
    usage: "/goal [clear|<completion condition>]",
    description: "Show, set, or clear the explicit completion goal",
    async execute(args, context) {
      const argument = args.trim();
      if (argument === "") {
        const goal = context.sessionManager.goal();
        context.renderer.print(
          goal === null ? "No active goal." : formatGoalView(goal),
        );
        return { kind: "continue", stateChanged: false };
      }
      if (argument === "clear") {
        await context.sessionManager.clearGoal();
        context.renderer.print("Goal cleared.");
        return { kind: "continue", stateChanged: true };
      }
      const goal = await context.sessionManager.setGoal(argument);
      const created = [
        context.theme.brandStrong("◆ Goal active"),
        `  ${goal.condition}`,
        "  The next ordinary message will run under this goal.",
      ];
      context.renderer.print(created.join("\n"));
      return { kind: "continue", stateChanged: true };
    },
  };
}
