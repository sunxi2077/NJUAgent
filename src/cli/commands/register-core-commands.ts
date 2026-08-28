import type { SlashCommandRouter } from "../command-router.js";
import { createCompactCommand } from "./compact-command.js";
import { createContextCommand } from "./context-command.js";
import { createExitCommand } from "./exit-command.js";
import { createHelpCommand } from "./help-command.js";
import { createHistoryCommand } from "./history-command.js";
import { createNewCommand } from "./new-command.js";
import { createResumeCommand } from "./resume-command.js";
import { createSkillCommand } from "./skill-command.js";
import { createSkillsCommand } from "./skills-command.js";
import { createSessionsCommand } from "./sessions-command.js";
import { createStatusCommand } from "./status-command.js";

/**
 * Registers the implemented core commands. Future plans add `/context`,
 * `/compact`, `/skills`, `/skill`, and `/setup`; this list reflects only
 * commands that are actually registered on the final branch.
 */
export function registerCoreCommands(router: SlashCommandRouter): void {
  router.register(createHelpCommand(() => router.commands()));
  router.register(createStatusCommand());
  router.register(createSessionsCommand());
  router.register(createResumeCommand());
  router.register(createNewCommand());
  router.register(createHistoryCommand());
  router.register(createContextCommand());
  router.register(createCompactCommand());
  router.register(createSkillsCommand());
  router.register(createSkillCommand());
  router.register(createExitCommand());
}
