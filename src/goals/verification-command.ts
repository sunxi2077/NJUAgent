const VERIFICATION_HEADS = [
  /^npm test(?:\s|$)/u,
  /^npm run (?:test|build|lint|typecheck|check)(?:\s|$)/u,
  /^pnpm test(?:\s|$)/u,
  /^pnpm run (?:test|build|lint|typecheck|check)(?:\s|$)/u,
  /^yarn test(?:\s|$)/u,
  /^yarn run (?:test|build|lint|typecheck|check)(?:\s|$)/u,
  /^bun test(?:\s|$)/u,
  /^bun run (?:test|build|lint|typecheck|check)(?:\s|$)/u,
  /^vitest(?:\s|$)/u,
  /^pytest(?:\s|$)/u,
  /^tsc(?:\s|$)/u,
  /^cargo (?:test|check|build)(?:\s|$)/u,
  /^go test(?:\s|$)/u,
] as const;

/** Any shell composition makes the exit status untrustworthy as evidence. */
const COMPOUND_SHELL = /[|<>;&]|\|\||&&/u;

/**
 * Classifies whether a command is a verification command. Pure and
 * conservative: false positives would let an Agent claim completion without
 * real evidence, so compound shell syntax is always rejected before the head
 * is examined. Matching is case-sensitive with a token boundary.
 */
export function isVerificationCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed === "") {
    return false;
  }
  if (COMPOUND_SHELL.test(trimmed)) {
    return false;
  }
  return VERIFICATION_HEADS.some((pattern) => pattern.test(trimmed));
}
