# NJUAgent Stage-Two Skills and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe, explicit single-Skill activation, complete the prompt-layer and error/cancellation integration, and close the second stage with truthful documentation, full quality gates, a real API smoke test, and a short reproducible video scenario.

**Architecture:** Load only bounded `SKILL.md` files from user and project roots, merge them with deterministic project-over-user precedence, and inject one explicitly selected Skill as a delimited System Prompt layer. Finish by auditing Provider errors and every cross-module lifecycle path instead of adding more product scope.

**Tech Stack:** TypeScript 5.9, Node.js 20+, ESM, Vitest, Node filesystem/path APIs, existing Provider/Session/Context/CLI infrastructure; no YAML package, plugin framework, MCP, or script runner.

**Spec:** `docs/superpowers/specs/2026-08-28-stage-two-productization-design.md`

## Global Constraints

- Complete all three prior second-stage plans first.
- A Skill is local prompt text, not executable code. Do not run scripts, install dependencies, load assets/references, or grant permissions from Skill content.
- Only explicit `/skill <name>` activation is supported; never auto-select based on model output or user text.
- At most one Skill is active per Session.
- Project Skills override user Skills with the same valid name; invalid project files do not silently replace a valid user Skill.
- Canonical `SKILL.md` paths must remain under their configured root; reject symlink escape.
- Skill content cannot weaken Workspace, permission, timeout, output, credential, or command policies.
- Provider-facing default errors must be safe and classified; SDK request headers/bodies are never dumped.
- Do not mark requirements complete until automated and manual evidence exists.

## File Responsibility Map

| File | Responsibility after this plan |
| --- | --- |
| `src/skills/skill.ts` | Skill types, name/size limits, minimal frontmatter parsing. |
| `src/skills/skill-loader.ts` | Canonical single-root discovery and per-file diagnostics. |
| `src/skills/skill-registry.ts` | Refresh and user/project precedence. |
| `src/skills/skill-prompt.ts` | Compose base, active Skill, then conversation summary. |
| `src/cli/commands/skills-command.ts` | `/skills`. |
| `src/cli/commands/skill-command.ts` | `/skill <name>` and `/skill off`. |
| `src/sessions/session-manager.ts` | Persist and restore active Skill with runtime prompt updates. |
| `src/providers/provider.ts` | Stable Provider failure kinds. |
| `src/providers/anthropic-provider.ts` | Map SDK status/connection/protocol errors without leaking details. |
| `src/errors/error-presenter.ts` | Final user/debug behavior. |
| `README.md`, `README.txt`, `docs/PROJECT_REQUIREMENTS.md` | Truthful second-stage behavior and limitations. |

---

### Task 1: Parse a Strict, Bounded SKILL.md

**Files:**
- Create: `src/skills/skill.ts`
- Create: `tests/unit/skills/skill.test.ts`

**Interfaces:**
- Produces:

```ts
export type SkillSource = "user" | "project";

export type Skill = {
  name: string;
  description: string;
  instructions: string;
  source: SkillSource;
  filePath: string;
};

export const MAX_SKILL_BYTES = 32 * 1024;
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

export function parseSkillFile(input: {
  text: string;
  byteLength: number;
  directoryName: string;
  source: SkillSource;
  filePath: string;
}): Skill;
```

- [ ] **Step 1: Write successful parsing tests**

Use this exact fixture:

```md
---
name: test-first
description: Require a focused failing test before implementation.
---

# Test First

Write one focused failing test, observe the failure, then implement.
```

Assert trimmed metadata, preserved body headings/newlines, source and path.

- [ ] **Step 2: Write rejection tests**

Cover missing opening/closing delimiter, blank body, missing/duplicate/unknown fields, multiline scalar, invalid name, directory-name mismatch, blank or >300-character description, and `byteLength > MAX_SKILL_BYTES`. Assert `AppError` code `SKILL_INVALID` and a message naming only the file/name—not the full content.

- [ ] **Step 3: Run and verify RED**

```bash
npm test -- tests/unit/skills/skill.test.ts
```

- [ ] **Step 4: Implement a deliberately minimal parser**

Normalize CRLF to LF. Require the first line and a later line to equal exactly `---`. Parse each nonblank frontmatter line at the first colon, trim key/value, and accept only `name` and `description` once each. Do not support YAML quotes, arrays, nested values, folded blocks, interpolation, or comments. This is a documented format, not partial general YAML.

