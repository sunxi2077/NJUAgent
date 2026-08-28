import { SkillLoader, type SkillDiagnostic, type SkillLoadResult } from "./skill-loader.js";
import type { Skill } from "./skill.js";

/**
 * Refreshes the user/project skill snapshots with deterministic project
 * precedence and atomic replacement: both roots load before the snapshot
 * fields are swapped, and all returned arrays are defensive copies.
 */
export class SkillRegistry {
  readonly #userRoot: string;
  readonly #projectRoot: string;
  readonly #loader: SkillLoader;
  #skills: Skill[] = [];
  #diagnostics: SkillDiagnostic[] = [];

  constructor(userRoot: string, projectRoot: string, loader?: SkillLoader) {
    this.#userRoot = userRoot;
    this.#projectRoot = projectRoot;
    this.#loader = loader ?? new SkillLoader();
  }

  async refresh(): Promise<SkillLoadResult> {
    const [userResult, projectResult] = await Promise.all([
      this.#loader.loadRoot(this.#userRoot, "user"),
      this.#loader.loadRoot(this.#projectRoot, "project"),
    ]);

    const merged = new Map<string, Skill>();
    for (const skill of userResult.skills) {
      merged.set(skill.name, skill);
    }
    // Project entries override user entries with the same valid name.
    for (const skill of projectResult.skills) {
      merged.set(skill.name, skill);
    }

    this.#skills = [...merged.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    this.#diagnostics = [...userResult.diagnostics, ...projectResult.diagnostics];
    return { skills: [...this.#skills], diagnostics: [...this.#diagnostics] };
  }

  list(): readonly Skill[] {
    return this.#skills.map((skill) => structuredClone(skill));
  }

  resolve(name: string): Skill | undefined {
    const found = this.#skills.find((skill) => skill.name === name);
    return found === undefined ? undefined : structuredClone(found);
  }

  diagnostics(): readonly SkillDiagnostic[] {
    return [...this.#diagnostics];
  }
}
