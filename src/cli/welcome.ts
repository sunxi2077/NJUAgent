import type { TerminalTheme } from "./theme.js";

export type WelcomeView = {
  version: string;
  workspace: string;
  model: string;
  sessionShortId: string;
  permissionMode: string;
  recentSession?: string;
};

const MIN_FORMATTED_WIDTH = 60;

/** Truncates a value without splitting surrogate pairs. */
function truncate(value: string, maxChars: number): string {
  const chars = [...value];
  if (chars.length <= maxChars) {
    return value;
  }
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join("")}…`;
}

/** One-based index of the last column that fits within the width. */
function contentWidth(width: number, padding = 4): number {
  return Math.max(8, width - padding);
}

/**
 * Formats the one-time startup panel. The plain theme emits newline records
 * including exactly one `[session]` line; the enabled theme renders a
 * restrained box with brand-colored text.
 */
export function formatWelcome(view: WelcomeView, theme: TerminalTheme): string {
  const title = `${theme.brand("NJUAgent")} v${view.version}`;
  const workspace = truncate(view.workspace, contentWidth(MIN_FORMATTED_WIDTH));
  const model = truncate(view.model, contentWidth(MIN_FORMATTED_WIDTH));
  const sessionLine = `session: ${view.sessionShortId} · ${view.permissionMode}`;
  const recentHint = view.recentSession === undefined
    ? ""
    : `\n${theme.muted(`continue? ${view.recentSession}`)}`;

  if (!theme.enabled) {
    return [
      title,
      `[session] ${view.sessionShortId}`,
      `workspace: ${workspace}`,
      `model: ${model}`,
      `permission mode: ${view.permissionMode}`,
      "Type /help for usage, or enter a task.",
    ].join("\n") + recentHint;
  }

  const lines = [
    title,
    `workspace: ${workspace}`,
    `model: ${model}`,
    sessionLine,
    theme.muted("/help for usage, or enter a task."),
  ];
  const inner = Math.max(...lines.map((line) => [...line.replace(/\x1b\[[0-9;]*m/gu, "")].length));
  const boxWidth = Math.max(MIN_FORMATTED_WIDTH, inner + 2);
  const top = `┌${"─".repeat(boxWidth - 2)}┐`;
  const bottom = `└${"─".repeat(boxWidth - 2)}┘`;
  const rows = lines.map((line) => {
    const visible = line.replace(/\x1b\[[0-9;]*m/gu, "");
    const padding = Math.max(0, boxWidth - 2 - [...visible].length);
    return `│ ${line}${" ".repeat(padding)}│`;
  });
  return [top, ...rows, bottom].join("\n") + recentHint;
}
