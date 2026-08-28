import type { SessionManager } from "../sessions/session-manager.js";
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
    "active" | "isDirty" | "flush" | "createNew" | "resume" | "contextStatus" | "compact"
  >;
  store: Pick<SessionStore, "list">;
  signal: AbortSignal;
};
