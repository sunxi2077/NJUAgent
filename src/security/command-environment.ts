const COMMAND_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "CI",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
] as const;

/**
 * Builds the deliberately small environment passed to shell commands.
 *
 * This is an allowlist, not a secret-name denylist: a denylist misses names
 * such as `DATABASE_URL`, while child processes only need the documented
 * runtime variables to run ordinary builds and tests.
 */
export function createCommandEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of COMMAND_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}
