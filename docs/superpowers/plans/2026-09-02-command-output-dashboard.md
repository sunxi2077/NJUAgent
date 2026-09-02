# Command Output Cards and Session Dashboard — Implementation Plan

> **Audience:** DSH implementation agent
>
> **Objective:** make NJUAgent's slash-command output visually scannable in a normal scrollback-preserving CLI, and provide a useful on-demand status dashboard with context pressure, session token usage, and an optional cost estimate.

## 1. Scope and product decisions

### In scope

1. A reusable, responsive command-output card/table/progress-bar formatter for enhanced TTY mode.
2. Richer output for `/help`, `/status`, `/context`, `/sessions`, `/goal`, `/plan`, `/skills`, and `/setup`.
3. A `/status` dashboard containing session identity, context pressure, and cumulative usage.
4. Cumulative **per-session** model-request counts, reported input tokens, and reported output tokens.
5. Optional, explicitly configured cost estimate.
6. `/sessions [all]`: show the most recent 12 sessions by default, and all sessions only when the user asks for `all`.

### Explicit non-goals

- Do **not** build a persistent bottom status bar, alternate screen UI, fullscreen dashboard, mouse UI, Ink/React/Blessed UI, or a background process.
- Do **not** change model prompts, tool behavior, permissions, workspace rules, API-key handling, session IDs, or slash-palette behavior.
- Do **not** hard-code DeepSeek pricing or claim an exact bill. Pricing changes and providers differ.
- Do **not** add a dependency.
- Do **not** change model response Markdown rendering in this task.

### UX decisions (implement exactly)

- Cards are used for compact structured results; long conversational content and `/history` remain unboxed.
- Enhanced TTY output uses NJU purple titles/borders, muted labels, cyan values/links where useful, green success, yellow warning, and red failure. Reuse semantic `TerminalTheme` methods; do not emit raw ANSI outside `theme.ts`.
- `NO_COLOR`, `TERM=dumb`, and non-TTY output remain ANSI-free, one-line-or-table-like plain text. They must remain useful for scripts.
- `/status` is the dashboard. `/context` remains a focused detailed context view. There is no new `/dashboard` command.
- The default session-list limit is **12**. `/sessions all` is explicit; other arguments show `Usage: /sessions [all]`.
- The cost label is `estimate`, not `cost`. It is based only on reported tokens captured by the client. If pricing is absent, show `not configured`.

## 2. Target interaction examples

These are appearance contracts, not exact byte-for-byte snapshots. Box width must respond to the terminal width and never exceed 88 columns.

### `/status`

```text
╭─ ◆ Session status ────────────────────────────────────╮
│ Model        deepseek-v4-flash                         │
│ Workspace    .                                         │
│ Permission   balanced                                  │
│ Session      61948677 · clean                          │
│ Skill        none · Web search available               │
├─ Context ──────────────────────────────────────────────┤
│ [█░░░░░░░░░░░░░░░░░] 1.4k / 41.9k · 3%                 │
│ Compact at 33.6k · 0 summaries · 0/0 messages covered  │
├─ Usage (this session) ─────────────────────────────────┤
│ 4 requests · 8.2k input · 1.1k output tokens           │
│ Estimate     not configured                            │
╰────────────────────────────────────────────────────────╯
```

Rules:

- The denominator for the bar is `hardInputTokens`, not the nominal context window, because that is the effective host limit.
- Bar states: `< 70%` brand/cyan, `70–89%` warning yellow, `>= 90%` error red.
- Use `0%` when the denominator is zero or invalid; never render `NaN`, `Infinity`, or a bar wider than the card's content region.
- `dirty` is shown as yellow `dirty`; `clean` is green.

### `/context`

```text
╭─ ◇ Context budget ─────────────────────────────────────╮
│ [██████████░░░░░░░] 22.4k / 41.9k · 53%                │
│ Compact at 33.6k · window 48.0k                         │
│ Summary 12/28 messages · 1 compaction                   │
│ Last provider input 21.8k tokens                        │
╰────────────────────────────────────────────────────────╯
```

### `/sessions`

