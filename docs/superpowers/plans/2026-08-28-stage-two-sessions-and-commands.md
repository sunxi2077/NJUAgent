# NJUAgent Stage-Two Sessions and Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local Slash Command control plane and reliable multi-session persistence with `/status`, `/sessions`, `/resume`, `/new`, `/history`, and `/exit`, while ordinary text continues through the existing AgentRunner.

**Architecture:** Store complete valid message history in one versioned JSON file per UUID. A SessionManager owns the active in-memory runtime and performs save-before-switch; SlashCommandRouter parses local commands and calls small handlers without sending commands to the model or writing them into conversation history.

**Tech Stack:** TypeScript 5.9, Node.js 20+, ESM, Vitest, Ajv, existing `ConversationHistory`, `AgentRunner`, Workspace and atomic JSON helper.

**Spec:** `docs/superpowers/specs/2026-08-28-stage-two-productization-design.md`

## Global Constraints

- Complete the CLI foundation plan first and begin from its green commit.
- Session data lives only under `${NJU_AGENT_HOME}/sessions`; never write Session data into the workspace.
- Persist complete messages, but never persist API Key, Base URL, request headers, transient streamed text, or child-process environment.
- Slash commands are local control operations and never become `Message` objects.
- Session switches are save-before-switch and commit-after-validate: failure must leave the original active runtime untouched.
- One corrupt Session file must not prevent listing or loading other valid Sessions.
- Full cross-session text search, automatic resume, deletion, rename, and export commands remain out of scope.
- Follow TDD and keep all first-stage and CLI-foundation tests green.

## File Responsibility Map

| File | Responsibility after this plan |
| --- | --- |
| `src/agent/history.ts` | Create from validated messages, replace, snapshot, and report size. |
| `src/agent/context-types.ts` | Define the checkpoint/state subset required by the Session V1 schema; the context plan extends this file. |
| `src/sessions/session-schema.ts` | `PersistedSessionV1`, creation/title helpers, Ajv and history validation. |
| `src/sessions/session-store.ts` | Atomic save, exact load, list, unique-prefix resolution, corrupt-file diagnostics. |
| `src/sessions/session-manager.ts` | Active Session, runtime factory, run/checkpoint, new/resume/flush/dirty behavior. |
| `src/sessions/session-format.ts` | Pure status, list, and bounded history views. |
| `src/cli/command.ts` | Command interfaces and command context. |
| `src/cli/command-router.ts` | Parse command/arguments, `//` escape, registry dispatch. |
| `src/cli/commands/*.ts` | Small handlers for help/status/sessions/resume/new/history/exit. |
| `src/cli/session.ts` | Route every non-empty input before deciding to run AgentRunner. |
| `src/index.ts` | Construct SessionStore, SessionManager, commands, and the dynamic run-turn delegate. |

---

### Task 1: Make ConversationHistory Loadable and Define the Session Schema

**Files:**
- Modify: `src/agent/history.ts`
- Create: `src/agent/context-types.ts`
- Create: `src/sessions/session-schema.ts`
- Modify: `tests/unit/agent/messages.test.ts`
- Modify: `tests/unit/agent/context-policy.test.ts`
- Create: `tests/unit/sessions/session-schema.test.ts`

**Interfaces:**
- Adds: `ConversationHistory.from(messages)`, `replace(messages)`, and `length`.
- Produces: `ContextCheckpoint` and `ContextState` in `src/agent/context-types.ts`; `PersistedSessionV1`, `createEmptySession(input)`, `deriveSessionTitle(text)`, and `parseSession(value)` in `session-schema.ts`.
- Validates both JSON structure and `assertValidHistory()` invariants.

- [ ] **Step 1: Write failing history load tests**

Add focused cases:

```ts
test("loads a defensive copy of valid messages", () => {
  const source: Message[] = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
  const history = ConversationHistory.from(source);
  source[0]!.content[0] = { type: "text", text: "mutated" };
  expect(history.snapshot()[0]).toEqual({
    role: "user",
    content: [{ type: "text", text: "hello" }],
  });
  expect(history.length).toBe(1);
});

test("replace rejects an invalid tool-result sequence without changing history", () => {
  const history = ConversationHistory.from([
    { role: "user", content: [{ type: "text", text: "safe" }] },
  ]);
  expect(() => history.replace([
    { role: "user", content: [{ type: "tool_result", toolCallId: "missing", content: "x", isError: false }] },
  ])).toThrow();
  expect(history.snapshot()).toHaveLength(1);
});
```

