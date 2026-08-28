import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { AppError } from "../errors/app-error.js";
import { writeJsonAtomic } from "../storage/atomic-json.js";
import { parseSession, type PersistedSessionV1 } from "./session-schema.js";

export type SessionListEntry = {
  id: string;
  title: string;
  workspaceRoot: string;
  modelId: string;
  updatedAt: string;
};

export type SessionDiagnostic = { file: string; message: string };

const FILE_PATTERN = /^[0-9a-f-]{36}\.json$/i;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/**
 * Stores one versioned JSON file per session UUID under a dedicated
 * directory. Corrupt files are isolated in `list()` diagnostics; an injected
 * atomic writer lets tests prove failed saves never damage existing files.
 */
export class SessionStore {
  constructor(
    private readonly directory: string,
    private readonly atomicWrite: typeof writeJsonAtomic = writeJsonAtomic,
  ) {}

  async save(session: PersistedSessionV1): Promise<void> {
    const file = this.#fileFor(session.id);
    try {
      await this.atomicWrite(file, session);
    } catch (error) {
      throw new AppError({
        code: "SESSION_IO",
        userMessage: "Could not save the session file.",
        cause: error,
      });
    }
  }

  async load(id: string): Promise<PersistedSessionV1> {
    const file = this.#fileFor(id);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if (isMissing(error)) {
        throw new AppError({
          code: "SESSION_CORRUPT",
          userMessage: `No session matches ${id}`,
          cause: error,
        });
      }
      throw new AppError({
        code: "SESSION_IO",
        userMessage: "Could not read the session file.",
        cause: error,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new AppError({
        code: "SESSION_CORRUPT",
        userMessage: `Session file is not valid JSON: ${id}`,
        cause: error,
      });
    }
    return parseSession(parsed);
  }

  async list(): Promise<{
    sessions: SessionListEntry[];
    diagnostics: SessionDiagnostic[];
  }> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (isMissing(error)) {
        return { sessions: [], diagnostics: [] };
      }
      throw new AppError({
        code: "SESSION_IO",
        userMessage: "Could not list session files.",
        cause: error,
      });
    }

    const sessions: SessionListEntry[] = [];
    const diagnostics: SessionDiagnostic[] = [];
    for (const name of names) {
      if (!FILE_PATTERN.test(name)) {
        continue;
      }
      const id = name.slice(0, -".json".length);
      try {
        const loaded = await this.load(id);
        sessions.push({
          id: loaded.id,
          title: loaded.title,
          workspaceRoot: loaded.workspaceRoot,
          modelId: loaded.modelId,
          updatedAt: loaded.updatedAt,
        });
      } catch (error) {
        diagnostics.push({
          file: name,
          message: error instanceof AppError ? error.userMessage : String(error),
        });
      }
    }
    sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return { sessions, diagnostics };
  }

  async resolveId(prefix: string): Promise<string> {
    const { sessions } = await this.list();
    const lower = prefix.toLowerCase();
    const matches = sessions.filter(
      (entry) =>
        entry.id === prefix || entry.id.toLowerCase().startsWith(lower),
    );
    if (matches.length === 0) {
      throw new AppError({
        code: "SESSION_CORRUPT",
        userMessage: `No session matches ${prefix}`,
      });
    }
    if (matches.length > 1) {
      throw new AppError({
        code: "SESSION_CORRUPT",
        userMessage:
          `Multiple sessions match ${prefix}: ` +
          matches.map((entry) => entry.id.slice(0, 13)).join(", "),
      });
    }
    return matches[0]!.id;
  }

  #fileFor(id: string): string {
    if (!UUID_PATTERN.test(id)) {
      throw new AppError({
        code: "SESSION_CORRUPT",
        userMessage: `Invalid session id: ${id}`,
      });
    }
    return path.join(this.directory, `${id}.json`);
  }
}
