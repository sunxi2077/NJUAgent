import type { SlashCompletionSnapshot } from "./slash-completion.js";
import { sanitizeTerminalText, terminalWidth, truncateToTerminalWidth } from "./terminal-text.js";
import type { TerminalTheme } from "./theme.js";

const FULL_MENU_MIN_COLUMNS = 40;
const MAX_FRAME_WIDTH = 88;
const COMPACT_MAX_ROWS = 3;
const FOOTER = "↑↓ select · Tab complete · Esc close";
const COMPACT_FOOTER = "↑↓ · Tab · Esc";

const ANSI_SAVE_CURSOR = "\x1b[s";
const ANSI_RESTORE_CURSOR = "\x1b[u";
const ANSI_CURSOR_DOWN_ONE = "\x1b[1B";
const ANSI_CLEAR_ENTIRE_LINE = "\x1b[2K";

/**
 * Pure menu formatting. Full mode draws a single-column box whose every row
 * (borders included) has the same visible width; below 40 columns a compact
 * borderless list is used. Only the `visibleMatches` window is rendered; the
 * footer reports the absolute window range.
 */
export function formatSlashMenu(
  snapshot: SlashCompletionSnapshot,
  options: { columns: number; theme: TerminalTheme },
): readonly string[] {
  if (!snapshot.active) {
    return [];
  }
  const { theme } = options;
  const safeColumns = Math.floor(options.columns);
  if (safeColumns < FULL_MENU_MIN_COLUMNS) {
    return formatCompact(snapshot, theme);
  }
  const width = Math.min(Math.max(safeColumns, FULL_MENU_MIN_COLUMNS) - 2, MAX_FRAME_WIDTH);
  return formatFull(snapshot, theme, width);
}

function formatRange(snapshot: SlashCompletionSnapshot): string {
  if (snapshot.totalMatches === 0) {
    return "0 commands";
  }
  if (snapshot.totalMatches <= snapshot.visibleMatches.length) {
    return `${snapshot.totalMatches} commands`;
  }
  const start = snapshot.windowStart + 1;
  const end = snapshot.windowStart + snapshot.visibleMatches.length;
  return `${start}–${end} / ${snapshot.totalMatches}`;
}

function compactRange(snapshot: SlashCompletionSnapshot): string {
  const shown = Math.min(snapshot.visibleMatches.length, COMPACT_MAX_ROWS);
  if (snapshot.totalMatches === 0) {
    return "0";
  }
  if (snapshot.totalMatches <= shown) {
    return String(snapshot.totalMatches);
  }
  return `${snapshot.windowStart + 1}–${snapshot.windowStart + shown}/${snapshot.totalMatches}`;
}

function formatFull(
  snapshot: SlashCompletionSnapshot,
  theme: TerminalTheme,
  width: number,
): string[] {
  const contentWidth = width - 4; // "│ " + body + " │"
  const visible = snapshot.visibleMatches;
  const padToWidth = (text: string, target: number): string => {
    const current = terminalWidth(text);
    return current >= target ? text : `${text}${" ".repeat(target - current)}`;
  };

  const topPrefix = `╭─ Commands `;
  const top = theme.brandBorder(
    `${topPrefix}${"─".repeat(Math.max(0, width - terminalWidth(topPrefix) - 1))}╮`,
  );
  const footer = `${FOOTER} · ${formatRange(snapshot)}`;
  const bottomPrefix = `╰─ ${footer} `;
  const bottom = theme.brandBorder(
    `${bottomPrefix}${"─".repeat(Math.max(0, width - terminalWidth(bottomPrefix) - 1))}╯`,
  );

  if (visible.length === 0) {
    const row = `│ ${padToWidth(theme.muted("No matching commands"), contentWidth)} │`;
    return [top, row, bottom];
  }

  const maxNameCells = Math.max(...visible.map((command) => terminalWidth(`/${command.name}`)));
  const nameColWidth = maxNameCells + 3; // "› "/"  " prefix plus one gap cell
  const descBudget = Math.max(1, contentWidth - nameColWidth);

  const rows = visible.map((command, visibleIndex) => {
    const absoluteIndex = snapshot.windowStart + visibleIndex;
    const selected = absoluteIndex === snapshot.selectedIndex;
    const mark = selected ? theme.brandStrong("› ") : "  ";
    const name = selected
      ? theme.brandStrong(`/${command.name}`)
      : `/${command.name}`;
    const namePadding = " ".repeat(
      Math.max(0, nameColWidth - (terminalWidth(`/${command.name}`) + 2)),
    );
    const description = sanitizeTerminalText(command.description);
    const desc = description === ""
      ? ""
      : theme.muted(truncateToTerminalWidth(description, descBudget));
    const body = `${mark}${name}${namePadding}${desc}`;
    return `│ ${padToWidth(body, contentWidth)} │`;
  });

  return [top, ...rows, bottom];
}

