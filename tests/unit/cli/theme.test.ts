import { describe, expect, test } from "vitest";

import { createTheme } from "../../../src/cli/theme.js";

describe("createTheme", () => {
  test("disabled styles are identity functions", () => {
    const plain = createTheme({ enabled: false });
    expect(plain.brand("NJUAgent")).toBe("NJUAgent");
    expect(plain.brandBase("NJUAgent")).toBe("NJUAgent");
    expect(plain.success("ok")).toBe("ok");
    expect(plain.warning("warn")).toBe("warn");
    expect(plain.error("boom")).toBe("boom");
    expect(plain.muted("dim")).toBe("dim");
  });

  test("enabled brand text contains ANSI and the original text", () => {
    const colored = createTheme({ enabled: true });
    expect(colored.brand("NJUAgent")).toContain("\x1b[");
    expect(colored.brand("NJUAgent")).toContain("NJUAgent");
    expect(colored.error("boom")).toContain("\x1b[");
  });

  test("every enabled wrapper opens with ANSI and closes its own sequence", () => {
    const theme = createTheme({ enabled: true });
    const names = ["brand", "brandBase", "success", "warning", "error", "muted"] as const;
    for (const name of names) {
      const formatted = theme[name]("text");
      expect(formatted, name).toMatch(/^\x1b\[[0-9;]+m/u);
      expect(formatted, name).toMatch(/\x1b\[[0-9;]*m$/u);
      expect(formatted.replace(/\x1b\[[0-9;]*m/gu, ""), name).toBe("text");
    }
  });
});
