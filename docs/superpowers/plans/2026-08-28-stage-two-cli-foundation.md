# NJUAgent Stage-Two CLI Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the second-stage CLI foundation: stable error contracts, safe non-secret configuration storage, first-run setup, a restrained NJU-purple terminal theme, a one-time welcome panel, and a readline-owned prompt that survives line editing and renderer output.

**Architecture:** Preserve the first-stage AgentRunner, Provider, Tools, and streaming event model. Add host-level storage/config/error helpers, make `ReadlinePrompt` own the actual readline prompt instead of printing a prefix manually, and keep rendering behind injectable ports so every behavior is testable without a real terminal.

**Tech Stack:** TypeScript 5.9, Node.js 20+, ESM, Vitest, Ajv, picocolors, Node `readline`, `fs/promises`, and `path`; no UI framework and no new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-08-28-stage-two-productization-design.md`

## Global Constraints

- The delivered application remains a normal CLI; do not add a browser, web server, Electron, Ink, React, or alternate-screen TUI.
- `ANTHROPIC_API_KEY` is read only from the process environment and is never written to disk or included in diagnostics.
- Preserve Node.js `>=20`, ESM imports with `.js` suffixes, existing tool/workspace security, non-TTY output, and Ctrl-C semantics.
- `--help` must work before reading configuration or credentials.
- Use `${NJU_AGENT_HOME:-path.join(os.homedir(), ".nju-agent")}`; tests inject a temporary root and never touch the developer's real home.
- Follow TDD for every task and keep the full suite green after every commit.
- Execute this plan before the sessions, context, and Skills plans.

## File Responsibility Map

| File | Responsibility after this plan |
| --- | --- |
| `src/errors/app-error.ts` | Stable error codes and safe public messages. |
| `src/errors/error-presenter.ts` | Default/debug formatting without dumping secrets. |
| `src/storage/paths.ts` | Resolve the application home, config, sessions, and user-Skills paths. |
| `src/storage/atomic-json.ts` | Atomic JSON write primitive used by later stores. |
| `src/storage/config-store.ts` | Validate, load, and save `PersistedConfigV1`. |
| `src/config.ts` | Merge CLI, environment, persisted values, and defaults into `AppConfig`. |
| `src/cli/setup.ts` | First-run and `/setup` non-secret configuration flow. |
| `src/cli/theme.ts` | NJU-purple and semantic terminal styles with a plain identity theme. |
| `src/cli/welcome.ts` | Format the one-time startup panel. |
| `src/cli/prompt.ts` | Readline prompt, confirmations, clear/redraw coordination, Ctrl-C. |
| `src/cli/renderer.ts` | Consume the theme and coordinate writes with the prompt surface. |
| `src/index.ts` | Bootstrap in the required order and print the welcome panel once. |

---

### Task 1: Add Stable Application Errors and Safe Presentation

**Files:**
- Create: `src/errors/app-error.ts`
- Create: `src/errors/error-presenter.ts`
- Create: `tests/unit/errors/app-error.test.ts`
- Create: `tests/unit/errors/error-presenter.test.ts`
- Modify: `src/config.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Produces: `AppErrorCode`, `AppError`, `isAppError(error)`, and `formatError(error, { debug }): string`.
- Preserves: `ConfigError` as an exported name, but makes it extend `AppError` with code `CONFIG_INVALID`.
- Guarantees: normal output contains a stable code and public message; debug output never serializes environment/config objects.

- [ ] **Step 1: Write failing error contract tests**

Create `tests/unit/errors/app-error.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { AppError, isAppError } from "../../../src/errors/app-error.js";

describe("AppError", () => {
  test("keeps a stable code, safe message, retryability, and cause", () => {
    const cause = new Error("socket closed");
    const error = new AppError({
      code: "PROVIDER_UNAVAILABLE",
      userMessage: "The model service is temporarily unavailable.",
      retryable: true,
      cause,
    });
    expect(isAppError(error)).toBe(true);
    expect(error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(error.userMessage).toBe("The model service is temporarily unavailable.");
    expect(error.retryable).toBe(true);
    expect(error.cause).toBe(cause);
  });
});
```

