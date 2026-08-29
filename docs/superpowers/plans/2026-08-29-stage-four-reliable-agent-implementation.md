# Stage Four Reliable Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional Tavily-backed `web_search` tool, a persisted model-maintained Plan, and an explicit `/goal` mode that refuses to claim completion without current evidence.

**Architecture:** Keep the existing `AgentRunner` as the only worker loop. Add Plan and Evidence as session-owned state, observe every final tool result in `ToolExecutor`, and attach Goal behavior through a small `StopGate` evaluated only when the worker would normally stop. Keep Tavily behind an internal provider interface and keep all CLI commands as local control-plane operations.

**Tech Stack:** TypeScript 5.9, Node.js 20 native `fetch`, Vitest, Ajv, the existing Anthropic-compatible `ModelProvider`, and the existing CLI/permission/session infrastructure.

**Spec:** `docs/superpowers/specs/2026-08-29-stage-four-reliable-agent-design.md`

## Global Constraints

- Work in the order below. Later tasks depend on the public interfaces established earlier.
- Use test-driven development for every task: add or change a failing test, run it and confirm the expected failure, implement the smallest complete change, then rerun the focused test.
- Do not add a Tavily SDK, terminal UI framework, database, validation library, or a second Agent loop.
- Do not implement long-term memory, repository maps, fork/subagents, MCP, `web_fetch`, background execution, or automatic Git rollback.
- Do not send Plan/Goal slash commands into model history.
- Do not log, persist, interpolate into errors, or return `TAVILY_API_KEY`.
- Never call real Tavily endpoints from unit or integration tests. Inject `fetch` or a fake `WebSearchProvider`.
- Preserve ordinary-mode behavior: with no active Goal and no Tavily key, there is no evaluator request and no network access.
- Preserve non-TTY behavior: no ANSI codes or cursor controls.
- Keep `schemaVersion: 1`; load old session documents by normalizing missing `plan`, `goal`, and `evidence` fields before strict validation.
- All new user-visible strings are stable test contracts. Copy them from the spec or this plan rather than inventing variants.
- After each task, run the focused tests and `npm run typecheck`, inspect `git diff`, and commit only that task. Do not merge branches or modify unrelated user changes.

---

## Task 1: Add Persisted Plan, Goal, and Evidence State

**Files:**

- Create: `src/planning/plan.ts`
- Create: `src/goals/goal.ts`
- Modify: `src/sessions/session-schema.ts`
- Test: `tests/unit/sessions/session-schema.test.ts`
- Test: `tests/unit/planning/plan.test.ts`

### 1.1 Define the canonical data types and defaults

- [ ] Create `src/planning/plan.ts` with the exact public types from the spec and these exports:

```ts
export type PlanItemStatus = "pending" | "in_progress" | "completed";

export type PlanItem = {
  id: string;
  content: string;
  status: PlanItemStatus;
};

export type PlanState = {
  items: PlanItem[];
  updatedAt?: string;
};

export const EMPTY_PLAN_STATE: Readonly<PlanState> = { items: [] };
```

- [ ] Create `src/goals/goal.ts` and export `GoalStatus`, `GoalState`, `CommandEvidence`, `EvidenceState`, `GoalEvaluationInput`, and `GoalEvaluationDecision` exactly as specified. Export factory functions rather than shared mutable objects:

```ts
export function createEmptyEvidenceState(): EvidenceState {
  return { workspaceRevision: 0, changedPaths: [], commands: [] };
}
```

### 1.2 Write failing session compatibility tests

- [ ] Extend `tests/unit/sessions/session-schema.test.ts` with tests proving:

  - `createEmptySession()` includes empty Plan, null Goal, and empty Evidence;
  - an old valid V1 fixture with all three properties absent loads successfully and receives defaults;
  - a newly saved-shaped session requires valid nested fields;
  - unknown top-level and nested fields are still rejected;
  - invalid status, duplicate data shape errors, negative revision, invalid dates, and more than 20 persisted commands are rejected;
  - parsing returns a defensive clone.

- [ ] Run the test and confirm failure:

```bash
npm test -- tests/unit/sessions/session-schema.test.ts
```

Expected failure: new properties are absent or old documents fail validation.

### 1.3 Normalize old documents before strict validation

- [ ] Do not add the new keys directly to the old schema's `required` list before normalization. Instead, build a non-mutating normalization candidate:

```ts
function normalizeSessionCandidate(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  return {
    ...record,
    plan: record.plan ?? { items: [] },
    goal: record.goal ?? null,
    evidence: record.evidence ?? createEmptyEvidenceState(),
  };
}
```

