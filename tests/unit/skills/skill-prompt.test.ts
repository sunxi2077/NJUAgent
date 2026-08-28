import { describe, expect, test } from "vitest";

import { buildLayeredSystemPrompt } from "../../../src/skills/skill-prompt.js";

const skill = {
  name: "test-first",
  instructions: "Write a failing test first.",
  source: "project" as const,
};

describe("buildLayeredSystemPrompt", () => {
  test("base prompt always exists", () => {
    expect(buildLayeredSystemPrompt({})).toContain("NJUAgent");
  });

  test("no empty tags when both layers are absent", () => {
    const prompt = buildLayeredSystemPrompt({});
    expect(prompt).not.toContain("<active_skill");
    expect(prompt).not.toContain("<conversation_summary>");
  });

  test("skill appears after base and before summary", () => {
    const prompt = buildLayeredSystemPrompt({
      skill,
      summary: "the summary text",
    });
    const baseIndex = prompt.indexOf("NJUAgent");
    const skillIndex = prompt.indexOf("<active_skill");
    const summaryIndex = prompt.indexOf("<conversation_summary>");
    expect(baseIndex).toBeGreaterThanOrEqual(0);
    expect(skillIndex).toBeGreaterThan(baseIndex);
    expect(summaryIndex).toBeGreaterThan(skillIndex);
  });

  test("emits exactly one skill and one summary block", () => {
    const prompt = buildLayeredSystemPrompt({ skill, summary: "s" });
    expect(prompt.match(/<active_skill name="test-first" source="project">/gu)).toHaveLength(1);
    expect(prompt.match(/<\/active_skill>/gu)).toHaveLength(1);
    expect(prompt.match(/<conversation_summary>/gu)).toHaveLength(1);
    expect(prompt.match(/<\/conversation_summary>/gu)).toHaveLength(1);
  });

  test("preserves instructions and summary text", () => {
    const prompt = buildLayeredSystemPrompt({ skill, summary: "Fixed parser" });
    expect(prompt).toContain("Write a failing test first.");
    expect(prompt).toContain("Fixed parser");
  });

  test("skill text cannot remove or replace the base prompt", () => {
    const prompt = buildLayeredSystemPrompt({ skill });
    expect(prompt).toContain("Only access files inside the workspace");
    expect(prompt.indexOf("Only access files")).toBeLessThan(prompt.indexOf("<active_skill"));
  });

  test("output is deterministic", () => {
    const first = buildLayeredSystemPrompt({ skill, summary: "s" });
    const second = buildLayeredSystemPrompt({ skill, summary: "s" });
    expect(first).toBe(second);
  });

  test("host permissions note precedes the skill layer", () => {
    const prompt = buildLayeredSystemPrompt({ skill });
    expect(prompt.indexOf("remain authoritative")).toBeGreaterThan(0);
    expect(prompt.indexOf("remain authoritative")).toBeLessThan(
      prompt.indexOf("<active_skill"),
    );
  });
});
