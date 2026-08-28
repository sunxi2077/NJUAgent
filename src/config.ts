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
  workspaceRoot: string;
  permissionMode: PermissionMode;
  debug: boolean;
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

type ParsedArgs = {
  workspaceRoot?: string;
  permissionMode?: PermissionMode;
  debug: boolean;
};

function assignOption(parsed: ParsedArgs, option: string, value: string): void {
  if (option === "--workspace") {
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

  return {
    apiKey,
    baseURL,
    model,
    maxTokens: readPositiveInt(input.env, "AGENT_MAX_TOKENS", NUMERIC_DEFAULTS.AGENT_MAX_TOKENS),
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
    workspaceRoot: args.workspaceRoot ?? input.cwd,
    permissionMode:
      args.permissionMode ?? input.persisted?.permissionMode ?? "balanced",
    debug: args.debug,
  };
}

/**
 * Temporary compatibility wrapper used by legacy tests and pre-bootstrap
 * call sites; migrates to `resolveConfig` in the bootstrap task.
 */
export function loadConfig(env: NodeJS.ProcessEnv, argv: readonly string[]): AppConfig {
  return resolveConfig({ env, argv, cwd: process.cwd() });
}
