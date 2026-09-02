/**
 * Conservative lexical guard against commands that obviously escape the
 * active workspace or target hard-high-risk resources. It runs before every
 * permission mode makes its own decision, so even a user confirmation can
 * never approve one of these forms. This is defense in depth for an
 * intentionally shell-based tool: it blocks obvious escape attempts but is
 * not a kernel/container sandbox and makes no claim to be one.
 */
export type CommandGuardDecision =
  | { action: "allow" }
  | { action: "deny"; reason: string };

const HOME_EXPANSION = /(?:^|[^\w])~|\$HOME|\$\{HOME\}|`/u;
// Absolute filesystem paths (mirrors the policy's /dev/null exception).
const ABSOLUTE_PATH = /(?:^|[\s;&|<>"'=(])\/(?!dev\/null(?:\s|$))/u;
// Parent-directory traversal: `..`, `../x`, or `a/../b`.
const PARENT_TRAVERSAL =
  /(?:^|[\s;&|<>"'=(])\.\.(?:\/|$|\s)|(?:\/\.\.\/)/u;
// Directory-changing builtins, denied when they go nowhere, to `..`, `~`,
// $HOME, or an absolute path; a bare `cd` returns to $HOME.
const BARE_CD = /(?:^|[\s;&|(])cd(?:\s*[;&|]|\s*$)/u;
const CD_ESCAPE =
  /(?:^|[\s;&|(])cd\s+(?:\.\.|~|\$HOME|\$\{HOME\}|\/)/u;
const DIRECTORY_BUILTIN = /(?:^|[\s;&|(])(?:pushd|popd)\b/u;
// git -C always targets an explicit directory other than the shell cwd.
const GIT_DASH_C = /(?:^|[\s;&|])git\s+-C\b/u;
// Command substitution.
const COMMAND_SUBSTITUTION = /\$\(|\$\(\(/u;
// Pipe straight into a shell interpreter.
const PIPE_TO_SHELL = /\|\s*(?:sh|bash|dash|zsh|fish|ksh|tcsh|csh)\b/u;
// Privileged or destructive executables (kept in sync with the policy deny list).
const PRIVILEGED_EXECUTABLE =
  /(?:^|\s)(?:sudo|doas|su)(?:\s|$)/u;
const DESTRUCTIVE_FORM =
  /(?:^|\s)(?:shutdown|reboot|halt)(?:\s|$)|(?:^|\s)(?:mkfs(?:\.\w+)?|fdisk|diskutil\s+erase)(?:\s|$)|(?:^|\s)dd\s+[^\n]*\bof=\/dev\//u;
const ROOT_DELETION = /(?:^|\s)rm\s+-[^\n]*r[^\n]*f[^\n]*\s+\/(?:\s|$)/u;
// Remote Git writes.
const REMOTE_GIT_WRITE = /(?:^|[\s;&|])git\s+push(?:\s|$)/u;

export function guardWorkspaceCommand(command: string): CommandGuardDecision {
  const trimmed = command.trim();
  if (trimmed === "") {
    return { action: "allow" };
  }
  const reasonFor = (
    pattern: RegExp,
    reason: string,
  ): CommandGuardDecision | undefined =>
    pattern.test(trimmed) ? { action: "deny", reason } : undefined;

  return (
    reasonFor(
      PRIVILEGED_EXECUTABLE,
      "Privileged commands are never allowed",
    ) ??
    reasonFor(
      DESTRUCTIVE_FORM,
      "Destructive system commands are never allowed",
    ) ??
    reasonFor(
      ROOT_DELETION,
      "Recursive root deletion is never allowed",
    ) ??
    reasonFor(
      REMOTE_GIT_WRITE,
      "Remote Git writes are never allowed",
    ) ??
    reasonFor(
      COMMAND_SUBSTITUTION,
      "Command substitution could execute outside the workspace",
    ) ??
    reasonFor(
      HOME_EXPANSION,
      "Command references a home directory outside the workspace",
    ) ??
    reasonFor(
      ABSOLUTE_PATH,
      "Command references an absolute filesystem path outside the workspace",
    ) ??
    reasonFor(
      PARENT_TRAVERSAL,
      "Command escapes the workspace through parent-directory traversal",
    ) ??
    reasonFor(
      BARE_CD,
      "Bare cd returns to the home directory outside the workspace",
    ) ??
    reasonFor(
      CD_ESCAPE,
      "Command changes directory outside the workspace",
    ) ??
    reasonFor(
      DIRECTORY_BUILTIN,
      "Command changes the working directory with pushd/popd",
    ) ??
    reasonFor(
      GIT_DASH_C,
      "git -C runs against a directory outside the current workspace",
    ) ??
    reasonFor(
      PIPE_TO_SHELL,
      "Piping into a shell could execute outside the workspace",
    ) ?? { action: "allow" }
  );
}
