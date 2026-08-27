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
    ["run_command", { command: "npm test" }],
    ["run_command", { command: "git diff --stat" }],
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
});
