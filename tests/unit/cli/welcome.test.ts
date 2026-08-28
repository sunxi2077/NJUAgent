import { describe, expect, test } from "vitest";

import { formatWelcome, type WelcomeView } from "../../../src/cli/welcome.js";
import { createTheme } from "../../../src/cli/theme.js";
import { terminalWidth } from "../../../src/cli/terminal-text.js";

const view: WelcomeView = {
  version: "0.2.0",
  workspace: "/tmp/demo",
  model: "deepseek-v4-flash",
  sessionShortId: "abc123",
  permissionMode: "balanced",
};

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/gu, "");

describe("formatWelcome", () => {
  test("plain theme emits a single [session] line without ANSI", () => {
    const plain = formatWelcome(view, createTheme({ enabled: false }));
    expect(plain).toContain("NJUAgent");
    expect(plain).toContain("workspace");
    expect(plain).toContain("model");
    expect(plain).toContain("session");
    expect(plain).toContain("/help");
    expect(plain.match(/\[session\]/gu)).toHaveLength(1);
    expect(plain).not.toContain("\x1b[");
  });

  test("wide TTY shows the NJU logo inside a visible 72-column-or-smaller frame", () => {
    const output = formatWelcome(view, createTheme({ enabled: true }), { columns: 100 });
    const plain = stripAnsi(output);
    expect(plain).toContain("███╗   ██╗");
    expect(plain).toContain("NJUAgent v0.2.0");
    expect(output).toContain("\x1b[38;5;141m");
    expect(output).toContain("\x1b[38;5;99m");
    const frame = plain.split("\n").filter((line) => /^[╭│╰]/u.test(line));
    expect(frame.every((line) => terminalWidth(line) <= 72)).toBe(true);
    expect(frame.every((line) => terminalWidth(line) === terminalWidth(frame[0]!))).toBe(true);
  });

  test.each([60, 40])("%i columns uses a compact complete frame", (columns) => {
    const plain = stripAnsi(formatWelcome(view, createTheme({ enabled: true }), { columns }));
    expect(plain).not.toContain("███╗");
    expect(plain).toContain("╭");
    expect(plain).toContain("╯");
    expect(plain.split("\n").every((line) => terminalWidth(line) <= columns)).toBe(true);
  });

  test("an extremely narrow terminal falls back to unboxed text", () => {
    const plain = stripAnsi(formatWelcome(view, createTheme({ enabled: true }), { columns: 30 }));
    expect(plain).toContain("NJUAgent v0.2.0");
    expect(plain).not.toMatch(/[╭╮╰╯│]/u);
    expect(plain.split("\n").every((line) => terminalWidth(line) <= 30)).toBe(true);
  });

  test("caps a wide terminal and renders an actionable resume hint", () => {
    const colored = formatWelcome(
      { ...view, recentSession: "8e6a2f (fix parser)" },
      createTheme({ enabled: true }),
      { columns: 120 },
    );
    const lines = stripAnsi(colored).split("\n");
    expect(lines.at(-1)).toBe("Use /resume 8e6a2f (fix parser) to continue.");
  });

  test("truncates very long workspace and model values", () => {
    const long: WelcomeView = {
      ...view,
      workspace: "x".repeat(300),
      model: "y".repeat(200),
    };
    const plain = formatWelcome(long, createTheme({ enabled: false }));
    expect(plain).toContain("…");
    expect(plain).not.toContain("x".repeat(300));
  });
});