- [ ] Validate the normalized candidate with Ajv. In the normalized schema, make all three fields required and keep `additionalProperties: false` at every object level.
- [ ] Validate all ISO timestamps, including `plan.updatedAt`, Goal timestamps, `lastDecision.evaluatedAt`, and command `observedAt` when present.
- [ ] Keep structural constraints in Ajv and cross-field rules in later managers; session loading must still reject impossible persisted shapes such as two in-progress Plan items. Reuse the Plan validator added next rather than duplicating rules.

### 1.4 Add pure Plan validation

- [ ] In `src/planning/plan.ts`, export:

```ts
export type PlanValidationResult =
  | { ok: true; value: PlanItem[] }
  | { ok: false; message: string };

export function validatePlanItems(input: readonly PlanItem[]): PlanValidationResult;
```

- [ ] Enforce max 12 items, unique IDs, the ID regex, trimmed content of 1–200 Unicode code points, valid status, and at most one `in_progress`. Return cloned, trimmed items on success.
- [ ] Add focused tests in `tests/unit/planning/plan.test.ts` for every boundary, including 200 vs. 201 CJK characters and atomic rejection input.

### 1.5 Verify and commit

- [ ] Run:

```bash
npm test -- tests/unit/planning/plan.test.ts tests/unit/sessions/session-schema.test.ts
npm run typecheck
git diff --check
```

- [ ] Commit:

```bash
git add src/planning/plan.ts src/goals/goal.ts src/sessions/session-schema.ts tests/unit/planning/plan.test.ts tests/unit/sessions/session-schema.test.ts
git commit -m "feat: persist plan goal and evidence state"
```

---

## Task 2: Implement PlanManager and `plan_write`

**Files:**

- Create: `src/planning/plan-manager.ts`
- Create: `src/planning/plan-tool.ts`
- Modify: `src/tools/registry.ts` only if its generic types require a narrow adapter
- Test: `tests/unit/planning/plan-manager.test.ts`
- Test: `tests/unit/planning/plan-tool.test.ts`

### 2.1 Write PlanManager tests first

- [ ] Test successful whole-list replacement, timestamp updates through an injected clock, clear, defensive copies, and preservation of old state after invalid replacement.
- [ ] Use this interface:

```ts
export class PlanManager {
  constructor(options: {
    state: PlanState;
    clock?: () => Date;
    onChanged?: (state: PlanState) => void;
  });

  snapshot(): PlanState;
  replace(items: readonly PlanItem[]): PlanState;
  clear(): PlanState;
}
```

- [ ] `state` is the session-owned object. Mutate its properties only after validation succeeds so the runtime and persisted session cannot diverge.
- [ ] Run the failing test:

```bash
npm test -- tests/unit/planning/plan-manager.test.ts
```

### 2.2 Implement the manager

- [ ] Throw an `AppError` with code `PLAN_INVALID` and a concise, non-sensitive message for cross-item validation failures.
- [ ] Invoke `onChanged` only after successful state mutation, with a defensive snapshot.

### 2.3 Write and implement the tool adapter

- [ ] Test the exact JSON schema, successful output, event callback, invalid cross-item result, and empty-list clear.
- [ ] Export this factory:

```ts
export function createPlanWriteTool(options: {
  manager: PlanManager;
  onUpdated?: (plan: PlanState) => void;
}): Tool<{ items: PlanItem[] }>;
```

- [ ] The tool name is `plan_write`. Copy the schema from the spec, use `additionalProperties: false`, and return the complete normalized Plan in its text output.
- [ ] Do not perform session I/O inside the tool. Runtime state mutation is checkpointed by the existing `SessionManager.runTurn()` path.

### 2.4 Verify and commit

- [ ] Run:

```bash
npm test -- tests/unit/planning/plan-manager.test.ts tests/unit/planning/plan-tool.test.ts tests/unit/tools/registry.test.ts
npm run typecheck
git diff --check
```

If `tests/unit/tools/registry.test.ts` does not exist, omit only that path; do not create an unrelated test merely to satisfy the command.

- [ ] Commit:

```bash
git add src/planning src/tools/registry.ts tests/unit/planning
git commit -m "feat: add model maintained plans"
```

---

## Task 3: Add `/plan`, Plan Events, and Runtime Wiring

**Files:**

- Create: `src/cli/commands/plan-command.ts`
- Modify: `src/agent/events.ts`
- Modify: `src/runtime/create-runtime.ts`
- Modify: `src/sessions/session-manager.ts`
- Modify: `src/cli/command.ts`
- Modify: `src/cli/commands/register-core-commands.ts`
- Modify: `src/cli/help.ts`
- Modify: `src/cli/renderer.ts`
- Test: `tests/unit/cli/command-router.test.ts`
- Test: `tests/unit/cli/renderer.test.ts`
- Test: `tests/unit/sessions/session-manager.test.ts`
- Test: `tests/integration/session-lifecycle.test.ts`