- [ ] **Step 2: Write failing schema tests**

Test `createEmptySession` defaults, UUID/timestamps, `New session`, canonical workspace, null active Skill, zero stats, and empty messages. Test deterministic title behavior:

```ts
expect(deriveSessionTitle("  fix\n  the   parser  ")).toBe("fix the parser");
expect([...deriveSessionTitle("x".repeat(80))]).toHaveLength(48);
```

Test rejection of unknown properties, non-ISO dates, invalid UUID, negative counters, a checkpoint covering more messages than exist, and invalid tool pairing. Assert failures use `SESSION_CORRUPT` and do not include the entire Session JSON.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
npm test -- tests/unit/agent/messages.test.ts tests/unit/sessions/session-schema.test.ts
```

- [ ] **Step 4: Implement history loading atomically**

Add:

```ts
static from(messages: readonly Message[]): ConversationHistory {
  const history = new ConversationHistory();
  history.replace(messages);
  return history;
}

get length(): number {
  return this.#messages.length;
}

replace(messages: readonly Message[]): void {
  const candidate = structuredClone(messages);
  assertValidHistory(candidate);
  this.#messages.splice(0, this.#messages.length, ...candidate);
}
```

Never partially replace on validation failure.

- [ ] **Step 5: Implement the exact V1 schema**

First create the shared persistence subset in `src/agent/context-types.ts`:

```ts
export type ContextCheckpoint = {
  summary: string;
  coveredMessageCount: number;
  createdAt: string;
  sourceEstimatedTokens: number;
};

export type ContextState = {
  checkpoint?: ContextCheckpoint;
  lastInputTokens?: number;
  compactionCount: number;
};
```

Then use the fields and meanings from design section 9, importing `ContextState` into the Session type. Ajv options must reject additional properties. After Ajv, call `assertValidHistory(session.messages)`, verify `coveredMessageCount <= messages.length`, and verify `createdAt/updatedAt/checkpoint.createdAt` parse as valid dates. Clone the returned object.

`deriveSessionTitle` collapses Unicode whitespace, trims, and slices by `[...text].slice(0, 48).join("")`; blank input returns `New session`.

- [ ] **Step 6: Verify and commit**

```bash
npm test -- tests/unit/agent tests/unit/sessions/session-schema.test.ts
npm run typecheck
git add src/agent/history.ts src/agent/context-types.ts src/sessions/session-schema.ts tests/unit/agent tests/unit/sessions/session-schema.test.ts
git commit -m "feat: define persistent session records"
```

---

### Task 2: Implement an Atomic, Corruption-Tolerant SessionStore

**Files:**
- Create: `src/sessions/session-store.ts`
- Create: `tests/unit/sessions/session-store.test.ts`

**Interfaces:**
- Produces:

```ts
export type SessionListEntry = {
  id: string;
  title: string;
  workspaceRoot: string;
  modelId: string;
  updatedAt: string;
};

export type SessionDiagnostic = { file: string; message: string };

export class SessionStore {
  constructor(directory: string, atomicWrite?: typeof writeJsonAtomic);
  save(session: PersistedSessionV1): Promise<void>;
  load(id: string): Promise<PersistedSessionV1>;
  list(): Promise<{ sessions: SessionListEntry[]; diagnostics: SessionDiagnostic[] }>;
  resolveId(prefix: string): Promise<string>;
}
```

- [ ] **Step 1: Write store tests with temporary directories**

Cover:

1. save/load round-trip;
2. file name is exactly `<uuid>.json` and Session file contains no key-like fixture value;
3. list sorting by descending `updatedAt`;
4. malformed JSON and schema-invalid files appear in diagnostics while valid entries remain;
5. `resolveId` accepts a full ID and a unique case-insensitive prefix;
6. zero matches throws safe `SESSION_CORRUPT` message `No session matches ...`;
7. multiple matches throws a message containing only matching short IDs;
8. injected atomic writer failure preserves an existing valid file.

- [ ] **Step 2: Run and verify RED**

```bash
npm test -- tests/unit/sessions/session-store.test.ts
```

- [ ] **Step 3: Implement safe file selection**

List only direct child files matching `/^[0-9a-f-]{36}\.json$/i`; do not follow directory entries or accept path separators from an ID. Before building a path, require `randomUUID`-compatible UUID syntax. `resolveId` compares against validated list entries, never against arbitrary filenames supplied by the user.

- [ ] **Step 4: Implement corruption isolation and safe errors**

`load` reads UTF-8, parses JSON, then calls `parseSession`. Convert `ENOENT` into a safe no-match error and other I/O into `SESSION_IO`. `list` catches errors per file, adds `{ file: basename, message }`, and continues. Do not include Session content in diagnostics.

- [ ] **Step 5: Run tests and commit**

```bash
npm test -- tests/unit/sessions/session-store.test.ts
npm run typecheck
git add src/sessions/session-store.ts tests/unit/sessions/session-store.test.ts
git commit -m "feat: add atomic session storage"
```

---

### Task 3: Add SessionManager and Save Checkpoints Around Agent Turns

**Files:**
- Create: `src/sessions/session-manager.ts`
- Create: `tests/unit/sessions/session-manager.test.ts`
- Modify: `src/agent/runner.ts`
- Modify: `tests/unit/agent/runner.test.ts`

**Interfaces:**
- Produces:

```ts
export type ActiveRuntime = {
  session: PersistedSessionV1;
  history: ConversationHistory;
  run(text: string, signal: AbortSignal): Promise<RunResult>;
  dispose?(): Promise<void> | void;
};