Create `tests/unit/errors/error-presenter.test.ts`:

```ts
import { expect, test } from "vitest";
import { AppError } from "../../../src/errors/app-error.js";
import { formatError } from "../../../src/errors/error-presenter.js";

test("default errors expose only code and public message", () => {
  const error = new AppError({
    code: "SESSION_IO",
    userMessage: "Could not save the session. Your in-memory session is still active.",
    cause: new Error("ANTHROPIC_API_KEY=must-not-appear"),
  });
  const text = formatError(error, { debug: false });
  expect(text).toBe("[SESSION_IO] Could not save the session. Your in-memory session is still active.");
  expect(text).not.toContain("must-not-appear");
});

test("debug includes a controlled cause name and message", () => {
  const error = new AppError({
    code: "INTERNAL",
    userMessage: "Unexpected internal failure.",
    cause: new TypeError("invalid state"),
  });
  expect(formatError(error, { debug: true })).toContain("Cause: TypeError: invalid state");
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm test -- tests/unit/errors/app-error.test.ts tests/unit/errors/error-presenter.test.ts
```

Expected: FAIL because both source modules are absent.

- [ ] **Step 3: Implement the exact public error surface**

Create `src/errors/app-error.ts` with this union and constructor shape:

```ts
export type AppErrorCode =
  | "CONFIG_INVALID"
  | "CONFIG_MISSING_API_KEY"
  | "PROVIDER_AUTH"
  | "PROVIDER_RATE_LIMIT"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_PROTOCOL"
  | "SESSION_IO"
  | "SESSION_CORRUPT"
  | "CONTEXT_LIMIT"
  | "COMPACTION_FAILED"
  | "SKILL_INVALID"
  | "USER_CANCELLED"
  | "INTERNAL";

export type AppErrorOptions = {
  code: AppErrorCode;
  userMessage: string;
  retryable?: boolean;
  cause?: unknown;
};

export class AppError extends Error {
  override readonly name = "AppError";
  readonly code: AppErrorCode;
  readonly userMessage: string;
  readonly retryable: boolean;

  constructor(options: AppErrorOptions) {
    super(options.userMessage, { cause: options.cause });
    this.code = options.code;
    this.userMessage = options.userMessage;
    this.retryable = options.retryable ?? false;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
```

In `error-presenter.ts`, return `[CODE] message` by default. In debug mode append only `Cause: <name>: <message>` and the AppError stack; never call `JSON.stringify(error)`, never inspect request headers, and never include `process.env`.

- [ ] **Step 4: Make `ConfigError` extend `AppError`**

Keep existing imports source-compatible:

```ts
export class ConfigError extends AppError {
  override readonly name = "ConfigError";
  constructor(message: string, code: "CONFIG_INVALID" | "CONFIG_MISSING_API_KEY" = "CONFIG_INVALID") {
    super({ code, userMessage: message });
  }
}
```

Change `src/index.ts` to use `formatError` for configuration and top-level failures while keeping process exit code 1.

- [ ] **Step 5: Run focused and regression tests**

Run:

```bash
npm test -- tests/unit/errors tests/unit/config.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/errors src/config.ts src/index.ts tests/unit/errors tests/unit/config.test.ts
git commit -m "feat: add stable application errors"
```

---

### Task 2: Add Application Paths, Atomic JSON, and Non-Secret Config Storage

**Files:**
- Create: `src/storage/paths.ts`
- Create: `src/storage/atomic-json.ts`
- Create: `src/storage/config-store.ts`
- Create: `tests/unit/storage/paths.test.ts`
- Create: `tests/unit/storage/atomic-json.test.ts`
- Create: `tests/unit/storage/config-store.test.ts`

**Interfaces:**
- Produces: `resolveAppPaths(env, homeDirectory)`, `writeJsonAtomic(path, value)`, `ConfigStore.load()`, and `ConfigStore.save(config)`.
- Persists exactly: `PersistedConfigV1 { schemaVersion: 1; baseURL; model; permissionMode }`.
- Later plans consume the returned `sessionsDirectory` and `userSkillsDirectory` paths.

