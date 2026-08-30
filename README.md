# NJUAgent

A small, independently implemented command-line coding agent. Give it a natural-language programming task in a workspace and it plans and executes its own steps: reading and searching code, editing files, and running builds and tests — until it decides it is done.

NJUAgent does **not** wrap Claude Code, Codex, or any agent framework. The agent loop, tool protocol, conversation history, context control, permission checks, and error handling are all implemented in this repository. `@anthropic-ai/sdk` is used only as a plain Messages API client.

## Requirements

- Node.js >= 20
- npm
- A model endpoint that speaks the Anthropic Messages API (the default target is DeepSeek's Anthropic-compatible endpoint)

## Install and build

```bash
npm install
npm run build
```

## Configuration

NJUAgent is a normal command-line application: configuration comes from environment variables plus an optional per-user config file, and the only supported CLI flags are `--workspace`, `--permission-mode` and `--debug`. Copy `.env.example` and export the values (the program reads the process environment, not `.env`).

On first run (TTY only), missing Base URL or Model triggers an interactive setup that saves only those non-secret values — Base URL, Model, and permission mode — to `config.json` under the application home (`NJU_AGENT_HOME`, default `~/.nju-agent`). `ANTHROPIC_API_KEY` is read **only** from the process environment and is never written to disk.

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | — | API key; environment only, never stored on disk |
| `ANTHROPIC_BASE_URL` | yes* | — | e.g. `https://api.deepseek.com/anthropic` |
| `MODEL_ID` | yes* | — | model name supported by the endpoint |
| `NJU_AGENT_HOME` | no | `~/.nju-agent` | application home (config, sessions, skills) |
| `AGENT_MAX_STEPS` | no | `20` | max model requests per user turn |
| `AGENT_MAX_TOKENS` | no | `4096` | `max_tokens` sent to the model |
| `COMMAND_TIMEOUT_MS` | no | `120000` | default `run_command` timeout |
| `TOOL_OUTPUT_MAX_BYTES` | no | `32768` | max tool output returned to the model |
| `UI_OUTPUT_MAX_BYTES` | no | `65536` | maximum command output shown live per tool call |
| `TAVILY_API_KEY` | no | — | enables the permission-gated `web_search` tool |
| `WEB_SEARCH_TIMEOUT_MS` | no | `15000` | web search request timeout |
| `WEB_SEARCH_MAX_CONTENT_CHARS` | no | `6000` | per-result content cap for `web_search` |

`*` Base URL and Model may come from the persisted config instead of the environment (saved by setup); the API Key always comes from the environment.

## Usage

Run from the repository root:

```bash
npm install
npm run build
npm start -- --workspace /path/to/project
npm start -- --workspace /path/to/project --permission-mode cautious --debug
```

`nju-agent` becomes available as a short command only after an explicit link or install step (optional):

```bash
npm link
nju-agent --workspace /path/to/project
```

Run `npm start -- --help` (or `node dist/index.js --help`) to see usage; help works without any API credentials.

Then type a task, e.g.:

```
Add input validation to parsePort in src/validate.mjs and make the tests pass.
```

- `/exit` or `Ctrl-C` at the prompt exits.
- `Ctrl-C` during a run cancels the current turn and returns to the prompt.
- Permission prompts (`Allow ... (y/N)`) appear for risky operations; declining returns the refusal to the model as a tool result.

Non-TTY output (pipes, CI) degrades automatically to plain newline-safe records with no colors or cursor control; set `NO_COLOR` for the same behavior on a TTY.

### Slash commands

Input starting with `/` is handled locally and never reaches the model; use `//` to send literal text starting with a slash:

```
/help                        Show available commands
/status                      Show current session status
/sessions                    List saved sessions
/resume <id>                 Resume a saved session (full UUID or unique prefix)
/new                         Start a new session
/history [1-100]             Show recent messages
/context                     Show context budget and checkpoint status
/compact [focus]             Summarize the covered conversation
/plan [clear]                Show or clear the model-maintained execution plan
/goal [clear|<condition>]    Set, show, or clear the explicit completion goal
/skills                      List available skills
/skill <name>|off            Activate or deactivate a skill
/setup                       Update model and permission configuration
/exit                        Save the current session and exit
```

### Slash command palette

On a real interactive TTY, typing `/` on an empty input line immediately shows a filterable command list under the prompt:

- type an ASCII prefix (`go`, `sta`, …) to filter the candidates case-insensitively, applied on every keypress;
- `↑` / `↓` move the selection through **all** matches (wrapping at the ends); the menu shows a 6-row scrolling window with the current range in the footer (e.g. `1–6 / 14`);
- `Tab` (or `Enter` on a prefix) completes the selected command as `/<name> ` without executing it;
- `Enter` on a fully typed command (`/help`) runs it directly, with no extra confirmation;
- `Esc` closes the palette and keeps the current input; `Backspace` back to an empty line also closes it;
- typing a space leaves command-name mode and hands the arguments back to normal readline editing, so Chinese parameters, IME, and pasted text behave exactly as before (`/goal 完成测试` keeps every character);
- `//literal` still escapes to literal text; an unknown command still reports `Unknown command`;
- parameter completion, fuzzy search, and mouse interaction are **not** part of this palette;
- non-TTY, `NO_COLOR`, and `TERM=dumb` keep the plain input line with no dynamic menu or ANSI output.

The command list comes only from the registered slash commands — there is no second hard-coded list.

### Sessions

Each session is stored as one versioned JSON file under `$NJU_AGENT_HOME/sessions` (default `~/.nju-agent/sessions`), containing the complete valid message history, context checkpoint state, and run statistics. A new session starts on every launch (the welcome panel shows the most recent session with a `/resume` hint); the API Key is never persisted; a corrupt session file is reported as a warning without blocking the others. There is currently **no cross-session text search**.

### Context

Token numbers are **estimates** (`CONTEXT_WINDOW_TOKENS` default 48,000, `CONTEXT_COMPACT_RATIO` 0.70, `CONTEXT_SAFETY_TOKENS` 2,048). When the estimate crosses the compact threshold, old tool results are shrunk first; if that is not enough, a no-tools model call summarizes the newly covered prefix into a cumulative checkpoint. The complete transcript always stays in the session; every request carries the summary plus only the post-checkpoint tail, and never exceeds the hard input budget (`window − max_tokens − safety`). `/compact [focus]` forces a checkpoint (Ctrl-C cancels it); a failed or cancelled compaction keeps the previous checkpoint.

### Skills

A Skill is **plain prompt text**, not executable code: one `SKILL.md` per directory, with a minimal frontmatter (`name` and `description`), at most 32 KiB, under `$NJU_AGENT_HOME/skills/<name>/SKILL.md` (user) or `<workspace>/.nju-agent/skills/<name>/SKILL.md` (project). Project skills override same-name user skills; symlink escapes and oversized files are rejected as warnings. Only explicit `/skill <name>` activates one skill per session (persisted and restored on resume); `/skill off` deactivates. Skill content cannot weaken workspace, permission, timeout, output, or credential policies.

### Plans and goals

- **Plans**: for multi-step tasks the model can maintain an execution plan with the `plan_write` tool (at most 12 steps, one `in_progress` at a time). The CLI shows each update as a compact progress panel (`◆ Plan 3/5`). `/plan` displays the current plan and `/plan clear` empties it.
- **Goals**: `/goal <completion condition>` enables explicit completion verification. The next ordinary message runs under that goal: when the worker would stop, a no-tools model call checks the condition against the current Plan and Evidence, and the host refuses `satisfied` unless the plan is finished and every workspace edit is followed by a fresh successful verification command (`npm test`, `npm run build|lint|typecheck|check`, `vitest`, `pytest`, `tsc`, `cargo test|check|build`, `go test`, …).
- A goal triggers at most **3 automatic continuations** per user message; if the 4th check is still not satisfied the run ends `goal_incomplete` and the goal stays active. `verified` and `cancelled` goals stop the checks until you set a new one. `/goal` and `/goal clear` view and remove it.
- Evidence observes only the tools NJUAgent itself runs: writes/edits bump a workspace revision, and commands are recorded with exit code, timeout, cancellation and revision. If you edit files in another terminal, those edits do **not** count as workspace changes (and cannot invalidate verification).
- Web search: with `TAVILY_API_KEY` set, `web_search` becomes available and every call requires your approval because the query is sent to an external service. Results are returned as untrusted reference material inside `<untrusted_web_results>`; they cannot trigger commands or override permission rules. Queries must never contain credentials or private source code.
- There is **no automatic Git rollback**: NJUAgent never resets, restores, stashes, or commits on its own.

## Architecture

```
CLI (session / prompt / renderer)
  └─ AgentRunner            model/tool loop, stop reasons, stats
      ├─ ConversationHistory  append-only, invariant-checked messages
      ├─ ContextPolicy        token estimate, deterministic compaction
      ├─ ModelProvider        vendor-neutral contract
      │    └─ AnthropicProvider  only place that knows the SDK types
      └─ ToolExecutor         validation, permissions, execution
          ├─ ToolRegistry     name → schema + implementation
          ├─ PermissionPolicy allow / ask / deny
          └─ Workspace        canonical-path boundary
  Plan / Goal / Evidence      session-owned state, saved with the session
      └─ GoalController       StopGate: verifies only when the worker stops
          └─ GoalEvaluator    no-tools model check + host evidence policy
```

Design principles:

1. The model decides *what* to do; the harness decides *what is allowed*.
2. The runner only knows internal types — SDK types never cross the provider boundary.
3. Tools describe themselves with JSON Schema; the executor handles validation, permission, timing and error conversion uniformly.
4. Safety (workspace boundary, command timeout, output budget, dangerous-command denial) is enforced by the host, never delegated to the model.
5. A run ending with no tool call is reported as `completed`, **not** as "task proven successful"; the terminal shows real command records and lets you judge.

## Tools

| Tool | Purpose |
| --- | --- |
| `read_file` | read UTF-8 text with one-based line pagination |
| `write_file` | create or overwrite a file |
| `edit_file` | exact literal replacement (fails on zero or ambiguous matches unless `replaceAll`) |
| `list_files` | sorted listing with glob filtering, ignores `.git`/`node_modules`/build dirs |
| `search_text` | literal text search with `path:line` matches and result limits |
| `run_command` | shell command in the workspace, with timeout, cancellation and head/tail output capture |
| `plan_write` | replace the model-maintained execution plan (session metadata, no permission prompt) |
| `web_search` | optional Tavily-backed web search; requires approval, returns untrusted results |

## Security model

- File tools accept only workspace-relative paths; canonical paths are re-checked against the workspace root after `realpath` resolution, covering `..`, absolute paths and symlink escapes.
- Commands run with the workspace as `cwd`, inside a **sanitized allowlisted environment**: model credentials and unrelated parent variables (such as `DATABASE_URL`) are never passed to child processes. Only documented runtime variables (`PATH`, `HOME`, locale, color and CI flags, and Windows system variables) are copied.
- Commands have a timeout, support cancellation, and stream output through a per-call live display budget (`UI_OUTPUT_MAX_BYTES`) that is separate from the model-result budget (`TOOL_OUTPUT_MAX_BYTES`).
- The balanced permission policy auto-allows reads, ordinary writes/edits, and a strict set of test/build/lint and read-only git commands; pipelines, redirection, home expansion, arbitrary runtimes, deletion, dependency install, network and destructive git operations require confirmation; privilege escalation, disk formatting and obvious outside-workspace targets are denied.
- A denied or cancelled tool still produces a structured tool result so the message history stays valid.

This is a trusted local developer tool, **not an operating-system sandbox**: commands run with the permissions of your user account, and a project script you approve can still access any file your account can access (see the design doc for TOCTOU limitations).

## Testing

```bash
npm test              # the full offline unit and integration suite, no network
npm run typecheck
npm run build
npm run test:smoke    # opt-in real API smoke test; skips when env vars are absent
```

Unit tests cover the runner loop, message invariants, workspace boundary, credential isolation, command permission classification, all tools, permission policy, retry, context compaction, provider translation, the live-output limiter and the CLI. The integration test drives a real fail → fix → pass coding loop (see `tests/fixtures/demo-project`) with only the model provider scripted. `npm run test:smoke` reports `PASS` only after an actual credentialed run against the real endpoint; without credentials it prints a skip message and exits 0.

## Demo scenario

`tests/fixtures/demo-project` contains a tiny module with a deliberately failing test. The planned demo scenario shows the agent listing files, reading the module and its test, editing to add input validation, running `npm test`, seeing the failure, fixing the range check, and reporting a green run. The Stage Four acceptance scenario adds a `/goal` with a two-command condition (`npm test` and `npm run typecheck` both exit 0 after the latest edit) so the agent must run the missing verification before the goal is marked verified.

## Limitations

- Single agent, single active workspace; no GUI, MCP, background tasks or multi-agent orchestration.
- Context accounting uses a conservative estimate plus the latest Provider usage; it is not an exact tokenizer calculation.
- `edit_file` requires exact literal matches; there is no fuzzy or patch-based editing.
- The agent's claims are only as good as the commands it actually ran; the UI never fabricates a "verified" badge.

## Documentation

- Requirements baseline: `docs/PROJECT_REQUIREMENTS.md`
- Stage One design: `docs/superpowers/specs/2026-08-27-njuagent-design.md`
- Stage Two design: `docs/superpowers/specs/2026-08-28-stage-two-productization-design.md`
- Stage Two acceptance fixes: `docs/superpowers/plans/2026-08-28-stage-two-acceptance-fixes.md`
- Stage Three CLI UI design: `docs/superpowers/specs/2026-08-29-stage-three-cli-ui-design.md`
- Stage Four design: `docs/superpowers/specs/2026-08-29-stage-four-reliable-agent-design.md`
