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

`tests/fixtures/demo-project` contains a tiny module with a deliberately failing test. The planned demo scenario shows the agent listing files, reading the module and its test, editing to add input validation, running `npm test`, seeing the failure, fixing the range check, and reporting a green run.

## Limitations

- Single agent, single workspace; no GUI, MCP, skills, background tasks or multi-agent orchestration.
- Deterministic context compaction replaces old tool outputs with metadata placeholders; there is no semantic summarization.
- `edit_file` requires exact literal matches; there is no fuzzy or patch-based editing.
- The agent's claims are only as good as the commands it actually ran; the UI never fabricates a "verified" badge.

## Documentation

- Requirements baseline: `docs/PROJECT_REQUIREMENTS.md`
- Design: `docs/superpowers/specs/2026-08-27-njuagent-design.md`
- Implementation plan: `docs/superpowers/plans/2026-08-27-njuagent-implementation.md`
