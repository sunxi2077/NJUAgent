import { describe, expect, test } from "vitest";

import { HELP_TEXT, isHelpRequest } from "../../../src/cli/help.js";

describe("CLI help", () => {
  test.each(["--help", "-h"])("recognizes %s", (arg) => {
    expect(isHelpRequest([arg])).toBe(true);
  });

  test("recognizes help alongside other flags", () => {
    expect(isHelpRequest(["--debug", "--help"])).toBe(true);
  });

  test("does not treat ordinary run arguments as help", () => {
    expect(isHelpRequest(["--workspace", "."])).toBe(false);
  });

  test("documents run syntax, flags, required environment, and exit", () => {
    expect(HELP_TEXT).toContain("Usage:");
    expect(HELP_TEXT).toContain("njuagent [path]");
    expect(HELP_TEXT).toContain("--workspace");
    expect(HELP_TEXT).toContain("--permission-mode");
    expect(HELP_TEXT).toContain("ANTHROPIC_API_KEY");
    expect(HELP_TEXT).toContain("NJU_AGENT_HOME");
    expect(HELP_TEXT).toContain("NO_COLOR");
    expect(HELP_TEXT).toContain("MODEL_INPUT_COST_PER_MTOKENS");
    expect(HELP_TEXT).toContain("MODEL_OUTPUT_COST_PER_MTOKENS");
    expect(HELP_TEXT).toContain("/exit");
  });
});
