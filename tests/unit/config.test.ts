import { describe, expect, test } from "vitest";

import { ConfigError, loadConfig, resolveConfig } from "../../src/config.js";
import type { PersistedConfigV1 } from "../../src/storage/config-store.js";

function captureError(fn: () => void): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

const validEnv = {
  ANTHROPIC_API_KEY: "sk-test",
  ANTHROPIC_BASE_URL: "https://api.example.com/anthropic",
  MODEL_ID: "deepseek-v3",
};

const persisted: PersistedConfigV1 = {
  schemaVersion: 1,
  baseURL: "https://persisted.example/anthropic",
  model: "persisted-model",
  permissionMode: "cautious",
};

describe("loadConfig (compatibility wrapper)", () => {
  test("missing API Key throws CONFIG_MISSING_API_KEY by name without echoing values", () => {
    const error = captureError(() => loadConfig({}, []));
    expect(error).toBeInstanceOf(ConfigError);
    expect(error).toMatchObject({ code: "CONFIG_MISSING_API_KEY" });
    expect(String(error)).toMatch(/ANTHROPIC_API_KEY/);
  });

  test("missing Base URL or Model is reported as incomplete non-secret configuration", () => {
    const missingUrl = () =>
      loadConfig({ ANTHROPIC_API_KEY: "k", MODEL_ID: "m" }, []);
    expect(missingUrl).toThrow(ConfigError);
    expect(missingUrl).toThrow(/ANTHROPIC_BASE_URL/);

    const missingModel = () =>
      loadConfig({ ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://x" }, []);
    expect(missingModel).toThrow(/MODEL_ID/);
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
    expect(config.uiOutputMaxBytes).toBe(65536);
    expect(config.maxTokens).toBe(4096);
    expect(config.permissionMode).toBe("balanced");
    expect(config.debug).toBe(false);
    expect(config.workspaceRoot).toBe(process.cwd());
    expect(config.tavilyApiKey).toBeUndefined();
    expect(config.webSearchTimeoutMs).toBe(15000);
    expect(config.webSearchMaxContentChars).toBe(6000);
  });

  test("web search settings accept overrides and a present key", () => {
    const config = loadConfig(
      {
        ...validEnv,
        TAVILY_API_KEY: "  tvly-secret  ",
        WEB_SEARCH_TIMEOUT_MS: "9000",
        WEB_SEARCH_MAX_CONTENT_CHARS: "400",
      },
      [],
    );
    expect(config.tavilyApiKey).toBe("tvly-secret");
    expect(config.webSearchTimeoutMs).toBe(9000);
    expect(config.webSearchMaxContentChars).toBe(400);
  });

  test("rejects invalid web search numeric settings", () => {
    for (const bad of ["0", "-1", "abc", "1.5"]) {
      expect(() =>
        loadConfig({ ...validEnv, WEB_SEARCH_TIMEOUT_MS: bad }, []),
      ).toThrow(ConfigError);
      expect(() =>
        loadConfig({ ...validEnv, WEB_SEARCH_MAX_CONTENT_CHARS: bad }, []),
      ).toThrow(ConfigError);
    }
  });

  test("treats a blank Tavily key as unavailable", () => {
    const blank = loadConfig({ ...validEnv, TAVILY_API_KEY: "   " }, []);
    expect(blank.tavilyApiKey).toBeUndefined();
  });

  test("accepts positive integer overrides from the environment", () => {
    const config = loadConfig(
      {
        ...validEnv,
        AGENT_MAX_STEPS: "5",
        COMMAND_TIMEOUT_MS: "3000",
        TOOL_OUTPUT_MAX_BYTES: "1024",
        UI_OUTPUT_MAX_BYTES: "2048",
        AGENT_MAX_TOKENS: "2048",
      },
      [],
    );
    expect(config.maxSteps).toBe(5);
    expect(config.commandTimeoutMs).toBe(3000);
    expect(config.toolOutputMaxBytes).toBe(1024);
    expect(config.uiOutputMaxBytes).toBe(2048);
    expect(config.maxTokens).toBe(2048);
  });

  test("rejects zero, negative, and non-numeric numeric settings", () => {
    for (const bad of ["0", "-1", "abc", "1.5"]) {
      expect(() => loadConfig({ ...validEnv, AGENT_MAX_STEPS: bad }, [])).toThrow(
        ConfigError,
      );
      expect(() => loadConfig({ ...validEnv, UI_OUTPUT_MAX_BYTES: bad }, [])).toThrow(
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

describe("resolveConfig", () => {
  test("env overrides persisted values, and persisted fills the gaps", () => {
    expect(resolveConfig({
      env: {
        ANTHROPIC_API_KEY: "env-key",
        MODEL_ID: "env-model",
      },
      argv: [],
      cwd: "/workspace",
      persisted,
    })).toMatchObject({
      apiKey: "env-key",
      baseURL: "https://persisted.example/anthropic",
      model: "env-model",
      permissionMode: "cautious",
    });
  });

  test("API Key comes only from the environment and never from persisted config", () => {
    const error = captureError(() =>
      resolveConfig({ env: {}, argv: [], cwd: "/w", persisted }),
    );
    expect(error).toMatchObject({ code: "CONFIG_MISSING_API_KEY" });
  });

  test("missing Base URL and Model are reported separately as incomplete configuration", () => {
    const missingUrl = captureError(() =>
      resolveConfig({
        env: { ANTHROPIC_API_KEY: "k" },
        argv: [],
        cwd: "/w",
      }),
    );
    expect(missingUrl).toMatchObject({ code: "CONFIG_INVALID" });
    expect(String(missingUrl)).toMatch(/ANTHROPIC_BASE_URL/u);

    const missingModel = captureError(() =>
      resolveConfig({
        env: { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://x" },
        argv: [],
        cwd: "/w",
      }),
    );
    expect(missingModel).toMatchObject({ code: "CONFIG_INVALID" });
    expect(String(missingModel)).toMatch(/MODEL_ID/u);
  });

  test("workspaceRoot falls back to the injected cwd", () => {
    const config = resolveConfig({
      env: validEnv,
      argv: [],
      cwd: "/injected/cwd",
      persisted,
    });
    expect(config.workspaceRoot).toBe("/injected/cwd");
    expect(config.permissionMode).toBe("cautious");
  });

  test("CLI permission mode overrides the persisted value", () => {
    const config = resolveConfig({
      env: validEnv,
      argv: ["--permission-mode", "balanced"],
      cwd: "/w",
      persisted,
    });
    expect(config.permissionMode).toBe("balanced");
  });
});

describe("context budgets", () => {
  test("applies documented context budget defaults", () => {
    const config = loadConfig(validEnv, []);
    expect(config).toMatchObject({
      contextWindowTokens: 48_000,
      contextCompactRatio: 0.70,
      contextRecentMessages: 12,
      contextSafetyTokens: 2_048,
    });
  });

  test("accepts positive overrides from the environment", () => {
    const config = loadConfig(
      {
        ...validEnv,
        CONTEXT_WINDOW_TOKENS: "60000",
        CONTEXT_COMPACT_RATIO: "0.5",
        CONTEXT_RECENT_MESSAGES: "6",
        CONTEXT_SAFETY_TOKENS: "4096",
      },
      [],
    );
    expect(config.contextWindowTokens).toBe(60000);
    expect(config.contextCompactRatio).toBe(0.5);
    expect(config.contextRecentMessages).toBe(6);
    expect(config.contextSafetyTokens).toBe(4096);
  });

  test.each(["0", "1.01", "abc"])(
    "rejects an invalid compact ratio: %s",
    (value) => {
      expect(() =>
        loadConfig({ ...validEnv, CONTEXT_COMPACT_RATIO: value }, []),
      ).toThrow(ConfigError);
    },
  );

  test("rejects a zero or negative recent-message count", () => {
    for (const bad of ["-1"]) {
      expect(() =>
        loadConfig({ ...validEnv, CONTEXT_RECENT_MESSAGES: bad }, []),
      ).toThrow(ConfigError);
    }
  });

  test("requires the hard input budget window - maxTokens - safety to be positive", () => {
    expect(() =>
      loadConfig(
        { ...validEnv, CONTEXT_WINDOW_TOKENS: "3000", AGENT_MAX_TOKENS: "2000", CONTEXT_SAFETY_TOKENS: "2048" },
        [],
      ),
    ).toThrow(/hard input budget/iu);
  });
});
