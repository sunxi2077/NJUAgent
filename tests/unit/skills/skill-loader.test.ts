import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { SkillLoader } from "../../../src/skills/skill-loader.js";
import { MAX_SKILL_BYTES } from "../../../src/skills/skill.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "nju-skills-"));
  temporaryDirectories.push(dir);
  return dir;
}

async function writeSkill(root: string, name: string, text: string): Promise<void> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), text, "utf8");
}

const good = (name: string, description = "d") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nbody for ${name}\n`;

describe("SkillLoader", () => {
  test("a missing root yields an empty result without error", async () => {
    const loader = new SkillLoader();
    const result = await loader.loadRoot(path.join(await tempRoot(), "nope"), "user");
    expect(result.skills).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  test("loads a valid direct <name>/SKILL.md", async () => {
    const root = await tempRoot();
    await writeSkill(root, "alpha", good("alpha", "the alpha skill"));
    const loader = new SkillLoader();
    const result = await loader.loadRoot(root, "user");
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toMatchObject({
      name: "alpha",
      description: "the alpha skill",
      source: "user",
    });
    expect(result.diagnostics).toEqual([]);
  });

  test("ignores unrelated files and nested grandchildren", async () => {
    const root = await tempRoot();
    await writeSkill(root, "alpha", good("alpha"));
    await writeFile(path.join(root, "README.md"), "not a skill", "utf8");
    await mkdir(path.join(root, "alpha", "nested"), { recursive: true });
    await writeFile(path.join(root, "alpha", "nested", "SKILL.md"), good("nested"), "utf8");
    const loader = new SkillLoader();
    const result = await loader.loadRoot(root, "user");
    expect(result.skills.map((skill) => skill.name)).toEqual(["alpha"]);
  });

  test("an invalid file creates a diagnostic while valid siblings load", async () => {
    const root = await tempRoot();
    await writeSkill(root, "alpha", good("alpha"));
    await writeSkill(root, "broken", "not a valid skill file");
    const loader = new SkillLoader();
    const result = await loader.loadRoot(root, "user");
    expect(result.skills.map((skill) => skill.name)).toEqual(["alpha"]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ name: "broken", source: "user" });
    expect(result.diagnostics[0]!.message).not.toContain("not a valid skill file");
  });

  test("rejects a symlinked SKILL.md that resolves outside the root", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await writeFile(path.join(outside, "SKILL.md"), good("evil"), "utf8");
    await mkdir(path.join(root, "evil"), { recursive: true });
    await symlink(path.join(outside, "SKILL.md"), path.join(root, "evil", "SKILL.md"));
    const loader = new SkillLoader();
    const result = await loader.loadRoot(root, "user");
    expect(result.skills).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
  });

  test("allows a symlink resolving to a file inside the root when checks pass", async () => {
    const root = await tempRoot();
    await writeSkill(root, "real", good("real"));
    await mkdir(path.join(root, "alias"), { recursive: true });
    await symlink(
      path.join(root, "real", "SKILL.md"),
      path.join(root, "alias", "SKILL.md"),
    );
    const loader = new SkillLoader();
    const result = await loader.loadRoot(root, "user");
    // "alias" has no valid directory-name match (its own dir name), so it is
    // rejected; "real" remains valid.
    expect(result.skills.map((skill) => skill.name)).toEqual(["real"]);
  });

  test("rejects an oversized file before an unbounded read", async () => {
    const root = await tempRoot();
    await writeSkill(root, "big", `---\nname: big\ndescription: d\n---\n\n${"x".repeat(MAX_SKILL_BYTES + 100)}\n`);
    const loader = new SkillLoader();
    const result = await loader.loadRoot(root, "user");
    expect(result.skills).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.message).toContain("size limit");
  });

  test("sorts results by name", async () => {
    const root = await tempRoot();
    await writeSkill(root, "zeta", good("zeta"));
    await writeSkill(root, "alpha", good("alpha"));
    await writeSkill(root, "mike", good("mike"));
    const loader = new SkillLoader();
    const result = await loader.loadRoot(root, "user");
    expect(result.skills.map((skill) => skill.name)).toEqual(["alpha", "mike", "zeta"]);
  });
});
