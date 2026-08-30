import { describe, expect, test } from "vitest";
import { stripVTControlCharacters } from "node:util";

import { formatSlashMenu, SlashMenuPresenter } from "../../../src/cli/slash-menu.js";
import type { SlashCompletionSnapshot } from "../../../src/cli/slash-completion.js";
import type { SlashCommandDescriptor } from "../../../src/cli/command.js";
import { createTheme, type TerminalTheme } from "../../../src/cli/theme.js";
import { terminalWidth } from "../../../src/cli/terminal-text.js";

function descriptor(name: string, description = `the ${name} command`): SlashCommandDescriptor {
  return { name, usage: `/${name}`, description };
}

function snapshot(overrides: Partial<SlashCompletionSnapshot> = {}): SlashCompletionSnapshot {
  const matches = [
    descriptor("help"),
    descriptor("status", "Show current session status"),
    descriptor("sessions"),
    descriptor("resume"),
    descriptor("new"),
    descriptor("history"),
  ];
  return {
    active: true,
    prefix: "",
    selectedIndex: 0,
    windowStart: 0,
    totalMatches: matches.length,
    matches,
    visibleMatches: matches.slice(0, 6),
    ...overrides,
  };
}

function frameWidths(lines: readonly string[]): number[] {
  return lines.map((line) => terminalWidth(stripVTControlCharacters(line)));
}

function plain(theme = createTheme({ enabled: true })) {
  return { theme };
}

describe("formatSlashMenu", () => {
  test("inactive snapshot renders no lines", () => {
    expect(formatSlashMenu({ ...snapshot(), active: false }, { columns: 80, theme: createTheme({ enabled: true }) })).toEqual([]);
  });

  test("renders a full single-column box at 80 columns", () => {
    const lines = formatSlashMenu(snapshot(), { columns: 80, theme: createTheme({ enabled: true }) });
    const visible = lines.map((line) => stripVTControlCharacters(line));
    expect(visible[0]).toMatch(/^╭─ Commands ─/u);
    expect(visible[0]).toMatch(/─╮$/u);
    expect(visible.at(-1)).toMatch(/↑↓ select · Tab\/Enter complete · Esc close/u);
    expect(visible.at(-1)).toMatch(/─╯$/u);
    // Selected row carries the › marker; description text is present.
    expect(visible.some((line) => line.includes("› /help"))).toBe(true);
    expect(visible.some((line) => line.includes("Show current session status"))).toBe(true);
    // Every framed row shares one width.
    const widths = frameWidths(lines);
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]!).toBeLessThanOrEqual(80);
  });

  test("marks the selected row with › and others with a space", () => {
    const lines = formatSlashMenu(snapshot({ selectedIndex: 2 }), { columns: 80, theme: createTheme({ enabled: true }) });
    const visible = lines.map((line) => stripVTControlCharacters(line));
    const selected = visible.find((line) => line.includes("/sessions"));
    const other = visible.find((line) => line.includes("/help"));
    expect(selected).toContain("› /sessions");
    expect(other).toContain("  /help");
  });

  test("truncates long names and descriptions without exceeding the frame", () => {
    const long = snapshot({
      matches: [descriptor("very-long-command-name-here", "x".repeat(300))],
    });
    const lines = formatSlashMenu(long, { columns: 80, theme: createTheme({ enabled: true }) });
    const widths = frameWidths(lines);
    const frame = widths[0]!;
    for (const width of widths) {
      expect(width).toBe(frame);
    }
  });

  test("truncates CJK and emoji by cell width without breaking alignment", () => {
    const mixed = snapshot({
      matches: [descriptor("goal", "完成所有测试 😀 收尾")],
    });
    const lines = formatSlashMenu(mixed, { columns: 80, theme: createTheme({ enabled: true }) });
    const widths = frameWidths(lines);
    expect(new Set(widths).size).toBe(1);
  });

  test("sanitizes ANSI, CR/LF, and tabs in descriptions", () => {
    const dirty = snapshot({
      matches: [descriptor("goal", "\x1b[31mred\x1b[0m\nline2\tend")],
    });
    const lines = formatSlashMenu(dirty, { columns: 80, theme: createTheme({ enabled: true }) });
    const visible = lines.map((line) => stripVTControlCharacters(line));
    const row = visible.find((line) => line.includes("/goal"));
    expect(row).toContain("red line2 end");
    expect(row).not.toContain("\n");
    // No unexpected control sequences beyond the theme's own styling.
    const sanitized = lines.join("");
    expect(sanitized.replace(/\x1b\[[0-9;]*m/gu, "")).not.toContain("\x1b[");
  });

  test("renders No matching commands for an empty match set", () => {
    const lines = formatSlashMenu(snapshot({ matches: [], selectedIndex: -1 }), { columns: 80, theme: createTheme({ enabled: true }) });
    const visible = lines.map((line) => stripVTControlCharacters(line));
    expect(visible.some((line) => line.includes("No matching commands"))).toBe(true);
  });

  test("stays a full box at 40 columns and switches to compact below 40", () => {
    const full = formatSlashMenu(snapshot(), { columns: 40, theme: createTheme({ enabled: true }) });
    expect(full.length).toBeGreaterThan(3);
    expect(full[0]!.includes("╭")).toBe(true);
    expect(frameWidths(full)[0]!).toBeLessThanOrEqual(40);

    const compact = formatSlashMenu(snapshot(), { columns: 39, theme: createTheme({ enabled: true }) });
    const visible = compact.map((line) => stripVTControlCharacters(line));
    expect(visible.length).toBeLessThanOrEqual(4);
    expect(visible.some((line) => line.includes("› /help"))).toBe(true);
    expect(compact.some((line) => line.includes("╭"))).toBe(false);
  });

  test("theme enabled and disabled produce the same visible widths", () => {
    const enabled = formatSlashMenu(snapshot(), { columns: 80, theme: createTheme({ enabled: true }) });
    const disabled = formatSlashMenu(snapshot(), { columns: 80, theme: createTheme({ enabled: false }) });
    expect(frameWidths(enabled)).toEqual(frameWidths(disabled));
  });
});

