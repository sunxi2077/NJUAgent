import type { TerminalTheme } from "../cli/theme.js";
import type { Message } from "../agent/messages.js";
import type { SessionListEntry } from "./session-store.js";
import type { PersistedSessionV1 } from "./session-schema.js";

const TITLE_LIMIT = 48;
const WORKSPACE_LIMIT = 60;
const MESSAGE_PREVIEW_LIMIT = 240;
const TOOL_RESULT_LIMIT = 160;

/** Truncates by code points without splitting surrogate pairs. */
function truncateText(text: string, maxCodePoints: number): string {
  const chars = [...text];
  if (chars.length <= maxCodePoints) {
    return text;
  }
  return `${chars.slice(0, Math.max(0, maxCodePoints - 1)).join("")}…`;
}

export function formatSessionList(options: {
  sessions: readonly SessionListEntry[];
  currentId: string;
  theme: TerminalTheme;
}): string {
  const { sessions, currentId, theme } = options;
  const rows = sessions.map((entry) => {
    const marker = entry.id === currentId ? theme.brand("  (current)") : "";
    const title = truncateText(entry.title, TITLE_LIMIT);
    const workspace = truncateText(entry.workspaceRoot, WORKSPACE_LIMIT);
    return `${entry.id.slice(0, 8)}  ${title}  ${workspace}  ${entry.updatedAt}${marker}`;
  });
  return [`Sessions (${sessions.length}):`, ...rows].join("\n");
}

export function formatSessionStatus(
  session: PersistedSessionV1,
  options: { dirty: boolean; theme: TerminalTheme },
): string {
  const { dirty, theme } = options;
  return [
    `Model: ${session.modelId}`,
    `Workspace: ${truncateText(session.workspaceRoot, WORKSPACE_LIMIT)}`,
    `Permission: ${session.permissionMode}`,
    `Skill: ${session.activeSkill ?? "none"}`,
    `Messages: ${session.messages.length}`,
    `Dirty: ${dirty ? "yes" : "no"}`,
    theme.muted(`/help for commands`),
  ].join("\n");
}

function previewMessage(message: Message, theme: TerminalTheme): string {
  if (message.role === "assistant") {
    const parts = message.content.map((block) => {
      if (block.type === "text") {
        return truncateText(block.text, MESSAGE_PREVIEW_LIMIT);
      }
      return theme.brand(`→ tool: ${block.name} (${block.id})`);
    });
    return `assistant: ${parts.join(" | ") || "(no text)"}`;
  }
  const parts = message.content.map((block) => {
    if (block.type === "text") {
      return truncateText(block.text, MESSAGE_PREVIEW_LIMIT);
    }
    const status = block.isError ? theme.error("failed") : theme.success("ok");
    return `tool ${truncateText(block.toolCallId, 12)}: ${status} ${truncateText(block.content, TOOL_RESULT_LIMIT)}`;
  });
  return `user: ${parts.join(" | ")}`;
}

export function formatHistory(
  session: PersistedSessionV1,
  options: { theme: TerminalTheme; count?: number },
): string {
  const { theme } = options;
  const count = options.count ?? 20;
  const tail = session.messages.slice(-count);
  if (tail.length === 0) {
    return theme.muted("(no messages yet)");
  }
  return tail.map((message) => previewMessage(message, theme)).join("\n");
}