```text
╭─ ◇ Sessions · 41 total ─────────────────────────────────╮
│ ● 61948677  New session          .              now      │
│   be0f1dcc  New session          .              4m ago    │
│   f3cdf6fb  New session          …/NJUAgent/2048 42m ago  │
│ … showing 12 of 41 · /sessions all for the full list     │
╰──────────────────────────────────────────────────────────╯
```

- Current session uses a brand marker `●`; it does not append a long literal `(current)` column.
- Use bounded Unicode-aware truncation for title and workspace. Preserve the existing safe truncation helpers.
- Relative-time formatting is optional only if deterministic tests inject a clock. If that is inconvenient, retain ISO time but put it in a muted final column. Do not call `new Date()` inside a pure formatter.
- Invalid-session diagnostics are warning cards/lines after the list; never hide them.

### `/help`

```text
╭─ ◆ Commands ───────────────────────────────────────────╮
│ Session                                                  │
│   /sessions   Browse saved sessions                      │
│   /resume     Continue a saved session                   │
│   /new        Start a new session                        │
│ Agent                                                    │
│   /status     Show session, context, and usage           │
│   /plan       Show or clear the execution plan           │
│   /goal       Set or inspect a completion goal           │
│ Context & skills                                         │
│   /context    Inspect context budget                     │
│   /compact    Compact conversation now                   │
│   /skills     List Skills                                │
│   /skill      Activate a Skill                           │
│ Configuration                                            │
│   /setup      Update model and permission configuration  │
│   /exit       Save and exit                              │
│ Use // to send literal text beginning with /.            │
╰─────────────────────────────────────────────────────────╯
```

Keep exact command `usage` text, including argument syntax, visible in the card. Grouping should be defined as metadata on each core command, not by an ad-hoc string match in `help-command.ts`.

## 3. Data model and accounting

### 3.1 Persisted per-session usage

Extend `PersistedSessionV1.stats` with:

```ts
usage: {
  requests: number;
  inputTokens: number;
  outputTokens: number;
}
```

All values are non-negative integers. `createEmptySession()` initializes all three to zero.

Backward compatibility is mandatory:

- Existing v1 JSON files lack `stats.usage`.
- In `normalizeSessionCandidate()`, merge the old `stats` object with the zero-valued usage default before Ajv validation.
- Keep `schemaVersion: 1`; this is a backward-compatible additive normalized field, not a new file format family.
- Add `usage` to the strict Ajv schema and keep `additionalProperties: false`.
- Validate that all three values are integers `>= 0`.

### 3.2 Capture every provider stream consistently

Do not derive totals from rendered text and do not put accounting only in `TerminalRenderer`.

Add a small provider decorator, e.g. `src/providers/usage-tracking-provider.ts`:

```ts
export type UsageRecord = { inputTokens: number; outputTokens: number };

export class UsageTrackingProvider implements ModelProvider {
  constructor(
    private readonly inner: ModelProvider,
    private readonly onUsage: (usage: UsageRecord) => void,
  ) {}
  // stream() forwards every event unchanged. For each provider stream, retain
  // the most recent usage event; once the stream completes, invoke onUsage once.
}
```

Important semantics:

- Wrap the provider once in `createRuntime()` **before** constructing `ModelCompactor`, `ModelGoalEvaluator`, and `AgentRunner`. This counts ordinary worker requests, compaction calls, and goal-evaluator calls uniformly.
- A stream contributes at most one record: its final reported `usage` event. This avoids double counting if a provider emits multiple usage updates.
- If a stream throws after reporting usage, still record the latest usage before rethrowing; work may have been billed.
- If no usage event arrives, record nothing. Do not invent an estimate.
- `onUsage` mutates `session.stats.usage` synchronously. Existing checkpoint/compact/goal persistence paths already save the session after the relevant operation.
- Do not count retries twice unless the upstream returned a separate usage event for each retry attempt; each actual provider stream with reported usage is intentionally a separate request.

Add unit tests for the wrapper: unchanged event forwarding, one record from multiple usage events, no record without usage, and record-before-rethrow after a usage event.

### 3.3 Optional pricing configuration

Add optional configuration values:

```text
MODEL_INPUT_COST_PER_MTOKENS
MODEL_OUTPUT_COST_PER_MTOKENS
```

