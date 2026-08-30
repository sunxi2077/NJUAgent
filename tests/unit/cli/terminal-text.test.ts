import { describe, expect, test } from "vitest";

import { sanitizeTerminalText, terminalWidth, truncateToTerminalWidth } from "../../../src/cli/terminal-text.js";

describe("terminal text width", () => {
  test("counts ASCII, CJK, combining marks, emoji and ANSI", () => {
    expect(terminalWidth("abc")).toBe(3);
    expect(terminalWidth("南京")).toBe(4);
    expect(terminalWidth("e\u0301")).toBe(1);
    expect(terminalWidth("😀")).toBe(2);
    expect(terminalWidth("\x1b[38;5;141mNJU\x1b[0m")).toBe(3);
  });

  test("truncates without exceeding the requested cells", () => {
    expect(truncateToTerminalWidth("南京大学", 5)).toBe("南京…");
    expect(terminalWidth(truncateToTerminalWidth("abc😀def", 6))).toBeLessThanOrEqual(6);
    expect(truncateToTerminalWidth("short", 5)).toBe("short");
  });

  test("sanitizes ANSI, CR/LF, and tab whitespace into a single trimmed line", () => {
    expect(sanitizeTerminalText("line 1\nline 2\r\nline 3")).toBe("line 1 line 2 line 3");
    expect(sanitizeTerminalText("\x1b[31mred\x1b[0m")).toBe("red");
    expect(sanitizeTerminalText("a\t\tb")).toBe("a b");
    expect(sanitizeTerminalText("  leading and trailing  ")).toBe("leading and trailing");
  });
});
