# Stage Two Acceptance Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the verified Stage Two correctness gaps and bring the primary interactive CLI transcript in line with the approved restrained NJU-purple design.

**Architecture:** Preserve the existing Agent, Session, Context, Skill, and readline boundaries. Repair lifecycle behavior at their current owners, add `/setup` through the existing command router, and improve only the formatter/renderer presentation layer; no new framework or full-screen terminal UI.

**Tech Stack:** Node.js 20+, TypeScript 5.9, ESM, Vitest, readline, picocolors.

**Spec:** `docs/superpowers/specs/2026-08-28-stage-two-productization-design.md`

## Global Constraints

- Keep the application a normal scrollback-preserving CLI, not a GUI or full-screen TUI.
- Keep the API key environment-only and never persist or print it.
- Preserve plain, ANSI-free, newline-safe output for non-TTY and `NO_COLOR`.
- Do not add a UI framework, tokenizer, model SDK, agent framework, or unrelated feature.
- Every behavior change follows RED → GREEN and ends with focused plus full verification.

---

### Task 1: Lifecycle and Session Correctness

**Files:**
- Modify: `src/index.ts`
- Modify: `src/cli/session.ts`
- Modify: `src/sessions/session-manager.ts`
- Test: `tests/integration/bootstrap.test.ts`
- Test: `tests/unit/cli/session.test.ts`
- Test: `tests/unit/sessions/session-manager.test.ts`

**Interfaces:**
- `main()` always closes the created Prompt, including configuration and workspace failures.
- `CliSession` accepts an exit-flush callback for EOF and idle Ctrl-C.
- `SessionManager.resume()` restores the resumed runtime's active Skill.

- [x] Add regression tests for prompt cleanup, exit flush, and same-manager Skill resume.
- [x] Run the focused tests and confirm each new assertion fails for the diagnosed reason.
- [x] Implement prompt ownership with `try/finally`, explicit exit flush, and Skill restoration after runtime replacement.
- [x] Run the focused tests until green.

### Task 2: Honest Context Accounting

**Files:**
- Modify: `src/agent/context-manager.ts`
- Test: `tests/unit/agent/context-manager.test.ts`

**Interfaces:**
- `status()` estimates only the checkpoint tail and reports Provider usage separately.
- Preparation uses Provider usage as a conservative floor only when it describes the same un-compacted view; a new compaction candidate is estimated from its candidate request.

- [x] Add failing tests for checkpoint-tail status and Provider-usage threshold behavior.
- [x] Run the focused tests and verify RED.
- [x] Pass the persisted usage floor into pre-compaction estimates and keep post-compaction candidate estimates independent.
- [x] Run focused Context tests until green.

### Task 3: Complete Setup and Skill Contracts

**Files:**
- Create: `src/cli/commands/setup-command.ts`
- Modify: `src/cli/commands/register-core-commands.ts`
- Modify: `src/cli/command.ts`
- Modify: `src/index.ts`
- Modify: `src/cli/commands/skill-command.ts`
- Test: `tests/unit/cli/commands/setup-command.test.ts`
- Test: `tests/unit/cli/commands/skill-commands.test.ts`

**Interfaces:**
- `/setup` invokes the existing non-secret setup flow while idle, saves only Base URL/Model/permission mode, and rebuilds the active Runtime without changing the environment-only API key.
- Project Skills resolve from `<workspace>/.nju-agent/skills/`.
- `/skill off` formats persistence failures instead of terminating the CLI.

- [x] Add failing command and path-contract tests.
- [x] Run focused tests and verify RED.
- [x] Register `/setup`, inject its minimal callback through `CommandContext`, fix the project Skill root, and contain deactivation errors.
- [x] Run focused tests until green.

### Task 4: Approved CLI Visual Transcript

**Files:**
- Modify: `src/cli/welcome.ts`
- Modify: `src/cli/renderer.ts`
- Modify: `src/cli/prompt.ts`
- Test: `tests/unit/cli/welcome.test.ts`
- Test: `tests/unit/cli/renderer.test.ts`
- Test: `tests/unit/cli/prompt.test.ts`

**Interfaces:**
- Welcome formatting accepts a terminal width and uses aligned labels, NJU-purple border/title accents, and an actionable `/resume` hint.
- Interactive tool records show concise human-readable summaries without internal call IDs or raw run-stat keys.
- Readline queues lines received between sequential reads so fast multi-line paste does not lose commands.

- [x] Add exact ANSI-stripped transcript assertions for 80/120-column welcome output, concise tool cards, and queued paste input.
- [x] Run focused CLI tests and verify RED.
- [x] Implement the smallest formatter, renderer, and prompt queue changes that satisfy the approved transcript.
- [x] Run focused CLI tests until green.

### Task 5: Release Truthfulness and Verification

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/PROJECT_REQUIREMENTS.md`
- Modify: `docs/STAGE_TWO_DEMO.md`

- [x] Align package/display version and document `/setup` plus `.nju-agent/skills`.
- [x] Remove contradictory Stage One limitation text and link the Stage Two design/plan.
- [x] Run `npm test`, `npm run typecheck`, and `npm run build` from a clean command invocation.
- [x] Run the opt-in smoke command and report PASS or SKIP truthfully.
- [x] Perform a real TTY transcript check for startup, `/help`, `/status`, multi-line paste, and exit.