export type RuntimeFactory = (session: PersistedSessionV1) => Promise<ActiveRuntime>;

export class SessionManager {
  active(): PersistedSessionV1;
  isDirty(): boolean;
  runTurn(text: string, signal: AbortSignal): Promise<RunResult>;
  flush(): Promise<void>;
  createNew(): Promise<PersistedSessionV1>;
  resume(prefix: string): Promise<PersistedSessionV1>;
}
```

- [ ] **Step 1: Write state-machine tests**

Using an in-memory fake store and runtime factory, prove:

- first user text changes `New session` to a deterministic title;
- completed, model_failed, cancelled, limit_reached, and context_limit results all update stats and save;
- a save failure leaves the runtime active and `isDirty() === true`;
- `flush()` clears dirty only after a successful save;
- `createNew()` refuses to switch if flush fails;
- `resume()` fully loads/builds the target before disposing and replacing the original runtime;
- failed target Workspace/runtime creation leaves the original active;
- a new Session has no inherited active Skill.

- [ ] **Step 2: Run and verify RED**

```bash
npm test -- tests/unit/sessions/session-manager.test.ts
```

- [ ] **Step 3: Implement checkpoint updates without moving Agent history into storage**

`SessionManager.runTurn` delegates to active runtime, then in `finally` copies `history.snapshot()` into `session.messages`, updates ISO `updatedAt`, title/stats, marks dirty, and calls `flush()`. If run unexpectedly throws, synthesize or propagate the existing `internal_failed` behavior only after attempting the checkpoint. Do not save partial provider deltas because they are not in ConversationHistory.

The manager may accept a `clock: () => Date` and `idFactory: () => string` for deterministic tests.

- [ ] **Step 4: Preserve AgentRunner behavior**

Do not make AgentRunner know about SessionStore. Only adjust its surface if necessary so SessionManager can observe the final `RunResult`; all existing runner tests must remain unchanged or receive type-only updates.

- [ ] **Step 5: Verify and commit**

```bash
npm test -- tests/unit/sessions/session-manager.test.ts tests/unit/agent/runner.test.ts
npm run typecheck
git add src/sessions/session-manager.ts src/agent/runner.ts tests/unit/sessions/session-manager.test.ts tests/unit/agent/runner.test.ts
git commit -m "feat: manage active session checkpoints"
```

---

### Task 4: Build the SlashCommandRouter Before Command Handlers

**Files:**
- Create: `src/cli/command.ts`
- Create: `src/cli/command-router.ts`
- Create: `tests/unit/cli/command-router.test.ts`
- Modify: `src/cli/session.ts`
- Modify: `tests/unit/cli/session.test.ts`

**Interfaces:**
- Produces the exact `RouteResult` and `SlashCommand` interfaces in design section 8.
- `SlashCommandRouter.route(text, context)` is async and returns ordinary escaped text as `not_command`.
- `CliSessionOptions` receives `router` and `commandContext`; `runTurn` remains the only ordinary Agent entry.

- [ ] **Step 1: Write router parser tests**

Register fake `help` and `exit` commands and assert:

```ts
await expect(router.route("fix code", context)).resolves.toEqual({
  kind: "not_command",
  text: "fix code",
});
await expect(router.route("//literal", context)).resolves.toEqual({
  kind: "not_command",
  text: "/literal",
});
await router.route("/HELP   extra text ", context);
expect(help.execute).toHaveBeenCalledWith("extra text", context);
```

Also test duplicate registration rejection, unknown command rendering, bare `/`, and preservation of internal spaces in the argument remainder.

- [ ] **Step 2: Add CLI session routing tests**

Prove a handled command does not call `runTurn`, an escaped command does call it with one leading slash, and `{ kind: "exit" }` closes after Session flush logic in the command handler.

- [ ] **Step 3: Run and verify RED**

```bash
npm test -- tests/unit/cli/command-router.test.ts tests/unit/cli/session.test.ts
```

- [ ] **Step 4: Implement the registry and parser**

Normalize only the command name with `.toLowerCase()`. Split at the first Unicode whitespace after the leading `/`; use `.trim()` on the remainder. `//` removes exactly one slash. Unknown commands call `context.renderer.error(...)` or a specific `commandError(...)` view and return handled/unchanged.