### 3.1 Establish the persistence ownership

- [ ] Add the following methods to `SessionManager` and its `CommandContext` pick:

```ts
plan(): PlanState;
async clearPlan(): Promise<PlanState>;
```

- [ ] `clearPlan()` mutates the active runtime session, updates `updatedAt`, marks dirty, flushes, and returns a clone. Runtime construction must create one `PlanManager` over `session.plan`, so the tool and slash command always see the same state.
- [ ] Confirm via a failing lifecycle test that a tool-updated Plan survives checkpoint and `/resume`, while `/new` starts empty.

### 3.2 Add the command

- [ ] Implement `/plan` and `/plan clear`; reject other arguments with `Usage: /plan [clear]`.
- [ ] Register it, add it to help output, and verify the router does not append command text to model history.

### 3.3 Add event and renderer behavior

- [ ] Add `{ type: "plan_updated"; plan: PlanState }` to `AgentEvent`.
- [ ] Render the progress numerator as the number of `completed` items, not the array position. Use the spec's symbols and TTY/non-TTY formats.
- [ ] For an empty Plan update, print `◆ Plan cleared` in TTY and `[plan] cleared` in non-TTY.
- [ ] Ensure the `AgentEvent` switch remains exhaustive.

### 3.4 Wire the tool

- [ ] In `createRuntime()`, construct the session-bound manager, register `plan_write`, and forward `onUpdated` to the renderer as `plan_updated`.
- [ ] Add `plan_write` to the PermissionPolicy allow set in both modes because it changes only session metadata.
- [ ] Add concise planning rules to `buildSystemPrompt()` as specified.

### 3.5 Verify and commit

- [ ] Run:

```bash
npm test -- tests/unit/cli/command-router.test.ts tests/unit/cli/renderer.test.ts tests/unit/sessions/session-manager.test.ts tests/integration/session-lifecycle.test.ts tests/unit/security/permission-policy.test.ts tests/unit/system-prompt.test.ts
npm run typecheck
git diff --check
```

- [ ] Commit:

```bash
git add src/agent/events.ts src/runtime/create-runtime.ts src/sessions/session-manager.ts src/cli src/security/permission-policy.ts src/agent/system-prompt.ts tests
git commit -m "feat: expose persisted plans in the cli"
```

---

## Task 4: Implement the Tavily Provider and Configuration

**Files:**

- Create: `src/web/web-search.ts`
- Create: `src/web/tavily-search-provider.ts`
- Modify: `src/config.ts`
- Modify: `.env.example`
- Test: `tests/unit/web/tavily-search-provider.test.ts`
- Test: `tests/unit/config.test.ts`

### 4.1 Add optional configuration with tests

- [ ] Extend `AppConfig` with:

```ts
tavilyApiKey?: string;
webSearchTimeoutMs: number;
webSearchMaxContentChars: number;
```

- [ ] Add defaults `15_000` and `6_000`. Trim the key; represent missing/blank as `undefined`. Reuse `readPositiveInt` for both numeric values.
- [ ] Test defaults, overrides, invalid zero/negative/non-integer values, blank key, and a present key. Do not assert or snapshot the real secret.
- [ ] Add documented placeholders to `.env.example`.

### 4.2 Define the provider boundary

- [ ] Add the `WebSearchQuery`, `WebSearchResult`, and `WebSearchProvider` types exactly as in the spec.
- [ ] Define a stable internal error without carrying response bodies:

```ts
export type WebSearchErrorKind =
  | "auth"
  | "rate_limit"
  | "unavailable"
  | "timeout"
  | "cancelled"
  | "invalid_response";

export class WebSearchError extends Error {
  constructor(readonly kind: WebSearchErrorKind, message: string) {
    super(message);
  }
}
```

### 4.3 Write request/response tests before provider code

- [ ] Inject fetch rather than replacing globals:

```ts
export type FetchPort = typeof fetch;

export class TavilySearchProvider implements WebSearchProvider {
  constructor(options: {
    apiKey: string;
    timeoutMs: number;
    fetch?: FetchPort;
  });
}
```

- [ ] Test URL, POST method, `Authorization: Bearer ...`, JSON content type, snake_case body, `search_depth: "basic"`, and `include_raw_content: "markdown"`. Assert the body has no `api_key` property.
- [ ] Test successful normalization and unknown-field tolerance.
- [ ] Test 401/403, 429, 5xx/network failure, invalid JSON, missing/non-array `results`, timeout, and caller cancellation.
- [ ] Test that errors and result output never contain the key or raw response body.
- [ ] Use fake timers only if needed; a deferred fake fetch plus `AbortController` is clearer for cancellation.

