import { describe, expect, test } from "vitest";

import { isVerificationCommand } from "../../../src/goals/verification-command.js";

describe("isVerificationCommand", () => {
  test.each([
    ["npm test"],
    ["npm test -- --run"],
    ["npm run test"],
    ["npm run build"],
    ["npm run lint"],
    ["npm run typecheck"],
    ["npm run check"],
    ["pnpm test"],
    ["pnpm run typecheck"],
    ["yarn test"],
    ["yarn run build"],
    ["bun test"],
    ["bun run check"],
    ["vitest"],
    ["vitest run"],
    ["pytest"],
    ["tsc"],
    ["tsc --noEmit"],
    ["cargo test"],
    ["cargo check"],
    ["cargo build"],
    ["go test"],
    ["go test ./..."],
    ["  npm test  "],
  ])("accepts verification command %s", (command) => {
    expect(isVerificationCommand(command)).toBe(true);
  });

  test.each([
    ["npm testing"],
    ["pytester"],
    ["vitest-something"],
    ["npm install"],
    ["npm run"],
    ["node test.js"],
    ["python -m pytest"],
    ["cat package.json"],
    ["grep test src"],
    ["git status"],
    ["npm test | tee out.txt"],
    ["npm test && npm run typecheck"],
    ["npm run build > /dev/null"],
    ["cd src; npm test"],
    ["echo ok < file"],
    ["npm test & echo done"],
    ["npm run 'test && rm -rf /'"],
    [""],
  ])("rejects non-verification command %s", (command) => {
    expect(isVerificationCommand(command)).toBe(false);
  });
});
