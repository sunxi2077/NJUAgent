import { describe, expect, test } from "vitest";
import { stripVTControlCharacters } from "node:util";

import { formatSlashMenu, SlashMenuPresenter } from "../../../src/cli/slash-menu.js";
import type { SlashCompletionSnapshot } from "../../../src/cli/slash-completion.js";
import type { SlashCommandDescriptor } from "../../../src/cli/command.js";
import { createTheme } from "../../../src/cli/theme.js";
import { terminalWidth } from "../../../src/cli/terminal-text.js";

function descriptor(name: string, description = `${name} command`): SlashCommandDescriptor {
  return { name, usage: `/${name}`, description };
}

const FOURTEEN_COMMANDS = [
  "help", "status", "sessions", "resume", "new", "history", "context",
  "compact", "plan", "goal", "skills", "skill", "setup", "exit",
].map((name) => descriptor(name));

function snapshot(overrides: Partial<SlashCompletionSnapshot> = {}) {
  const matches = FOURTEEN_COMMANDS;
  return {
    active: true,
    prefix: "",
    selectedIndex: 0,
    windowStart: 0,
    totalMatches: matches.length,
    matches,
    visibleMatches: matches.slice(0, 6),
    ...overrides,
  } satisfies SlashCompletionSnapshot;
}

function frameWidths(lines: readonly string[]): number[] {
  return lines.map((line) => terminalWidth(stripVTControlCharacters(line)));
}

const theme = createTheme({ enabled: true });

describe("formatSlashMenu", () => {
  test("inactive snapshot renders no lines", () => {
    expect(formatSlashMenu({ ...snapshot(), active: false }, { columns: 80, theme })).toEqual([]);
  });

  test("renders the six-row window with a range footer", () => {
    const text = formatSlashMenu(snapshot(), { columns: 80, theme })
      .map((line) => stripVTControlCharacters(line))
      .join("\n");
    expect(text).toContain("/help");
    expect(text).toContain("/history");
    expect(text).not.toContain("/context");
    expect(text).toContain("1–6 / 14");
  });

  test("scrolled window shows its range and marks the absolute selection", () => {
    const scrolled = formatSlashMenu(
      snapshot({
        windowStart: 6,
        selectedIndex: 7,
        visibleMatches: FOURTEEN_COMMANDS.slice(6, 12),
      }),
      { columns: 80, theme },
    );
    const visible = scrolled.map((line) => stripVTControlCharacters(line));
    expect(visible.join("\n")).toContain("7–12 / 14");
    expect(visible.join("\n")).toContain("/context");
    // Absolute index 6 is context (first visible row), 7 is compact.
    const contextRow = visible.findIndex((line) => line.includes("/context"));
    const compactRow = visible.findIndex((line) => line.includes("/compact"));
    expect(compactRow).toBe(contextRow + 1);
  });

  test("renders a full single-column box with equal row widths", () => {
    const lines = formatSlashMenu(snapshot(), { columns: 80, theme });
    const visible = lines.map((line) => stripVTControlCharacters(line));
    expect(visible[0]).toMatch(/^╭─ Commands /u);
    expect(visible[0]).toMatch(/╮$/u);
    expect(visible.at(-1)).toMatch(/↑↓ select · Tab complete · Esc close/u);
    const widths = frameWidths(lines);
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]!).toBeLessThanOrEqual(80);
  });

  test("marks the selected row with › and others with a space", () => {
    const lines = formatSlashMenu(snapshot({ selectedIndex: 2 }), { columns: 80, theme });
    const visible = lines.map((line) => stripVTControlCharacters(line));
    expect(visible.find((line) => line.includes("/sessions"))).toContain("› /sessions");
    expect(visible.find((line) => line.includes("/help"))).toContain("  /help");
  });

  test("truncates long names and descriptions without exceeding the frame", () => {
    const narrow = snapshot({ visibleMatches: [descriptor("very-long-command-name", "x".repeat(300))] });
    const lines = formatSlashMenu(narrow, { columns: 80, theme });
    const widths = frameWidths(lines);
    const frame = widths[0]!;
    for (const width of widths) {
      expect(width).toBe(frame);
    }
  });

  test("truncates CJK and emoji by cell width without breaking alignment", () => {
    const mixed = snapshot({ visibleMatches: [descriptor("goal", "完成所有测试 😀 收尾")] });
    const lines = formatSlashMenu(mixed, { columns: 80, theme });
    expect(new Set(frameWidths(lines)).size).toBe(1);
  });

  test("sanitizes ANSI, CR/LF, and tabs in descriptions", () => {
    const dirty = snapshot({ visibleMatches: [descriptor("goal", "\x1b[31mred\x1b[0m\nline2\tend")] });
    const visible = formatSlashMenu(dirty, { columns: 80, theme })
      .map((line) => stripVTControlCharacters(line));
    const row = visible.find((line) => line.includes("/goal"));
    expect(row).toContain("red line2 end");
    expect(row).not.toContain("\n");
    const sanitized = formatSlashMenu(dirty, { columns: 80, theme }).join("");
    expect(sanitized.replace(/\x1b\[[0-9;]*m/gu, "")).not.toContain("\x1b[");
  });

  test("renders No matching commands for an empty match set", () => {
    const empty = formatSlashMenu(
      snapshot({ matches: [], visibleMatches: [], totalMatches: 0, selectedIndex: -1 }),
      { columns: 80, theme },
    );
    const visible = empty.map((line) => stripVTControlCharacters(line));
    expect(visible.some((line) => line.includes("No matching commands"))).toBe(true);
    expect(visible.join("\n")).toContain("0 commands");
  });

  test("shows a plain count when all matches fit in the window", () => {
    const small = formatSlashMenu(
      snapshot({ visibleMatches: FOURTEEN_COMMANDS.slice(0, 2), totalMatches: 2 }),
      { columns: 80, theme },
    );
    expect(small.map((line) => stripVTControlCharacters(line)).join("\n")).toContain("2 commands");
  });

  test("stays a full box at 40 columns and switches to compact below 40", () => {
    const full = formatSlashMenu(snapshot(), { columns: 40, theme });
    expect(full[0]!.includes("╭")).toBe(true);
    expect(frameWidths(full)[0]!).toBeLessThanOrEqual(40);

    const compact = formatSlashMenu(snapshot(), { columns: 39, theme });
    const visible = compact.map((line) => stripVTControlCharacters(line));
    expect(visible.length).toBeLessThanOrEqual(4);
    expect(visible.some((line) => line.includes("› /help"))).toBe(true);
    expect(compact.some((line) => line.includes("╭"))).toBe(false);
    expect(visible.join("\n")).toContain("↑↓ · Tab · Esc · 1–3/14");
  });

  test("theme enabled and disabled produce the same visible widths", () => {
    const enabled = formatSlashMenu(snapshot(), { columns: 80, theme });
    const disabled = formatSlashMenu(snapshot(), { columns: 80, theme: createTheme({ enabled: false }) });
    expect(frameWidths(enabled)).toEqual(frameWidths(disabled));
  });
});

