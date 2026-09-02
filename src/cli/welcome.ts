import { truncateToTerminalWidth, terminalWidth } from "./terminal-text.js";
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
const MAX_FRAME_WIDTH = 72;
const FULL_LAYOUT_MIN_COLUMNS = 64;
const BORDERED_LAYOUT_MIN_COLUMNS = 36;
const OUTER_MARGIN = 2;
const NJU_LOGO = [
  "███╗   ██╗     ██╗██╗   ██╗",
  "████╗  ██║     ██║██║   ██║",
  "██╔██╗ ██║     ██║██║   ██║",
  "██║╚██╗██║██   ██║██║   ██║",
  "██║ ╚████║╚█████╔╝╚██████╔╝",
  "╚═╝  ╚═══╝ ╚════╝  ╚═════╝",
] as const;

const HELP_LINE = "Type /help for commands · Ctrl-C cancels · twice exits";
const PLAIN_HELP_LINE = "Type /help for usage, or enter a task.";

type Cell = { text: string; style?: (text: string) => string };

/** One framed row: `│` + cells + padding + `│`, all rows the same content width. */
function boxLine(
  theme: TerminalTheme,
  cells: ReadonlyArray<Cell>,
  contentWidth: number,
): string {
  const textWidth = cells.reduce((sum, cell) => sum + terminalWidth(cell.text), 0);
  const padding = " ".repeat(Math.max(0, contentWidth - textWidth));
  const body =
    cells
      .map((cell) => (cell.style === undefined ? cell.text : cell.style(cell.text)))
      .join("") + padding;
  return theme.brandBorder("│") + body + theme.brandBorder("│");
}

function frameTop(theme: TerminalTheme, contentWidth: number): string {
  return theme.brandBorder(`╭${"─".repeat(contentWidth)}╮`);
}

function frameBottom(theme: TerminalTheme, contentWidth: number): string {
  return theme.brandBorder(`╰${"─".repeat(contentWidth)}╯`);
}

function infoRows(
  theme: TerminalTheme,
  view: WelcomeView,
  contentWidth: number,
): string[] {
  const valueWidth = Math.max(8, contentWidth - 2 - 11);
  const values = [
    ["workspace", view.workspace],
    ["model", view.model],
    ["session", `${view.sessionShortId} · new · ${view.permissionMode}`],
  ] as const;
  return values.map(([label, value]) =>
    boxLine(
      theme,
      [
        { text: "  " },
        { text: label.padEnd(11), style: theme.muted },
        { text: truncateToTerminalWidth(value, valueWidth) },
      ],
      contentWidth,
    ),
  );
}

/** Full layout: ASCII NJU logo, title and three info rows inside the frame. */
function fullLayout(
  theme: TerminalTheme,
  view: WelcomeView,
  frameWidth: number,
): string[] {
  const contentWidth = frameWidth - 2;
  const logoWidth = Math.max(...NJU_LOGO.map((line) => terminalWidth(line)));
  const indent = Math.max(1, Math.floor((contentWidth - logoWidth) / 2));
  const blank = boxLine(theme, [], contentWidth);
  const lines: string[] = [frameTop(theme, contentWidth), blank];
  for (const logoLine of NJU_LOGO) {
    lines.push(
      boxLine(
        theme,
        [{ text: " ".repeat(indent) }, { text: logoLine, style: theme.brandStrong }],
        contentWidth,
      ),
    );
  }
  lines.push(blank);
  lines.push(
    boxLine(
      theme,
      [{ text: "  " }, { text: `NJUAgent v${view.version}`, style: theme.brandStrong }],
      contentWidth,
    ),
  );
  lines.push(...infoRows(theme, view, contentWidth));
  lines.push(blank);
  lines.push(frameBottom(theme, contentWidth));
  return lines;
}

/** Compact layout: no logo, title and info rows only. */
function compactLayout(
  theme: TerminalTheme,
  view: WelcomeView,
  frameWidth: number,
): string[] {
  const contentWidth = frameWidth - 2;
  const lines: string[] = [frameTop(theme, contentWidth)];
  lines.push(
    boxLine(
      theme,
      [{ text: "  " }, { text: `NJUAgent v${view.version}`, style: theme.brandStrong }],
      contentWidth,
    ),
  );
  lines.push(...infoRows(theme, view, contentWidth));
  lines.push(frameBottom(theme, contentWidth));
  return lines;
}

/** Width-safe plain record used when the theme is disabled or the terminal is too narrow. */
function plainLayout(view: WelcomeView, safeColumns: number): string[] {
  const valueWidth = Math.max(8, safeColumns - 12);
  const lines = [
    `NJUAgent v${view.version}`,
    `[session] ${view.sessionShortId}`,
    `workspace: ${truncateToTerminalWidth(view.workspace, valueWidth)}`,
    `model: ${truncateToTerminalWidth(view.model, valueWidth)}`,
    `permission mode: ${view.permissionMode}`,
    truncateToTerminalWidth(PLAIN_HELP_LINE, safeColumns),
  ];
  if (view.recentSession !== undefined) {
    lines.push(
      truncateToTerminalWidth(`Use /resume ${view.recentSession} to continue.`, safeColumns),
    );
  }
  return lines;
}

/** Out-of-frame muted hints, each truncated when the terminal is narrow. */
function hintLines(
  theme: TerminalTheme,
  view: WelcomeView,
  safeColumns: number,
): string[] {
  const hints = [theme.muted(truncateToTerminalWidth(HELP_LINE, safeColumns))];
  if (view.recentSession !== undefined) {
    hints.push(
      theme.muted(
        truncateToTerminalWidth(`Use /resume ${view.recentSession} to continue.`, safeColumns),
      ),
    );
  }
  return hints;
}

/** Formats the one-time startup panel and its plain record-mode fallback. */
export function formatWelcome(
  view: WelcomeView,
  theme: TerminalTheme,
  options: WelcomeOptions = {},
): string {
  const safeColumns =
    options.columns !== undefined && Number.isFinite(options.columns)
      ? Math.max(1, Math.floor(options.columns))
      : DEFAULT_COLUMNS;

  if (!theme.enabled || safeColumns < BORDERED_LAYOUT_MIN_COLUMNS) {
    return plainLayout(view, safeColumns).join("\n");
  }

  const frameWidth = Math.max(1, Math.min(MAX_FRAME_WIDTH, safeColumns - OUTER_MARGIN));
  const boxed =
    safeColumns >= FULL_LAYOUT_MIN_COLUMNS
      ? fullLayout(theme, view, frameWidth)
      : compactLayout(theme, view, frameWidth);
  return [...boxed, ...hintLines(theme, view, safeColumns)].join("\n");
}
