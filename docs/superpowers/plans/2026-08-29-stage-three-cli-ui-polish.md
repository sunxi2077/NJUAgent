# Stage Three CLI UI Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a distinctive, readable, scrollback-preserving NJU-purple CLI with a responsive ASCII welcome card, clear user/assistant anchors, and streaming rendering for the approved Markdown subset.

**Architecture:** Keep Node readline and the existing ordinary terminal transcript. Expand the semantic theme, isolate Unicode terminal-width helpers and streaming Markdown in focused modules, inject the user prompt into `CliSession`, and let `TerminalRenderer` coordinate assistant segments, Markdown, tools, and status boundaries without changing Agent events or persisted history.

**Tech Stack:** Node.js 20+, TypeScript 5.9, ESM, Vitest, Node readline, Node `util.stripVTControlCharacters`, existing `picocolors`; no new runtime dependency or UI framework.

**Spec:** `docs/superpowers/specs/2026-08-29-stage-three-cli-ui-design.md`

## Global Constraints

- Read the complete spec before editing. When an example in this plan is shorter than the spec, the spec wins.
- Start from `main` at or after `3e23767`; preserve unrelated user changes if the tree is not clean.
- Keep the application a normal scrollback-preserving CLI. Do not use alternate screen, raw-mode input, Ink, React, Blessed, mouse handling, or a fixed status region.
- Keep Node readline as the sole line editor. Chinese input, cursor movement, history, paste queueing, Ctrl-C, EOF, and confirmation prompts must not regress.
- Do not implement Slash suggestions, Slash completion, a command palette, syntax highlighting, GFM tables, task lists, OSC 8 links, or theme configuration.
- Do not modify Agent event types, Provider behavior, tool protocol, session persistence, context management, Skills, permissions, or API-key handling.
- Keep ANSI bytes in the display layer only. Persisted messages and model context remain raw Markdown.
- TTY + enabled theme receives the enhanced transcript. Non-TTY, `NO_COLOR`, explicit no-color, and `TERM=dumb` remain ANSI-free and machine-readable.
- No new package is required. Do not add a Markdown parser, tokenizer, terminal UI library, `string-width`, or syntax-highlighting package.
- Use TDD for every behavior change: add a focused failing test, run it and observe the expected failure, implement the smallest behavior, then run focused tests until green.
- After each task, review `git diff`, ensure only listed files changed, run `git diff --check`, and commit with the stated commit message.
- Do not update dependency versions, package version, lockfiles, generated artifacts, or unrelated documentation.

## Target File Map

```text
src/cli/theme.ts                       semantic colors/styles and theme enablement helper
src/cli/terminal-text.ts               ANSI stripping, terminal-cell width and width-safe truncation
src/cli/welcome.ts                     responsive full/compact/plain welcome formatting
src/cli/prompt.ts                      unchanged readline ownership; only tests exercise ANSI prompt
src/cli/session.ts                     injected input prompt used by the main read loop
src/cli/streaming-markdown.ts          isolated incremental Markdown state machine
src/cli/renderer.ts                    AgentEvent orchestration and transcript boundaries
src/sessions/session-format.ts         migrate old brand method names to semantic theme methods
src/index.ts                            construct one theme and inject it into welcome/renderer/session

tests/unit/cli/theme.test.ts
tests/unit/cli/terminal-text.test.ts
tests/unit/cli/welcome.test.ts
tests/unit/cli/prompt.test.ts
tests/unit/cli/session.test.ts
tests/unit/cli/streaming-markdown.test.ts
tests/unit/cli/renderer.test.ts
tests/unit/sessions/session-format.test.ts
tests/integration/bootstrap.test.ts
```

The only new production files are `src/cli/terminal-text.ts` and `src/cli/streaming-markdown.ts`. Do not create a general UI framework or move current files merely to match this map.

---

### Task 1: Semantic Theme and One Enablement Decision

**Files:**
- Modify: `src/cli/theme.ts`
- Modify: `src/cli/renderer.ts`
- Modify: `src/sessions/session-format.ts`
- Modify: `src/index.ts`
- Test: `tests/unit/cli/theme.test.ts`
- Test: `tests/unit/cli/renderer.test.ts`
- Test: `tests/unit/sessions/session-format.test.ts`
- Test: `tests/integration/bootstrap.test.ts`

**Interfaces:**
- Produces: `createTheme(options: { enabled: boolean }): TerminalTheme`
- Produces: `shouldEnableTerminalTheme(options: { isTTY: boolean; env: NodeJS.ProcessEnv }): boolean`
- Produces semantic methods `brandStrong`, `brandBorder`, `userLabel`, `assistantLabel`, `heading`, `code`, `quote`, `success`, `warning`, `error`, `muted`, `bold`, `italic`, and `underline`.
- Removes production use of old `theme.brand()` and `theme.brandBase()` names.
- `TerminalRendererOptions.theme` remains injectable; `src/index.ts` passes the same instance to welcome, renderer, command context, and input-prompt formatting.

- [ ] **Step 1: Replace the theme tests with semantic-contract tests**

Add assertions equivalent to:

```ts
import { createTheme, shouldEnableTerminalTheme } from "../../../src/cli/theme.js";

const methods = [
  "brandStrong",
  "brandBorder",
  "userLabel",
  "assistantLabel",
  "heading",
  "code",
  "quote",
  "success",
  "warning",
  "error",
  "muted",
  "bold",
  "italic",
  "underline",
] as const;

test("disabled semantic styles are identity functions", () => {
  const theme = createTheme({ enabled: false });
  for (const method of methods) {
    expect(theme[method]("text"), method).toBe("text");
  }
});

test("uses distinct visible brand, border, user and assistant styles", () => {
  const theme = createTheme({ enabled: true });
  expect(theme.brandStrong("x")).toContain("\x1b[38;5;141m");
  expect(theme.brandBorder("x")).toContain("\x1b[38;5;99m");
  expect(theme.userLabel("x")).toContain("\x1b[38;5;45m");
  expect(theme.brandBorder("x")).not.toContain("38;5;54m");
  expect(theme.userLabel("x")).not.toBe(theme.assistantLabel("x"));
});

test("enables enhanced terminal output in exactly the supported environment", () => {
  expect(shouldEnableTerminalTheme({ isTTY: true, env: {} })).toBe(true);
  expect(shouldEnableTerminalTheme({ isTTY: false, env: {} })).toBe(false);
  expect(shouldEnableTerminalTheme({ isTTY: true, env: { NO_COLOR: "1" } })).toBe(false);
  expect(shouldEnableTerminalTheme({ isTTY: true, env: { TERM: "dumb" } })).toBe(false);
});
```

