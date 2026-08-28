import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { AppError, isAppError } from "../errors/app-error.js";
import { MAX_SKILL_BYTES, parseSkillFile, type Skill, type SkillSource } from "./skill.js";

export type SkillDiagnostic = {
  source: SkillSource;
  name: string;
  message: string;
};

export type SkillLoadResult = {
  skills: readonly Skill[];
  diagnostics: readonly SkillDiagnostic[];
};

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/**
 * Discovers direct `<name>/SKILL.md` files under a single canonical root.
 * Symlink escape is rejected via `realpath`; oversized files are rejected from
 * `stat.size` before any read; per-file failures become diagnostics.
 */
export class SkillLoader {
  async loadRoot(root: string, source: SkillSource): Promise<SkillLoadResult> {
    const skills: Skill[] = [];
    const diagnostics: SkillDiagnostic[] = [];

    let rootReal: string;
    let entries;
    try {
      rootReal = await realpath(root);
      entries = await readdir(rootReal, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) {
        return { skills: [], diagnostics: [] };
      }
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const directoryPath = path.join(rootReal, entry.name);
      const skillPath = path.join(directoryPath, "SKILL.md");
      try {
        const stats = await stat(skillPath);
        if (!stats.isFile()) {
          continue;
        }
        if (stats.size > MAX_SKILL_BYTES) {
          diagnostics.push({
            source,
            name: entry.name,
            message: `SKILL.md for ${entry.name} exceeds the size limit`,
          });
          continue;
        }
        const fileReal = await realpath(skillPath);
        const relative = path.relative(rootReal, fileReal);
        if (
          relative === "" ||
          relative.startsWith("..") ||
          path.isAbsolute(relative)
        ) {
          diagnostics.push({
            source,
            name: entry.name,
            message: `SKILL.md for ${entry.name} resolves outside the skill root`,
          });
          continue;
        }
        const text = await readFile(skillPath, "utf8");
        skills.push(
          parseSkillFile({
            text,
            byteLength: stats.size,
            directoryName: entry.name,
            source,
            filePath: fileReal,
          }),
        );
      } catch (error) {
        if (isAppError(error) && error.code === "SKILL_INVALID") {
          diagnostics.push({ source, name: entry.name, message: error.userMessage });
        } else {
          diagnostics.push({
            source,
            name: entry.name,
            message: `Could not read SKILL.md for ${entry.name}`,
          });
        }
      }
    }

    skills.sort((left, right) => left.name.localeCompare(right.name));
    return { skills, diagnostics };
  }
}
