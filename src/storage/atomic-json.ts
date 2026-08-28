import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Atomically writes a JSON document: write to a same-directory temporary file
 * with restrictive permissions, then rename over the target. On failure the
 * validated temporary path is unlinked and the original error is rethrown.
 */
export async function writeJsonAtomic(
  target: string,
  value: unknown,
): Promise<void> {
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.tmp-${randomUUID()}`);
  try {
    await writeFile(
      temporary,
      `${JSON.stringify(value, null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    await rename(temporary, target);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {
      // The temporary file may never have been created; ignore cleanup errors.
    }
    throw error;
  }
}