Keep the existing test that every enabled wrapper contains the original text and closes its own ANSI sequence. Extend it to the new method list.

- [ ] **Step 2: Run the focused theme test and observe RED**

Run:

```bash
npm test -- tests/unit/cli/theme.test.ts
```

Expected: FAIL because `shouldEnableTerminalTheme` and the semantic method names do not exist, and the current border still uses color `54`.

- [ ] **Step 3: Implement the semantic theme**

Use this public shape in `src/cli/theme.ts`:

```ts
export type TerminalTheme = {
  enabled: boolean;
  brandStrong(text: string): string;
  brandBorder(text: string): string;
  userLabel(text: string): string;
  assistantLabel(text: string): string;
  heading(text: string): string;
  code(text: string): string;
  quote(text: string): string;
  success(text: string): string;
  warning(text: string): string;
  error(text: string): string;
  muted(text: string): string;
  bold(text: string): string;
  italic(text: string): string;
  underline(text: string): string;
};

export function shouldEnableTerminalTheme(options: {
  isTTY: boolean;
  env: NodeJS.ProcessEnv;
}): boolean {
  const noColor = options.env.NO_COLOR;
  return options.isTTY &&
    !(noColor !== undefined && noColor !== "") &&
    options.env.TERM !== "dumb";
}
```

Keep the local `ansi256()` helper. Compose bold labels by applying `picocolors.bold` to the complete colored result or the ANSI-256 formatter to the bold result; tests should check visible semantics rather than demand one nesting order.

Required mapping:

```ts
brandStrong   => ansi256(141)
brandBorder   => ansi256(99)
userLabel     => ansi256(45) + bold
assistantLabel=> ansi256(141) + bold
heading       => ansi256(141) + bold
code          => ansi256(81)
quote         => semantic.dim
success       => semantic.green
warning       => semantic.yellow
error         => semantic.red
muted         => semantic.dim
bold          => semantic.bold
italic        => semantic.italic
underline     => semantic.underline
```

For a disabled theme, every method must be the same `identity` function.

- [ ] **Step 4: Migrate old brand callers and centralize composition**

In `src/cli/renderer.ts`, replace old generic brand calls according to intent:

```ts
theme.brand("⚙")       -> theme.brandStrong("⚙")
theme.brand(frame)     -> theme.brandStrong(frame)
cancelled status color -> theme.brandStrong
```

Remove Renderer's private `envNoColor()` lookup and make constructor behavior explicit:

```ts
this.#interactive = options.isTTY && !(options.noColor ?? false);
this.#theme = options.theme ?? createTheme({ enabled: this.#interactive });
```

Production environment policy belongs to `src/index.ts`; renderer unit tests continue to control plain/interactive mode through `isTTY`, `noColor`, and the optional injected theme.

In `src/sessions/session-format.ts`, replace current markers, tool-history markers, context title, and active-skill markers with `theme.brandStrong(...)`. Do not change their visible text.

In `src/index.ts`, calculate the theme once after configuration is resolved and before creating `TerminalRenderer`:

```ts
const themeEnabled = shouldEnableTerminalTheme({ isTTY, env });
const theme = createTheme({ enabled: themeEnabled });
```

Pass it into the renderer:

```ts
const renderer = rendererFactory({
  stdout,
  isTTY,
  noColor: !themeEnabled,
  theme,
  maxLiveOutputBytes: config.uiOutputMaxBytes,
  inputSurface: prompt,
});
```

Remove the later duplicate `createTheme()` call. Keep screen clearing stricter than color enablement: it still additionally requires `env.CI === undefined`.

Replace the current clear-screen `interactive` calculation with `themeEnabled && env.CI === undefined`, and remove the now-unused `envNoColor()` helper from `src/index.ts`.

- [ ] **Step 5: Add TERM=dumb and shared-theme regression tests**

In `tests/integration/bootstrap.test.ts`, add:

```ts
test("TERM=dumb disables clear and all ANSI output", async () => {
  const { deps, stdout, prompt } = await makeDeps({
    isTTY: true,
    env: {
      ANTHROPIC_API_KEY: "key",
      ANTHROPIC_BASE_URL: "https://api.example.com/anthropic",
      MODEL_ID: "deepseek-v4-flash",
      TERM: "dumb",
    },
  });
  prompt.reads = [null];

  expect(await main(deps)).toBe(0);
  expect(stdout.text()).not.toContain("\x1b[");
});
```

Update renderer/session-format unit fixtures to call semantic method names. Do not loosen existing non-TTY assertions.

- [ ] **Step 6: Run focused tests until GREEN**

Run:

```bash
npm test -- tests/unit/cli/theme.test.ts tests/unit/cli/renderer.test.ts tests/unit/sessions/session-format.test.ts tests/integration/bootstrap.test.ts
npm run typecheck
```

Expected: all listed tests pass; typecheck exits 0; `rg '\.brand(Base)?\(' src` returns no matches.

- [ ] **Step 7: Commit Task 1**

```bash
git add src/cli/theme.ts src/cli/renderer.ts src/sessions/session-format.ts src/index.ts tests/unit/cli/theme.test.ts tests/unit/cli/renderer.test.ts tests/unit/sessions/session-format.test.ts tests/integration/bootstrap.test.ts
git diff --check
git commit -m "refactor: add semantic terminal theme"
```

---

### Task 2: Unicode-Safe Responsive Welcome Card

**Files:**
- Create: `src/cli/terminal-text.ts`
- Modify: `src/cli/welcome.ts`
- Create: `tests/unit/cli/terminal-text.test.ts`
- Modify: `tests/unit/cli/welcome.test.ts`

**Interfaces:**
- Produces: `terminalWidth(text: string): number`
- Produces: `truncateToTerminalWidth(text: string, maxWidth: number): string`
- Preserves: `formatWelcome(view: WelcomeView, theme: TerminalTheme, options?: WelcomeOptions): string`
- Full layout at `columns >= 64`; compact bordered layout at `36 <= columns < 64`; plain layout below 36 or when theme is disabled.

- [ ] **Step 1: Write failing terminal-width tests**