- [ ] **Step 5: Verify and commit**

```bash
npm test -- tests/unit/skills/skill.test.ts
npm run typecheck
git add src/skills/skill.ts tests/unit/skills/skill.test.ts
git commit -m "feat: parse bounded skill instructions"
```

---

### Task 2: Discover Skills Safely and Apply Project Precedence

**Files:**
- Create: `src/skills/skill-loader.ts`
- Create: `src/skills/skill-registry.ts`
- Create: `tests/unit/skills/skill-loader.test.ts`
- Create: `tests/unit/skills/skill-registry.test.ts`

**Interfaces:**
- Produces:

```ts
export type SkillDiagnostic = {
  source: SkillSource;
  name: string;
  message: string;
};

export type SkillLoadResult = {
  skills: readonly Skill[];
  diagnostics: readonly SkillDiagnostic[];
};

export class SkillLoader {
  loadRoot(root: string, source: SkillSource): Promise<SkillLoadResult>;
}

export class SkillRegistry {
  constructor(userRoot: string, projectRoot: string, loader?: SkillLoader);
  refresh(): Promise<SkillLoadResult>;
  list(): readonly Skill[];
  resolve(name: string): Skill | undefined;
  diagnostics(): readonly SkillDiagnostic[];
}
```

- [ ] **Step 1: Write loader security tests**

Under temporary roots, test:

1. missing root yields empty result without error;
2. valid direct `<name>/SKILL.md` loads;
3. unrelated files and nested grandchildren are ignored;
4. invalid one creates a diagnostic while valid siblings load;
5. a symlinked `SKILL.md` resolving outside root is rejected;
6. a symlink resolving to a file still inside root is allowed only if directory/name checks pass;
7. an oversized file is rejected using `stat.size` before an unbounded read;
8. results sort by name.

- [ ] **Step 2: Write precedence tests**

Assert project overrides a valid same-name user Skill, unique Skills from both roots remain, and an invalid project duplicate produces a diagnostic but does not erase the valid user Skill. `refresh()` replaces the previous snapshot atomically only after both loads complete.

- [ ] **Step 3: Run and verify RED**

```bash
npm test -- tests/unit/skills/skill-loader.test.ts tests/unit/skills/skill-registry.test.ts
```

- [ ] **Step 4: Implement canonical boundary checks**

Resolve the root with `realpath` when it exists. For each candidate, resolve `SKILL.md` with `realpath` and require `relative(rootReal, fileReal)` to be nonempty, not start with `..`, and not be absolute. Use direct `readdir({ withFileTypes: true })`; do not use a recursive glob.

- [ ] **Step 5: Implement atomic registry refresh**

Load both roots into local results, merge user first then valid project entries, sort by name, then replace registry fields. Clone arrays returned to callers or expose readonly copies; do not let command formatters mutate registry state.

- [ ] **Step 6: Verify and commit**

```bash
npm test -- tests/unit/skills
npm run typecheck
git add src/skills/skill-loader.ts src/skills/skill-registry.ts tests/unit/skills
git commit -m "feat: discover user and project skills"
```

---

### Task 3: Compose Prompt Layers and Persist Explicit Activation

**Files:**
- Create: `src/skills/skill-prompt.ts`
- Create: `tests/unit/skills/skill-prompt.test.ts`
- Modify: `src/agent/system-prompt.ts`
- Modify: `tests/unit/system-prompt.test.ts`
- Modify: `src/sessions/session-manager.ts`
- Modify: `tests/unit/sessions/session-manager.test.ts`
- Modify: `src/runtime/create-runtime.ts`

**Interfaces:**
- Produces:

```ts
export type PromptLayers = {
  skill?: Pick<Skill, "name" | "instructions" | "source">;
  summary?: string;
};

export function buildLayeredSystemPrompt(layers: PromptLayers): string;
```

- Extends `ActiveRuntime` with `setActiveSkill(skill: Skill | undefined): void`.
- Extends SessionManager with `activateSkill(name)`, `deactivateSkill()`, and `activeSkill()`.

- [ ] **Step 1: Write exact layer-order tests**

Assert:

- base prompt always exists;
- no empty tags when both layers are absent;
- Skill appears after base and before summary;
- one `<active_skill name="..." source="...">` and one `<conversation_summary>` block;
- instructions and summary text are preserved;
- Skill text cannot remove or replace base prompt text;
- the resulting string is deterministic.

- [ ] **Step 2: Write activation state tests**

Prove:

- activation resolves only from current Registry and calls runtime `setActiveSkill` before saving Session state;
- failed save leaves active in-memory Skill selected and marks Session dirty, matching other Session mutations;
- `/new` has null Skill;
- `/resume` restores an existing valid Skill;
- missing/invalid persisted Skill is changed to null, emits one warning, and saves the repaired Session when possible;
- deactivate is idempotent.

- [ ] **Step 3: Run and verify RED**

```bash
npm test -- tests/unit/skills/skill-prompt.test.ts tests/unit/sessions/session-manager.test.ts tests/unit/system-prompt.test.ts
```

- [ ] **Step 4: Implement prompt composition without broad XML parsing**

Skill names already match the strict pattern and source is a union, so attributes are safe. Add fixed explanatory lines before each layer stating that host permissions remain authoritative and transcript summary is reference data. Do not insert Skill into Message history.

The runtime's prompt source must read current active Skill on every model step or be updated synchronously by `setActiveSkill`; do not require recreating Session history.

- [ ] **Step 5: Verify and commit**

```bash
npm test -- tests/unit/skills/skill-prompt.test.ts tests/unit/sessions/session-manager.test.ts tests/unit/system-prompt.test.ts
npm run typecheck
git add src/skills/skill-prompt.ts src/agent/system-prompt.ts src/sessions/session-manager.ts src/runtime tests/unit
git commit -m "feat: activate one skill per session"
```

---

### Task 4: Add `/skills` and `/skill`

**Files:**
- Create: `src/cli/commands/skills-command.ts`
- Create: `src/cli/commands/skill-command.ts`
- Modify: `src/cli/commands/register-core-commands.ts`
- Modify: `src/sessions/session-format.ts`
- Create: `tests/unit/cli/commands/skill-commands.test.ts`
- Create: `tests/integration/skill-lifecycle.test.ts`

**Interfaces:**
- `/skills` refreshes before listing.
- `/skill <name>` refreshes, resolves, activates, persists, and reports source.
- `/skill off` deactivates; other missing/extra argument forms show usage.

- [ ] **Step 1: Write command tests**

Cover:

- sorted rows with name, `[user|project]`, description, and active marker;
- invalid diagnostics appear after valid Skills;
- no Skills gives exact actionable roots;
- `/skill` renders `Usage: /skill <name>|off`;
- unknown name does not change current activation and suggests `/skills`;
- project override is the activated object;
- `/skill off` twice remains successful and null;
- Slash inputs never reach Provider/history.

- [ ] **Step 2: Write lifecycle integration test**

Create a temporary user Skill and same-name project override. Start Session, `/skills`, activate, run one turn through a recording Provider, and assert the System Prompt contains project instructions/source exactly once. Exit, resume, assert activation persists. Delete the project Skill, resume again, assert safe fallback to the user Skill only if Registry still resolves the same name; if no valid same-name Skill exists, disable and warn.

- [ ] **Step 3: Run and verify RED**

```bash
npm test -- tests/unit/cli/commands/skill-commands.test.ts tests/integration/skill-lifecycle.test.ts
```

- [ ] **Step 4: Implement bounded formatting and handlers**

Truncate description at 120 code points in list output. Diagnostics show source/name/message but never file body. A Skill activation event uses NJU purple; invalid warnings use yellow; loader I/O failure uses the safe AppError presenter.

- [ ] **Step 5: Verify and commit**

```bash
npm test -- tests/unit/cli/commands/skill-commands.test.ts tests/integration/skill-lifecycle.test.ts
npm run typecheck
git add src/cli/commands src/sessions/session-format.ts tests/unit/cli/commands tests/integration/skill-lifecycle.test.ts
git commit -m "feat: manage skills with slash commands"
```

---

### Task 5: Finish Provider Error Classification and Cancellation Audit

