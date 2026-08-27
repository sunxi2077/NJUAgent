# NJUAgent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a usable TypeScript/Node.js command-line coding agent that talks to a DeepSeek Anthropic-compatible endpoint, executes six local tools inside a guarded workspace, streams progress, handles failures, and is verified by offline tests.

**Architecture:** The CLI owns input and rendering, `AgentRunner` owns the model/tool loop, providers translate vendor protocol into internal discriminated unions, and `ToolExecutor` applies validation and permission policy before invoking registered local tools. All core behavior is testable with a scripted provider; only one opt-in smoke test touches the real API.

**Tech Stack:** Node.js 20+, TypeScript 5, npm, `@anthropic-ai/sdk`, Ajv, fast-glob, picocolors, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-27-njuagent-design.md`

## Global Constraints

- Use TypeScript + Node.js and native ESM.
- Use `@anthropic-ai/sdk` only as a normal Messages API client; never use an agent SDK or framework.
- Keep SDK types inside `src/providers/anthropic-provider.ts`.
- Execute tool calls in their original order and produce exactly one result for every tool-call ID.
- Restrict file tools to the selected workspace; command execution always uses that workspace as `cwd`.
- Keep API keys in environment variables and out of output, fixtures, and version control.
- Follow red-green-refactor for every production behavior; run the named test once before and once after implementation.
- Commit each completed task independently after its focused tests and the full suite pass.

---

## File Map

```text
package.json                         scripts, dependencies and CLI entry
tsconfig.json                        strict ESM compiler settings
vitest.config.ts                     deterministic test configuration
.gitignore                           credentials, dependencies and build output
.env.example                         model configuration names with placeholder values
src/index.ts                         executable composition root
src/config.ts                        environment and CLI configuration validation
src/agent/messages.ts                internal messages and history invariants
src/agent/events.ts                  renderer-facing events
src/agent/result.ts                  terminal run states and statistics
src/agent/history.ts                 append-only conversation and compaction
src/agent/context-policy.ts          size estimate and deterministic compaction trigger
src/agent/runner.ts                  model/tool control loop
src/agent/system-prompt.ts           stable coding behavior instructions
src/providers/provider.ts            vendor-neutral provider contract and errors
src/providers/anthropic-provider.ts  Anthropic SDK stream adapter
src/providers/retry.ts               bounded retry policy
src/tools/tool.ts                     tool contracts and structured output
src/tools/registry.ts                 unique-name registry and schemas
src/tools/executor.ts                 validation, permission and execution pipeline
src/tools/file-tools.ts               read_file, write_file and edit_file
src/tools/search-tools.ts             list_files and search_text
src/tools/command-tool.ts             run_command and process cancellation
src/security/workspace.ts             canonical path boundary
src/security/permission-policy.ts     allow, ask and deny decisions
src/cli/renderer.ts                   TTY and plain-event rendering
src/cli/prompt.ts                     input and permission prompts
src/cli/session.ts                    multi-turn session and Ctrl-C ownership
tests/unit/**/*.test.ts               focused behavioral tests
tests/integration/agent.test.ts       real filesystem/tool loop with scripted provider
tests/fixtures/demo-project/**        deterministic demonstration project
README.md                             developer documentation
README.txt                            submission summary within 1000 Chinese characters
```

## Shared Interfaces

The following names are fixed across tasks:

```ts
export type AssistantMessage = {
  role: "assistant";
  content: AssistantBlock[];
};

export type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "message_completed"; message: AssistantMessage; stopReason: string };

export interface ModelProvider {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}

export interface Tool<TInput = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(input: TInput, context: ToolContext): Promise<ToolOutput>;
}

export type PermissionDecision =
  | { action: "allow" }
  | { action: "ask"; reason: string }
  | { action: "deny"; reason: string };
```

---

### Task 1: Project Scaffold and Message Invariants

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`
- Create: `src/agent/messages.ts`
- Test: `tests/unit/agent/messages.test.ts`

**Interfaces:**
- Produces: `Message`, `UserBlock`, `AssistantBlock`, `AssistantMessage`, `assertValidHistory(messages: readonly Message[]): void`.

- [x] **Step 1: Initialize Git and the TypeScript test scaffold**

Use `git init`, create strict ESM configuration, and define scripts `build`, `test`, `test:watch`, `typecheck`, `start`, and `dev`. Install the dependency set from the Tech Stack.

- [x] **Step 2: Write the failing message-invariant test**

```ts
import { describe, expect, test } from "vitest";
import { assertValidHistory, type Message } from "../../../src/agent/messages.js";

describe("assertValidHistory", () => {
  test("rejects a tool result whose id was not requested by the preceding assistant message", () => {
    const history: Message[] = [
      { role: "assistant", content: [{ type: "tool_call", id: "call-1", name: "read_file", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolCallId: "call-2", content: "x", isError: false }] },
    ];
    expect(() => assertValidHistory(history)).toThrow(/call-2/);
  });
});
```

- [x] **Step 3: Run the test and verify RED**

Run: `npm test -- tests/unit/agent/messages.test.ts`  
Expected: FAIL because `src/agent/messages.ts` does not exist.

- [x] **Step 4: Implement the message unions and invariant**

The function must allow text-only user messages, require tool results to immediately follow an assistant tool-call batch, reject duplicate/missing IDs, and accept results in the same order as calls.

- [x] **Step 5: Add success and duplicate-ID cases, then verify GREEN**

Run: `npm test -- tests/unit/agent/messages.test.ts`  
Expected: all message tests PASS.

- [x] **Step 6: Commit**

Run: `git add .gitignore .env.example package.json package-lock.json tsconfig.json vitest.config.ts src/agent/messages.ts tests/unit/agent/messages.test.ts && git commit -m "chore: initialize typed agent core"`.

### Task 2: Provider Contract, Events, Results, and Text-Only Loop

**Files:**
- Create: `src/providers/provider.ts`, `src/agent/events.ts`, `src/agent/result.ts`, `src/agent/history.ts`, `src/agent/runner.ts`
- Test: `tests/unit/agent/runner.test.ts`

**Interfaces:**
- Consumes: message types and `assertValidHistory` from Task 1.
- Produces: `ModelRequest`, `ProviderEvent`, `ModelProvider`, `AgentEvent`, `RunResult`, `ConversationHistory`, `AgentRunner.run(userText, signal): Promise<RunResult>`.

- [x] **Step 1: Write a failing text-only runner test**

```ts
test("completes after a final assistant message and preserves it", async () => {
  const provider = scriptedProvider([
    [{ type: "text_delta", text: "done" }, complete(textAssistant("done"), "end_turn")],
  ]);
  const history = new ConversationHistory();
  const runner = new AgentRunner({ provider, history, tools: emptyExecutor(), maxSteps: 4 });

  const result = await runner.run("fix it", new AbortController().signal);

  expect(result.status).toBe("completed");
  expect(history.snapshot()).toEqual([
    { role: "user", content: [{ type: "text", text: "fix it" }] },
    textAssistant("done"),
  ]);
});
```

- [x] **Step 2: Verify RED**

Run: `npm test -- tests/unit/agent/runner.test.ts`  
Expected: FAIL because the runner and provider contract are absent.

- [x] **Step 3: Implement the minimal text-only loop**

Collect streamed events, emit renderer-facing events, require one final `message_completed`, append only the complete assistant message, and return common statistics.

- [x] **Step 4: Add cancellation and missing-final-event tests**

Assert that an interrupted half stream is not appended and a stream without `message_completed` returns `model_failed`. The maximum-step behavior is exercised after the tool loop exists in Task 4.

- [x] **Step 5: Verify GREEN and commit**

Run: `npm test -- tests/unit/agent/runner.test.ts` then `npm test`.  
Commit: `git commit -am "feat: add vendor-neutral agent loop"` after staging new files.

### Task 3: Tool Registry and Execution Pipeline

**Files:**
- Create: `src/tools/tool.ts`, `src/tools/registry.ts`, `src/tools/executor.ts`
- Create: `src/security/permission-policy.ts`
- Test: `tests/unit/tools/executor.test.ts`

**Interfaces:**
- Produces: `Tool`, `ToolOutput`, `ToolContext`, `ToolRegistry`, `ToolExecutor.execute(call, signal)`, `PermissionPolicy.decide(request)`.

- [x] **Step 1: Write the failing behavior test**

```ts
test("returns a structured error without calling a tool when input violates its schema", async () => {
  const executor = executorWith(echoTool);
  const result = await executor.execute(
    { id: "c1", name: "echo", input: { value: 42 } },
    new AbortController().signal,
  );
  expect(result).toMatchObject({ toolCallId: "c1", isError: true, code: "invalid_input" });
});
```

- [x] **Step 2: Verify RED**

Run: `npm test -- tests/unit/tools/executor.test.ts`.

- [x] **Step 3: Implement registry, Ajv validation, and executor**

Unknown tools produce `unknown_tool`; thrown exceptions produce `execution_failed`; deny produces `permission_denied`; ask delegates to an injected async confirmation function. Every branch retains the original tool-call ID.

- [x] **Step 4: Add tests for duplicate registration, deny, ask-decline, throw, and abort**

Each test asserts the returned real `ToolOutput`, not an assertion on a mocked executor.

- [x] **Step 5: Verify GREEN and commit**

Run focused tests and `npm test`; commit as `feat: add validated tool execution pipeline`.

### Task 4: Tool-Calling Agent Loop

**Files:**
- Modify: `src/agent/runner.ts`, `src/agent/history.ts`
- Modify: `tests/unit/agent/runner.test.ts`

**Interfaces:**
- Consumes: `ToolExecutor.execute` from Task 3.
- Produces: a loop that translates each assistant `tool_call` into one ordered user `tool_result` block.

- [x] **Step 1: Write a failing two-step tool-loop test**

Use a scripted provider whose first response calls `read_file` and whose second response is text-only. Assert the second request contains the assistant tool call followed by the matching user tool result.

- [x] **Step 2: Verify RED**

Run: `npm test -- tests/unit/agent/runner.test.ts -t "executes tool calls"`.

- [x] **Step 3: Implement serial execution and result appending**

Execute calls in content order, emit start/complete events, append one user message containing all ordered results, then continue the model loop.

- [x] **Step 4: Add multi-tool failure, mid-batch cancellation, and maximum-step tests**

On cancellation, already announced but unexecuted calls receive `cancelled` results so `assertValidHistory` still passes.

- [x] **Step 5: Verify GREEN and commit**

Run all runner and message tests, then the full suite; commit as `feat: complete model tool-call loop`.

### Task 5: Canonical Workspace Boundary

**Files:**
- Create: `src/security/workspace.ts`
- Test: `tests/unit/security/workspace.test.ts`

**Interfaces:**
- Produces: `Workspace.open(root)`, `resolveExisting(relativePath)`, `resolveForWrite(relativePath)`, and `toRelative(absolutePath)`.

- [x] **Step 1: Write failing traversal and symlink tests**

Create real temporary directories. Assert normal in-root paths resolve, while `../secret`, absolute paths, an existing symlink to outside, and a nonexistent child below an outside symlink all reject with `WorkspaceViolationError`.

- [x] **Step 2: Verify RED**

Run: `npm test -- tests/unit/security/workspace.test.ts`.

- [x] **Step 3: Implement canonical resolution**

Use `realpath`, `lstat`, `path.relative`, and the nearest existing parent for write targets. A valid relative result must be empty or neither absolute nor start with `..` plus a separator.

- [x] **Step 4: Verify GREEN and commit**

Run focused and full tests; commit as `feat: enforce workspace file boundary`.

### Task 6: File Tools

**Files:**
- Create: `src/tools/file-tools.ts`
- Test: `tests/unit/tools/file-tools.test.ts`

**Interfaces:**
- Consumes: `Workspace` and `Tool`.
- Produces: `createReadFileTool`, `createWriteFileTool`, `createEditFileTool`.

- [x] **Step 1: Write failing tests for read pagination and exact edit**

Use a temporary workspace with literal fixture text. Assert one-based line ranges, no-match failure, ambiguous-match failure, one-match replacement, explicit replace-all, and write-parent creation.

- [x] **Step 2: Verify RED**

Run: `npm test -- tests/unit/tools/file-tools.test.ts`.

- [x] **Step 3: Implement the three tools**

Return stable text plus metadata `{ path, bytes, truncated }`; reject NUL bytes and binary input; enforce the configured model-output byte budget.

- [x] **Step 4: Add workspace-escape and truncation cases, verify GREEN, and commit**

Run focused and full tests; commit as `feat: add guarded file tools`.

### Task 7: File Listing and Text Search

**Files:**
- Create: `src/tools/search-tools.ts`
- Test: `tests/unit/tools/search-tools.test.ts`

**Interfaces:**
- Produces: `createListFilesTool`, `createSearchTextTool`.

- [x] **Step 1: Write failing tests using a real temporary tree**

Assert sorted relative output, glob filtering, default exclusion of `.git` and `node_modules`, line-numbered matches, binary-file skipping, result-count limit, and truncation marker.

- [x] **Step 2: Verify RED**

Run: `npm test -- tests/unit/tools/search-tools.test.ts`.

- [x] **Step 3: Implement recursive listing and search**

Use fast-glob for candidate paths, canonicalize every candidate through `Workspace`, read only files below the size limit, and sort results for reproducibility.

- [x] **Step 4: Verify GREEN and commit**

Run focused and full tests; commit as `feat: add workspace search tools`.

### Task 8: Command Execution and Permission Classification

**Files:**
- Create: `src/tools/command-tool.ts`
- Modify: `src/security/permission-policy.ts`
- Test: `tests/unit/tools/command-tool.test.ts`, `tests/unit/security/permission-policy.test.ts`

**Interfaces:**
- Produces: `createRunCommandTool`, `BalancedPermissionPolicy`, `CautiousPermissionPolicy`.

- [x] **Step 1: Write failing real-process tests**

Run Node child commands in a temporary workspace. Assert captured stdout/stderr/exit code, fixed `cwd`, nonzero exit, timeout, AbortSignal cancellation, live chunk events, and head-tail truncation.

- [x] **Step 2: Verify RED**

Run: `npm test -- tests/unit/tools/command-tool.test.ts`.

- [x] **Step 3: Implement cross-platform shell execution**

Use `/bin/sh -lc` on POSIX and `cmd.exe /d /s /c` on Windows, spawn detached where process-group termination is supported, and ensure timers/listeners are cleaned in every terminal branch.

- [x] **Step 4: Write and implement permission behavior**

Literal cases must cover allow for tests and inspection, ask for deletion/package installation/network/destructive Git, deny for privilege escalation/system shutdown/disk formatting/obvious outside-workspace targets, and cautious mode asking for every write or command.

- [x] **Step 5: Verify GREEN and commit**

Run focused and full tests; commit as `feat: add cancellable command execution`.

### Task 9: Deterministic Context Control

**Files:**
- Create: `src/agent/context-policy.ts`
- Modify: `src/agent/history.ts`, `src/agent/runner.ts`
- Test: `tests/unit/agent/context-policy.test.ts`

**Interfaces:**
- Produces: `ContextPolicy.prepare(messages, usage): ContextDecision` where decision is `continue`, `compacted`, or `stop`.

- [x] **Step 1: Write a failing compaction test**

Build literal old and recent tool batches. Assert only old tool-result content becomes a metadata placeholder, IDs and call ordering remain unchanged, recent messages remain byte-for-byte equal, and an oversized remainder returns `stop`.

- [x] **Step 2: Verify RED**

Run: `npm test -- tests/unit/agent/context-policy.test.ts`.

- [x] **Step 3: Implement conservative estimation and compaction**

Use provider usage when available and a documented character estimate otherwise. Never remove user text, assistant tool calls, current results, or the configured recent-message window.

- [x] **Step 4: Integrate `context_limit`, verify GREEN, and commit**

Run context, runner, history, and full tests; commit as `feat: bound conversation context`.

### Task 10: Bounded Model Retry

**Files:**
- Create: `src/providers/retry.ts`
- Modify: `src/agent/runner.ts`
- Test: `tests/unit/providers/retry.test.ts`

**Interfaces:**
- Produces: `withModelRetry(openStream, policy, signal, onRetry)` and typed `ProviderError` with `retryable` and optional `retryAfterMs`.

- [x] **Step 1: Write failing retry tests**

Use injected zero-delay sleep. Assert two retryable failures followed by success make three attempts; auth/invalid-request errors make one; abort stops immediately; attempts never exceed three.

- [x] **Step 2: Verify RED**

Run: `npm test -- tests/unit/providers/retry.test.ts`.

- [x] **Step 3: Implement retry before history mutation**

Use exponential delays with injectable jitter, respect larger `Retry-After`, emit retry events, and never append a partial assistant message.

- [x] **Step 4: Verify GREEN and commit**

Run focused, runner, and full tests; commit as `feat: retry transient model failures`.

### Task 11: Anthropic-Compatible Provider

**Files:**
- Create: `src/providers/anthropic-provider.ts`
- Test: `tests/unit/providers/anthropic-provider.test.ts`

**Interfaces:**
- Consumes: internal `ModelRequest`, `ProviderEvent`, and `ProviderError`.
- Produces: `AnthropicProvider` implementing `ModelProvider`.

- [x] **Step 1: Write failing fixture-driven adapter tests**

Inject a narrow `messages.create` client boundary. Feed complete Anthropic stream event fixtures for text and tool use; assert internal deltas and one final `message_completed`. Include malformed partial JSON and mapped 401/429/500 cases.

- [x] **Step 2: Verify RED**

Run: `npm test -- tests/unit/providers/anthropic-provider.test.ts`.

- [x] **Step 3: Implement request and stream translation**

Map internal messages and JSON Schemas to Anthropic request blocks, accumulate tool JSON by content index, validate completion, map usage, and convert SDK errors without exporting an SDK type.

- [x] **Step 4: Verify GREEN and commit**

Run focused, typecheck, and full tests; commit as `feat: add Anthropic-compatible model provider`.

### Task 12: Renderer, Prompt, and Ctrl-C Semantics

**Files:**
- Create: `src/cli/renderer.ts`, `src/cli/prompt.ts`, `src/cli/session.ts`
- Test: `tests/unit/cli/renderer.test.ts`, `tests/unit/cli/session.test.ts`

**Interfaces:**
- Produces: `Renderer.handle(event)`, `Prompt.read()`, `Prompt.confirm()`, `CliSession.start()`.

- [x] **Step 1: Write failing plain-renderer tests**

Inject memory stdout with `isTTY=false`. Assert text deltas, tool start/end, retry, command output, and final status become newline-safe plain records with no ANSI bytes.

- [x] **Step 2: Verify RED**

Run: `npm test -- tests/unit/cli/renderer.test.ts`.

- [x] **Step 3: Implement permanent and transient rendering**

Use picocolors only when TTY and `NO_COLOR` is absent. Clear the transient status before permanent writes and restore it afterward. Apply UI output budget separately from model-result budget.

- [x] **Step 4: Write and implement session cancellation tests**

Inject prompt and runner fakes at their public boundary. Assert Ctrl-C during a run aborts that run and returns to input; Ctrl-C at idle or `/exit` ends the session; a second concurrent run cannot begin.

- [x] **Step 5: Verify GREEN and commit**

Run CLI tests and full suite; commit as `feat: add streaming terminal session`.

### Task 13: Configuration and Executable Composition

**Files:**
- Create: `src/config.ts`, `src/agent/system-prompt.ts`, `src/index.ts`
- Modify: `package.json`
- Test: `tests/unit/config.test.ts`, `tests/unit/system-prompt.test.ts`

**Interfaces:**
- Produces: `loadConfig(env, argv): AppConfig`, executable `nju-agent` bin.

- [x] **Step 1: Write failing configuration behavior tests**

Assert missing variable names are listed without values; numeric limits reject zero, negatives, and nonnumbers; defaults are applied; `--workspace`, `--debug`, and `--permission-mode` override only their documented fields.

- [x] **Step 2: Verify RED**

Run: `npm test -- tests/unit/config.test.ts`.

- [x] **Step 3: Implement config, prompt, and composition root**

Construct workspace, policies, tools, executor, provider, history, runner, renderer, prompt, and session in `src/index.ts`. The system prompt explicitly asks for minimal changes, relevant verification, and truthful final reporting.

- [x] **Step 4: Verify build and CLI startup errors**

Run `npm run typecheck`, `npm run build`, and the built CLI without model variables; expect a concise actionable configuration error and nonzero exit.

- [x] **Step 5: Commit**

Commit as `feat: assemble runnable coding agent CLI`.

### Task 14: End-to-End Offline Integration

**Files:**
- Create: `tests/integration/agent.test.ts`
- Create: `tests/fixtures/demo-project/package.json`, `tests/fixtures/demo-project/src/validate.ts`, `tests/fixtures/demo-project/test/validate.test.ts`

**Interfaces:**
- Exercises the real history, runner, registry, executor, workspace, file tools, search tools, and command tool with only the provider scripted.

- [ ] **Step 1: Write the failing end-to-end test**

Script the model to list/read, edit, run a failing test, inspect output, edit again, run a passing test, and finish. Copy the demo fixture to a temporary workspace and assert the final file content, command exit records, event order, valid history, and `completed` status.

- [ ] **Step 2: Verify RED and correct the first exposed integration gap**

Run: `npm test -- tests/integration/agent.test.ts`. The expected first failure must identify an actual missing integration rather than a malformed fixture.

- [ ] **Step 3: Implement only the required integration corrections**

Keep corrections in the owning production modules; do not add test-only branches.

- [ ] **Step 4: Verify GREEN, full quality gates, and commit**

Run `npm test`, `npm run typecheck`, and `npm run build`; commit as `test: verify offline coding-agent workflow`.

### Task 15: Real API Smoke Test and Delivery Documentation

**Files:**
- Create: `tests/smoke/anthropic-api.smoke.ts`
- Create: `README.md`, `README.txt`
- Modify: `docs/PROJECT_REQUIREMENTS.md`

**Interfaces:**
- Produces: `npm run test:smoke`, complete run instructions, architecture explanation, security limitations, and submission checklist.

- [ ] **Step 1: Add an opt-in smoke script**

The script exits with a clear skip message when variables are absent. When present, it performs one short text turn and one harmless `read_file` tool turn against a temporary workspace; it never prints request headers or environment values.

- [ ] **Step 2: Run offline quality gates**

Run `npm test`, `npm run typecheck`, and `npm run build`. All must exit zero before checking requirement boxes.

- [ ] **Step 3: Run the real API smoke test when credentials are available**

Run: `npm run test:smoke`. Record only model ID, status, latency, and pass/fail; do not persist response text if it may contain local data.

- [ ] **Step 4: Write developer and submission documentation**

`README.md` must explain installation, environment variables, commands, architecture, tools, permissions, limitations, tests, and demo. `README.txt` must stay within 1000 Chinese characters and contain repository URL placeholder instructions without inventing an unpublished URL.

- [ ] **Step 5: Audit every requirement and commit**

For every checkbox in `docs/PROJECT_REQUIREMENTS.md`, link it to a test, command output, file, or remaining external delivery action. Mark only proven implementation items complete; leave video, public repository URL, form submission, and deadline-dependent items unchecked until actually done. Commit as `docs: document usage and delivery evidence`.

## Final Verification Gate

Before declaring the implementation complete, run fresh commands and inspect their full output:

```bash
npm test
npm run typecheck
npm run build
npm run test:smoke
git status --short
git log --oneline --decorate -15
```

Then manually run the built CLI in a copied demo workspace, complete one coding turn, cancel one in-progress command with `Ctrl-C`, and reject one permission prompt. Completion requires both automated evidence and these observable behaviors; the external video, public remote, ZIP, and form remain separate delivery tasks until performed.
