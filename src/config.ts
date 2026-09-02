import { AppError } from "./errors/app-error.js";
import type { PersistedConfigV1 } from "./storage/config-store.js";

export type PermissionMode = "balanced" | "cautious";

export type AppConfig = {
  apiKey: string;
  baseURL: string;
  model: string;
  maxTokens: number;
  maxSteps: number;
  commandTimeoutMs: number;
  toolOutputMaxBytes: number;
  uiOutputMaxBytes: number;
  contextWindowTokens: number;
  contextCompactRatio: number;
  contextRecentMessages: number;
  contextSafetyTokens: number;
  workspaceRoot: string;
  permissionMode: PermissionMode;
  debug: boolean;
  /** Optional Tavily key; when absent the web_search tool is not registered. */
  tavilyApiKey?: string;
  webSearchTimeoutMs: number;
  webSearchMaxContentChars: number;
  /** Optional token pricing (USD per million tokens); environment-only. */
  pricing?: { inputPerMillion: number; outputPerMillion: number };
};

export class ConfigError extends AppError {
  override readonly name = "ConfigError";
  constructor(
    message: string,
    code: "CONFIG_INVALID" | "CONFIG_MISSING_API_KEY" = "CONFIG_INVALID",
  ) {
    super({ code, userMessage: message });
  }
}

const NUMERIC_DEFAULTS = {
  AGENT_MAX_STEPS: 20,
  COMMAND_TIMEOUT_MS: 120_000,
  TOOL_OUTPUT_MAX_BYTES: 32_768,
  UI_OUTPUT_MAX_BYTES: 65_536,
  AGENT_MAX_TOKENS: 4_096,
  CONTEXT_WINDOW_TOKENS: 48_000,
  CONTEXT_COMPACT_RATIO: 0.70,
  CONTEXT_RECENT_MESSAGES: 12,
  CONTEXT_SAFETY_TOKENS: 2_048,
  WEB_SEARCH_TIMEOUT_MS: 15_000,
  WEB_SEARCH_MAX_CONTENT_CHARS: 6_000,
} as const;

function readPositiveInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(
      `Environment variable ${name} must be a positive integer; got "${raw}"`,
    );
  }
  return value;
}

function readNonNegativeInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new ConfigError(
      `Environment variable ${name} must be a non-negative integer; got "${raw}"`,
    );
  }
  return value;
}

/**
 * Reads an optional paired decimal pricing configuration. Both values must be
 * present and be finite, non-negative decimals, or neither is configured.
 * Values are never persisted and never echo secrets.
 */
function readPricing(
  env: NodeJS.ProcessEnv,
): { inputPerMillion: number; outputPerMillion: number } | undefined {
  const inputRaw = env.MODEL_INPUT_COST_PER_MTOKENS?.trim() ?? "";
  const outputRaw = env.MODEL_OUTPUT_COST_PER_MTOKENS?.trim() ?? "";
  if (inputRaw === "" && outputRaw === "") {
    return undefined;
  }
  if (inputRaw === "" || outputRaw === "") {
    throw new ConfigError(
      "MODEL_INPUT_COST_PER_MTOKENS and MODEL_OUTPUT_COST_PER_MTOKENS must be set together",
    );
  }
  const parse = (raw: string, name: string): number => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      throw new ConfigError(
        `Environment variable ${name} must be a non-negative decimal; got "${raw}"`,
      );
    }
    return value;
  };
  return {
    inputPerMillion: parse(inputRaw, "MODEL_INPUT_COST_PER_MTOKENS"),
    outputPerMillion: parse(outputRaw, "MODEL_OUTPUT_COST_PER_MTOKENS"),
  };
}

function readRatio(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new ConfigError(
      `Environment variable ${name} must be a ratio in (0, 1]; got "${raw}"`,
    );
  }
  return value;
}

type ParsedArgs = {
  workspaceRoot?: string;
  permissionMode?: PermissionMode;
  debug: boolean;
};

function assignOption(parsed: ParsedArgs, option: string, value: string): void {
  if (option === "--workspace") {
    if (parsed.workspaceRoot !== undefined) {
      throw new ConfigError("Workspace may be specified only once");
    }
    parsed.workspaceRoot = value;
    return;
  }
  if (option === "--permission-mode") {
    if (value !== "balanced" && value !== "cautious") {
      throw new ConfigError(
        `--permission-mode must be "balanced" or "cautious"; got "${value}"`,
      );
    }
    parsed.permissionMode = value;
    return;
  }
  throw new ConfigError(`Unknown option: ${option}`);
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { debug: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--debug") {
      parsed.debug = true;
      continue;
    }
    if (arg === "--workspace" || arg === "--permission-mode") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new ConfigError(`Option ${arg} requires a value`);
      }
      assignOption(parsed, arg, value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--workspace=")) {
      assignOption(parsed, "--workspace", arg.slice("--workspace=".length));
      continue;
    }
    if (arg.startsWith("--permission-mode=")) {
      assignOption(parsed, "--permission-mode", arg.slice("--permission-mode=".length));
      continue;
    }
    if (!arg.startsWith("-")) {
      if (parsed.workspaceRoot !== undefined) {
        throw new ConfigError("Workspace may be specified only once");
      }
      parsed.workspaceRoot = arg;
      continue;
    }
    throw new ConfigError(`Unknown option: ${arg}`);
  }
  return parsed;
}

