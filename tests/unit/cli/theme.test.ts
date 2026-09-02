import { describe, expect, test } from "vitest";

import { createTheme, shouldEnableTerminalTheme } from "../../../src/cli/theme.js";

const methods = [
  "brandStrong",
  "brandBorder",
  "userLabel",
  "assistantLabel",
  "heading",
  "code",
  "quote",
  "success",
  "warning",
  "error",
  "muted",
  "bold",
  "italic",
  "underline",
] as const;

describe("createTheme", () => {
  test("disabled semantic styles are identity functions", () => {
    const theme = createTheme({ enabled: false });
    for (const method of methods) {
      expect(theme[method]("text"), method).toBe("text");
    }
  });

  test("uses distinct visible brand, border, user and assistant styles", () => {
    const theme = createTheme({ enabled: true });
    expect(theme.brandStrong("x")).toContain("\x1b[38;5;141m");
    expect(theme.brandBorder("x")).toContain("\x1b[38;5;99m");
    expect(theme.userLabel("x")).toContain("\x1b[38;5;45m");
    expect(theme.brandBorder("x")).not.toContain("38;5;54m");
    expect(theme.userLabel("x")).not.toBe(theme.assistantLabel("x"));
  });

  test("enabled semantic wrappers contain the original text and ANSI", () => {
    const theme = createTheme({ enabled: true });
    for (const method of methods) {
      const formatted = theme[method]("text");
      expect(formatted, method).toContain("\x1b[");
      expect(formatted.replace(/\x1b\[[0-9;]*m/gu, ""), method).toBe("text");
    }
  });

  test("every enabled wrapper opens with ANSI and closes its own sequence", () => {
    const theme = createTheme({ enabled: true });
    for (const method of methods) {
      const formatted = theme[method]("text");
      expect(formatted, method).toMatch(/^\x1b\[[0-9;]+m/u);
      expect(formatted, method).toMatch(/\x1b\[[0-9;]*m$/u);
      expect(formatted.replace(/\x1b\[[0-9;]*m/gu, ""), method).toBe("text");
    }
  });
});

describe("shouldEnableTerminalTheme", () => {
  test("enables enhanced terminal output in exactly the supported environment", () => {
    expect(shouldEnableTerminalTheme({ isTTY: true, env: {} })).toBe(true);
    expect(shouldEnableTerminalTheme({ isTTY: false, env: {} })).toBe(false);
    expect(shouldEnableTerminalTheme({ isTTY: true, env: { NO_COLOR: "1" } })).toBe(false);
    expect(shouldEnableTerminalTheme({ isTTY: true, env: { NO_COLOR: "" } })).toBe(true);
    expect(shouldEnableTerminalTheme({ isTTY: true, env: { TERM: "dumb" } })).toBe(false);
  });
});

describe("createTheme hyperlinks", () => {
  test("disabled theme returns the label unchanged without OSC 8", () => {
    const theme = createTheme({ enabled: false });
    expect(theme.hyperlink("docs", "https://example.com")).toBe("docs");
  });

  test("enabled theme wraps the label in an OSC 8 hyperlink", () => {
    const theme = createTheme({ enabled: true });
    const link = theme.hyperlink("docs", "https://example.com/path?a=1");
    expect(link).toContain("\x1b]8;;https://example.com/path?a=1\x1b\\");
    expect(link).toContain("docs");
    expect(link).toContain("\x1b]8;;\x1b\\");
    expect(link.startsWith("\x1b]8;;")).toBe(true);
    expect(link.endsWith("\x1b]8;;\x1b\\")).toBe(true);
  });

  test("url control characters cannot inject a second OSC 8 payload", () => {
    const theme = createTheme({ enabled: true });
    const link = theme.hyperlink("x", "https://example.com/a\x1b]8;;evil");
    // Exactly one opener and one closer; the injected ESC is stripped.
    expect(link.split("\x1b]8;;")).toHaveLength(3);
    expect(link).not.toContain("\x1b]8;;evil");
  });
});