### 4.4 Implement abort composition correctly

- [ ] Compose caller cancellation and timeout without leaking listeners. Node 20 permits `AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)])`.
- [ ] Distinguish caller cancellation from timeout after fetch rejects:

```ts
if (signal.aborted) {
  throw new WebSearchError("cancelled", "Web search was cancelled.");
}
if (combined.aborted) {
  throw new WebSearchError("timeout", "Web search timed out.");
}
```

- [ ] Do not retry.

### 4.5 Verify and commit

- [ ] Run:

```bash
npm test -- tests/unit/web/tavily-search-provider.test.ts tests/unit/config.test.ts
npm run typecheck
git diff --check
```

- [ ] Commit:

```bash
git add src/web src/config.ts .env.example tests/unit/web tests/unit/config.test.ts
git commit -m "feat: add optional tavily search provider"
```

---

## Task 5: Add the Permission-Gated `web_search` Tool

**Files:**

- Create: `src/web/web-search-tool.ts`
- Modify: `src/runtime/create-runtime.ts`
- Modify: `src/security/permission-policy.ts`
- Modify: `src/cli/commands/status-command.ts`
- Modify: `src/agent/system-prompt.ts`
- Test: `tests/unit/web/web-search-tool.test.ts`
- Test: `tests/unit/security/permission-policy.test.ts`
- Test: `tests/unit/cli/command-router.test.ts`
- Test: `tests/integration/stage-four-web-search.test.ts`

### 5.1 Test input validation and output budgeting

- [ ] Build a fake provider and test query length, maxResults default and range, domain counts, hostname-only validation, and include/exclude overlap.
- [ ] Count Unicode code points with `[...text].length`, and truncate content by code points before the existing whole-output UTF-8 byte budget.
- [ ] Escape XML-sensitive characters in the `query` attribute (`&`, `<`, `>`, `"`, `'`). Result bodies remain text inside the untrusted wrapper; prevent a result from closing the wrapper by replacing literal `</untrusted_web_results>` with an inert escaped form.
- [ ] Test exact safe mappings for all `WebSearchErrorKind` values and the zero-result string.

### 5.2 Implement the tool

- [ ] Export:

```ts
export function createWebSearchTool(options: {
  provider: WebSearchProvider;
  maxContentChars: number;
  maxOutputBytes: number;
}): Tool<WebSearchToolInput>;
```

- [ ] Keep provider exceptions out of output. Map only by error kind to the messages in the spec.
- [ ] Return results inside exactly one `<untrusted_web_results ...>` block.

### 5.3 Wire availability and permissions

- [ ] Register `web_search` only when `config.tavilyApiKey !== undefined`.
- [ ] In both permission modes, return `ask` with reason `Web search sends the query to an external service`.
- [ ] Make `/status` derive availability from config/runtime capability rather than reading or printing the key. If the current command context cannot see config, add a boolean `webSearchAvailable` capability to the context; do not expose `AppConfig` wholesale.
- [ ] Add the web trust/privacy rules to the system prompt.

### 5.4 Add a network-free integration test

- [ ] Add `tests/integration/stage-four-web-search.test.ts` proving:

  - no key means no tool definition and no fetch;
  - a key plus injected fake fetch registers the tool;
  - permission rejection produces a valid tool result;
  - permission approval returns normalized untrusted results;
  - ordinary Agent behavior remains unchanged.

If `createRuntime()` currently only injects a model provider, add `webSearchProvider?: WebSearchProvider` as a test seam. Prefer this over injecting global fetch into integration tests.

### 5.5 Verify and commit

- [ ] Run:

```bash
npm test -- tests/unit/web/web-search-tool.test.ts tests/unit/security/permission-policy.test.ts tests/unit/cli/command-router.test.ts tests/integration/stage-four-web-search.test.ts tests/unit/system-prompt.test.ts
npm run typecheck
git diff --check
```

- [ ] Commit:

```bash
git add src/web src/runtime/create-runtime.ts src/security/permission-policy.ts src/cli/commands/status-command.ts src/agent/system-prompt.ts tests
git commit -m "feat: add permission gated web search"
```

---

## Task 6: Record Deterministic Tool Evidence

**Files:**

- Create: `src/goals/verification-command.ts`
- Create: `src/goals/evidence-ledger.ts`
- Modify: `src/tools/executor.ts`
- Modify: `src/runtime/create-runtime.ts`
- Test: `tests/unit/goals/verification-command.test.ts`
- Test: `tests/unit/goals/evidence-ledger.test.ts`
- Test: `tests/unit/tools/executor.test.ts`

### 6.1 Implement and test command classification

