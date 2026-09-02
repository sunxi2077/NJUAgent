import type { TerminalTheme } from "./theme.js";
import {
  sanitizeTerminalText,
  terminalWidth,
  truncateToTerminalWidth,
} from "./terminal-text.js";

export type CommandPanel = {
  title: string;
  symbol: string;
  sections: readonly {
    heading?: string;
    rows: readonly { label?: string; value: string }[];
  }[];
  footer?: string;
};

const FULL_MIN_COLUMNS = 48;
const SINGLE_LINE_MIN_COLUMNS = 28;
const MAX_OUTER_WIDTH = 88;

/** Pads a styled/plain string to `target` terminal cells. */
function padCells(text: string, target: number): string {
  const visible = terminalWidth(text);
  return visible >= target ? text : `${text}${" ".repeat(target - visible)}`;
}

/**
 * Renders a structured command panel. Pure: no stream writes, no process
 * reads, no session mutation. Full mode draws a uniform-width box; narrow
 * terminals degrade to a borderless compact panel and then a one-line
 * fallback; a disabled theme produces plain sectioned text.
 */
export function formatCommandPanel(
  panel: CommandPanel,
  options: { columns: number; theme: TerminalTheme },
): string {
  const { theme } = options;
  const safeColumns = Math.max(1, Math.floor(options.columns));
  if (!theme.enabled) {
    return formatPlain(panel);
  }
  if (safeColumns < SINGLE_LINE_MIN_COLUMNS) {
    return formatSingleLine(panel, safeColumns);
  }
  if (safeColumns < FULL_MIN_COLUMNS) {
    return formatCompact(panel, theme, safeColumns);
  }
  const width = Math.min(safeColumns - 1, MAX_OUTER_WIDTH);
  return formatFull(panel, theme, width);
}

/**
 * Renders `[█…░…]`-style bar with state coloring: `<70%` cyan, `70–89%`
 * warning yellow, `>=90%` error red. A zero or invalid maximum renders an
 * empty bar at 0%, never NaN/Infinity.
 */
export function formatProgressBar(
  value: number,
  maximum: number,
  options: { cells: number; theme: TerminalTheme },
): string {
  const { cells, theme } = options;
  const safeCells = Math.max(0, Math.floor(cells));
  const safeMax = Number.isFinite(maximum) && maximum > 0 ? maximum : 0;
  const safeValue = Number.isFinite(value) && value >= 0 ? value : 0;
  const ratio = safeMax === 0 ? 0 : Math.min(1, safeValue / safeMax);
  const filled = Math.round(ratio * safeCells);
  const fillText = "█".repeat(filled) + "░".repeat(Math.max(0, safeCells - filled));
  const style = ratio >= 0.9
    ? theme.error
    : ratio >= 0.7
      ? theme.warning
      : theme.code;
  return `[${style(fillText)}]`;
}

function formatFull(panel: CommandPanel, theme: TerminalTheme, width: number): string {
  const contentWidth = width - 4; // "│ " + body + " │"
  const lines: string[] = [];

  const topPrefix = `╭─ ${panel.symbol} ${panel.title} `;
  const topFill = "─".repeat(Math.max(0, width - terminalWidth(topPrefix) - 1));
  const top = `${theme.brandBorder("╭─ ")}${theme.brandStrong(panel.symbol)}` +
    `${theme.brandBorder(` ${panel.title} ${topFill}╮`)}`;
  lines.push(top);

  for (const section of panel.sections) {
    if (section.heading !== undefined && section.heading !== "") {
      const headingPrefix = `├─ ${section.heading} `;
      const headingFill = "─".repeat(
        Math.max(0, width - terminalWidth(headingPrefix) - 1),
      );
      lines.push(
        theme.brandBorder(`${headingPrefix}${headingFill}┤`),
      );
    }
    const labeled = section.rows.filter((row) => row.label !== undefined);
    const labelWidth = labeled.length === 0
      ? 0
      : Math.max(...labeled.map((row) => terminalWidth(row.label!))) + 2;
    for (const row of section.rows) {
      let body: string;
      if (row.label !== undefined) {
        const labelCell = `${row.label}${" ".repeat(Math.max(1, labelWidth - terminalWidth(row.label)))}`;
        const valueBudget = Math.max(1, contentWidth - terminalWidth(labelCell) - 1);
        const value = truncateToTerminalWidth(row.value, valueBudget);
        body = `${theme.muted(labelCell)} ${value}`;
      } else {
        body = truncateToTerminalWidth(row.value, contentWidth);
      }
      lines.push(`│ ${padCells(body, contentWidth)} │`);
    }
  }

  if (panel.footer !== undefined) {
    lines.push(`│ ${padCells(theme.muted(truncateToTerminalWidth(panel.footer, contentWidth)), contentWidth)} │`);
  }
  lines.push(theme.brandBorder(`╰${"─".repeat(width - 2)}╯`));
  return lines.join("\n");
}

function formatCompact(panel: CommandPanel, theme: TerminalTheme, columns: number): string {
  const lines: string[] = [theme.brandStrong(`${panel.symbol} ${panel.title}`)];
  const contentWidth = columns;
  for (const section of panel.sections) {
    if (section.heading !== undefined) {
      lines.push(theme.brandBorder(section.heading));
    }
    const labeled = section.rows.filter((row) => row.label !== undefined);
    const labelWidth = labeled.length === 0
      ? 0
      : Math.max(...labeled.map((row) => terminalWidth(row.label!))) + 2;
    for (const row of section.rows) {
      if (row.label !== undefined) {
        const labelCell = `${row.label}${" ".repeat(Math.max(1, labelWidth - terminalWidth(row.label)))}`;
        const valueBudget = Math.max(1, contentWidth - terminalWidth(labelCell) - 1);
        lines.push(`${theme.muted(labelCell)} ${truncateToTerminalWidth(row.value, valueBudget)}`);
      } else {
        lines.push(truncateToTerminalWidth(row.value, contentWidth));
      }
    }
  }
  if (panel.footer !== undefined) {
    lines.push(truncateToTerminalWidth(panel.footer, contentWidth));
  }
  return lines.join("\n");
}

function formatSingleLine(panel: CommandPanel, columns: number): string {
  const cells: string[] = [`${panel.symbol} ${panel.title}`];
  for (const section of panel.sections) {
    for (const row of section.rows) {
      cells.push(row.label === undefined ? row.value : `${row.label}: ${row.value}`);
    }
  }
  if (panel.footer !== undefined) {
    cells.push(panel.footer);
  }
  return truncateToTerminalWidth(sanitizeTerminalText(cells.join(" | ")), columns);
}

function formatPlain(panel: CommandPanel): string {
  const lines: string[] = [`${panel.symbol} ${panel.title}`];
  for (const section of panel.sections) {
    if (section.heading !== undefined) {
      lines.push(section.heading);
    }
    const labeled = section.rows.filter((row) => row.label !== undefined);
    const labelWidth = labeled.length === 0
      ? 0
      : Math.max(...labeled.map((row) => row.label!.length)) + 2;
    for (const row of section.rows) {
      if (row.label !== undefined) {
        const padded = row.label.padEnd(labelWidth);
        lines.push(`${padded}${row.value}`);
      } else {
        lines.push(row.value);
      }
    }
  }
  if (panel.footer !== undefined) {
    lines.push(panel.footer);
  }
  return lines.join("\n");
}
