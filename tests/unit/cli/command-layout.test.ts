import { describe, expect, test } from "vitest";
import { stripVTControlCharacters } from "node:util";

import {
  formatCommandPanel,
  formatProgressBar,
  type CommandPanel,
} from "../../../src/cli/command-layout.js";
import { createTheme } from "../../../src/cli/theme.js";
import { terminalWidth } from "../../../src/cli/terminal-text.js";

const theme = createTheme({ enabled: true });
const plainTheme = createTheme({ enabled: false });

function statusPanel(overrides: Partial<CommandPanel> = {}): CommandPanel {
  return {
    symbol: "◆",
    title: "Session status",
    sections: [
      {
        rows: [
          { label: "Model", value: "deepseek-v4-flash" },
          { label: "Workspace", value: "/tmp/demo" },
          { label: "Session", value: "61948677" },
        ],
      },
      {
        heading: "Context",
        rows: [
          { value: "[progress] 1.4k / 41.9k · 3%" },
          { value: "Compact at 33.6k · 0 summaries" },
        ],
      },
    ],
    ...overrides,
  };
}

function visibleWidths(text: string): number[] {
  return text.split("\n").map((line) => terminalWidth(stripVTControlCharacters(line)));
}

describe("formatCommandPanel", () => {
  test("full panel has one uniform visible row width with ANSI enabled", () => {
    const panel = formatCommandPanel(statusPanel(), { columns: 80, theme });
    const widths = visibleWidths(panel);
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]!).toBeLessThanOrEqual(80);
    expect(panel).toContain("Session status");
    expect(stripVTControlCharacters(panel)).toContain("│ Model");
  });

  test("CJK and long values truncate without breaking the frame", () => {
    const long = statusPanel({
      sections: [
        {
          rows: [
            { label: "Workspace", value: "/very/".repeat(60) },
            { label: "标题", value: "这是一个很长很长的中文工作区路径示例".repeat(10) },
          ],
        },
      ],
    });
    const panel = formatCommandPanel(long, { columns: 60, theme });
    const widths = visibleWidths(panel);
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]!).toBeLessThanOrEqual(60);
    // No surrogate pair is split.
    const clean = stripVTControlCharacters(panel);
    for (const char of clean) {
      expect(char.codePointAt(0)!).toBeGreaterThanOrEqual(0);
    }
    expect(clean).not.toContain("\uFFFD");
  });

  test.each([47, 28, 20])("%i columns never emits over-wide or broken lines", (columns) => {
    const panel = formatCommandPanel(statusPanel(), { columns, theme });
    const widths = visibleWidths(panel);
    for (const width of widths) {
      expect(width).toBeLessThanOrEqual(Math.max(columns, 1));
    }
    // No negative repeat artifacts.
    expect(panel).not.toContain("NaN");
    expect(panel).not.toContain("Infinity");
  });

  test("disabled theme output contains no ANSI bytes", () => {
    const panel = formatCommandPanel(statusPanel(), { columns: 80, theme: plainTheme });
    expect(panel).not.toContain("\x1b[");
    expect(panel).toContain("Session status");
    expect(panel).toContain("deepseek-v4-flash");
  });

  test("a compact panel below 48 columns stays readable without borders", () => {
    const panel = formatCommandPanel(statusPanel(), { columns: 40, theme });
    expect(panel).not.toContain("╭");
    expect(panel).toContain("Model");
    expect(panel).toContain("deepseek-v4-flash");
  });
});

describe("formatProgressBar", () => {
  test("renders filled cells with normal, warning, and error states", () => {
    const normal = formatProgressBar(10, 100, { cells: 10, theme });
    const warning = formatProgressBar(75, 100, { cells: 10, theme });
    const error = formatProgressBar(95, 100, { cells: 10, theme });
    for (const bar of [normal, warning, error]) {
      expect(stripVTControlCharacters(bar)).toMatch(/^\[.+\]$/u);
    }
    expect(normal).not.toBe(warning);
    expect(warning).not.toBe(error);
  });

  test("protects a zero or invalid maximum", () => {
    expect(formatProgressBar(5, 0, { cells: 10, theme })).toContain("[");
    expect(formatProgressBar(Number.NaN, 100, { cells: 10, theme })).toContain("[");
    const visible = stripVTControlCharacters(formatProgressBar(Number.POSITIVE_INFINITY, 100, { cells: 10, theme }));
    expect(visible).not.toContain("NaN");
    expect(visible).not.toContain("Infinity");
  });

  test("disabled theme has no ANSI", () => {
    const bar = formatProgressBar(30, 100, { cells: 10, theme: plainTheme });
    expect(bar).not.toContain("\x1b[");
  });
});
