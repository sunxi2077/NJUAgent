import { describe, expect, test } from "vitest";

import { formatWelcome, type WelcomeView } from "../../../src/cli/welcome.js";
import { createTheme } from "../../../src/cli/theme.js";

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

  test("enabled theme renders a boxed panel with ANSI brand text", () => {
    const colored = formatWelcome(view, createTheme({ enabled: true }), { columns: 80 });
    const lines = stripAnsi(colored).split("\n");
    expect(lines[0]).toMatch(/^╭─ NJUAgent v0\.2\.0 /u);
    expect(lines[1]).toContain("│ workspace  /tmp/demo");
    expect(lines[2]).toContain("│ model      deepseek-v4-flash");
    expect(lines[3]).toContain("│ session    abc123 · new · balanced");
    expect(lines[4]).toMatch(/^╰─+╯$/u);
    expect(lines[5]).toBe("Type /help for commands · Ctrl-C cancels");
    expect([...lines[0]!]).toHaveLength(80);
    expect(colored).toContain("\x1b[38;5;54m");
    expect(colored).toContain("\x1b[38;5;141m");
  });

  test("caps a wide terminal and renders an actionable resume hint", () => {
    const colored = formatWelcome(
      { ...view, recentSession: "8e6a2f (fix parser)" },
      createTheme({ enabled: true }),
      { columns: 120 },
    );
    const lines = stripAnsi(colored).split("\n");
    expect([...lines[0]!]).toHaveLength(88);
    expect(lines.at(-1)).toBe("Use /resume 8e6a2f (fix parser) to continue.");
  });

  test("does not exceed a narrow terminal width", () => {
    const colored = formatWelcome(
      view,
      createTheme({ enabled: true }),
      { columns: 32 },
    );
    const lines = stripAnsi(colored).split("\n").slice(0, 5);
    expect(lines.every((line) => [...line].length <= 32)).toBe(true);
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