Both are decimal USD values per one million tokens. Rules:

- Both must be present or both absent.
- Parse finite, non-negative decimal numbers. Reject `NaN`, Infinity, negatives, and blank-one-side configuration with `ConfigError`.
- Add `pricing?: { inputPerMillion: number; outputPerMillion: number }` to `AppConfig` only when both are configured.
- Never persist prices or API keys in the user config file; pricing stays environment-only like the API key.
- Estimate formula:

```ts
(inputTokens / 1_000_000) * inputPerMillion +
(outputTokens / 1_000_000) * outputPerMillion
```

- Render USD with enough precision for small values: `$0.0000` below $0.01, `$0.00` otherwise. The label must say `Estimate`.
- The README must explain that this is an estimate based on reported tokens and does not model provider-specific cache discounts, promotions, taxes, or external usage.

## 4. Presentation architecture

### 4.1 New pure layout module

Create `src/cli/command-layout.ts`. It must be a pure formatter: no stream writes, no global terminal reads, no process environment reads, and no session mutation.

Suggested exports:

```ts
export type CommandPanel = {
  title: string;
  symbol: string;
  sections: readonly {
    heading?: string;
    rows: readonly { label?: string; value: string }[];
  }[];
  footer?: string;
};

export function formatCommandPanel(
  panel: CommandPanel,
  options: { columns: number; theme: TerminalTheme },
): string;

export function formatProgressBar(
  value: number,
  maximum: number,
  options: { cells: number; theme: TerminalTheme },
): string;
```

Formatting rules:

- Use `terminalWidth`, `truncateToTerminalWidth`, and `sanitizeTerminalText` from `terminal-text.ts`; never use JavaScript string `.length` to size a terminal column.
- Full card mode at `>= 48` columns, compact borderless mode below it, and a safe one-line fallback below 28 columns.
- Maximum outer width: 88 columns; leave one terminal cell free to avoid implicit wrapping.
- Card title/border: `theme.brandBorder`; title glyph and selected key values: `theme.brandStrong`; labels: `theme.muted`.
- Never pad ANSI text with `String.padEnd`; calculate padding from `terminalWidth`.
- Existing plain-mode formatters remain explicit, stable text. `formatCommandPanel` can return a plain sectioned format when `theme.enabled === false`.

### 4.2 Give command formatters access to terminal width

Add a narrow display field to `CommandContext`, for example:

```ts
display: {
  enhanced: boolean;
  columns: () => number;
};
```

At composition in `src/index.ts`, return the current `stdout.columns` when it is a finite positive number; otherwise return 80. This must be a function so a terminal resize is reflected for the next command. Test fixtures may use `() => 80`.

Do not make individual commands inspect `process.stdout` directly.

### 4.3 Session formatters become display models

Keep `src/sessions/session-format.ts` as the only formatter for session/status/context/skills values, but split it into small functions where useful:

- `formatSessionList(...)`
- `formatSessionStatus(...)`
- `formatContextStatus(...)`
- `formatSkillList(...)`
- `formatUsage(...)` (new; accepts usage plus optional pricing)

Each selects a card only when `theme.enabled` and uses legacy readable plain records otherwise. Do not put command routing logic into this module.

## 5. File-by-file implementation tasks

### Task 1 — Layout primitives and visual contracts

**Files**

- Create: `src/cli/command-layout.ts`
- Test: `tests/unit/cli/command-layout.test.ts`
- Modify only if needed: `src/cli/theme.ts`, `src/cli/terminal-text.ts`

**Tests first**

- Full panel has uniform visible row width with ANSI enabled.
- Chinese text, long workspace path, and long command description truncate without splitting surrogate pairs or overflowing the panel.
- Narrow 47-, 28-, and 20-column paths never emit negative repeat counts or terminal-wrap-width lines.
- Progress bar has normal/warning/error states and protects zero maximum.
- Disabled theme output contains no ANSI bytes.

**Implementation**

- Implement the smallest pure card/table/progress functions to satisfy these tests.
- Do not change commands yet.

**Verification**

