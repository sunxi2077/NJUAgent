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
    const colored = formatWelcome(view, createTheme({ enabled: true }));
    expect(colored).toContain("NJUAgent");
    expect(colored).toContain("workspace");
    expect(colored).toContain("model");
    expect(colored).toContain("session");
    expect(colored).toContain("/help");
    expect(colored).toContain("\x1b[");
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