Create `tests/unit/cli/terminal-text.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { terminalWidth, truncateToTerminalWidth } from "../../../src/cli/terminal-text.js";

describe("terminal text width", () => {
  test("counts ASCII, CJK, combining marks, emoji and ANSI", () => {
    expect(terminalWidth("abc")).toBe(3);
    expect(terminalWidth("南京")).toBe(4);
    expect(terminalWidth("e\u0301")).toBe(1);
    expect(terminalWidth("😀")).toBe(2);
    expect(terminalWidth("\x1b[38;5;141mNJU\x1b[0m")).toBe(3);
  });

  test("truncates without exceeding the requested cells", () => {
    expect(truncateToTerminalWidth("南京大学", 5)).toBe("南京…");
    expect(terminalWidth(truncateToTerminalWidth("abc😀def", 6))).toBeLessThanOrEqual(6);
    expect(truncateToTerminalWidth("short", 5)).toBe("short");
  });
});
```

- [ ] **Step 2: Run the new test and observe RED**

Run:

```bash
npm test -- tests/unit/cli/terminal-text.test.ts
```

Expected: FAIL because `src/cli/terminal-text.ts` does not exist.

- [ ] **Step 3: Implement the focused terminal-width utility**

Use `stripVTControlCharacters` from `node:util`. Iterate code points, ignore combining marks, and count common East Asian/emoji ranges as two cells. Keep the implementation local and deterministic:

```ts
import { stripVTControlCharacters } from "node:util";

function isCombining(codePoint: number): boolean {
  return (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
    codePoint === 0xfe0f;
}

function isWide(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f ||
    codePoint === 0x2329 || codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

export function terminalWidth(text: string): number {
  let width = 0;
  for (const char of stripVTControlCharacters(text)) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint === 0 || isCombining(codePoint)) continue;
    width += isWide(codePoint) ? 2 : 1;
  }
  return width;
}
```

Implement `truncateToTerminalWidth()` by reserving one cell for `…`, iterating complete code points, and stopping before the next character would exceed `maxWidth - 1`. Return the original string unchanged when it already fits. Inputs to this function are unstyled values; do not attempt to preserve arbitrary ANSI while slicing.

- [ ] **Step 4: Write failing responsive welcome tests**

Replace old exact 80/88-column assumptions with the approved three layouts:

```ts
test("wide TTY shows the NJU logo inside a visible 72-column-or-smaller frame", () => {
  const output = formatWelcome(view, createTheme({ enabled: true }), { columns: 100 });
  const plain = stripAnsi(output);
  expect(plain).toContain("███╗   ██╗");
  expect(plain).toContain("NJUAgent v0.2.0");
  expect(output).toContain("\x1b[38;5;141m");
  expect(output).toContain("\x1b[38;5;99m");
  const frame = plain.split("\n").filter((line) => /^[╭│╰]/u.test(line));
  expect(frame.every((line) => terminalWidth(line) <= 72)).toBe(true);
  expect(frame.every((line) => terminalWidth(line) === terminalWidth(frame[0]!))).toBe(true);
});

test.each([60, 40])("%i columns uses a compact complete frame", (columns) => {
  const plain = stripAnsi(formatWelcome(view, createTheme({ enabled: true }), { columns }));
  expect(plain).not.toContain("███╗");
  expect(plain).toContain("╭");
  expect(plain).toContain("╯");
  expect(plain.split("\n").every((line) => terminalWidth(line) <= columns)).toBe(true);
});

test("an extremely narrow terminal falls back to unboxed text", () => {
  const plain = stripAnsi(formatWelcome(view, createTheme({ enabled: true }), { columns: 30 }));
  expect(plain).toContain("NJUAgent v0.2.0");
  expect(plain).not.toMatch(/[╭╮╰╯│]/u);
  expect(plain.split("\n").every((line) => terminalWidth(line) <= 30)).toBe(true);
});
```

Also keep tests for plain output, long workspace/model values, and the actionable `/resume` hint.

- [ ] **Step 5: Run welcome tests and observe RED**

Run:

```bash
npm test -- tests/unit/cli/terminal-text.test.ts tests/unit/cli/welcome.test.ts
```

Expected: width utility tests pass after Step 3; welcome tests fail because the old formatter has no Logo, uses the dark border, and forces a box at 30 columns.

- [ ] **Step 6: Implement full, compact, and plain formatters**

Define constants in `welcome.ts`:

```ts
const MAX_FRAME_WIDTH = 72;
const FULL_LAYOUT_MIN_COLUMNS = 64;
const BORDERED_LAYOUT_MIN_COLUMNS = 36;
const OUTER_MARGIN = 2;
const NJU_LOGO = [
  "███╗   ██╗     ██╗██╗   ██╗",
  "████╗  ██║     ██║██║   ██║",
  "██╔██╗ ██║     ██║██║   ██║",
  "██║╚██╗██║██   ██║██║   ██║",
  "██║ ╚████║╚█████╔╝╚██████╔╝",
  "╚═╝  ╚═══╝ ╚════╝  ╚═════╝",
] as const;
```

Build content lines without ANSI, pad them using `terminalWidth()`, then color only the Logo/title and individual border characters. This prevents ANSI length from affecting padding. Use:

```ts
const safeColumns = Number.isFinite(options.columns)
  ? Math.max(1, Math.floor(options.columns ?? 80))
  : 80;
const frameWidth = Math.min(MAX_FRAME_WIDTH, safeColumns - OUTER_MARGIN);
```

For the full layout, include one blank row above and below Logo, a title row, the three aligned information rows, and one blank row before the bottom border. For compact layout, omit Logo and reduce blank rows, but keep title/workspace/model/session. For `safeColumns < 36` or `!theme.enabled`, call a shared plain formatter with width-safe truncation.

The recent-session and `/help` hints remain outside the box and must themselves be truncated when the terminal is narrow.

- [ ] **Step 7: Run focused tests until GREEN**

Run:

```bash
npm test -- tests/unit/cli/terminal-text.test.ts tests/unit/cli/welcome.test.ts tests/integration/bootstrap.test.ts
npm run typecheck
```

Expected: all pass; no output line exceeds its requested width after ANSI stripping.

- [ ] **Step 8: Commit Task 2**

```bash
git add src/cli/terminal-text.ts src/cli/welcome.ts tests/unit/cli/terminal-text.test.ts tests/unit/cli/welcome.test.ts
git diff --check
git commit -m "feat: add responsive NJU welcome card"
```

---

### Task 3: Persistent User Anchor Through Readline

**Files:**
- Modify: `src/cli/session.ts`
- Modify: `src/index.ts`
- Test: `tests/unit/cli/session.test.ts`
- Test: `tests/unit/cli/prompt.test.ts`
- Test: `tests/integration/bootstrap.test.ts`

**Interfaces:**
- Extends `CliSessionOptions` with `inputPrompt?: string`.
- Default remains the plain-compatible `› ` for existing direct constructors.
- Production bootstrap injects `${theme.userLabel("❯ You")}  `.
- `ReadlinePrompt.read(promptText)` remains unchanged and owns `setPrompt()`/`prompt(true)`.

