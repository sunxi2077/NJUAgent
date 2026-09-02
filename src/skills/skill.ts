import { AppError } from "../errors/app-error.js";

export type SkillSource = "user" | "project";

export type Skill = {
  name: string;
  description: string;
  instructions: string;
  source: SkillSource;
  filePath: string;
};

export const MAX_SKILL_BYTES = 32 * 1024;
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

const MAX_DESCRIPTION_CODE_POINTS = 300;

function invalidSkill(directoryName: string, reason: string): AppError {
  return new AppError({
    code: "SKILL_INVALID",
    userMessage: `Invalid SKILL.md for ${directoryName}: ${reason}`,
  });
}

/**
 * Parses a deliberately minimal, documented SKILL.md format: a frontmatter
 * block between two exactly `---` lines containing only `name` and
 * `description` keys, followed by the instructions body. It is not general
 * YAML: quotes, arrays, nested values, folded blocks, interpolation, and
 * comments are unsupported and rejected.
 */
export function parseSkillFile(input: {
  text: string;
  byteLength: number;
  directoryName: string;
  source: SkillSource;
  filePath: string;
}): Skill {
  const { text, byteLength, directoryName, source, filePath } = input;
  if (byteLength > MAX_SKILL_BYTES) {
    throw invalidSkill(directoryName, "file exceeds the size limit");
  }

  const normalized = text.replace(/\r\n/gu, "\n");
  const lines = normalized.split("\n");
  if ((lines[0] ?? "").trim() !== "---") {
    throw invalidSkill(directoryName, "missing opening delimiter");
  }
  const closeOffset = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (closeOffset < 0) {
    throw invalidSkill(directoryName, "missing closing delimiter");
  }
  const frontmatter = lines.slice(1, 1 + closeOffset);
  const body = lines.slice(2 + closeOffset).join("\n").trim();
  if (body === "") {
    throw invalidSkill(directoryName, "empty instructions");
  }

  let name: string | undefined;
  let description: string | undefined;
  let license: string | undefined;
  for (const line of frontmatter) {
    if (line.trim() === "") {
      continue;
    }
    if (/^\s/u.test(line)) {
      throw invalidSkill(directoryName, "multiline scalar is not supported");
    }
    const colon = line.indexOf(":");
    if (colon < 0) {
      throw invalidSkill(directoryName, "unknown field");
    }
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key === "name") {
      if (name !== undefined) {
        throw invalidSkill(directoryName, "duplicate name field");
      }
      name = value;
    } else if (key === "description") {
      if (description !== undefined) {
        throw invalidSkill(directoryName, "duplicate description field");
      }
      description = value;
    } else if (key === "license") {
      // Official Skills carry `license` as documentation-only metadata. It is
      // permitted once, must be a non-empty single-line value, and is never
      // injected into the active skill instructions.
      if (license !== undefined) {
        throw invalidSkill(directoryName, "duplicate license field");
      }
      if (value === "") {
        throw invalidSkill(directoryName, "blank license field");
      }
      license = value;
    } else {
      throw invalidSkill(directoryName, `unknown field: ${key}`);
    }
  }

  if (name === undefined) {
    throw invalidSkill(directoryName, "missing name");
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw invalidSkill(directoryName, "invalid name");
  }
  if (name !== directoryName) {
    throw invalidSkill(directoryName, "name does not match the directory");
  }
  if (description === undefined || description === "") {
    throw invalidSkill(directoryName, "blank description");
  }
  if ([...description].length > MAX_DESCRIPTION_CODE_POINTS) {
    throw invalidSkill(directoryName, "description too long");
  }

  return { name, description, instructions: body, source, filePath };
}