**Files:**
- Modify: `src/providers/provider.ts`
- Modify: `src/providers/anthropic-provider.ts`
- Modify: `src/providers/retry.ts`
- Modify: `src/agent/runner.ts`
- Modify: `src/errors/error-presenter.ts`
- Modify: `tests/unit/providers/anthropic-provider.test.ts`
- Modify: `tests/unit/providers/retry.test.ts`
- Create: `tests/integration/error-recovery.test.ts`

**Interfaces:**
- Adds `ProviderErrorKind = "auth" | "rate_limit" | "unavailable" | "protocol" | "invalid_request"` to ProviderError.
- Maps Provider errors to stable `AppErrorCode` only at the application/runner presentation boundary.
- Keeps retry decision on `ProviderError.retryable`, not string matching.

- [ ] **Step 1: Add Provider mapping tests**

Using SDK error fakes or the current injectable client, prove mappings:

- 401/403 → auth, not retryable;
- 429 → rate_limit, retryable, respects `Retry-After`;
- 408/409/5xx and connection error → unavailable, retryable;
- 400/404/422 → invalid_request, not retryable;
- malformed tool JSON, missing stop reason, and missing message_stop → protocol, not retryable;
- abort → AbortError, never retried.

Default user output must not contain raw response bodies, headers, API Key fixtures, or entire malformed JSON.

- [ ] **Step 2: Add cross-module recovery tests**

Test:

1. 429 retries to the configured limit and displays retry events;
2. Ctrl-C during backoff ends immediately as cancelled;
3. Provider auth failure returns to `›` after a safe message;
4. tool execution failure remains a tool result and the model can continue;
5. Session save failure prevents switch but the next ordinary turn may continue in memory;
6. compactor abort preserves checkpoint and returns to prompt;
7. Skill invalidity does not crash startup.

- [ ] **Step 3: Run and verify RED**

```bash
npm test -- tests/unit/providers tests/integration/error-recovery.test.ts
```

- [ ] **Step 4: Implement classification without changing SDK responsibility**

`AnthropicProvider` remains the only module importing SDK error types. Set a safe ProviderError message such as `Model authentication failed` or `Model stream ended unexpectedly`; keep the original SDK error only as `cause`. Retry events may show the safe message, never raw headers/body.

Map to final AppError codes:

| Provider kind | App error |
| --- | --- |
| auth | `PROVIDER_AUTH` |
| rate_limit | `PROVIDER_RATE_LIMIT` |
| unavailable | `PROVIDER_UNAVAILABLE` |
| protocol, invalid_request | `PROVIDER_PROTOCOL` |

- [ ] **Step 5: Audit every AbortSignal path**

Confirm the same current-turn signal reaches Provider stream, retry sleep, ToolExecutor, permission confirmation, ContextManager, and ModelCompactor. No catch block may convert an abort into `INTERNAL` or retry it.

- [ ] **Step 6: Verify and commit**

```bash
npm test -- tests/unit/providers tests/integration/error-recovery.test.ts
npm run typecheck
git add src/providers src/agent/runner.ts src/errors/error-presenter.ts tests/unit/providers tests/integration/error-recovery.test.ts
git commit -m "fix: classify and recover from runtime failures"
```

---

### Task 6: Complete Documentation, Release Tests, and Video Rehearsal

**Files:**
- Modify: `README.md`
- Modify: `README.txt`
- Modify: `.env.example`
- Modify: `docs/PROJECT_REQUIREMENTS.md`
- Modify: `tests/smoke/anthropic-api.smoke.ts`
- Create: `tests/integration/stage-two-demo.test.ts`
- Create: `docs/STAGE_TWO_DEMO.md`

**Interfaces:**
- `stage-two-demo.test.ts` is fully offline and deterministic.
- Real smoke remains opt-in and prints only model, statuses, tool-call count, duration, and PASS/SKIP/FAIL.
- `README.txt` remains within the assignment's 1,000-Chinese-character limit.

- [ ] **Step 1: Write the final offline demonstration test**

Drive a scripted fail → inspect → edit → pass loop in the existing demo fixture, then exercise `/context`, manual compact, `/new`, `/sessions`, `/resume`, project Skill activation, and exit/restart. Assertions must prove state, not terminal decoration alone:

- final command result passed;
- resumed Session contains original complete messages;
- checkpoint exists and Provider request uses summary/tail;
- project Skill layer appears once;
- no command string entered as Slash is in messages;
- no temporary app-home path leaks into the repository.