class FakeOutput {
  readonly chunks: string[] = [];
  columns = 80;
  throwOnWrite = false;
  readonly resizeListeners = new Set<() => void>();
  readonly listenerCounts: Record<string, number> = {};

  write(chunk: string): boolean {
    if (this.throwOnWrite) {
      throw new Error("write exploded");
    }
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
    for (const listener of [...this.resizeListeners]) {
      listener();
    }
  }
}

function makePresenter(columns = 80) {
  const output = new FakeOutput();
  output.columns = columns;
  const presenter = new SlashMenuPresenter({
    output: output as unknown as NodeJS.WritableStream & { columns?: number },
    theme,
  });
  return { presenter, output };
}

describe("SlashMenuPresenter", () => {
  test("first render saves the cursor, draws the menu below, and restores it", () => {
    const { presenter, output } = makePresenter();
    presenter.render(snapshot());
    const text = output.text();
    expect(text).toContain("\x1b[s");
    expect(text).toContain("\x1b[1B\r\x1b[2K");
    expect(text).toContain("\x1b[u");
    expect(text).toContain("Commands");
    expect(text).toContain("/help");
    // No cursor-up positioning anywhere.
    expect(text).not.toContain("\x1b[A");
  });

  test("clear moves down below the input line and never uses cursor-up", () => {
    const { presenter, output } = makePresenter();
    presenter.render(snapshot());
    const before = output.text().length;
    presenter.clear();
    const delta = output.text().slice(before);
    expect(delta).toContain("\x1b[s");
    expect(delta).toContain("\x1b[1B\r\x1b[2K");
    expect(delta).toContain("\x1b[u");
    expect(delta).not.toContain("\x1b[A");
  });

  test("a shorter second render clears every previously drawn row", () => {
    const { presenter, output } = makePresenter();
    presenter.render(snapshot());
    const first = output.text();
    presenter.render(snapshot({ visibleMatches: FOURTEEN_COMMANDS.slice(0, 1) }));
    const delta = output.text().slice(first.length);
    expect(delta).toContain("\x1b[1B\r\x1b[2K");
    expect(delta).not.toContain("/resume");
    expect(delta).toContain("/help");
  });

  test("clear is idempotent and restores the cursor", () => {
    const { presenter, output } = makePresenter();
    presenter.render(snapshot());
    presenter.clear();
    const afterFirst = output.text();
    presenter.clear();
    expect(output.text()).toBe(afterFirst);
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
    presenter.resume({ ...snapshot(), active: false });
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

  test("a throwing writer on resize disables the presenter without escaping", () => {
    const { presenter, output } = makePresenter();
    presenter.render(snapshot());
    output.throwOnWrite = true;
    expect(() => output.resize()).not.toThrow();
    expect(output.resizeListeners.size).toBe(0);
    output.throwOnWrite = false;
    const before = output.text();
    presenter.render(snapshot());
    presenter.clear();
    expect(output.text()).toBe(before);
  });
});
