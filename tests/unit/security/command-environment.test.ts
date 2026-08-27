import { describe, expect, test } from "vitest";

import { createCommandEnvironment } from "../../../src/security/command-environment.js";

describe("createCommandEnvironment", () => {
  test("preserves required runtime variables and removes credentials", () => {
    const result = createCommandEnvironment({
      PATH: "/safe/bin",
      HOME: "/safe/home",
      LANG: "en_US.UTF-8",
      CI: "true",
      ANTHROPIC_API_KEY: "anthropic-secret",
      ANTHROPIC_AUTH_TOKEN: "auth-secret",
      GITHUB_TOKEN: "github-secret",
      DATABASE_URL: "postgres://user:password@example/db",
      RANDOM_PROJECT_SETTING: "private-value",
    });

    expect(result).toMatchObject({
      PATH: "/safe/bin",
      HOME: "/safe/home",
      LANG: "en_US.UTF-8",
      CI: "true",
    });
    expect(result).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(result).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(result).not.toHaveProperty("GITHUB_TOKEN");
    expect(result).not.toHaveProperty("DATABASE_URL");
    expect(result).not.toHaveProperty("RANDOM_PROJECT_SETTING");
  });

  test("omits allowlisted variables that are not present", () => {
    expect(createCommandEnvironment({ PATH: "/safe/bin" })).toEqual({
      PATH: "/safe/bin",
    });
  });
});