- [ ] **Step 2: Run the new test and repair only integration defects**

```bash
npm test -- tests/integration/stage-two-demo.test.ts
```

Expected after implementation: PASS. Do not add new features while fixing this gate.

- [ ] **Step 3: Update real smoke carefully**

Retain the existing text and `read_file` verification. Add a second-process Session resume and one manual compact only if the real endpoint can perform them deterministically; otherwise keep these in offline integration and document why. Never print response text, Session message content, Skill body, request headers, Base URL query parameters, or credentials.

- [ ] **Step 4: Rewrite documentation to match the delivered product**

README must cover:

- pure CLI status and NJU-purple/NO_COLOR behavior;
- first-run setup and environment-only API Key;
- all Slash commands with examples;
- Session location, complete transcript, default-new startup and no cross-session search;
- estimated context budgeting, automatic/manual compact and failure fallback;
- user/project Skill paths, override/explicit single activation, no scripts/plugins;
- trusted-local-tool security boundary;
- current limitations: no GUI/full-screen TUI, multi-agent, MCP, plugins, auto Skills, cloud sync.

Update `PROJECT_REQUIREMENTS.md` checkboxes only from verified evidence. Keep `README.txt` concise enough for the submission requirement. Replace its current repository-address marker only when the actual public URL is known; never invent a URL.

- [ ] **Step 5: Write a two-minute rehearsal document**

`docs/STAGE_TWO_DEMO.md` must contain a timestamped script with a primary and fallback task. Target:

```text
00:00-00:12  startup panel, architecture sentence, no key visible
00:12-01:12  real coding task: inspect → edit → failing test → fix → pass
01:12-01:32  /context and /compact
01:32-01:48  /new, /sessions, /resume
01:48-01:58  /skills and one explicit activation
01:58-02:00  final status
```

State exactly which terminal window size, workspace fixture, commands, and environment-variable names to prepare. Require a clean rehearsal with no secret, personal home path, notifications, or unrelated terminal tabs visible.

- [ ] **Step 6: Run all automated release gates**

```bash
npm test
npm run typecheck
npm run build
npm run test:smoke
```

Expected: offline tests PASS, typecheck PASS, build PASS; smoke prints SKIP without credentials or PASS with configured credentials. A SKIP is not evidence for the final real-API gate.

- [ ] **Step 7: Run manual clean-environment acceptance**

Use a new temporary directory as `NJU_AGENT_HOME` and a disposable workspace. Verify first setup, welcome, prompt editing, cancellation, one Session save/resume, context commands, one project Skill, `NO_COLOR`, and EOF/exit. Inspect Session/config JSON and confirm no API Key.

- [ ] **Step 8: Inspect repository cleanliness and sensitive strings**

Run:

```bash
git status --short
git diff --check
rg -n "ANTHROPIC_API_KEY=|sk-ant-|api[_-]?key.{0,20}[=:].{8,}" . \
  -g '!node_modules/**' -g '!dist/**' -g '!package-lock.json'
```

Review every match manually. Variable names and deliberate redacted test fixtures are acceptable; real-looking values are not.

- [ ] **Step 9: Commit the release closure**

```bash
git add README.md README.txt .env.example docs/PROJECT_REQUIREMENTS.md docs/STAGE_TWO_DEMO.md tests/smoke/anthropic-api.smoke.ts tests/integration/stage-two-demo.test.ts
git commit -m "docs: close the second-stage productization"
```

## Final Stage-Two Completion Gate

- [ ] Every requirement in the design spec maps to a passing test, manual check, or documented out-of-scope item.
- [ ] `npm test`, typecheck, build, and credentialed real smoke pass.
- [ ] Welcome/prompt/output are polished but remain a normal scrollback CLI.
- [ ] Sessions, context checkpoints, and active Skill survive restart as designed.
- [ ] Complete history remains available after compact.
- [ ] All failure classes return actionable, secret-free messages and recover when specified.
- [ ] README, README.txt, requirements checklist, and demo script match actual behavior.
- [ ] No runtime app-home data, Session file, private Skill, API Key, or unrelated worktree change is committed.
- [ ] Only after this gate should the implementation branch be reviewed for merge into `main`.