- [ ] Write parameterized tests for every accepted command family and every rejected category in the spec.
- [ ] Reject compound shell syntax before examining command heads. The first version must return false when the command contains an unquoted or quoted occurrence of `|`, `>`, `<`, `;`, `&&`, or `||`. Conservative false negatives are acceptable; false positive verification is not.
- [ ] Match the trimmed command case-sensitively and require a token boundary, so `npm testing` and `pytester` are false.
- [ ] Implement `isVerificationCommand(command)` as a pure function with no shell execution.

### 6.2 Define an observer that cannot alter tool semantics

- [ ] Extend `ToolExecutorOptions` with:

```ts
export type ToolResultObserver = (
  call: ToolExecutionRequest,
  result: ToolExecutionResult,
) => void;

onResult?: ToolResultObserver;
```

- [ ] Refactor every return path through a private `finish(call, result)` helper. It calls the observer once for unknown tools, invalid input, denied/cancelled calls, success, tool-reported errors, and thrown execution failures.
- [ ] The observer is trusted internal code, but its exception must not change the tool result. Catch observer errors and report them through a new optional `onObserverError?: (error: unknown) => void`; never throw them into the Agent loop.
- [ ] Add tests proving exactly-once observation and unchanged result semantics for every path.

### 6.3 Implement EvidenceLedger

- [ ] Use this interface:

```ts
export class EvidenceLedger {
  constructor(options: {
    state: EvidenceState;
    clock?: () => Date;
  });

  observe(call: ToolExecutionRequest, result: ToolExecutionResult): void;
  snapshot(): EvidenceState;
  hasFreshSuccessfulVerification(): boolean;
}
```

- [ ] Only a non-error `write_file` or `edit_file` result with a string `metadata.path` increments revision and records a path.
- [ ] For `run_command`, read the command from `call.input.command`; read exit/timeout/cancel from metadata; record failures too. If metadata is malformed, record conservative values (`exitCode: null`, false flags unless the error code is `cancelled`) and never treat it as successful.
- [ ] Keep only the newest 20 commands with `slice(-20)`.
- [ ] Add tests for revision changes, path deduplication, stale verification, failed writes, malformed metadata, and defensive snapshots.

### 6.4 Wire session-owned evidence

- [ ] Construct one ledger over `session.evidence` in `createRuntime()` and attach it to `ToolExecutor.onResult`.
- [ ] Send observer errors to the existing renderer/error path without including tool inputs.
- [ ] Confirm the ordinary tool result returned to history contains no Evidence-only fields.

### 6.5 Verify and commit

- [ ] Run:

```bash
npm test -- tests/unit/goals/verification-command.test.ts tests/unit/goals/evidence-ledger.test.ts tests/unit/tools/executor.test.ts
npm run typecheck
git diff --check
```

- [ ] Commit:

```bash
git add src/goals/verification-command.ts src/goals/evidence-ledger.ts src/tools/executor.ts src/runtime/create-runtime.ts tests/unit/goals tests/unit/tools/executor.test.ts
git commit -m "feat: record deterministic tool evidence"
```

---

## Task 7: Add Explicit `/goal` Session Control

**Files:**

- Create: `src/cli/commands/goal-command.ts`
- Modify: `src/sessions/session-manager.ts`
- Modify: `src/cli/command.ts`
- Modify: `src/cli/commands/register-core-commands.ts`
- Modify: `src/cli/help.ts`
- Modify: `src/cli/renderer.ts`
- Test: `tests/unit/cli/command-router.test.ts`
- Test: `tests/unit/sessions/session-manager.test.ts`
- Test: `tests/integration/session-lifecycle.test.ts`

### 7.1 Add Goal state methods

- [ ] Add these `SessionManager` methods and expose them through `CommandContext`:

```ts
goal(): GoalState | null;
async setGoal(condition: string): Promise<GoalState>;
async clearGoal(): Promise<void>;
```

- [ ] Validate trimmed condition length as 1–1000 Unicode code points. `setGoal` replaces the old Goal with active status, timestamps, zero continuations, and no last decision.
- [ ] `clearGoal` changes an existing Goal to cancelled for the duration of the mutation and then stores `null`; the externally visible/session persisted result is `null`, matching “clear”.
- [ ] Flush command mutations immediately. `/new` gets null Goal; `/resume` restores it.

### 7.2 Implement `/goal`

- [ ] `/goal` shows condition, status, last decision, and a short Evidence summary from the session.
- [ ] `/goal clear` clears it.
- [ ] Any other non-empty args are the condition, including spaces and Chinese text. Do not parse them as flags.
- [ ] Empty condition after trimming prints `Usage: /goal [clear|<completion condition>]` only if the raw form was invalid; bare `/goal` remains the view action.
- [ ] Creation prints the exact three-line output from the spec and does not call the model.

