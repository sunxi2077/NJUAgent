import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { Ajv, type AnySchema } from "ajv";

import { AppError } from "../errors/app-error.js";
import { writeJsonAtomic } from "./atomic-json.js";

export type PersistedConfigV1 = {
  schemaVersion: 1;
  baseURL: string;
  model: string;
  permissionMode: "balanced" | "cautious" | "trusted";
};

const CONFIG_SCHEMA = {
  type: "object",
  properties: {
    schemaVersion: { const: 1 },
    baseURL: { type: "string", pattern: "\\S" },
    model: { type: "string", pattern: "\\S" },
    permissionMode: { enum: ["balanced", "cautious", "trusted"] },
  },
  required: ["schemaVersion", "baseURL", "model", "permissionMode"],
  additionalProperties: false,
} as const;

export class ConfigStore {
  readonly #file: string;
  readonly #atomicWrite: typeof writeJsonAtomic;
  readonly #validate: (value: unknown) => boolean;
  readonly #ajv: Ajv;

  constructor(
    file: string,
    atomicWrite: typeof writeJsonAtomic = writeJsonAtomic,
  ) {
    this.#file = file;
    this.#atomicWrite = atomicWrite;
    this.#ajv = new Ajv({ allErrors: true });
    this.#validate = this.#ajv.compile(CONFIG_SCHEMA as AnySchema);
  }

  async load(): Promise<PersistedConfigV1 | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.#file, "utf8");
    } catch (error) {
      if (await this.#isMissingFile(error)) {
        return undefined;
      }
      throw this.#wrap(error, "Could not read the agent configuration file.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw this.#wrap(error, "The agent configuration file is not valid JSON.");
    }

    if (!this.#validate(parsed)) {
      throw this.#wrap(
        new Error(this.#ajv.errorsText(this.#ajv.errors, { separator: "; " })),
        "The agent configuration file is invalid or contains unknown fields.",
      );
    }
    const config = parsed as PersistedConfigV1;
    return {
      schemaVersion: 1,
      baseURL: config.baseURL.trim(),
      model: config.model.trim(),
      permissionMode: config.permissionMode,
    };
  }

  async save(config: PersistedConfigV1): Promise<void> {
    try {
      await this.#atomicWrite(this.#file, config);
    } catch (error) {
      throw this.#wrap(error, "Could not save the agent configuration file.");
    }
  }

  /**
   * ENOENT counts as "no config yet" when the file is genuinely absent: the
   * parent directory is missing (first run) or exists as a directory. An
   * unreadable path structure (e.g. the parent is a file) is an I/O failure.
   */
  async #isMissingFile(error: unknown): Promise<boolean> {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      return false;
    }
    try {
      const stats = await stat(path.dirname(this.#file));
      return stats.isDirectory();
    } catch {
      return true;
    }
  }

  #wrap(error: unknown, remediation: string): AppError {
    const detail = error instanceof Error ? error.message : String(error);
    return new AppError({
      code: "CONFIG_INVALID",
      userMessage: `${remediation} ${detail}`,
      cause: error,
    });
  }
}
