import { describe, expect, test } from "vitest";
import path from "node:path";

import { resolveAppPaths } from "../../../src/storage/paths.js";

describe("resolveAppPaths", () => {
  test("NJU_AGENT_HOME overrides the default application home", () => {
    const paths = resolveAppPaths({ NJU_AGENT_HOME: "/tmp/custom-home" }, "/users/demo");
    expect(paths).toEqual({
      root: path.resolve("/tmp/custom-home"),
      configFile: path.resolve("/tmp/custom-home/config.json"),
      sessionsDirectory: path.resolve("/tmp/custom-home/sessions"),
      userSkillsDirectory: path.resolve("/tmp/custom-home/skills"),
    });
  });

  test("default home is ~/.nju-agent", () => {
    expect(resolveAppPaths({}, "/users/demo").root).toBe("/users/demo/.nju-agent");
  });
});
