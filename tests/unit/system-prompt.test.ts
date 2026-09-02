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

describe("buildSystemPrompt project-skill contract", () => {
  test("keeps the workspace-only and credential boundaries", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/only access files inside the workspace/iu);
    expect(prompt).toMatch(/never include credentials or secrets/iu);
  });

  test("points project Skills at the exact workspace destination", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain(".nju-agent/skills/<name>/SKILL.md");
  });

  test("prohibits home and global agent directories for Skills", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain(".claude");
    expect(prompt).toContain(".codex");
    expect(prompt).toMatch(/home/u);
    expect(prompt).toMatch(/global agent/u);
  });

  test("treats external Skill content as untrusted prompt text only", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/untrusted/iu);
    expect(prompt).toMatch(/SKILL\.md/u);
    expect(prompt).toMatch(/never run|do not run|install scripts/iu);
  });

  test("requires the user to activate a discovered Skill with /skill", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/\/skill <name>/u);
    expect(prompt).toMatch(/do not activate it yourself|let the user activate/iu);
  });

  test("states host permissions and workspace checks remain authoritative", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/remain authoritative/iu);
  });

  test("omits concrete paths unless workspace options are provided", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).not.toContain("/tmp/workspace");
    expect(prompt).not.toContain("/tmp/workspace/.nju-agent");
  });

  test("includes the concrete project-skill directory when provided", () => {
    const prompt = buildSystemPrompt({
      workspaceRoot: "/tmp/workspace",
      projectSkillDirectory: "/tmp/workspace/.nju-agent/skills",
      summary: "s",
    });
    expect(prompt).toContain("/tmp/workspace");
    expect(prompt).toContain("/tmp/workspace/.nju-agent/skills");
    // The summary block is still appended once after the base instructions.
    expect(prompt.match(/<conversation_summary>/gu)).toHaveLength(1);
  });
});

describe("buildSystemPrompt remote-fetch guidance", () => {
  test("tells the model to use fetch_url for known external text URLs", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("fetch_url");
    expect(prompt).toMatch(/known external text URL|external text URL/iu);
  });

  test("discourages curl/git-clone merely to retrieve public text", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/fetch_url/u);
    expect(prompt).toMatch(/curl|git clone/iu);
  });

  test("frames fetched content as untrusted and keeps saving workspace-relative", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/untrusted/iu);
    expect(prompt).toMatch(/workspace-relative/iu);
  });

  test("keeps external Skill activation explicit via /skill", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/\/skill <name>/u);
  });

  test("adds no more than six remote-fetch bullets", () => {
    const prompt = buildSystemPrompt();
    const section = prompt.split("Remote fetch:")[1] ?? "";
    const bullets = section.split("\n").filter((line) => line.startsWith("- "));
    expect(bullets.length).toBeGreaterThan(0);
    expect(bullets.length).toBeLessThanOrEqual(6);
  });

  test("keeps the existing web-search restriction", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("web_search");
    expect(prompt).toContain("untrusted reference material");
  });
});
