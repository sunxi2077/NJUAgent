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

All configuration comes from environment variables; the only supported CLI flags are `--workspace`, `--permission-mode` and `--debug`. Copy `.env.example` and export the values (the program reads the process environment, not `.env`).

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | — | API key (never committed or logged) |
| `ANTHROPIC_BASE_URL` | yes | — | e.g. `https://api.deepseek.com/anthropic` |
| `MODEL_ID` | yes | — | model name supported by the endpoint |
| `AGENT_MAX_STEPS` | no | `20` | max model requests per user turn |
| `AGENT_MAX_TOKENS` | no | `4096` | `max_tokens` sent to the model |
| `COMMAND_TIMEOUT_MS` | no | `120000` | default `run_command` timeout |
| `TOOL_OUTPUT_MAX_BYTES` | no | `32768` | max tool output returned to the model |

## Usage

```bash
nju-agent --workspace /path/to/project
nju-agent --workspace /path/to/project --permission-mode cautious --debug
```

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
- Commands always run with the workspace as `cwd`.
- The balanced permission policy auto-allows reads, ordinary writes/edits, and common test/build/lint commands; deletion, dependency install, network and destructive git operations require confirmation; privilege escalation, disk formatting and obvious outside-workspace targets are denied.
- A denied or cancelled tool still produces a structured tool result so the message history stays valid.

This is a trusted local developer tool, not a hostile multi-tenant sandbox (see the design doc for TOCTOU limitations).

## Testing

```bash
npm test              # 114 unit + integration tests, offline
npm run typecheck
npm run build
npm run test:smoke    # opt-in real API smoke test; skips when env vars are absent
```

Unit tests cover the runner loop, message invariants, workspace boundary, all tools, permission policy, retry, context compaction, provider translation and the CLI. The integration test drives a real fail → fix → pass coding loop (see `tests/fixtures/demo-project`) with only the model provider scripted.

## Demo scenario

`tests/fixtures/demo-project` contains a tiny module with a deliberately failing test. The recorded demo (see the submission `README.txt`) shows the agent listing files, reading the module and its test, editing to add input validation, running `npm test`, seeing the failure, fixing the range check, and reporting a green run.

## Limitations

- Single agent, single workspace; no GUI, MCP, skills, background tasks or multi-agent orchestration.
- Deterministic context compaction replaces old tool outputs with metadata placeholders; there is no semantic summarization.
- `edit_file` requires exact literal matches; there is no fuzzy or patch-based editing.
- The agent's claims are only as good as the commands it actually ran; the UI never fabricates a "verified" badge.

## Documentation

- Requirements baseline: `docs/PROJECT_REQUIREMENTS.md`
- Design: `docs/superpowers/specs/2026-08-27-njuagent-design.md`
- Implementation plan: `docs/superpowers/plans/2026-08-27-njuagent-implementation.md`