```bash
npm test -- --run tests/unit/cli/command-layout.test.ts tests/unit/cli/theme.test.ts tests/unit/cli/terminal-text.test.ts
```

### Task 2 — Session usage persistence and provider accounting

**Files**

- Create: `src/providers/usage-tracking-provider.ts`
- Modify: `src/sessions/session-schema.ts`
- Modify: `src/runtime/create-runtime.ts`
- Test: `tests/unit/providers/usage-tracking-provider.test.ts`
- Test: `tests/unit/sessions/session-schema.test.ts`
- Test: `tests/unit/sessions/session-manager.test.ts` or `tests/integration/session-lifecycle.test.ts`

**Tests first**

- New empty sessions have zero usage.
- Old v1 session fixture without `stats.usage` parses to zeros.
- Invalid negative/non-integer usage is rejected.
- Usage wrapper forwards event sequence and only records the final usage once per stream.
- A usage event followed by a provider exception still updates totals.
- Resume/save round trip retains totals.

**Implementation**

- Normalize old stats before strict validation.
- Wrap the provider exactly once in runtime construction and mutate only the active session's usage totals.
- Avoid double wrapping on resume/reconfigure.

**Verification**

```bash
npm test -- --run tests/unit/providers/usage-tracking-provider.test.ts tests/unit/sessions/session-schema.test.ts tests/unit/sessions/session-manager.test.ts
```

### Task 3 — Optional pricing configuration

**Files**

- Modify: `src/config.ts`
- Modify: `src/cli/help.ts`
- Modify: `.env.example`
- Modify: `README.md`
- Test: `tests/unit/config.test.ts`
- Test: `tests/unit/cli/help.test.ts`

**Tests first**

- Pricing is absent when both variables are absent.
- Valid decimal pair reaches `AppConfig.pricing`.
- One-sided, blank-one-sided, negative, NaN, and Infinity configuration is rejected without echoing any secret values.
- Help and `.env.example` document the names and label them optional.

**Implementation**

- Add a small paired-decimal parser; do not reuse positive-integer parsing.
- Do not alter setup persistence or write pricing into config JSON.

**Verification**

```bash
npm test -- --run tests/unit/config.test.ts tests/unit/cli/help.test.ts
```

### Task 4 — Rich `/status` and `/context`

**Files**

- Modify: `src/cli/command.ts`
- Modify: `src/index.ts`
- Modify: `src/sessions/session-format.ts`
- Modify: `src/cli/commands/status-command.ts`
- Modify: `src/cli/commands/context-command.ts`
- Test: `tests/unit/sessions/session-format.test.ts`
- Test: `tests/unit/cli/commands/context-commands.test.ts`
- Test: `tests/integration/bootstrap.test.ts` only if command-context composition changes require it

**Tests first**

- Enhanced `/status` contains model/workspace/permission/session, context bar, request/input/output totals, and either formatted estimate or `not configured`.
- Enhanced `/context` contains ratio bar, compact threshold, hard limit, window, covered-message count, compaction count, and last provider input when present.
- Plain mode contains the same factual fields without ANSI or box-drawing requirements.
- Dirty/clean, web-search availability, goal state, and plan progress remain visible.

**Implementation notes**

- Current `SessionManager.contextStatus()` already provides all context values. Add only the session usage/pricing input needed by the formatter.
- Use `session.id.slice(0, 8)`; do not expose full IDs in the dashboard.
- Show the active workspace as `.` when it equals the current process workspace; otherwise use the safely truncated path.

**Verification**

```bash
npm test -- --run tests/unit/sessions/session-format.test.ts tests/unit/cli/commands/context-commands.test.ts tests/integration/bootstrap.test.ts
```

### Task 5 — Help grouping and compact list/card command output

**Files**

- Modify: `src/cli/command.ts`
- Modify: every file in `src/cli/commands/` that creates a core command, to declare its help group
- Modify: `src/cli/commands/help-command.ts`
- Modify: `src/cli/commands/sessions-command.ts`
- Modify: `src/cli/commands/skills-command.ts`
- Modify: `src/cli/commands/goal-command.ts`
- Modify: `src/cli/commands/plan-command.ts`
- Modify: `src/cli/commands/setup-command.ts`
- Modify: `src/sessions/session-format.ts`
- Test: `tests/unit/cli/command-router.test.ts`
- Test: `tests/unit/cli/commands/session-commands.test.ts`
- Test: `tests/unit/cli/commands/skill-commands.test.ts`
- Test: `tests/unit/cli/prompt.test.ts`
- Test: `tests/integration/slash-palette.test.ts`

