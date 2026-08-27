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

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

const REQUIRED_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "MODEL_ID"] as const;

const NUMERIC_DEFAULTS = {
  AGENT_MAX_STEPS: 20,
  COMMAND_TIMEOUT_MS: 120_000,
  TOOL_OUTPUT_MAX_BYTES: 32_768,
  UI_OUTPUT_MAX_BYTES: 65_536,
  AGENT_MAX_TOKENS: 4_096,
} as const;

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new ConfigError(`Missing required environment variable: ${name}`);
  }
  return value;
}

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

export function loadConfig(env: NodeJS.ProcessEnv, argv: readonly string[]): AppConfig {
  const args = parseArgs(argv);

  const missing = REQUIRED_ENV.filter((name) => {
    const value = env[name];
    return value === undefined || value.trim() === "";
  });
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required environment variable${missing.length === 1 ? "" : "s"}: ` +
        missing.join(", "),
    );
  }

  return {
    apiKey: requireEnv(env, "ANTHROPIC_API_KEY"),
    baseURL: requireEnv(env, "ANTHROPIC_BASE_URL"),
    model: requireEnv(env, "MODEL_ID"),
    maxTokens: readPositiveInt(env, "AGENT_MAX_TOKENS", NUMERIC_DEFAULTS.AGENT_MAX_TOKENS),
    maxSteps: readPositiveInt(env, "AGENT_MAX_STEPS", NUMERIC_DEFAULTS.AGENT_MAX_STEPS),
    commandTimeoutMs: readPositiveInt(
      env,
      "COMMAND_TIMEOUT_MS",
      NUMERIC_DEFAULTS.COMMAND_TIMEOUT_MS,
    ),
    toolOutputMaxBytes: readPositiveInt(
      env,
      "TOOL_OUTPUT_MAX_BYTES",
      NUMERIC_DEFAULTS.TOOL_OUTPUT_MAX_BYTES,
    ),
    uiOutputMaxBytes: readPositiveInt(
      env,
      "UI_OUTPUT_MAX_BYTES",
      NUMERIC_DEFAULTS.UI_OUTPUT_MAX_BYTES,
    ),
    workspaceRoot: args.workspaceRoot ?? process.cwd(),
    permissionMode: args.permissionMode ?? "balanced",
    debug: args.debug,
  };
}