- [ ] **Step 1: Record prompt text in the session fake and write a failing test**

In `tests/unit/cli/session.test.ts`, change `FakePrompt.read()` to append its argument:

```ts
readonly promptTexts: string[] = [];

read(promptText: string): Promise<string | null> {
  this.promptTexts.push(promptText);
  this.readCount += 1;
  // keep the current queue/pending behavior unchanged
}
```

Add:

```ts
test("uses the injected input prompt for every read", async () => {
  const prompt = new FakePrompt();
  prompt.pushInput("task");
  prompt.pushInput("/exit");
  const session = new CliSession({
    prompt,
    renderer: new MemoryRenderer(),
    inputPrompt: "\x1b[36m❯ You\x1b[0m  ",
    runTurn: async () => ({ status: "completed", steps: 1, toolCalls: 0, durationMs: 1 }),
  });

  await session.start();

  expect(prompt.promptTexts).toEqual([
    "\x1b[36m❯ You\x1b[0m  ",
    "\x1b[36m❯ You\x1b[0m  ",
  ]);
});
```

- [ ] **Step 2: Run the session test and observe RED**

Run:

```bash
npm test -- tests/unit/cli/session.test.ts
```

Expected: FAIL because `CliSessionOptions` has no `inputPrompt` and the loop still uses the constant `› `.

- [ ] **Step 3: Implement input-prompt injection**

Use:

```ts
const DEFAULT_INPUT_PROMPT = "› ";

export type CliSessionOptions = {
  // existing fields
  inputPrompt?: string;
};

export class CliSession {
  readonly #inputPrompt: string;

  constructor(options: CliSessionOptions) {
    // existing assignments
    this.#inputPrompt = options.inputPrompt ?? DEFAULT_INPUT_PROMPT;
  }
}
```

Then replace the read expression inside `start()` with:

```ts
const text = await this.#prompt.read(this.#inputPrompt);
```

Do not style confirmation questions or setup prompts in this task.

In `src/index.ts`, pass:

```ts
inputPrompt: `${theme.userLabel("❯ You")}  `,
```

Because a disabled theme is identity, plain mode receives `❯ You  ` without ANSI. The bootstrap test should inspect prompt arguments rather than expect readline echo in `MemoryWriter`.

- [ ] **Step 4: Add ANSI readline ownership and bootstrap tests**

In `tests/unit/cli/prompt.test.ts`, add a case proving the prompt forwards an ANSI-decorated string unchanged to `setPrompt()` and still redraws through `prompt(true)`.

In `tests/integration/bootstrap.test.ts`, extend `FakePrompt` with `promptTexts`, then assert:

```ts
expect(prompt.promptTexts[0]).toBe("❯ You  "); // non-TTY disabled theme
```

Add a TTY case that strips ANSI and expects `❯ You  ` while also asserting the raw prompt contains `\x1b[`.

- [ ] **Step 5: Run focused tests until GREEN**

Run:

```bash
npm test -- tests/unit/cli/session.test.ts tests/unit/cli/prompt.test.ts tests/integration/bootstrap.test.ts
npm run typecheck
```

Expected: all pass; existing paste queue and suspend/resume tests remain green.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/cli/session.ts src/index.ts tests/unit/cli/session.test.ts tests/unit/cli/prompt.test.ts tests/integration/bootstrap.test.ts
git diff --check
git commit -m "feat: add distinct user prompt anchor"
```

---

### Task 4: Incremental Inline Markdown Core

**Files:**
- Create: `src/cli/streaming-markdown.ts`
- Create: `tests/unit/cli/streaming-markdown.test.ts`

**Interfaces:**
- Produces: `MarkdownRenderResult = { text: string; lineOpen: boolean }`.
- Produces: `new StreamingMarkdownRenderer(theme: TerminalTheme)`.
- Produces methods `push(text: string): MarkdownRenderResult`, `flush(): MarkdownRenderResult`, and `reset(): void`.
- Task 4 supports plain streaming, bold, italic, inline code, links, newlines, chunk fragmentation, and bounded buffering. Task 5 extends the same class with block syntax.

- [ ] **Step 1: Create tests for plain streaming and inline syntax**

Create helpers:

```ts
import { stripVTControlCharacters } from "node:util";
import { createTheme } from "../../../src/cli/theme.js";
import { StreamingMarkdownRenderer } from "../../../src/cli/streaming-markdown.js";

function render(chunks: string[]): { raw: string; visible: string } {
  const renderer = new StreamingMarkdownRenderer(createTheme({ enabled: true }));
  const raw = chunks.map((chunk) => renderer.push(chunk).text).join("") + renderer.flush().text;
  return { raw, visible: stripVTControlCharacters(raw) };
}
```

Add these behavioral cases:

```ts
test("streams ordinary text before completion", () => {
  const renderer = new StreamingMarkdownRenderer(createTheme({ enabled: true }));
  expect(renderer.push("hello").text).toContain("hello");
});

test.each([
  [["**important**"]],
  [["*", "*important*", "*"]],
  [["**impor", "tant", "**"]],
])("renders fragmented bold without visible delimiters", (chunks) => {
  const result = render(chunks);
  expect(result.visible).toBe("important");
  expect(result.raw).toContain("\x1b[");
});

test("renders italic, inline code and a non-clickable link", () => {
  const result = render(["Use *small* and `npm test`; read [docs](https://example.com)."]);
  expect(result.visible).toBe("Use small and npm test; read docs (https://example.com).");
  expect(result.visible).not.toContain("`");
  expect(result.visible).not.toContain("*");
});

test("bounds an incomplete link candidate and flushes it as readable text", () => {
  const renderer = new StreamingMarkdownRenderer(createTheme({ enabled: true }));
  const prefix = renderer.push("[" + "x".repeat(2048)).text;
  const suffix = renderer.flush().text;
  expect(stripVTControlCharacters(prefix + suffix)).toBe("[" + "x".repeat(2048));
});

test("flush closes state and the next segment starts clean", () => {
  const renderer = new StreamingMarkdownRenderer(createTheme({ enabled: true }));
  const first = renderer.push("**open").text + renderer.flush().text;
  renderer.reset();
  const second = renderer.push("plain").text + renderer.flush().text;
  expect(stripVTControlCharacters(first)).toContain("open");
  expect(stripVTControlCharacters(second)).toBe("plain");
});
```

Fix the `test.each` tuple typing if TypeScript inference requires an explicit `const cases: string[][]`; do not weaken the assertions.

- [ ] **Step 2: Run the new test and observe RED**

Run:

```bash
npm test -- tests/unit/cli/streaming-markdown.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the public result and bounded state**