### 7.3 Test persistence and command isolation

- [ ] Test create, replace, show, clear, invalid length, new, resume, and no model-history append.
- [ ] Verify renderer output in TTY and non-TTY without adding animation.

### 7.4 Verify and commit

- [ ] Run:

```bash
npm test -- tests/unit/cli/command-router.test.ts tests/unit/cli/renderer.test.ts tests/unit/sessions/session-manager.test.ts tests/integration/session-lifecycle.test.ts
npm run typecheck
git diff --check
```

- [ ] Commit:

```bash
git add src/cli src/sessions/session-manager.ts tests/unit/cli tests/unit/sessions/session-manager.test.ts tests/integration/session-lifecycle.test.ts
git commit -m "feat: add explicit goal controls"
```

---

## Task 8: Implement GoalEvaluator and Host GoalPolicy

**Files:**

- Create: `src/goals/goal-evaluator.ts`
- Create: `src/goals/goal-policy.ts`
- Test: `tests/unit/goals/goal-evaluator.test.ts`
- Test: `tests/unit/goals/goal-policy.test.ts`

### 8.1 Build a no-tools evaluator adapter

- [ ] Follow the streaming collection pattern in `src/agent/compactor.ts`, but do not reuse its prompt or allow tool definitions.
- [ ] Export:

```ts
export class ModelGoalEvaluator implements GoalEvaluatorPort {
  constructor(options: {
    provider: ModelProvider;
    systemPrompt?: string;
  });

  evaluate(input: GoalEvaluationInput): Promise<GoalEvaluationDecision>;
}
```

- [ ] Serialize condition, Plan, Evidence, and only the most recent 12 messages into one evaluator user message. Mark every section as untrusted evaluation data.
- [ ] Make the provider request with `tools: []` and the caller's signal.
- [ ] Collect text deltas; reject any completed assistant message containing a `tool_call` block.
- [ ] Accept a JSON object optionally wrapped in one Markdown JSON fence, but reject prose before or after it.
- [ ] Strictly validate `satisfied`, `reason`, `missingEvidence`, and optional `nextInstruction`; reject unknown keys, excessive lengths, more than 8 missing items, or an empty reason.
- [ ] Convert all evaluator protocol failures to one internal `GoalEvaluationError`; do not echo raw evaluator output.

### 8.2 Test evaluator isolation and parsing

- [ ] Use a scripted `ModelProvider` to prove `tools` is empty, cancellation propagates, legal JSON parses, fenced JSON parses, and malformed/oversized/tool-calling responses fail closed.
- [ ] Do not retry inside the evaluator; provider-level retry behavior is outside this class.

### 8.3 Implement deterministic GoalPolicy

- [ ] Export a pure function:

```ts
export function applyGoalPolicy(input: {
  modelDecision: GoalEvaluationDecision;
  plan: PlanState;
  evidence: EvidenceState;
}): GoalEvaluationDecision;
```

- [ ] If the model already says incomplete, retain incomplete and normalize/deduplicate missing reasons.
- [ ] If any Plan item is not completed, force `satisfied: false` and append `The active plan still has unfinished items.`
- [ ] If `changedPaths.length > 0` and there is no fresh successful verification at current revision, force incomplete and append `No successful verification command has run after the latest workspace edit.`
- [ ] Do not require command evidence when this session has recorded no workspace edits.
- [ ] Never mutate the input objects; cap output using evaluator bounds.

### 8.4 Verify and commit

- [ ] Run:

```bash
npm test -- tests/unit/goals/goal-evaluator.test.ts tests/unit/goals/goal-policy.test.ts
npm run typecheck
git diff --check
```

- [ ] Commit:

```bash
git add src/goals/goal-evaluator.ts src/goals/goal-policy.ts tests/unit/goals
git commit -m "feat: evaluate goals against host evidence"
```

---

## Task 9: Add StopGate and GoalController Without Forking the Loop

**Files:**

- Create: `src/goals/goal-controller.ts`
- Modify: `src/agent/runner.ts`
- Modify: `src/agent/result.ts`
- Modify: `src/agent/events.ts`
- Modify: `src/runtime/create-runtime.ts`
- Modify: `src/skills/skill-prompt.ts` or the current dynamic prompt composition module
- Test: `tests/unit/agent/runner.test.ts`
- Test: `tests/unit/goals/goal-controller.test.ts`
- Test: `tests/integration/stage-four-goal.test.ts`

### 9.1 Add the generic StopGate seam first

- [ ] Put the generic interface beside `AgentRunner` or in `src/agent/stop-gate.ts` if that avoids a goals dependency:

```ts
export type StopGateDecision =
  | {
      action: "stop";
      outcome?: "verified" | "incomplete";
      verification?: GoalEvaluationDecision;
    }
  | { action: "continue"; feedback: string }
  | { action: "fail"; message: string };

export interface StopGate {
  beginRun?(): void;
  evaluate(input: {
    messages: readonly Message[];
    signal: AbortSignal;
  }): Promise<StopGateDecision>;
}
```

- [ ] Add `stopGate?: StopGate` to `AgentRunnerOptions`. Call `beginRun()` once immediately before appending the user's ordinary message.
- [ ] At the existing `calls.length === 0` branch only, evaluate the gate. Preserve `completed` with no gate.
- [ ] `continue` appends the fixed feedback as a user text message and returns to the same while loop. It consumes future steps normally.
- [ ] `fail` maps to `internal_failed`. Cancellation during evaluation maps to `cancelled`.
- [ ] Add runner tests for no gate, stop, continue then stop, fail, cancel, and maxSteps. These tests prove there is still one loop.

### 9.2 Implement GoalController state transitions

- [ ] The controller receives closures so it always reads current session-owned state:

```ts
export class GoalController implements StopGate {
  constructor(options: {
    goal: () => GoalState | null;
    plan: () => PlanState;
    evidence: () => EvidenceState;
    evaluator: GoalEvaluatorPort;
    maxAutomaticContinuations: number;
    clock?: () => Date;
    onEvent?: (event: AgentEvent) => void;
  });
}
```

- [ ] `beginRun()` resets the in-memory attempt count and sets the active Goal's persisted `automaticContinuations` to 0.
- [ ] If Goal is absent or not active, return `stop` without calling evaluator.
- [ ] Emit evaluation-started, call evaluator, apply GoalPolicy, save `lastDecision`, and emit evaluation-completed.
- [ ] On satisfied: set status verified and return stop.
- [ ] On an incomplete decision while the persisted count is below 3, increment it and return continue. After three actual continuations, the next incomplete evaluation returns stop with outcome `incomplete` without incrementing again. This permits at most three injected feedback messages and at most four evaluator checks in one outer run.
- [ ] Map outcome `verified` to `goal_verified`, `incomplete` to `goal_incomplete`, and absent outcome to ordinary `completed`.
- [ ] Build feedback using constant wrapper tags. Include bounded, bullet-form missing evidence and optional nextInstruction; never include webpage output.
- [ ] Evaluator failure returns `fail` with `Goal evaluation failed; the goal remains active.` Goal state remains active.

### 9.3 Extend events and results exhaustively

- [ ] Add the three events from the spec.
- [ ] Add `goal_verified` and `goal_incomplete` to `RunResult`, session stats schema enum, renderer status mapping, and every exhaustive test/switch.
- [ ] Update checkpoint stats exactly as for other terminal RunResults.

### 9.4 Wire dynamic active Goal prompt

- [ ] Construct `ModelGoalEvaluator` and `GoalController` only once per runtime, using the same provider instance as the worker.
- [ ] Pass the controller as `stopGate` regardless of state; it is a no-op when no active Goal.
- [ ] Extend the dynamic system prompt with a bounded `<active_goal>` block only for active Goals. XML-escape the condition so it cannot close the block. Do not include verified/cancelled Goals.
- [ ] Ensure Plan/Evidence mutations are checkpointed after the outer run.

### 9.5 Add end-to-end Goal integration tests

- [ ] Script provider turns for:

  - ordinary task: one worker request, no evaluator request, completed;
  - active Goal verified immediately;
  - incomplete, host feedback, worker continues, then verified;
  - model says satisfied but Plan pending forces continuation;
  - model says satisfied after edit but before verification forces continuation;
  - verification at stale revision forces continuation;
  - three continuations followed by a fourth incomplete evaluation return `goal_incomplete` and leave Goal active;
  - evaluator malformed output returns `internal_failed` and leaves Goal active;
  - cancel and max-step paths preserve active Goal.

- [ ] Assert evaluator requests always have zero tools and worker requests still receive normal tools.

### 9.6 Verify and commit

- [ ] Run:

```bash
npm test -- tests/unit/agent/runner.test.ts tests/unit/goals/goal-controller.test.ts tests/integration/stage-four-goal.test.ts tests/unit/cli/renderer.test.ts tests/unit/sessions/session-schema.test.ts tests/unit/sessions/session-manager.test.ts
npm run typecheck
git diff --check
```

- [ ] Commit:

```bash
git add src/agent src/goals/goal-controller.ts src/runtime/create-runtime.ts src/skills src/sessions src/cli/renderer.ts tests
git commit -m "feat: continue active goals until verified"
```

---

## Task 10: Finish CLI Presentation and Documentation

**Files:**

