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

export interface SlashCommand {
  readonly name: string;
  readonly usage: string;
  readonly description: string;
  execute(args: string, context: CommandContext): Promise<CommandResult>;
}

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
  >;
  store: Pick<SessionStore, "list">;
  skillRegistry: Pick<SkillRegistry, "refresh" | "list" | "resolve" | "diagnostics">;
  /** Whether the web_search tool is registered (derived from config, never the key). */
  webSearchAvailable: boolean;
  runSetup?: () => Promise<boolean>;
  signal: AbortSignal;
};
