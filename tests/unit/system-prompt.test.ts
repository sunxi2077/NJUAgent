import { describe, expect, test } from "vitest";

import { buildSystemPrompt } from "../../src/agent/system-prompt.js";

describe("buildSystemPrompt", () => {
  test("asks the model to run relevant tests or builds after changing code", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/test|build/u);
    expect(prompt).toMatch(/after changing|after modifying|then run/iu);
  });

  test("requires truthful reporting of changes and verification results", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/truthful|truthfully|honest/u);
    expect(prompt).toMatch(/what.*changed|changed/u);
    expect(prompt).toMatch(/verif|pass|fail/u);
  });

  test("prefers minimal, focused edits after understanding existing code", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/minimal|small|focused/u);
    expect(prompt).toMatch(/understand|existing/u);
  });

  test("does not ask the model to enforce safety on its own", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/workspace/u);
  });

  test("instructs the model to plan complex work and mark steps honestly", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/plan_write/u);
    expect(prompt).toMatch(/in_progress/u);
    expect(prompt).toMatch(/never mark an unfinished step as completed/u);
  });

  test("discourages redundant external tools and consecutive parse commands", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/do not call additional external tools/u);
    expect(prompt).toMatch(/view and parse the same result/u);
    expect(prompt).toMatch(/single command/u);
  });
});

describe("buildSystemPrompt summary layer", () => {
  test("has no summary marker when absent", () => {
    expect(buildSystemPrompt()).not.toContain("<conversation_summary>");
  });

  test("emits exactly one delimited summary block when present", () => {
    const prompt = buildSystemPrompt({ summary: "Fixed the parser; tests pass." });
    expect(prompt.match(/<conversation_summary>/gu)).toHaveLength(1);
    expect(prompt.match(/<\/conversation_summary>/gu)).toHaveLength(1);
    expect(prompt).toContain("Fixed the parser; tests pass.");
    // Base safety/workspace instructions remain before the summary.
    expect(prompt.indexOf("Boundaries:")).toBeLessThan(prompt.indexOf("<conversation_summary>"));
  });
});
