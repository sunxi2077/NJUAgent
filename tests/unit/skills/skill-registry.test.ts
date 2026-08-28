import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { SkillRegistry } from "../../../src/skills/skill-registry.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "nju-skills-reg-"));
  temporaryDirectories.push(dir);
  return dir;
}

async function writeSkill(root: string, name: string, description: string): Promise<void> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nbody for ${name}\n`,
    "utf8",
  );
}

describe("SkillRegistry", () => {
  test("project overrides a valid same-name user skill", async () => {
    const user = await tempRoot();
    const project = await tempRoot();
    await writeSkill(user, "fmt", "user fmt");
    await writeSkill(project, "fmt", "project fmt");
    await writeSkill(user, "only-user", "only user");

    const registry = new SkillRegistry(user, project);
    const result = await registry.refresh();

    const names = registry.list().map((skill) => skill.name);
    expect(names).toContain("only-user");
    const resolved = registry.resolve("fmt");
    expect(resolved?.source).toBe("project");
    expect(resolved?.description).toBe("project fmt");
    expect(result.diagnostics).toEqual([]);
  });

  test("an invalid project duplicate does not erase the valid user skill", async () => {
    const user = await tempRoot();
    const project = await tempRoot();
    await writeSkill(user, "fmt", "user fmt");
    await mkdir(path.join(project, "fmt"), { recursive: true });
    await writeFile(path.join(project, "fmt", "SKILL.md"), "broken", "utf8");

    const registry = new SkillRegistry(user, project);
    await registry.refresh();

    const resolved = registry.resolve("fmt");
    expect(resolved?.source).toBe("user");
    expect(resolved?.description).toBe("user fmt");
    expect(registry.diagnostics().some((d) => d.name === "fmt")).toBe(true);
  });

  test("refresh replaces the snapshot atomically after both loads", async () => {
    const user = await tempRoot();
    const project = await tempRoot();
    await writeSkill(user, "a", "user a");
    const registry = new SkillRegistry(user, project);
    await registry.refresh();
    expect(registry.list().map((s) => s.name)).toEqual(["a"]);

    await writeSkill(project, "b", "project b");
    await registry.refresh();
    expect(registry.list().map((s) => s.name)).toEqual(["a", "b"]);
  });

  test("list returns a defensive copy that cannot mutate registry state", async () => {
    const user = await tempRoot();
    await writeSkill(user, "a", "user a");
    const registry = new SkillRegistry(user, user);
    await registry.refresh();
    const copy = registry.list();
    copy[0]!.name = "mutated";
    expect(registry.list()[0]!.name).toBe("a");
  });
});