- [ ] **Step 5: Route before running Agent turns**

Replace the hard-coded `/exit` branch in `CliSession` with the router result switch. Blank input remains ignored. Do not start a second read while `runTurn` or a handler is pending.

- [ ] **Step 6: Verify and commit**

```bash
npm test -- tests/unit/cli/command-router.test.ts tests/unit/cli/session.test.ts
npm run typecheck
git add src/cli/command.ts src/cli/command-router.ts src/cli/session.ts tests/unit/cli
git commit -m "feat: route local slash commands"
```

---

### Task 5: Implement Pure Session and History Formatting

**Files:**
- Create: `src/sessions/session-format.ts`
- Create: `tests/unit/sessions/session-format.test.ts`

**Interfaces:**
- Produces: `formatSessionList`, `formatSessionStatus`, and `formatHistory` as pure functions accepting a `TerminalTheme`.
- History count defaults to 20 and is validated separately by the command handler.
- Tool content displayed in history is bounded and never dumps a full old command output.

- [ ] **Step 1: Write formatting tests**

Create sessions with fixed times/paths and messages containing user text, assistant text, tool calls, successful and failed results, and a 10,000-character output. Assert:

- current marker appears once;
- sessions are one row each with 8-char IDs;
- status contains Model, Workspace, permission, Skill (`none`), message count, and dirty (`yes|no`);
- history roles are visible;
- tool call name and result status are visible;
- no formatted line exceeds the configured content budget and the long sentinel tail is absent;
- plain theme emits no ANSI.

- [ ] **Step 2: Run and verify RED**

```bash
npm test -- tests/unit/sessions/session-format.test.ts
```

- [ ] **Step 3: Implement bounded view models**

Use a shared `truncateText(text, maxCodePoints)` helper local to the module or existing output limiter logic. Default limits:

- title: 48 code points;
- workspace display: 60 code points;
- assistant/user message preview: 240 code points;
- tool result preview: 160 code points.

Never mutate Session data while formatting.

- [ ] **Step 4: Verify and commit**

```bash
npm test -- tests/unit/sessions/session-format.test.ts
npm run typecheck
git add src/sessions/session-format.ts tests/unit/sessions/session-format.test.ts
git commit -m "feat: format session and history views"
```

---

### Task 6: Implement Session Command Handlers

**Files:**
- Create: `src/cli/commands/help-command.ts`
- Create: `src/cli/commands/status-command.ts`
- Create: `src/cli/commands/sessions-command.ts`
- Create: `src/cli/commands/resume-command.ts`
- Create: `src/cli/commands/new-command.ts`
- Create: `src/cli/commands/history-command.ts`
- Create: `src/cli/commands/exit-command.ts`
- Create: `src/cli/commands/register-core-commands.ts`
- Create: `tests/unit/cli/commands/session-commands.test.ts`

**Interfaces:**
- Each command implements `SlashCommand` and uses only capabilities present on `CommandContext`.
- Produces `registerCoreCommands(router)` for bootstrap.
- Reserves command names `context`, `compact`, `skills`, `skill`, and `setup` for later plans; `/help` may list them as “available after the corresponding stage task” only during development, but the final branch lists only actually registered commands.

- [ ] **Step 1: Write handler tests with fake context services**

Cover exact behavior:

- `/history` uses 20; `/history 1` uses 1; 0, 101, decimals, and text render `Usage: /history [1-100]` without throwing;
- `/resume` with blank args renders `Usage: /resume <id>`;
- successful resume renders the target short ID/title; failure renders the safe AppError and keeps context unchanged;
- `/new` reports the new ID and no active Skill;
- `/sessions` renders corrupt-file diagnostics as warnings after valid rows;
- `/exit` calls `flush()` and returns exit only on success;
- help is generated from registered command metadata rather than a second hard-coded command list.

- [ ] **Step 2: Run and verify RED**

```bash
npm test -- tests/unit/cli/commands/session-commands.test.ts
```

- [ ] **Step 3: Implement one small handler per file**

Handlers parse only their own simple argument. They return:

```ts
type CommandResult =
  | { kind: "continue"; stateChanged: boolean }
  | { kind: "exit" };
```

`ExitCommand` catches no errors itself; the router or ErrorPresenter formats `AppError`. A flush failure returns continue/unchanged, keeping the CLI alive.

- [ ] **Step 4: Verify and commit**

```bash
npm test -- tests/unit/cli/commands/session-commands.test.ts
npm run typecheck
git add src/cli/commands tests/unit/cli/commands
git commit -m "feat: add session slash commands"
```

---

### Task 7: Wire Persistent Sessions End to End

**Files:**
- Modify: `src/index.ts`
- Modify: `src/cli/welcome.ts`
- Modify: `src/cli/help.ts`
- Create: `tests/integration/session-lifecycle.test.ts`
- Modify: `README.md`
- Modify: `docs/PROJECT_REQUIREMENTS.md`

**Interfaces:**
- Bootstrap constructs `SessionStore(paths.sessionsDirectory)`, creates and saves a default Session, builds `SessionManager`, registers commands, then creates `CliSession`.
- `runTurn` always delegates to `sessionManager.runTurn`; no closure may retain the initial AgentRunner after `/resume`.

- [ ] **Step 1: Write lifecycle integration tests**

Using a temporary app home, fake Provider, and two temporary workspaces, verify:

1. ordinary turn creates a saved Session with full user/assistant history;
2. a second process/runtime can list and resume that Session;
3. `/new` then a turn creates a second file and does not append to the first;
4. `/resume <short-id>` switches back and the next turn appends only to the resumed Session;
5. unknown slash input never reaches the fake Provider;
6. `//help` does reach the Provider as `/help`;
7. corrupt third file produces a warning but the two valid sessions remain usable.

- [ ] **Step 2: Run and verify RED**

```bash
npm test -- tests/integration/session-lifecycle.test.ts
```

- [ ] **Step 3: Wire dynamic runtime construction**

Extract the existing Workspace/registry/executor/provider/runner construction into a local factory or focused `src/runtime/create-runtime.ts` if `index.ts` would otherwise remain over 200 lines. The factory receives a Session and returns `ActiveRuntime`. Re-create Workspace and AgentRunner on resume. Continue sanitizing the child command environment.

- [ ] **Step 4: Add recent-session welcome hint**

Before creating the new default Session, list valid Sessions and pass the newest non-current entry into `WelcomeView`. The hint is informational only; do not auto-resume.

- [ ] **Step 5: Update truthful documentation**

README documents command examples, storage location, complete-history behavior, and the absence of cross-session search. In `PROJECT_REQUIREMENTS.md`, add a clearly labeled second-stage checklist; do not mark items complete until their tests pass.

- [ ] **Step 6: Run the plan quality gate**

```bash
npm test
npm run typecheck
npm run build
```

Then manually run with a temporary `NJU_AGENT_HOME`, complete a text turn, exit, restart, `/sessions`, and `/resume <short-id>`.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src/runtime src/cli README.md docs/PROJECT_REQUIREMENTS.md tests/integration/session-lifecycle.test.ts
git commit -m "feat: persist and resume CLI sessions"
```

## Plan Completion Gate

- [ ] All tests, typecheck, and build pass.
- [ ] Ordinary input and `//` escape reach AgentRunner; Slash commands do not.
- [ ] `/sessions`, `/resume`, `/new`, `/history`, `/status`, `/help`, and `/exit` match the spec.
- [ ] Complete history survives restart and remains isolated between Sessions.
- [ ] Corrupt Session files are isolated and safe messages contain no content dump.
- [ ] Failed save prevents silent switch/exit and leaves the current in-memory Session active.
- [ ] No runtime Session file appears in the repository.
- [ ] Begin `docs/superpowers/plans/2026-08-28-stage-two-context-management.md` only after this gate is green.