**Command groups**

| Group | Commands |
| --- | --- |
| Session | `/sessions`, `/resume`, `/new`, `/history`, `/exit` |
| Agent | `/status`, `/plan`, `/goal` |
| Context & skills | `/context`, `/compact`, `/skills`, `/skill` |
| Configuration | `/setup`, `/help` |

**Tests first**

- `/help` has groups in the stated order and retains every command/usage string exactly once.
- `/sessions` default returns exactly 12 newest rows, a total count, current marker, and an `all` hint when truncated.
- `/sessions all` returns all rows; invalid args show usage and do not call list twice.
- Long CJK title/workspace data stays inside width constraints.
- `/skills` empty state, active skill state, and diagnostics remain visible.
- `/goal`, `/plan`, and `/setup` preserve their state-changing behavior; only presentation changes.
- Slash completion descriptors remain name/usage/description only; help grouping must not alter palette behavior.

**Implementation notes**

- Add `group` metadata to the internal `SlashCommand` contract but keep `SlashCommandDescriptor` unchanged.
- Do not box every warning separately. A diagnostic should be a concise yellow warning line/card after its related output.
- `/history` stays transcript-oriented; only improve role color/labels if necessary, no card wrapper.

**Verification**

```bash
npm test -- --run tests/unit/cli/command-router.test.ts tests/unit/cli/commands/session-commands.test.ts tests/unit/cli/commands/skill-commands.test.ts tests/unit/cli/prompt.test.ts tests/integration/slash-palette.test.ts
```

### Task 6 — Documentation and final integration check

**Files**

- Modify: `README.md`
- Modify: `.env.example`
- Modify tests only where behavior/documented flags changed

**Documentation requirements**

- Explain `/status`, `/context`, and `/sessions all` succinctly.
- Document optional pricing variables and estimate caveats.
- Keep environment documentation free of actual keys and local usernames.

**Verification policy**

The user explicitly wants to conserve usage. Therefore:

- After Tasks 1–5, run only each task's focused tests plus `npm run build`.
- Before handoff, run `npm run typecheck`, `npm run build`, and `git diff --check`.
- Run the full `npm test` suite once only if time/budget permits or the user asks for final release-grade verification. If skipped, report that it was intentionally skipped and list the focused tests that passed.

## 6. Acceptance checklist

- [ ] In an enhanced terminal, `/help`, `/status`, `/context`, `/sessions`, `/goal`, `/plan`, `/skills`, and `/setup` have readable hierarchy, NJU-purple accents, and no overlong bare text dump.
- [ ] In `NO_COLOR`, `TERM=dumb`, and non-TTY, all commands still provide complete plain output without ANSI bytes.
- [ ] `/status` shows a width-safe context percentage/bar and facts consistent with `/context`.
- [ ] New session usage begins at zero, survives save/resume, and increases only from provider-reported usage.
- [ ] Pricing is opt-in, paired, validated, and presented as an estimate.
- [ ] `/sessions` does not flood the terminal by default; `/sessions all` is available.
- [ ] Existing sessions created before usage support load successfully with zero counters.
- [ ] Slash palette command discovery and Enter/Tab completion behavior remain unchanged.
- [ ] No API key, Tavily key, or raw environment value is printed, persisted, or introduced into snapshots.
- [ ] Focused tests and build/typecheck results are included in the implementation handoff.

## 7. Suggested commits

If the executor is asked to commit, keep commits reviewable:

1. `feat: add command output layout primitives`
2. `feat: track per-session model usage`
3. `feat: add optional token cost estimates`
4. `feat: redesign slash command output panels`
5. `docs: document status dashboard and usage estimates`

Do not commit generated `dist/`, runtime session files, `.env`, or the user's untracked `2048/` directory.
