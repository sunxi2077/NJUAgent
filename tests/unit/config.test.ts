import { describe, expect, test } from "vitest";

import { ConfigError, loadConfig } from "../../src/config.js";

const validEnv = {
  ANTHROPIC_API_KEY: "sk-test",
  ANTHROPIC_BASE_URL: "https://api.example.com/anthropic",
  MODEL_ID: "deepseek-v3",
};

describe("loadConfig", () => {
  test("reports all missing required variables by name without echoing values", () => {
    expect(() => loadConfig({}, [])).toThrow(ConfigError);
    expect(() => loadConfig({}, [])).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => loadConfig({}, [])).toThrow(/ANTHROPIC_BASE_URL/);
    expect(() => loadConfig({}, [])).toThrow(/MODEL_ID/);
  });

  test("reports only the variables that are missing", () => {
    const error = () => loadConfig({ ANTHROPIC_API_KEY: "k", MODEL_ID: "m" }, []);
    expect(error).toThrow(ConfigError);
    expect(error).toThrow(/ANTHROPIC_BASE_URL/);
    expect(() => loadConfig({ ...validEnv }, [])).not.toThrow();
  });

  test("rejects an empty required variable the same as a missing one", () => {
    expect(() =>
      loadConfig({ ...validEnv, ANTHROPIC_API_KEY: "   " }, []),
    ).toThrow(/ANTHROPIC_API_KEY/);
  });

  test("applies documented defaults for numeric settings", () => {
    const config = loadConfig(validEnv, []);
    expect(config.maxSteps).toBe(20);
    expect(config.commandTimeoutMs).toBe(120000);
    expect(config.toolOutputMaxBytes).toBe(32768);
    expect(config.maxTokens).toBe(4096);
    expect(config.permissionMode).toBe("balanced");
    expect(config.debug).toBe(false);
    expect(config.workspaceRoot).toBe(process.cwd());
  });

  test("accepts positive integer overrides from the environment", () => {
    const config = loadConfig(
      {
        ...validEnv,
        AGENT_MAX_STEPS: "5",
        COMMAND_TIMEOUT_MS: "3000",
        TOOL_OUTPUT_MAX_BYTES: "1024",
        AGENT_MAX_TOKENS: "2048",
      },
      [],
    );
    expect(config.maxSteps).toBe(5);
    expect(config.commandTimeoutMs).toBe(3000);
    expect(config.toolOutputMaxBytes).toBe(1024);
    expect(config.maxTokens).toBe(2048);
  });

  test("rejects zero, negative, and non-numeric numeric settings", () => {
    for (const bad of ["0", "-1", "abc", "1.5"]) {
      expect(() => loadConfig({ ...validEnv, AGENT_MAX_STEPS: bad }, [])).toThrow(
        ConfigError,
      );
    }
  });

  test("parses --workspace in both forms", () => {
    const spaced = loadConfig(validEnv, ["--workspace", "/tmp/a"]);
    expect(spaced.workspaceRoot).toBe("/tmp/a");
    const inline = loadConfig(validEnv, ["--workspace=/tmp/b"]);
    expect(inline.workspaceRoot).toBe("/tmp/b");
  });

  test("parses --debug and --permission-mode", () => {
    const config = loadConfig(validEnv, ["--debug", "--permission-mode", "cautious"]);
    expect(config.debug).toBe(true);
    expect(config.permissionMode).toBe("cautious");
  });

  test("rejects an invalid permission mode", () => {
    expect(() =>
      loadConfig(validEnv, ["--permission-mode", "paranoid"]),
    ).toThrow(/balanced.*cautious/u);
  });

  test("rejects unknown options and options without a value", () => {
    expect(() => loadConfig(validEnv, ["--nope"])).toThrow(/Unknown option/u);
    expect(() => loadConfig(validEnv, ["--workspace"])).toThrow(/requires a value/u);
  });
});