Start with:

```ts
export type MarkdownRenderResult = {
  text: string;
  lineOpen: boolean;
};

type InlineMode = "plain" | "bold" | "italic" | "code";
const MAX_LINK_CANDIDATE = 2048;

export class StreamingMarkdownRenderer {
  readonly #theme: TerminalTheme;
  #pending = "";
  #inlineMode: InlineMode = "plain";
  #lineOpen = false;

  constructor(theme: TerminalTheme) {
    this.#theme = theme;
  }

  push(text: string): MarkdownRenderResult {
    this.#pending += text;
    const rendered = this.#drain(false);
    return { text: rendered, lineOpen: this.#lineOpen };
  }

  flush(): MarkdownRenderResult {
    const rendered = this.#drain(true);
    this.#inlineMode = "plain";
    return { text: rendered, lineOpen: this.#lineOpen };
  }

  reset(): void {
    this.#pending = "";
    this.#inlineMode = "plain";
    this.#lineOpen = false;
  }
}
```

The parser must never leave ANSI open across calls. Instead, style each emitted visible run with the current theme wrapper:

```ts
#style(text: string): string {
  switch (this.#inlineMode) {
    case "bold": return this.#theme.bold(text);
    case "italic": return this.#theme.italic(text);
    case "code": return this.#theme.code(text);
    case "plain": return text;
  }
}
```

This makes every output chunk independently reset-safe while the logical Markdown mode can span provider chunks.

- [ ] **Step 4: Implement deterministic inline draining**

`#drain(flush: boolean)` must repeatedly consume `#pending`:

1. Emit ordinary runs up to the next `*`, backtick, `[`, or newline through `#style()`.
2. A newline is emitted literally and sets `#lineOpen = false`.
3. At `*`, wait if it is the final buffered character and `flush` is false. Two stars toggle bold; one star toggles italic. Delimiters are not emitted.
4. A single backtick toggles inline code. When already in code mode, only backtick has syntax; all stars and brackets are ordinary code text.
5. At `[`, match `^\[([^\]\n]{1,1024})\]\(([^)\n]{1,1024})\)`. A match emits `theme.underline(label) + theme.muted(" (" + url + ")")`. If the candidate is incomplete and below 2048 characters with no newline, retain it for the next push. Otherwise emit the leading `[` literally and continue.
6. On `flush`, emit every incomplete candidate literally or as readable current-mode text, clear pending state, and close logical inline mode.
7. Every emitted non-newline visible character sets `#lineOpen = true`.

Use this concrete control flow. Extracting the repeated emit/update logic into a private helper is encouraged, but its behavior must remain identical:

```ts
#drain(flush: boolean): string {
  let output = "";
  const emit = (visible: string): void => {
    if (visible === "") return;
    output += this.#style(visible);
    this.#lineOpen = !visible.endsWith("\n");
  };

  while (this.#pending !== "") {
    if (this.#inlineMode === "code") {
      const close = this.#pending.indexOf("`");
      if (close < 0) {
        emit(this.#pending);
        this.#pending = "";
        break;
      }
      emit(this.#pending.slice(0, close));
      this.#pending = this.#pending.slice(close + 1);
      this.#inlineMode = "plain";
      continue;
    }

    const special = this.#pending.search(/[*`[\n]/u);
    if (special < 0) {
      emit(this.#pending);
      this.#pending = "";
      break;
    }
    if (special > 0) {
      emit(this.#pending.slice(0, special));
      this.#pending = this.#pending.slice(special);
      continue;
    }

    if (this.#pending[0] === "\n") {
      output += "\n";
      this.#pending = this.#pending.slice(1);
      this.#lineOpen = false;
      continue;
    }
    if (this.#pending[0] === "`") {
      this.#pending = this.#pending.slice(1);
      this.#inlineMode = "code";
      continue;
    }
    if (this.#pending[0] === "*") {
      if (this.#pending.length === 1 && !flush) break;
      if (this.#pending.startsWith("**")) {
        this.#pending = this.#pending.slice(2);
        this.#inlineMode = this.#inlineMode === "bold" ? "plain" : "bold";
      } else {
        this.#pending = this.#pending.slice(1);
        this.#inlineMode = this.#inlineMode === "italic" ? "plain" : "italic";
      }
      continue;
    }

    const link = /^\[([^\]\n]{1,1024})\]\(([^)\n]{1,1024})\)/u.exec(this.#pending);
    if (link !== null) {
      output += this.#theme.underline(link[1]!) + this.#theme.muted(` (${link[2]})`);
      this.#lineOpen = true;
      this.#pending = this.#pending.slice(link[0].length);
      continue;
    }
    const newline = this.#pending.indexOf("\n");
    if (!flush && newline < 0 && this.#pending.length <= MAX_LINK_CANDIDATE) break;
    emit("[");
    this.#pending = this.#pending.slice(1);
  }

  if (flush && this.#pending !== "") {
    emit(this.#pending);
    this.#pending = "";
  }
  return output;
}
```

When Task 5 adds line-prefix parsing, this scanner becomes the inline stage called after a prefix is classified. Preserve the bounded-link and immediate ordinary-text behavior while refactoring.

Do not attempt nested inline styles. The approved subset requires stable common model output, not full CommonMark precedence.

- [ ] **Step 5: Add partition-invariance and Unicode tests**

Add:

```ts
test("common chunk partitions have identical visible output", () => {
  const source = "中文 **重点** 与 `代码` 😀\n";
  const expected = render([source]).visible;
  expect(render([...source]).visible).toBe(expected);
  expect(render([source.slice(0, 3), source.slice(3, 8), source.slice(8)]).visible).toBe(expected);
});

test("reports whether the rendered cursor is inside a line", () => {
  const renderer = new StreamingMarkdownRenderer(createTheme({ enabled: true }));
  expect(renderer.push("hello").lineOpen).toBe(true);
  expect(renderer.push("\n").lineOpen).toBe(false);
});
```

- [ ] **Step 6: Run focused tests until GREEN**

Run:

```bash
npm test -- tests/unit/cli/streaming-markdown.test.ts
npm run typecheck
```

Expected: all inline cases pass, ordinary text is emitted during `push()`, and the incomplete-link buffer never grows beyond the stated cap before releasing text.

- [ ] **Step 7: Commit Task 4**

```bash
git add src/cli/streaming-markdown.ts tests/unit/cli/streaming-markdown.test.ts
git diff --check
git commit -m "feat: add streaming inline markdown renderer"
```

---

### Task 5: Markdown Block Prefixes and Fenced Code

**Files:**
- Modify: `src/cli/streaming-markdown.ts`
- Modify: `tests/unit/cli/streaming-markdown.test.ts`

**Interfaces:**
- Preserves Task 4's constructor and `push`/`flush`/`reset` signatures.
- Consumes `terminalWidth()` from `src/cli/terminal-text.ts` when sizing heading dividers.
- Adds block recognition for headings, unordered/ordered lists, quotes, and fenced code.
- Buffers only an undecided line prefix or fence line, never an ordinary paragraph or the complete answer.

- [ ] **Step 1: Add failing block-level tests**

Add cases whose expected visible output is exact:

```ts
test("renders headings, lists and quotes", () => {
  const result = render([
    "## 主要问题\n",
    "- first\n",
    "* second\n",
    "1. numbered\n",
    "> quoted\n",
    "### Smaller\n",
  ]);
  expect(result.visible).toBe([
    "主要问题",
    "────────",
    "• first",
    "• second",
    "1. numbered",
    "│ quoted",
    "Smaller",
    "",
  ].join("\n"));
});

test("renders fragmented fenced code without parsing markdown inside", () => {
  const result = render([
    "`", "``ts\n",
    "const value = **raw**;\n",
    "`", "``\n",
  ]);
  expect(result.visible).toBe("  │ const value = **raw**;\n");
  expect(result.visible).not.toContain("```ts");
});

test("flushes an unclosed fence and resets for the next segment", () => {
  const renderer = new StreamingMarkdownRenderer(createTheme({ enabled: true }));
  const first = renderer.push("```\ncode").text + renderer.flush().text;
  renderer.reset();
  const second = renderer.push("plain").text + renderer.flush().text;
  expect(stripVTControlCharacters(first)).toBe("  │ code");
  expect(stripVTControlCharacters(second)).toBe("plain");
});
```

Add a heading longer than 24 cells and assert its synthesized divider is exactly 24 `─` cells. Add a test proving an ordinary line beginning with `#not-a-heading` is preserved literally.

Use exact assertions:

```ts
test("caps synthesized heading dividers at 24 cells", () => {
  const visible = render(["# " + "x".repeat(40) + "\n"]).visible;
  expect(visible).toBe("x".repeat(40) + "\n" + "─".repeat(24) + "\n");
});

test("preserves a hash that is not followed by a heading space", () => {
  expect(render(["#not-a-heading\n"]).visible).toBe("#not-a-heading\n");
});

test.each([1, 2, 3, 4, 5, 6])("renders heading level %i without raw hashes", (level) => {
  const visible = render([`${"#".repeat(level)} Heading\n`]).visible;
  expect(visible.startsWith("Heading\n")).toBe(true);
  expect(visible).not.toContain("#");
  expect(visible.includes("───────\n")).toBe(level <= 2);
});
```

- [ ] **Step 2: Run block tests and observe RED**

Run:

```bash
npm test -- tests/unit/cli/streaming-markdown.test.ts
```

Expected: inline tests remain green; new block tests fail because prefixes and fences are currently emitted literally.

- [ ] **Step 3: Add explicit block state**

Extend the class with:

```ts
type BlockMode = "normal" | "code";

#blockMode: BlockMode = "normal";
#atLineStart = true;
#linePrefix = "";
#headingLevel: number | undefined;
#headingVisibleWidth = 0;
#codeLineStarted = false;
```

`reset()` must restore every field. `flush()` must release an undecided `#linePrefix`, close a code block logically, clear heading state, and return a reset-safe result.

- [ ] **Step 4: Implement bounded line-prefix classification**

Before inline parsing, collect only a possible prefix at line start. Decide according to these exact rules:

````text
#{1,6} + one space     heading; suppress prefix
- + one space          emit "• "
* + one space          emit "• "
1-9 digits + ". "     emit the original number and ". "
> + optional one space emit theme.quote("│ ")
``` + optional language until newline
                       suppress fence line and enter code mode
anything else          release the prefix literally to inline parsing
````

Limit a numeric-list candidate to 9 digits. A heading with no separating space is ordinary text. Preserve the input's leading indentation before a recognized list/quote prefix.

For level 1 and 2 headings, count the visible heading cells while emitting the styled title. When its newline arrives, output that newline followed by `theme.muted("─".repeat(Math.min(24, Math.max(1, headingWidth))))` and another newline. Levels 3–6 output only the styled title and original newline.

- [ ] **Step 5: Implement fenced-code state**

In code mode:

- at the start of each content line, emit `  │ `, styling the prefix with `theme.quote`;
- emit code content through `theme.code`, without inline Markdown parsing;
- preserve blank code lines as `  │ \n`;
- at line start, buffer up to three backticks to detect a closing fence;
- a line containing exactly a closing triple fence plus optional whitespace is suppressed and returns to normal mode;
- a backtick sequence that is not a closing fence is emitted as code;
- `flush()` of an unclosed fence emits pending code characters, leaves no ANSI open, and resets block mode.

Do not show the optional language label and do not perform syntax highlighting.

- [ ] **Step 6: Add adversarial chunk tests**

Cover every decision point with exact visible output:

```ts
test.each([
  { chunks: ["#", "# Title\n"], expected: "Title\n─────\n" },
  { chunks: ["-", " item\n"], expected: "• item\n" },
  { chunks: ["1", ". item\n"], expected: "1. item\n" },
  { chunks: [">", " quote\n"], expected: "│ quote\n" },
  { chunks: ["`", "`", "`js\ncode\n", "```\n"], expected: "  │ code\n" },
])("recognizes $chunks across block-prefix chunk boundaries", ({ chunks, expected }) => {
  expect(render(chunks).visible).toBe(expected);
});
```

- [ ] **Step 7: Run focused tests until GREEN**

Run:

```bash
npm test -- tests/unit/cli/streaming-markdown.test.ts
npm run typecheck
```

Expected: all inline and block cases pass; ordinary paragraphs still emit during `push()` and do not wait for newline or completion.

- [ ] **Step 8: Commit Task 5**

```bash
git add src/cli/streaming-markdown.ts tests/unit/cli/streaming-markdown.test.ts
git diff --check
git commit -m "feat: render streaming markdown blocks"
```

---

### Task 6: Assistant Anchors and Renderer Integration

**Files:**
- Modify: `src/cli/renderer.ts`
- Modify: `tests/unit/cli/renderer.test.ts`

**Interfaces:**
- Consumes: `StreamingMarkdownRenderer` and `MarkdownRenderResult` from Tasks 4–5.
- Produces one permanent `◆ NJUAgent` label for each model step that emits at least one non-empty text delta.
- Preserves all existing non-TTY `[model]`, `[tool]`, `[usage]`, `[run]`, live-output limiting, and concise tool-summary contracts.

- [ ] **Step 1: Write failing assistant-segment tests**

Add a local ANSI stripper using `stripVTControlCharacters`, then add:

```ts
test("prints one assistant anchor lazily for a text-producing model step", () => {
  const stdout = new MemoryStdout();
  const renderer = ttyRenderer(stdout);
  renderer.handle({ type: "model_started", step: 1 });
  renderer.handle({ type: "text_delta", text: "" });
  renderer.handle({ type: "text_delta", text: "hello " });
  renderer.handle({ type: "text_delta", text: "**world**" });
  renderer.handle({ type: "model_completed", stopReason: "end_turn" });

  const visible = stripVTControlCharacters(stdout.text());
  expect(visible.match(/◆ NJUAgent/gu)).toHaveLength(1);
  expect(visible).toContain("hello world");
  expect(visible).not.toContain("**");
});

test("does not print an empty assistant anchor for direct tool use", () => {
  const stdout = new MemoryStdout();
  const renderer = ttyRenderer(stdout);
  renderer.handle({ type: "model_started", step: 1 });
  renderer.handle({ type: "model_completed", stopReason: "tool_use" });
  renderer.handle({ type: "tool_started", id: "c1", name: "read_file", summary: "{\"path\":\"a.ts\"}" });
  expect(stripVTControlCharacters(stdout.text())).not.toContain("◆ NJUAgent");
});

test("tool-separated text steps receive separate assistant anchors", () => {
  const stdout = new MemoryStdout();
  const renderer = ttyRenderer(stdout);
  renderer.handle({ type: "model_started", step: 1 });
  renderer.handle({ type: "text_delta", text: "I will inspect." });
  renderer.handle({ type: "model_completed", stopReason: "tool_use" });
  renderer.handle({ type: "tool_started", id: "c1", name: "read_file", summary: "{\"path\":\"a.ts\"}" });
  renderer.handle({ type: "tool_completed", id: "c1", name: "read_file", ok: true, durationMs: 1 });
  renderer.handle({ type: "model_started", step: 2 });
  renderer.handle({ type: "text_delta", text: "Found it." });
  expect(stripVTControlCharacters(stdout.text()).match(/◆ NJUAgent/gu)).toHaveLength(2);
});
```

Add a non-TTY case confirming raw `**bold**` remains in `[model]` output.

- [ ] **Step 2: Run renderer tests and observe RED**

Run:

```bash
npm test -- tests/unit/cli/renderer.test.ts
```

Expected: FAIL because there is no assistant label and TTY Markdown is written raw.

- [ ] **Step 3: Add renderer state and lazy segment start**

Add fields:

```ts
readonly #markdown: StreamingMarkdownRenderer;
#assistantLabelShown = false;
#modelLineOpen = false;
```

Create `#markdown` from the renderer's resolved `#theme` in the constructor. At `model_started`, reset only per-step presentation state:

```ts
this.#assistantLabelShown = false;
this.#markdown.reset();
this.#modelLineOpen = false;
```

On an empty `text_delta`, do nothing. On the first non-empty interactive delta:

1. clear the transient spinner line and set `#transient = ""`;
2. write `${theme.assistantLabel("◆ NJUAgent")}\n\n` exactly once;
3. set `#assistantLabelShown = true`;
4. pass text to `#markdown.push()` and write its returned text;
5. copy `result.lineOpen` to `#modelLineOpen`.

Do not use `#permanent()` for streaming Markdown content because that method appends a newline. It is acceptable to use a focused helper that suspends/resumes the input surface, clears transient status, and writes bytes without forcing a newline.

- [ ] **Step 4: Replace raw stream flushing with Markdown-aware flushing**

Replace `#flushStreamingText()` with a helper whose behavior is:

```ts
#flushModelText(): void {
  if (!this.#interactive) return;
  const remainder = this.#markdown.flush();
  if (remainder.text !== "") this.#stdout.write(remainder.text);
  this.#modelLineOpen = remainder.lineOpen;
  if (this.#modelLineOpen) this.#stdout.write("\n");
  this.#modelLineOpen = false;
}
```

Call this helper before `model_completed`, `tool_started`, `retrying` permanent output, `run_finished`, and `error()`. After a boundary, call `#markdown.reset()` before the next model step.

Interactive `usage` is also an output boundary because Provider usage can arrive immediately before `model_completed`; flush model text before drawing its transient token status. Remove automatic model flushing from both `#status()` and `#permanent()`. Boundary cases in `handle()` and `error()` must call `#flushModelText()` explicitly. This avoids hidden recursive or premature flushing.

Avoid recursive flushing: `#permanent()` must not call a helper that calls `#permanent()` again. Keep model flushing and general permanent-line writing as separate primitives.

- [ ] **Step 5: Preserve plain mode and tool/status behavior**

Leave `#writePlainModelDelta()` and `#flushPlainModelText()` intact. Keep concise tool cards and live-output limiting unchanged. Migrate any remaining visual brand references to semantic theme methods.

Add one blank line after the interactive run summary so the next readline prompt is visually separated. Implement it in the summary output, not by adding whitespace to the prompt string. Do not add blank lines to non-TTY records.

- [ ] **Step 6: Add boundary and reset tests**

Add tests for:

- unclosed `**` followed by `model_completed` does not style the run summary;
- unclosed fenced code followed by `tool_started` does not style the tool card;
- retry/error/cancel leave a visible reset sequence before later permanent text;
- multiple delta chunks still appear before `run_finished`;
- a model response ending in newline does not gain two extra blank lines;
- interactive tool cards still omit internal ids and raw JSON;
- no-color/non-TTY snapshots contain no ANSI and preserve raw Markdown.

Use ANSI-stripped structural assertions plus focused checks for assistant color `141`; do not snapshot spinner frame order.

At minimum include these concrete boundary tests in addition to retaining the existing tool-card and incremental-stream tests:

```ts
test("an unclosed inline style cannot color the run summary", () => {
  const stdout = new MemoryStdout();
  const renderer = ttyRenderer(stdout);
  renderer.handle({ type: "model_started", step: 1 });
  renderer.handle({ type: "text_delta", text: "**open" });
  renderer.handle({ type: "model_completed", stopReason: "end_turn" });
  renderer.handle({ type: "run_finished", result: result("completed") });
  const raw = stdout.text();
  expect(stripVTControlCharacters(raw)).toContain("open");
  expect(stripVTControlCharacters(raw)).toContain("✓ Completed");
  expect(raw.lastIndexOf("\x1b[0m")).toBeLessThan(raw.lastIndexOf("Completed"));
});

test("an unclosed fence is flushed before a tool card", () => {
  const stdout = new MemoryStdout();
  const renderer = ttyRenderer(stdout);
  renderer.handle({ type: "model_started", step: 1 });
  renderer.handle({ type: "text_delta", text: "```ts\nconst x = 1;" });
  renderer.handle({ type: "model_completed", stopReason: "tool_use" });
  renderer.handle({
    type: "tool_started",
    id: "c1",
    name: "read_file",
    summary: "{\"path\":\"a.ts\"}",
  });
  const visible = stripVTControlCharacters(stdout.text());
  expect(visible).toContain("  │ const x = 1;");
  expect(visible).toContain("⚙ read_file · a.ts");
});

test("a response already ending in newline does not gain duplicate model newlines", () => {
  const stdout = new MemoryStdout();
  const renderer = ttyRenderer(stdout);
  renderer.handle({ type: "model_started", step: 1 });
  renderer.handle({ type: "text_delta", text: "done\n" });
  renderer.handle({ type: "model_completed", stopReason: "end_turn" });
  expect(stripVTControlCharacters(stdout.text())).not.toContain("done\n\n\n");
});
```

If ANSI wrapper nesting makes the first test's index comparison brittle, replace it with a test theme whose `bold`, `code`, and `success` wrappers emit deterministic textual markers; do not delete the style-leak assertion.

- [ ] **Step 7: Run focused tests until GREEN**

Run:

```bash
npm test -- tests/unit/cli/streaming-markdown.test.ts tests/unit/cli/renderer.test.ts tests/unit/cli/prompt.test.ts
npm run typecheck
```

Expected: all pass; `◆ NJUAgent` appears once per text-producing step, common Markdown delimiters are absent from interactive visible output, and plain mode is unchanged.

- [ ] **Step 8: Commit Task 6**

```bash
git add src/cli/renderer.ts tests/unit/cli/renderer.test.ts
git diff --check
git commit -m "feat: distinguish assistant transcript segments"
```

---

### Task 7: Full Regression, TTY Acceptance, and Handoff Evidence

**Files:**
- Modify only if a verified failure requires a scoped correction: files listed in Tasks 1–6 and their tests
- Do not modify: package version, dependencies, lockfile, Agent/Provider/Session/Context/Skill implementation

**Interfaces:**
- Verifies the complete spec; introduces no new product behavior.
- Produces a concise evidence report for the reviewer, including automated results and manual TTY observations.

- [ ] **Step 1: Run the complete automated verification from a fresh command**

Run in this order:

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

Expected: typecheck exits 0; all Vitest files and tests pass with zero failures; build exits 0; diff check emits no errors.

If a command fails, record the exact failing file/assertion, make only the smallest in-scope correction using a failing focused test, rerun that focused test, then rerun all four commands from the beginning.

- [ ] **Step 2: Verify scope mechanically**

Run:

```bash
git status --short
git diff --stat 3e23767...HEAD
git diff --name-only 3e23767...HEAD
rg -n "ink|blessed|alternate screen|SlashSuggestion|command palette" src package.json
```

Expected:

- changed source/test files are confined to the Target File Map;
- `package.json` and the lockfile are unchanged;
- the final search finds no newly introduced UI framework or Slash-menu implementation;
- no generated `dist/` files are staged.

- [ ] **Step 3: Run plain-output acceptance without credentials or model calls**

Use existing automated bootstrap seams where possible. At minimum verify:

```bash
NO_COLOR=1 node dist/index.js --help
TERM=dumb node dist/index.js --help
```

Expected: help output is readable and contains no ESC bytes. Do not print environment secrets while checking this.

- [ ] **Step 4: Run the real TTY visual acceptance**

With the user's existing environment configuration, run:

```bash
node dist/index.js --workspace /tmp/demo
```

Check every item and record PASS/FAIL:

1. startup clears the visible screen once and prints one welcome card;
2. at 80+ columns, the complete `NJU` Logo is bright purple and the frame is visibly lighter than the old dark border;
3. at 60 and approximately 40 columns after restart, Logo/frame degradation matches the spec and no border wraps;
4. `❯ You` is cyan and readable; Chinese input, left/right movement, Backspace, and pasted text behave normally;
5. a prompt requesting heading, bold, italic, list, quote, inline code, fenced code, and link output renders without common raw delimiters;
6. a tool-using answer shows a purple `◆ NJUAgent` before each text segment and distinct tool rows between them;
7. three or more turns remain easy to distinguish when scrolling upward;
8. Ctrl-C during a run returns to a clean-colored input prompt;
9. `/help`, `/status`, `/history`, `/context`, and `/exit` retain existing behavior;
10. no model response, tool failure, or cancellation leaves the terminal color stuck.

If live API access is unavailable, mark only API-dependent items SKIP with the reason. Welcome, prompt, resize, `/help`, `/status`, `/history`, `/context`, and `/exit` still require a real TTY check.

- [ ] **Step 5: Review the final diff against the spec section by section**

Use this checklist:

```text
Theme and color disablement       -> Tasks 1 tests
Responsive bordered welcome      -> Task 2 tests + TTY check
Readline user anchor              -> Task 3 tests + Chinese input check
Inline Markdown                   -> Task 4 partition tests
Block/fenced Markdown             -> Task 5 boundary tests
Assistant/tool transcript layers  -> Task 6 event-order tests
Plain/no-color compatibility      -> Tasks 1, 2, 6 + built output check
Slash menu absent                 -> scope search
Full suite/build                  -> Step 1 evidence
```

Do not declare completion if any non-skipped row lacks evidence.

- [ ] **Step 6: Commit any final scoped correction, otherwise leave the verified commits unchanged**

Only when Step 1–5 exposed and you fixed a real issue:

```bash
git add <only-the-corrected-files>
git diff --check
git commit -m "fix: close CLI UI acceptance gaps"
```

If no correction was necessary, do not create an empty commit.

- [ ] **Step 7: Deliver the implementation report**

Report:

- commit hashes produced by Tasks 1–6 and any Task 7 correction;
- exact output summary for typecheck, full Vitest run, and build;
- TTY acceptance PASS/FAIL/SKIP per item;
- any skipped real-API check and its reason;
- confirmation that Slash suggestions, full-screen TUI, syntax highlighting, and persistence changes were not added;
- remaining issues, if any, without describing an incomplete item as complete.

Do not merge, amend the user's unrelated commits, or delete a worktree unless the user separately requests it.