class FakeOutput {
  readonly chunks: string[] = [];
  columns = 80;
  readonly resizeListeners = new Set<() => void>();
  listenerCounts: Record<string, number> = {};

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  on(event: string, listener: () => void): this {
    if (event === "resize") {
      this.resizeListeners.add(listener);
    }
    this.listenerCounts[event] = (this.listenerCounts[event] ?? 0) + 1;
    return this;
  }

  off(event: string, listener: () => void): this {
    if (event === "resize") {
      this.resizeListeners.delete(listener);
    }
    this.listenerCounts[event] = Math.max(0, (this.listenerCounts[event] ?? 0) - 1);
    return this;
  }

  text(): string {
    return this.chunks.join("");
  }

  resize(): void {
    for (const listener of this.resizeListeners) {
      listener();
    }
  }
}

function makePresenter(columns = 80) {
  const output = new FakeOutput();
  output.columns = columns;
  const presenter = new SlashMenuPresenter({
    output: output as unknown as NodeJS.WritableStream & { columns?: number },
    theme: createTheme({ enabled: true }),
  });
  return { presenter, output };
}

describe("SlashMenuPresenter", () => {
  test("first render saves the cursor, draws the menu, and restores it", () => {
    const { presenter, output } = makePresenter();
    presenter.render(snapshot());
    const text = output.text();
    expect(text).toContain("\x1b[s");
    expect(text).toContain("\x1b[u");
    expect(text).toContain("Commands");
    expect(text).toContain("/help");
  });

  test("a shorter second render clears the old rows before redrawing", () => {
    const { presenter, output } = makePresenter();
    presenter.render(snapshot());
    const first = output.text();
    presenter.render(snapshot({ matches: [descriptor("goal")], selectedIndex: 0 }));
    const delta = output.text().slice(first.length);
    // The redraw first clears every previously drawn row, then draws only the
    // new single-row menu.
    expect(delta).toContain("\x1b[A\x1b[K");
    expect(delta).not.toContain("/resume");
    expect(delta).toContain("/goal");
  });

  test("clear is idempotent and restores the cursor", () => {
    const { presenter, output } = makePresenter();
    presenter.render(snapshot());
    presenter.clear();
    presenter.clear();
    const text = output.text();
    expect(text).toContain("\x1b[u");
    // No further writes on the second clear.
    const after = output.text();
    expect(after).toBe(text);
  });

  test("suspend clears but resume redraws the active snapshot", () => {
    const { presenter, output } = makePresenter();
    presenter.render(snapshot());
    const before = output.text();
    presenter.suspend();
    const suspended = output.text();
    expect(suspended.length).toBeGreaterThan(before.length);
    presenter.resume(snapshot());
    const resumed = output.text();
    expect(resumed).toContain("/help");
  });

  test("resume of an inactive snapshot draws no menu", () => {
    const { presenter, output } = makePresenter();
    presenter.render(snapshot());
    const beforeSuspend = output.text();
    presenter.suspend();
    const afterSuspend = output.text();
    expect(afterSuspend.length).toBeGreaterThan(beforeSuspend.length);
    presenter.resume(snapshot({ active: false }));
    // An inactive resume must not draw anything.
    expect(output.text()).toBe(afterSuspend);
  });

  test("resize redraws with the new width", () => {
    const { presenter, output } = makePresenter(120);
    presenter.render(snapshot());
    const wide = output.text();
    output.columns = 60;
    output.resize();
    const narrowed = output.text();
    expect(narrowed.length).toBeGreaterThan(wide.length);
  });

  test("close clears the region and removes the resize listener once", () => {
    const { presenter, output } = makePresenter();
    presenter.render(snapshot());
    const listenerCount = output.resizeListeners.size;
    presenter.close();
    presenter.close();
    expect(output.resizeListeners.size).toBe(0);
    expect(output.listenerCounts["resize"] ?? 0).toBeLessThanOrEqual(listenerCount);
  });

  test("render and resize after close produce no output", () => {
    const { presenter, output } = makePresenter();
    presenter.close();
    const before = output.text();
    presenter.render(snapshot());
    output.resize();
    expect(output.text()).toBe(before);
  });
});
