import path from "node:path";

export type AppPaths = {
  root: string;
  configFile: string;
  sessionsDirectory: string;
  userSkillsDirectory: string;
};

/**
 * Resolves the application home and derived paths. The `NJU_AGENT_HOME`
 * environment variable overrides the default `~/.nju-agent`; tests inject a
 * temporary root and never touch the developer's real home.
 */
export function resolveAppPaths(
  env: NodeJS.ProcessEnv,
  homeDirectory: string,
): AppPaths {
  const override = env.NJU_AGENT_HOME;
  const root = path.resolve(override ?? path.join(homeDirectory, ".nju-agent"));
  return {
    root,
    configFile: path.join(root, "config.json"),
    sessionsDirectory: path.join(root, "sessions"),
    userSkillsDirectory: path.join(root, "skills"),
  };
}
