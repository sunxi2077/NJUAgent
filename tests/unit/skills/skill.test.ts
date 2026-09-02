import { describe, expect, test } from "vitest";

import {
  MAX_SKILL_BYTES,
  parseSkillFile,
  SKILL_NAME_PATTERN,
} from "../../../src/skills/skill.js";

const fixture = `---
name: test-first
description: Require a focused failing test before implementation.
---

# Test First

Write one focused failing test, observe the failure, then implement.
`;

function parse(overrides: Partial<Parameters<typeof parseSkillFile>[0]> = {}) {
  return parseSkillFile({
    text: fixture,
    byteLength: Buffer.byteLength(fixture, "utf8"),
    directoryName: "test-first",
    source: "user",
    filePath: "/root/test-first/SKILL.md",
    ...overrides,
  });
}

describe("SKILL_NAME_PATTERN", () => {
  test("accepts valid lowercase names", () => {
    expect(SKILL_NAME_PATTERN.test("test-first")).toBe(true);
    expect(SKILL_NAME_PATTERN.test("a")).toBe(true);
    expect(SKILL_NAME_PATTERN.test("a1-b2")).toBe(true);
  });

  test("rejects invalid names", () => {
    expect(SKILL_NAME_PATTERN.test("Test-first")).toBe(false);
    expect(SKILL_NAME_PATTERN.test("-first")).toBe(false);
    expect(SKILL_NAME_PATTERN.test("x".repeat(65))).toBe(false);
  });
});

describe("parseSkillFile", () => {
  test("parses metadata and preserves the body", () => {
    const skill = parse();
    expect(skill).toEqual({
      name: "test-first",
      description: "Require a focused failing test before implementation.",
      instructions: "# Test First\n\nWrite one focused failing test, observe the failure, then implement.",
      source: "user",
      filePath: "/root/test-first/SKILL.md",
    });
  });

  test.each([
    ["missing opening delimiter", { text: "name: x\n---\nbody\n" }],
    ["missing closing delimiter", { text: "---\nname: x\nbody\n" }],
    ["blank body", { text: "---\nname: x\ndescription: d\n---\n\n\n" }],
    ["missing name", { text: "---\ndescription: d\n---\nbody\n" }],
    ["duplicate name", { text: "---\nname: a\nname: b\ndescription: d\n---\nbody\n" }],
    ["unknown field", { text: "---\nname: a\ndescription: d\nversion: 2\n---\nbody\n" }],
    ["invalid name", { text: "---\nname: Bad Name\ndescription: d\n---\nbody\n" }],
    ["directory-name mismatch", { text: "---\nname: other-name\ndescription: d\n---\nbody\n" }],
    ["blank description", { text: "---\nname: test-first\ndescription:  \n---\nbody\n" }],
  ])("rejects %s with SKILL_INVALID", (_label, overrides) => {
    let error: unknown;
    try {
      parse(overrides as Partial<Parameters<typeof parseSkillFile>[0]>);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "SKILL_INVALID" });
    expect(String(error)).not.toContain("body");
    expect(String(error)).toContain("test-first");
  });

  test("rejects a description over 300 characters", () => {
    let error: unknown;
    try {
      parse({ text: fixture.replace("Require a focused failing test before implementation.", "x".repeat(301)) });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "SKILL_INVALID" });
  });

  test("rejects content over the byte limit", () => {
    let error: unknown;
    try {
      parse({ byteLength: MAX_SKILL_BYTES + 1 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "SKILL_INVALID" });
  });

  test("rejects a multiline scalar description", () => {
    const text = "---\nname: test-first\ndescription: line1\n  continued\n---\nbody\n";
    let error: unknown;
    try {
      parse({ text });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "SKILL_INVALID" });
  });

  test("accepts an official frontmatter with an optional license field", () => {
    const text = `---
name: frontend-design
description: Guidance for distinctive, intentional visual design.
license: Complete terms in LICENSE.txt
---

Follow the design system.
`;
    const skill = parse({
      text,
      byteLength: Buffer.byteLength(text, "utf8"),
      directoryName: "frontend-design",
      filePath: "/root/frontend-design/SKILL.md",
    });
    expect(skill.name).toBe("frontend-design");
    expect(skill.description).toBe("Guidance for distinctive, intentional visual design.");
    // license is metadata only and is never part of the instructions.
    expect(skill.instructions).toBe("Follow the design system.");
    expect(skill.instructions).not.toContain("license");
  });

  test("an unknown field still throws with the field named", () => {
    const text = "---\nname: test-first\ndescription: d\nversion: 2\n---\nbody\n";
    let error: unknown;
    try {
      parse({ text });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "SKILL_INVALID" });
    expect(String(error)).toContain("unknown field: version");
  });

  test.each([
    ["blank license", "license:  \n"],
    ["duplicate license", "license: MIT\nlicense: Apache-2.0\n"],
  ])("rejects %s", (_label, licenseLines) => {
    const text = `---\nname: test-first\ndescription: d\n${licenseLines}---\nbody\n`;
    let error: unknown;
    try {
      parse({ text });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "SKILL_INVALID" });
  });
});
