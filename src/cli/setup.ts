import type { PermissionMode } from "../config.js";
import type { ConfigStore, PersistedConfigV1 } from "../storage/config-store.js";
import type { Prompt } from "./prompt.js";

export type SetupDefaults = {
  baseURL?: string;
  model?: string;
  permissionMode?: PermissionMode;
};

export type SetupDeps = {
  prompt: Pick<Prompt, "read" | "confirm">;
  store: ConfigStore;
  defaults?: SetupDefaults;
};

function validateURL(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "must be a valid URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "must start with http:// or https://";
  }
  return undefined;
}

function validateModel(value: string): string | undefined {
  return value.trim() === "" ? "cannot be blank" : undefined;
}

function validateMode(value: string): string | undefined {
  return value === "balanced" || value === "cautious"
    ? undefined
    : "must be balanced or cautious";
}

async function askValue(
  prompt: Pick<Prompt, "read">,
  label: string,
  initial: string | undefined,
  validate: (value: string) => string | undefined,
): Promise<string | null> {
  for (;;) {
    const hint = initial === undefined ? "" : ` [${initial}]`;
    const answer = await prompt.read(`${label}${hint}: `);
    if (answer === null) {
      return null;
    }
    const trimmed = answer.trim();
    if (trimmed === "") {
      if (initial !== undefined) {
        return initial;
      }
      continue;
    }
    if (validate(trimmed) === undefined) {
      return trimmed;
    }
  }
}

/**
 * Runs the first-run non-secret configuration flow: Base URL, Model, and
 * permission mode. Returns `null` when cancelled or declined; cancellation is
 * never treated as consent. API Key is never requested or saved here.
 */
export async function runSetup(deps: SetupDeps): Promise<PersistedConfigV1 | null> {
  const baseURL = await askValue(
    deps.prompt,
    "Base URL",
    deps.defaults?.baseURL,
    validateURL,
  );
  if (baseURL === null) {
    return null;
  }

  const model = await askValue(
    deps.prompt,
    "Model",
    deps.defaults?.model,
    validateModel,
  );
  if (model === null) {
    return null;
  }

  const mode = await askValue(
    deps.prompt,
    "Permission mode (balanced|cautious)",
    deps.defaults?.permissionMode,
    validateMode,
  );
  if (mode === null) {
    return null;
  }

  const config: PersistedConfigV1 = {
    schemaVersion: 1,
    baseURL: baseURL.trim(),
    model: model.trim(),
    permissionMode: mode as PermissionMode,
  };

  const approved = await deps.prompt.confirm(
    "Save this configuration?\n" +
      `  Base URL: ${config.baseURL}\n` +
      `  Model: ${config.model}\n` +
      `  Permission mode: ${config.permissionMode}`,
  );
  if (!approved) {
    return null;
  }

  await deps.store.save(config);
  return config;
}