export type ResolveConfigInput = {
  env: NodeJS.ProcessEnv;
  argv: readonly string[];
  persisted?: PersistedConfigV1 | undefined;
  cwd: string;
};

export function resolveConfig(input: ResolveConfigInput): AppConfig {
  const args = parseArgs(input.argv);

  const apiKey = input.env.ANTHROPIC_API_KEY?.trim() ?? "";
  if (apiKey === "") {
    throw new ConfigError(
      "Missing required environment variable: ANTHROPIC_API_KEY",
      "CONFIG_MISSING_API_KEY",
    );
  }

  const baseURL =
    input.env.ANTHROPIC_BASE_URL?.trim() ||
    input.persisted?.baseURL.trim() ||
    "";
  if (baseURL === "") {
    throw new ConfigError(
      "Incomplete non-secret configuration: set ANTHROPIC_BASE_URL or run setup.",
    );
  }

  const model = input.env.MODEL_ID?.trim() || input.persisted?.model.trim() || "";
  if (model === "") {
    throw new ConfigError(
      "Incomplete non-secret configuration: set MODEL_ID or run setup.",
    );
  }

  const maxTokens = readPositiveInt(input.env, "AGENT_MAX_TOKENS", NUMERIC_DEFAULTS.AGENT_MAX_TOKENS);
  const contextWindowTokens = readPositiveInt(
    input.env,
    "CONTEXT_WINDOW_TOKENS",
    NUMERIC_DEFAULTS.CONTEXT_WINDOW_TOKENS,
  );
  const contextSafetyTokens = readPositiveInt(
    input.env,
    "CONTEXT_SAFETY_TOKENS",
    NUMERIC_DEFAULTS.CONTEXT_SAFETY_TOKENS,
  );
  const hardInputBudget = contextWindowTokens - maxTokens - contextSafetyTokens;
  if (hardInputBudget <= 0) {
    throw new ConfigError(
      "The hard input budget (CONTEXT_WINDOW_TOKENS - AGENT_MAX_TOKENS - CONTEXT_SAFETY_TOKENS) must be positive.",
    );
  }
  const tavilyKey = input.env.TAVILY_API_KEY?.trim() ?? "";

  return {
    apiKey,
    baseURL,
    model,
    maxTokens,
    maxSteps: readPositiveInt(input.env, "AGENT_MAX_STEPS", NUMERIC_DEFAULTS.AGENT_MAX_STEPS),
    commandTimeoutMs: readPositiveInt(
      input.env,
      "COMMAND_TIMEOUT_MS",
      NUMERIC_DEFAULTS.COMMAND_TIMEOUT_MS,
    ),
    toolOutputMaxBytes: readPositiveInt(
      input.env,
      "TOOL_OUTPUT_MAX_BYTES",
      NUMERIC_DEFAULTS.TOOL_OUTPUT_MAX_BYTES,
    ),
    uiOutputMaxBytes: readPositiveInt(
      input.env,
      "UI_OUTPUT_MAX_BYTES",
      NUMERIC_DEFAULTS.UI_OUTPUT_MAX_BYTES,
    ),
    contextWindowTokens,
    contextCompactRatio: readRatio(
      input.env,
      "CONTEXT_COMPACT_RATIO",
      NUMERIC_DEFAULTS.CONTEXT_COMPACT_RATIO,
    ),
    contextRecentMessages: readNonNegativeInt(
      input.env,
      "CONTEXT_RECENT_MESSAGES",
      NUMERIC_DEFAULTS.CONTEXT_RECENT_MESSAGES,
    ),
    contextSafetyTokens,
    workspaceRoot: args.workspaceRoot ?? input.cwd,
    permissionMode:
      args.permissionMode ?? input.persisted?.permissionMode ?? "balanced",
    debug: args.debug,
    ...(tavilyKey === "" ? {} : { tavilyApiKey: tavilyKey }),
    webSearchTimeoutMs: readPositiveInt(
      input.env,
      "WEB_SEARCH_TIMEOUT_MS",
      NUMERIC_DEFAULTS.WEB_SEARCH_TIMEOUT_MS,
    ),
    webSearchMaxContentChars: readPositiveInt(
      input.env,
      "WEB_SEARCH_MAX_CONTENT_CHARS",
      NUMERIC_DEFAULTS.WEB_SEARCH_MAX_CONTENT_CHARS,
    ),
    ...(readPricing(input.env) === undefined
      ? {}
      : { pricing: readPricing(input.env)! }),
  };
}

/**
 * Temporary compatibility wrapper used by legacy tests and pre-bootstrap
 * call sites; migrates to `resolveConfig` in the bootstrap task.
 */
export function loadConfig(env: NodeJS.ProcessEnv, argv: readonly string[]): AppConfig {
  return resolveConfig({ env, argv, cwd: process.cwd() });
}