- [ ] **Step 1: Write failing path and config tests**

Test the exact precedence without reading the real home:

```ts
test("NJU_AGENT_HOME overrides the default application home", () => {
  const paths = resolveAppPaths({ NJU_AGENT_HOME: "/tmp/custom-home" }, "/users/demo");
  expect(paths).toEqual({
    root: path.resolve("/tmp/custom-home"),
    configFile: path.resolve("/tmp/custom-home/config.json"),
    sessionsDirectory: path.resolve("/tmp/custom-home/sessions"),
    userSkillsDirectory: path.resolve("/tmp/custom-home/skills"),
  });
});

test("default home is ~/.nju-agent", () => {
  expect(resolveAppPaths({}, "/users/demo").root).toBe("/users/demo/.nju-agent");
});
```

In `config-store.test.ts`, use `mkdtemp()` and verify:

1. missing file returns `undefined`;
2. save then load round-trips only allowed fields;
3. invalid `schemaVersion`, blank Base URL, invalid Model, or permission mode throws `CONFIG_INVALID`;
4. a value named `apiKey` is rejected and never appears after save;
5. a pre-existing valid file remains valid when an injected atomic writer fails.

- [ ] **Step 2: Run tests and verify RED**

```bash
npm test -- tests/unit/storage
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement paths and atomic writes**

Use this exact public shape in `paths.ts`:

```ts
export type AppPaths = {
  root: string;
  configFile: string;
  sessionsDirectory: string;
  userSkillsDirectory: string;
};

export function resolveAppPaths(
  env: NodeJS.ProcessEnv,
  homeDirectory: string,
): AppPaths;
```

`writeJsonAtomic(target, value)` must:

1. create the parent with `{ recursive: true, mode: 0o700 }`;
2. build a same-directory temporary name using `randomUUID()`;
3. write `${JSON.stringify(value, null, 2)}\n` with mode `0o600` and flag `wx`;
4. rename the temporary file to the target;
5. unlink only that validated temporary path if a write or rename fails;
6. rethrow the original error.

- [ ] **Step 4: Implement ConfigStore with explicit validation**

Use Ajv with `additionalProperties: false` and this interface:

```ts
export type PersistedConfigV1 = {
  schemaVersion: 1;
  baseURL: string;
  model: string;
  permissionMode: "balanced" | "cautious";
};

export class ConfigStore {
  constructor(
    private readonly file: string,
    private readonly atomicWrite: typeof writeJsonAtomic = writeJsonAtomic,
  ) {}
  load(): Promise<PersistedConfigV1 | undefined>;
  save(config: PersistedConfigV1): Promise<void>;
}
```

Normalize with `trim()` only after validation. Wrap filesystem/JSON/Ajv failures as `AppError` code `CONFIG_INVALID` with a safe path-specific remediation message; do not echo the whole invalid document.

- [ ] **Step 5: Run storage tests, typecheck, and build**

```bash
npm test -- tests/unit/storage
npm run typecheck
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/storage tests/unit/storage
git commit -m "feat: persist non-secret agent configuration"
```

---

### Task 3: Merge Persisted Configuration and Implement Setup

**Files:**
- Modify: `src/config.ts`
- Create: `src/cli/setup.ts`
- Modify: `src/cli/prompt.ts`
- Modify: `tests/unit/config.test.ts`
- Create: `tests/unit/cli/setup.test.ts`

**Interfaces:**
- Produces: `resolveConfig({ env, argv, persisted, cwd }): AppConfig` and `runSetup({ prompt, store, defaults }): Promise<PersistedConfigV1 | null>`.
- Requires: API Key from env only; Base URL/Model precedence is CLI if later added, then env, persisted config, no silent service-specific hard-code.
- Returns `null` when setup is cancelled; never treats cancellation as consent.

- [ ] **Step 1: Extend config tests for precedence and missing API Key**

Add cases proving:

```ts
expect(resolveConfig({
  env: {
    ANTHROPIC_API_KEY: "env-key",
    MODEL_ID: "env-model",
  },
  argv: [],
  cwd: "/workspace",
  persisted: {
    schemaVersion: 1,
    baseURL: "https://persisted.example",
    model: "persisted-model",
    permissionMode: "cautious",
  },
})).toMatchObject({
  apiKey: "env-key",
  baseURL: "https://persisted.example",
  model: "env-model",
  permissionMode: "cautious",
});
```

Also assert that a missing `ANTHROPIC_API_KEY` throws `ConfigError` with code `CONFIG_MISSING_API_KEY`, while missing Base URL or Model is reported separately as incomplete non-secret configuration.

- [ ] **Step 2: Add setup tests using a scripted Prompt fake**

Use a fake that returns `https://api.example`, `deepseek-v4-flash`, and `cautious`. Assert the store receives exactly:

```ts
{
  schemaVersion: 1,
  baseURL: "https://api.example",
  model: "deepseek-v4-flash",
  permissionMode: "cautious",
}
```

Add cancellation, blank-value reprompt, invalid URL reprompt, and “API Key is never requested or saved” cases.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
npm test -- tests/unit/config.test.ts tests/unit/cli/setup.test.ts
```

Expected: FAIL on the new interfaces.

- [ ] **Step 4: Implement configuration resolution**

Rename the internal responsibility, not necessarily the source file. Export:

```ts
export type ResolveConfigInput = {
  env: NodeJS.ProcessEnv;
  argv: readonly string[];
  persisted?: PersistedConfigV1;
  cwd: string;
};

export function resolveConfig(input: ResolveConfigInput): AppConfig;
```

Keep `loadConfig(env, argv)` temporarily as a compatibility wrapper used by old tests, then migrate `index.ts` in Task 6. Preserve all current numeric defaults and argument validation.

- [ ] **Step 5: Implement the three-step setup flow**

Extend `Prompt` with a neutral `read(question)` already present; `runSetup` asks only Base URL, Model, and permission mode. Validate Base URL with `new URL()` and require `http:` or `https:`. Display the final values and call `prompt.confirm("Save this configuration?")`. Return `null` on decline or Ctrl-C.

- [ ] **Step 6: Run tests and commit**

```bash
npm test -- tests/unit/config.test.ts tests/unit/cli/setup.test.ts
npm run typecheck
git add src/config.ts src/cli/setup.ts src/cli/prompt.ts tests/unit/config.test.ts tests/unit/cli/setup.test.ts
git commit -m "feat: add first-run configuration setup"
```

---

### Task 4: Add the NJU-Purple Theme and One-Time Welcome Panel

**Files:**
- Create: `src/cli/theme.ts`
- Create: `src/cli/welcome.ts`
- Create: `tests/unit/cli/theme.test.ts`
- Create: `tests/unit/cli/welcome.test.ts`
- Modify: `src/cli/renderer.ts`
- Modify: `tests/unit/cli/renderer.test.ts`

**Interfaces:**
- Produces: `TerminalTheme`, `createTheme({ enabled })`, and `formatWelcome(view, theme)`.
- `WelcomeView` contains version, workspace, model, session short ID, permission mode, and optional recent-session hint.
- All visual functions return strings; they never call `console.log` directly.

- [ ] **Step 1: Write theme and welcome tests**

Prove that disabled styles are identity functions and enabled brand text contains ANSI:

```ts
const plain = createTheme({ enabled: false });
expect(plain.brand("NJUAgent")).toBe("NJUAgent");
expect(plain.error("boom")).toBe("boom");