function formatCompact(snapshot: SlashCompletionSnapshot, theme: TerminalTheme): string[] {
  const rows = snapshot.visibleMatches.slice(0, COMPACT_MAX_ROWS).map((command, visibleIndex) => {
    const absoluteIndex = snapshot.windowStart + visibleIndex;
    return absoluteIndex === snapshot.selectedIndex
      ? theme.brandStrong(`› /${command.name}`)
      : `  /${command.name}`;
  });
  const footerText = `${COMPACT_FOOTER} · ${compactRange(snapshot)}`;
  if (rows.length === 0) {
    return [theme.muted("No matching commands"), theme.muted(footerText)];
  }
  return [...rows, theme.muted(footerText)];
}

export interface SlashMenuPresenterPort {
  render(snapshot: SlashCompletionSnapshot): void;
  clear(): void;
  suspend(): void;
  resume(snapshot: SlashCompletionSnapshot): void;
  close(): void;
}

export type SlashMenuPresenterOptions = {
  output: NodeJS.WritableStream & { columns?: number };
  theme: TerminalTheme;
  fallbackColumns?: number;
};

/**
 * Draws the menu into the temporary region below the readline input line.
 * Positioning always moves the cursor down from the saved input position and
 * clears whole lines; it never uses cursor-up, so history above the input line
 * is never touched. A throwing writer during resize disables the presenter
 * instead of escaping.
 */
export class SlashMenuPresenter implements SlashMenuPresenterPort {
  readonly #output: NodeJS.WritableStream & { columns?: number };
  readonly #theme: TerminalTheme;
  readonly #fallbackColumns: number;
  readonly #onResize = (): void => this.#redrawOnResize();
  #lastRows = 0;
  #lastSnapshot: SlashCompletionSnapshot | null = null;
  #suspended = false;
  #closed = false;
  #disabled = false;

  constructor(options: SlashMenuPresenterOptions) {
    this.#output = options.output;
    this.#theme = options.theme;
    this.#fallbackColumns = options.fallbackColumns ?? 80;
    this.#output.on("resize", this.#onResize);
  }

  render(snapshot: SlashCompletionSnapshot): void {
    if (this.#closed || this.#disabled || !snapshot.active) {
      return;
    }
    const lines = formatSlashMenu(snapshot, {
      columns: this.#columns(),
      theme: this.#theme,
    });
    this.#draw(lines);
    this.#lastSnapshot = snapshot;
    this.#suspended = false;
  }

  clear(): void {
    if (this.#closed || this.#disabled) {
      return;
    }
    this.#clearRows();
  }

  suspend(): void {
    if (this.#closed || this.#disabled) {
      return;
    }
    this.#clearRows();
    this.#suspended = true;
  }

  resume(snapshot: SlashCompletionSnapshot): void {
    if (this.#closed || this.#disabled || !snapshot.active) {
      return;
    }
    const lines = formatSlashMenu(snapshot, {
      columns: this.#columns(),
      theme: this.#theme,
    });
    this.#draw(lines);
    this.#lastSnapshot = snapshot;
    this.#suspended = false;
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    if (!this.#disabled) {
      this.#clearRows();
    }
    this.#output.off("resize", this.#onResize);
    this.#closed = true;
    this.#lastSnapshot = null;
  }

  #draw(lines: readonly string[]): void {
    // Clear any previously drawn menu region, then redraw from the input line.
    this.#clearRows();
    if (lines.length === 0) {
      return;
    }
    this.#output.write(ANSI_SAVE_CURSOR);
    for (const line of lines) {
      this.#output.write(
        `${ANSI_CURSOR_DOWN_ONE}\r${ANSI_CLEAR_ENTIRE_LINE}${line}`,
      );
    }
    this.#output.write(ANSI_RESTORE_CURSOR);
    this.#lastRows = lines.length;
  }

  #clearRows(): void {
    if (this.#lastRows === 0) {
      return;
    }
    this.#output.write(ANSI_SAVE_CURSOR);
    for (let index = 0; index < this.#lastRows; index += 1) {
      this.#output.write(
        `${ANSI_CURSOR_DOWN_ONE}\r${ANSI_CLEAR_ENTIRE_LINE}`,
      );
    }
    this.#output.write(ANSI_RESTORE_CURSOR);
    this.#lastRows = 0;
  }

  #redrawOnResize(): void {
    if (this.#closed || this.#disabled || this.#lastSnapshot === null || this.#suspended) {
      return;
    }
    try {
      const lines = formatSlashMenu(this.#lastSnapshot, {
        columns: this.#columns(),
        theme: this.#theme,
      });
      this.#draw(lines);
    } catch {
      // A throwing formatter/writer must never escape a resize event.
      this.#disable();
    }
  }

  #disable(): void {
    this.#disabled = true;
    this.#lastRows = 0;
    this.#lastSnapshot = null;
    this.#output.off("resize", this.#onResize);
  }

  #columns(): number {
    const columns = this.#output.columns;
    if (typeof columns !== "number" || !Number.isFinite(columns) || columns <= 0) {
      return this.#fallbackColumns;
    }
    return Math.floor(columns);
  }
}
