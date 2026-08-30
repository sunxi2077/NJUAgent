import {
  clearLine,
  clearScreenDown,
  cursorTo,
  moveCursor,
} from "node:readline";

import type { SlashCompletionSnapshot } from "./slash-completion.js";
import { sanitizeTerminalText, terminalWidth, truncateToTerminalWidth } from "./terminal-text.js";
import type { TerminalTheme } from "./theme.js";

const FULL_MENU_MIN_COLUMNS = 40;
const MAX_FRAME_WIDTH = 88;
const COMPACT_MAX_ROWS = 3;
const FOOTER = "↑↓ select · Tab complete · Esc close";
const COMPACT_FOOTER = "↑↓ · Tab · Esc";

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
    return formatCompact(snapshot, theme, safeColumns);
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

function formatCompact(
  snapshot: SlashCompletionSnapshot,
  theme: TerminalTheme,
  columns: number,
): string[] {
  // Leave one free cell so writing the last visible character never triggers
  // an implicit terminal wrap/scroll at the right edge.
  const maxWidth = Math.max(0, columns - 1);
  const clip = (text: string): string => truncateToTerminalWidth(
    sanitizeTerminalText(text),
    maxWidth,
  );
  const rows = snapshot.visibleMatches.slice(0, COMPACT_MAX_ROWS).map((command, visibleIndex) => {
    const absoluteIndex = snapshot.windowStart + visibleIndex;
    const row = clip(`${absoluteIndex === snapshot.selectedIndex ? "› " : "  "}/${command.name}`);
    return absoluteIndex === snapshot.selectedIndex
      ? theme.brandStrong(row)
      : row;
  });
  const footerText = clip(`${COMPACT_FOOTER} · ${compactRange(snapshot)}`);
  if (rows.length === 0) {
    return [theme.muted(clip("No matching commands")), theme.muted(footerText)];
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
  /** Redraws readline on the blank line immediately below the menu. */
  redrawInput: () => void;
  /** Readline's logical cursor position, used to restore its redraw anchor. */
  inputCursor: () => { rows: number; cols: number };
  /** Called when a terminal write failure permanently disables the palette. */
  onDisable?: () => void;
};

/**
 * Owns a live region immediately above the readline input line. Replacing the
 * menu clears the current input line, moves upward only across menu rows owned
 * by this presenter, writes the new menu as ordinary terminal lines, and then
 * asks readline to redraw below it. This remains stable when the prompt starts
 * on the terminal's bottom row because it never saves a cursor position across
 * terminal scrolling.
 */
export class SlashMenuPresenter implements SlashMenuPresenterPort {
  readonly #output: NodeJS.WritableStream & { columns?: number };
  readonly #theme: TerminalTheme;
  readonly #fallbackColumns: number;
  readonly #redrawInput: () => void;
  readonly #inputCursor: () => { rows: number; cols: number };
  readonly #onDisable: (() => void) | undefined;
  readonly #onResize = (): void => this.#redrawOnResize();
  #lastLines: readonly string[] = [];
  #lastSnapshot: SlashCompletionSnapshot | null = null;
  #suspended = false;
  #closed = false;
  #disabled = false;

  constructor(options: SlashMenuPresenterOptions) {
    this.#output = options.output;
    this.#theme = options.theme;
    this.#fallbackColumns = options.fallbackColumns ?? 80;
    this.#redrawInput = options.redrawInput;
    this.#inputCursor = options.inputCursor;
    this.#onDisable = options.onDisable;
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
    this.#draw(lines, true);
    this.#lastSnapshot = snapshot;
    this.#suspended = false;
  }

  clear(): void {
    if (this.#closed || this.#disabled) {
      return;
    }
    const cursor = this.#cursorPosition();
    if (this.#eraseLiveRegion(cursor)) {
      this.#lastSnapshot = null;
      this.#restoreReadlineCursor(cursor);
      this.#redrawInput();
    }
  }

  suspend(): void {
    if (this.#closed || this.#disabled) {
      return;
    }
    this.#eraseLiveRegion(this.#cursorPosition());
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
    // External output now owns the current cursor position. Draw from there;
    // do not erase relative to readline's stale pre-suspend input location.
    this.#draw(lines, false);
    this.#lastSnapshot = snapshot;
    this.#suspended = false;
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    if (!this.#disabled) {
      this.#eraseLiveRegion(this.#cursorPosition());
    }
    this.#output.off("resize", this.#onResize);
    this.#closed = true;
    this.#lastSnapshot = null;
  }

  #draw(lines: readonly string[], eraseInput: boolean): void {
    // During normal input, replace the complete owned region. After external
    // output, start at the renderer's fresh line instead. In both cases,
    // restore readline's logical cursor before asking it to refresh itself.
    const cursor = this.#cursorPosition();
    if (eraseInput) {
      this.#eraseLiveRegion(cursor, true);
    }
    if (lines.length === 0) {
      this.#restoreReadlineCursor(cursor);
      this.#redrawInput();
      return;
    }
    for (const line of lines) {
      this.#output.write(`${line}\r\n`);
    }
    this.#lastLines = [...lines];
    this.#restoreReadlineCursor(cursor);
    this.#redrawInput();
  }

  #eraseLiveRegion(
    cursor: { rows: number; cols: number },
    force = false,
  ): boolean {
    if (this.#lastLines.length === 0 && !force) {
      return false;
    }
    clearLine(this.#output, 0);
    cursorTo(this.#output, 0);
    // Every rendered line was strictly shorter than the terminal width at the
    // time it was written. On resize, terminals disagree about historical
    // reflow, so the only conservative owned-row count is the hard line count.
    const rowsUp = this.#lastLines.length + cursor.rows;
    if (rowsUp > 0) {
      moveCursor(this.#output, 0, -rowsUp);
    }
    clearScreenDown(this.#output);
    this.#lastLines = [];
    return true;
  }

  #redrawOnResize(): void {
    if (this.#closed || this.#disabled || this.#lastSnapshot === null || this.#suspended) {
      return;
    }
    const cursor = this.#cursorPosition();
    try {
      // Existing hard lines may or may not reflow across terminals. Close the
      // optional palette instead of guessing and risking deletion of history.
      this.#eraseLiveRegion(cursor);
      this.#restoreReadlineCursor(cursor);
    } catch {
      // A throwing writer must never escape a resize event.
    } finally {
      this.#disable();
    }
  }

  #disable(): void {
    if (this.#disabled) {
      return;
    }
    this.#disabled = true;
    this.#lastLines = [];
    this.#lastSnapshot = null;
    this.#output.off("resize", this.#onResize);
    try {
      this.#onDisable?.();
    } catch {
      // Disabling the optional palette must never escape into terminal input.
    }
  }

  #cursorPosition(): { rows: number; cols: number } {
    try {
      const position = this.#inputCursor();
      return {
        rows: Number.isFinite(position.rows) && position.rows > 0
          ? Math.floor(position.rows)
          : 0,
        cols: Number.isFinite(position.cols) && position.cols > 0
          ? Math.floor(position.cols)
          : 0,
      };
    } catch {
      return { rows: 0, cols: 0 };
    }
  }

  #restoreReadlineCursor(cursor: { rows: number; cols: number }): void {
    if (cursor.rows > 0) {
      moveCursor(this.#output, 0, cursor.rows);
    }
    cursorTo(this.#output, cursor.cols);
  }

  #columns(): number {
    const columns = this.#output.columns;
    if (typeof columns !== "number" || !Number.isFinite(columns) || columns <= 0) {
      return this.#fallbackColumns;
    }
    return Math.floor(columns);
  }
}
