import type { SessionManager } from "../sessions/session-manager.js";
import type { SkillRegistry } from "../skills/skill-registry.js";
import type { SessionStore } from "../sessions/session-store.js";
import type { Renderer } from "./renderer.js";
import type { TerminalTheme } from "./theme.js";

export type CommandResult =
  | { kind: "continue"; stateChanged: boolean }
  | { kind: "exit" };

export type RouteResult =
  | { kind: "not_command"; text: string }
  | { kind: "handled"; stateChanged: boolean }
  | { kind: "exit" };

export type CommandGroup = "session" | "agent" | "context" | "configuration";

export interface SlashCommand {
  readonly name: string;
  readonly usage: string;
  readonly description: string;
  /** Help grouping for the core command surface. */
  readonly group?: CommandGroup;
  execute(args: string, context: CommandContext): Promise<CommandResult>;
}

/** Help grouping labels in display order. */
export const COMMAND_GROUP_LABELS: Readonly<Record<CommandGroup, string>> = {
  session: "Session",
  agent: "Agent",
  context: "Context & skills",
  configuration: "Configuration",
};

/** Display order for help grouping. */
export const COMMAND_GROUP_ORDER: readonly CommandGroup[] = [
  "session",
  "agent",
  "context",
  "configuration",
];

/** Safe read-only command metadata for the slash palette; never exposes execute. */
export type SlashCommandDescriptor = Readonly<
  Pick<SlashCommand, "name" | "usage" | "description">
>;

/** Capabilities available to slash-command handlers. */
export type CommandContext = {
  renderer: Renderer;
  theme: TerminalTheme;
  sessionManager: Pick<
    SessionManager,
    | "active"
    | "isDirty"
    | "flush"
    | "createNew"
    | "resume"
    | "contextStatus"
    | "compact"
    | "activeSkill"
    | "activateSkill"
    | "deactivateSkill"
    | "plan"
    | "clearPlan"
    | "goal"
    | "setGoal"
    | "clearGoal"
  >;
  store: Pick<SessionStore, "list">;
  skillRegistry: Pick<SkillRegistry, "refresh" | "list" | "resolve" | "diagnostics">;
  /** Whether the web_search tool is registered (derived from config, never the key). */
  webSearchAvailable: boolean;
  /** Narrow display capability; commands never inspect process.stdout directly. */
  display: {
    enhanced: boolean;
    /** Returns the current terminal columns; falls back to 80. */
    columns: () => number;
  };
  runSetup?: () => Promise<boolean>;
  signal: AbortSignal;
};