- Modify: `src/cli/renderer.ts`
- Modify: `src/cli/commands/status-command.ts`
- Modify: `src/cli/help.ts`
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `docs/PROJECT_REQUIREMENTS.md`
- Test: `tests/unit/cli/renderer.test.ts`
- Test: `tests/unit/cli/help.test.ts`
- Test: `tests/integration/stage-four-goal.test.ts`
- Test: `tests/integration/stage-four-web-search.test.ts`

### 10.1 Complete stable TTY and non-TTY output

- [ ] Render the exact Plan and Goal examples from the spec, using existing `TerminalTheme` colors.
- [ ] Keep evaluation feedback compact: one header, at most three missing-evidence lines on screen, then `… and N more`.
- [ ] Make `/help` list `/plan` and `/goal`; make `/status` list Goal state, Plan completed/total, and web search availability without secrets.
- [ ] Add snapshot/string assertions for TTY, non-TTY, and `NO_COLOR`; do not add cursor animation.

### 10.2 Document operator behavior and limits

- [ ] In `README.md`, document:

  - optional Tavily setup and external query disclosure;
  - `/plan`, `/plan clear`, `/goal`, `/goal <condition>`, `/goal clear`;
  - explicit Goal mode and max three automatic continuations;
  - fresh verification semantics;
  - Evidence observes only tools run by NJUAgent, not external terminal edits;
  - no automatic Git rollback;
  - an example demo flow using the acceptance scenario.

- [ ] Update `docs/PROJECT_REQUIREMENTS.md` so Stage Four scope and non-goals match the design spec. Do not mark features complete until the final suite passes.
- [ ] Keep `.env.example` values non-secret.

### 10.3 Run the full acceptance suite

- [ ] Run focused Stage Four tests first:

```bash
npm test -- tests/unit/planning tests/unit/goals tests/unit/web tests/integration/stage-four-goal.test.ts tests/integration/stage-four-web-search.test.ts
```

- [ ] Run all required gates:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

- [ ] Inspect for accidental network access and secret leakage:

```bash
rg -n "api\.tavily\.com|TAVILY_API_KEY|tavilyApiKey" src tests README.md .env.example docs
rg -n "TODO|TBD|FIXME|placeholder|not implemented" src tests README.md docs/PROJECT_REQUIREMENTS.md
```

Expected: Tavily URL/key references occur only in provider/config/docs/tests; there are no unfinished implementation markers. A descriptive `.env.example` value is allowed, but no real key-like value is committed.

### 10.4 Perform two manual smoke tests

- [ ] Without `TAVILY_API_KEY`, run the built CLI in a temporary demo workspace. Verify welcome, `/status`, `/plan`, `/goal`, a simple ordinary message, and clean exit. Confirm no search tool is offered.
- [ ] With a deliberately invalid placeholder Tavily key, invoke a search, approve the permission prompt, and verify the user sees only `Web search authentication failed.` Confirm the placeholder key is absent from terminal output. Do not place a real key in shell history for this smoke test.
- [ ] Run the Goal acceptance scenario with the scripted integration fixture or a disposable local fixture; do not modify the NJUAgent source tree as the Agent's demo workspace.

### 10.5 Final review and commit

- [ ] Review the spec line by line and check every item in Sections 16–18.
- [ ] Review `git diff --stat`, `git diff`, and `git status --short`; remove unrelated or generated files.
- [ ] Only after all gates pass, mark Stage Four complete in `docs/PROJECT_REQUIREMENTS.md`.
- [ ] Commit:

```bash
git add src/cli README.md .env.example docs/PROJECT_REQUIREMENTS.md tests
git commit -m "docs: complete reliable agent stage"
```

---

## Handoff Rules for DSH

1. Read the linked design spec completely before editing.
2. Execute one task at a time and tick its checkboxes in a private working copy or progress message; do not edit this plan just to mark progress unless asked.
3. If an existing interface differs from a snippet, preserve the behavioral contract and make the smallest type-compatible adaptation. Do not redesign the architecture.
4. If a focused test exposes a pre-existing failure, record the exact command and failure, then determine whether Stage Four touches that path. Fix it only when in scope.
5. Never skip the initial failing-test run. It distinguishes a meaningful test from one that passes without exercising the new behavior.
6. Never weaken an assertion, permission check, host evidence rule, output budget, or strict schema merely to make a test pass.
7. Stop and report a blocker only for unavailable credentials required by a manual real-service check, irreconcilable pre-existing user edits, or a verified contradiction in this plan. Tavily credentials are not required for automated completion.
8. Final delivery must include commit hashes, exact verification commands and outcomes, any skipped optional smoke test, and remaining known limitations. Do not claim completion from model prose; use command output.