const colored = createTheme({ enabled: true });
expect(colored.brand("NJUAgent")).toContain("\x1b[");
expect(colored.brand("NJUAgent")).toContain("NJUAgent");
```

For `formatWelcome`, assert one occurrence of `NJUAgent`, workspace/model/session labels, `/help`, and no ANSI with a plain theme. Do not snapshot terminal width-dependent whitespace; test stable semantic fragments.

- [ ] **Step 2: Verify RED**

```bash
npm test -- tests/unit/cli/theme.test.ts tests/unit/cli/welcome.test.ts
```

- [ ] **Step 3: Implement centralized styles**

Define:

```ts
export type TerminalTheme = {
  brand(text: string): string;
  brandBase(text: string): string;
  success(text: string): string;
  warning(text: string): string;
  error(text: string): string;
  muted(text: string): string;
};
```

Use ANSI 256-color 141 for readable brand text and 54 for the dark base approximation; use standard green/yellow/red/dim for semantics. Every wrapper must close its own ANSI sequence. The disabled theme returns input unchanged.

- [ ] **Step 4: Implement the restrained welcome view**

Use Unicode box drawing only for TTY. The plain formatter emits one `[session]` line. Do not add a large ASCII logo. Truncate very long workspace/model values to the available width without splitting surrogate pairs; minimum supported formatted width is 60 columns.

- [ ] **Step 5: Inject the theme into TerminalRenderer**

Replace direct `pc.cyan` brand/progress calls with `theme.brand`; retain semantic green/yellow/red. Construct theme from the existing `interactive` decision, so `NO_COLOR` and non-TTY remain ANSI-free. Do not change AgentEvent semantics.

- [ ] **Step 6: Run renderer regressions and commit**

```bash
npm test -- tests/unit/cli/theme.test.ts tests/unit/cli/welcome.test.ts tests/unit/cli/renderer.test.ts
npm run typecheck
git add src/cli/theme.ts src/cli/welcome.ts src/cli/renderer.ts tests/unit/cli
git commit -m "feat: add NJU purple terminal presentation"
```

---

### Task 5: Make Readline Own and Restore the Input Prompt

**Files:**
- Modify: `src/cli/prompt.ts`
- Modify: `src/cli/renderer.ts`
- Modify: `src/cli/session.ts`
- Modify: `tests/unit/cli/session.test.ts`
- Create: `tests/unit/cli/prompt.test.ts`

**Interfaces:**
- Extends `Prompt` with `suspendForOutput(): void` and `resumeAfterOutput(): void`.
- `ReadlinePrompt.read(promptText)` calls readline `setPrompt(promptText)` and `prompt(true)`; it does not write the prefix itself.
- Renderer may receive `inputSurface?: Pick<Prompt, "suspendForOutput" | "resumeAfterOutput">`.

- [ ] **Step 1: Add a fake readline port and failing prompt tests**

Allow `ReadlinePromptOptions` to accept an optional `interfaceFactory` for tests. The fake port records `setPrompt`, `prompt`, event handlers, `line`, and `close`. Assert:

```ts
const pending = prompt.read("› ");
expect(fakeReadline.promptText).toBe("› ");
expect(fakeReadline.promptCalls).toEqual([true]);
expect(output.text()).toBe(""); // no manual prompt write
```

While a read is pending, call `suspendForOutput()` then `resumeAfterOutput()` and assert a clear-line sequence is written and `prompt(true)` is called again without mutating `fakeReadline.line`.

- [ ] **Step 2: Update CLI fakes before changing the interface**

Add no-op implementations to `FakePrompt` in `session.test.ts` and other Prompt fakes:

```ts
suspendForOutput(): void {}
resumeAfterOutput(): void {}
```

Run typecheck and confirm it still passes before extending the production interface.

- [ ] **Step 3: Implement prompt ownership and redraw coordination**

Use Node `clearLine(output, 0)` and `cursorTo(output, 0)` only when terminal mode is active and a read is pending. `resumeAfterOutput()` calls `this.#rl.prompt(true)`. It must be a no-op while AgentRunner is active because no input read is pending.

Set `INPUT_PROMPT` in `session.ts` to `"› "`. Do not include ANSI in the readline prompt; colorized prompt width accounting is terminal-dependent. The brand color remains in welcome/status output.

- [ ] **Step 4: Coordinate permanent renderer writes**

For renderer operations that may occur while a permission/setup prompt is active:

```ts
this.#inputSurface?.suspendForOutput();
try {
  this.#stdout.write(text);
} finally {
  this.#inputSurface?.resumeAfterOutput();
}
```

Do not wrap individual text deltas with redraw when no read is pending. Preserve output limiter and plain streaming behavior.

- [ ] **Step 5: Verify prompt, session, and renderer tests**

```bash
npm test -- tests/unit/cli/prompt.test.ts tests/unit/cli/session.test.ts tests/unit/cli/renderer.test.ts
npm run typecheck
```

Expected: PASS; tests prove `nju-agent>` is no longer manually printed and `› ` survives redraw.

- [ ] **Step 6: Commit**

```bash
git add src/cli/prompt.ts src/cli/renderer.ts src/cli/session.ts tests/unit/cli
git commit -m "fix: preserve the interactive input prompt"
```

---

### Task 6: Wire Bootstrap, First-Run Setup, and Welcome Output

**Files:**
- Modify: `src/index.ts`
- Modify: `src/cli/help.ts`
- Modify: `tests/unit/cli/help.test.ts`
- Create: `tests/integration/bootstrap.test.ts`
- Modify: `README.md`
- Modify: `.env.example`

**Interfaces:**
- Startup order: help → paths/store → persisted config → optional setup → config resolve/API Key check → workspace/provider/tools → welcome → session loop.
- Integration tests invoke an exported `main(deps): Promise<number>` or equivalent injected bootstrap function; importing the module must not start a process in tests.

- [ ] **Step 1: Write bootstrap integration tests**

Cover these exact scenarios with temporary paths and fake prompt/writer:

1. `--help` returns 0 without loading config or API Key;
2. missing Base URL/Model in TTY invokes setup, saves config, then continues to API Key validation;
3. missing API Key prints `CONFIG_MISSING_API_KEY`, mentions `ANTHROPIC_API_KEY`, and returns 1 without saving a key;
4. non-TTY incomplete config returns 1 without prompting;
5. valid config prints the welcome panel exactly once before the first `› ` prompt.

- [ ] **Step 2: Run bootstrap tests and verify RED**

```bash
npm test -- tests/integration/bootstrap.test.ts
```

- [ ] **Step 3: Extract a testable bootstrap function**

Keep the shebang in `src/index.ts`. Export a function whose dependencies default to real Node values but can be replaced in tests. The bottom-level executable call remains:

```ts
void main().then(
  (exitCode) => { process.exitCode = exitCode; },
  (error) => {
    process.stderr.write(`nju-agent: ${formatError(toInternalError(error), { debug: false })}\n`);
    process.exitCode = 1;
  },
);
```

Do not print the full error stack unless debug mode was successfully resolved.

- [ ] **Step 4: Update help and configuration documentation**

Help must document `NJU_AGENT_HOME`, `NO_COLOR`, the three model variables, and that API Key is environment-only. README must state that the application is a CLI and that setup saves only Base URL, Model, and permission mode.

- [ ] **Step 5: Run the plan quality gate**

```bash
npm test
npm run typecheck
npm run build
```

Expected: all tests PASS, typecheck PASS, build PASS. Manually run `node dist/index.js --help` without credentials and confirm exit 0 and no ANSI when piped.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/cli/help.ts tests/integration/bootstrap.test.ts tests/unit/cli/help.test.ts README.md .env.example
git commit -m "feat: initialize the polished CLI experience"
```

## Plan Completion Gate

- [ ] `npm test`, `npm run typecheck`, and `npm run build` pass.
- [ ] `--help` works without credentials.
- [ ] No serialized config contains `apiKey` or the API Key value.
- [ ] TTY startup displays one restrained NJUAgent panel; non-TTY output contains no ANSI.
- [ ] Moving the cursor or editing the current line does not erase the `› ` prompt.
- [ ] `git status --short` contains no `.nju-agent` runtime data.
- [ ] Begin `docs/superpowers/plans/2026-08-28-stage-two-sessions-and-commands.md` only after this gate is green.
