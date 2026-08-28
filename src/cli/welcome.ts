import type { TerminalTheme } from "./theme.js";

export type WelcomeView = {
  version: string;
  workspace: string;
  model: string;
  sessionShortId: string;
  permissionMode: string;
  recentSession?: string | undefined;
};

export type WelcomeOptions = {
  columns?: number;
};

const DEFAULT_COLUMNS = 80;
const MIN_BOX_WIDTH = 28;
const MAX_BOX_WIDTH = 88;

function truncate(value: string, maxChars: number): string {
  const chars = [...value];
  if (chars.length <= maxChars) {
    return value;
  }
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join("")}…`;
}

function boxWidth(columns: number | undefined): number {
  const available = Number.isFinite(columns)
    ? Math.floor(columns ?? DEFAULT_COLUMNS)
    : DEFAULT_COLUMNS;
  return Math.max(MIN_BOX_WIDTH, Math.min(MAX_BOX_WIDTH, available));
}

/** Formats the one-time startup panel and its plain record-mode fallback. */
export function formatWelcome(
  view: WelcomeView,
  theme: TerminalTheme,
  options: WelcomeOptions = {},
): string {
  if (!theme.enabled) {
    const valueWidth = Math.max(8, boxWidth(options.columns) - 12);
    const recentHint = view.recentSession === undefined
      ? []
      : [`Use /resume ${view.recentSession} to continue.`];
    return [
      `NJUAgent v${view.version}`,
      `[session] ${view.sessionShortId}`,
      `workspace: ${truncate(view.workspace, valueWidth)}`,
      `model: ${truncate(view.model, valueWidth)}`,
      `permission mode: ${view.permissionMode}`,
      "Type /help for usage, or enter a task.",
      ...recentHint,
    ].join("\n");
  }

  const width = boxWidth(options.columns);
  const title = `NJUAgent v${view.version}`;
  const titleFill = "─".repeat(Math.max(1, width - [...title].length - 5));
  const top =
    theme.brandBase("╭─ ") +
    theme.brand(title) +
    theme.brandBase(` ${titleFill}╮`);
  const bottom = theme.brandBase(`╰${"─".repeat(width - 2)}╯`);
  const valueWidth = Math.max(8, width - 14);
  const values = [
    ["workspace", truncate(view.workspace, valueWidth)],
    ["model", truncate(view.model, valueWidth)],
    ["session", `${view.sessionShortId} · new · ${view.permissionMode}`],
  ] as const;
  const rows = values.map(([label, value]) => {
    const content = `${label.padEnd(11)}${truncate(value, valueWidth)}`;
    const padding = " ".repeat(Math.max(0, width - 3 - [...content].length));
    return theme.brandBase("│") + ` ${content}${padding}` + theme.brandBase("│");
  });
  const lines = [
    top,
    ...rows,
    bottom,
    theme.muted("Type /help for commands · Ctrl-C cancels"),
  ];
  if (view.recentSession !== undefined) {
    lines.push(theme.muted(`Use /resume ${view.recentSession} to continue.`));
  }
  return lines.join("\n");
}
