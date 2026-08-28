import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { writeJsonAtomic } from "../../../src/storage/atomic-json.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "nju-atomic-json-"));
  temporaryDirectories.push(dir);
  return dir;
}

describe("writeJsonAtomic", () => {
  test("writes a readable JSON document into a new parent directory", async () => {
    const dir = await tempDir();
    const target = path.join(dir, "nested", "config.json");
    await writeJsonAtomic(target, { schemaVersion: 1, model: "m" });

    const text = await readFile(target, "utf8");
    expect(JSON.parse(text)).toEqual({ schemaVersion: 1, model: "m" });
  });

  test("writes the file with restrictive permissions on POSIX", async () => {
    const dir = await tempDir();
    const target = path.join(dir, "config.json");
    await writeJsonAtomic(target, { a: 1 });
    const stats = await stat(target);
    // 0o600 -> owner read/write only.
    expect(stats.mode & 0o777).toBe(0o600);
  });

  test("cleans up its temporary file and rethrows when the target cannot be written", async () => {
    const dir = await tempDir();
    const target = path.join(dir, "blocked", "config.json");
    // A file at the parent path makes the mkdir step fail.
    await writeJsonAtomic(path.join(dir, "blocked"), { occupied: true });

    await expect(writeJsonAtomic(target, { x: 1 })).rejects.toThrow();
    const entries = await (await import("node:fs/promises")).readdir(dir);
    expect(entries.some((entry) => entry.includes(".tmp-"))).toBe(false);
  });
});
