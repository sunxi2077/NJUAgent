# Tool Feedback, Stable Tool References, and Skill Compatibility Fix Plan

> **For agentic workers:** Implement task-by-task with targeted Vitest runs. Do not redesign unrelated CLI flows.

**Goal:** Remove the silent period after a user approves a tool call, make `/tool` references reliably usable with Anthropic-style IDs, and load the official Anthropic `frontend-design` Skill without weakening Skill validation.

**Root causes:**

1. `tool_started` writes a transient `run_command…` status. `permissionRequest()` clears that transient before the y/N prompt; after `permissionDecision(true)` the renderer only writes `✓ Allowed … once`, while interactive `toolOutput()` buffers all output until completion. A long `curl` therefore leaves no visible running signal and invites Ctrl-C. The executor then correctly returns `cancelled`.
2. Cards advertise `id.slice(0, 8)`. Anthropic-compatible tool ids commonly all begin `call_00_`, so `/tool call_00_` is necessarily ambiguous. `/tool call_00_ run_command` is not valid syntax: the whole string is treated as one id prefix.
3. The installer correctly wrote `2048/.nju-agent/skills/frontend-design/SKILL.md`. The loader rejects it because its safe, official frontmatter contains `license: Complete terms in LICENSE.txt`, while the parser only accepts `name` and `description`.

**Scope:** No new installer slash command. Preserve normal project-local Skill destination, full result retention, and all high-risk/escape protections. No new npm dependency.

---

## Task 1: Restore Visible Progress Immediately After Approval

**Files:**
- Modify: `src/cli/renderer.ts`
- Modify: `tests/unit/cli/renderer.test.ts`

**Required behaviour:**

```text
╭─ ⚠ Permission required ─╮
…
Your choice — [y] Allow once, [N] Deny (y/N) y
✓ Allowed run_command once
⠋ run_command running… Ctrl-C cancels
```

The last row may be the existing transient line, but it must appear immediately after approval and remain visible until `tool_completed` replaces it with the compact result card. No command stdout/stderr is printed live in interactive mode.

- [ ] Add a focused failing test: `tool_started` → `permissionRequest` → `permissionDecision(call, true)` must contain both the approval record and visible `run_command running… Ctrl-C cancels` status after the approval.
- [ ] Add a focused failing test: `permissionDecision(call, false)` must not restore a running status.
- [ ] In `TerminalRenderer.permissionDecision`, after writing an approved record, call the existing `#status` with the tool name and exact copy `running… Ctrl-C cancels`.
- [ ] Do not alter `permissionRequest` clearing behaviour: the y/N prompt must remain clean and readable.
- [ ] Confirm `tool_completed` still clears the transient status before rendering the final tool card; no duplicate running row remains after completion.
- [ ] Run: `npm test -- tests/unit/cli/renderer.test.ts`

**Manual smoke test:** In balanced mode, approve one `curl` or deliberately slow test command. Verify the running status remains on screen without pressing Ctrl-C, then changes into the completed/failed card.

## Task 2: Replace Ambiguous Provider-ID Hints With Stable Short References

**Files:**
- Modify: `src/cli/tool-activity.ts`
- Modify: `src/cli/renderer.ts`
- Modify: `src/cli/commands/tool-command.ts`
- Modify: `tests/unit/cli/tool-activity.test.ts`
- Modify: `tests/unit/cli/renderer.test.ts`
- Modify: `tests/unit/cli/commands/tool-command.test.ts`
- Modify: `README.md`

**Design:** A displayed reference is derived deterministically from the full provider id, not from its first characters. Use Node built-in `createHash("sha256")` and format it as `T-` plus the first 10 lowercase hex characters. Example:

```text
… 38 more lines hidden · /tool T-19ac41b0d2
```

The full provider id remains available in `/tool` detail output. `/tool` accepts either a full/unique provider-id prefix for backwards compatibility or a `T-<hash-prefix>` reference. If a reference prefix is ambiguous, show the stable reference and tool name for every candidate.

This solves the actual UI failure: IDs beginning `call_00_` no longer produce indistinguishable hints. Do not introduce a second positional argument such as `run_command`; it is unnecessary and conflicts with current simple parsing.

- [ ] Add `toolReference(id: string): string` to `tool-activity.ts`, using `createHash` from `node:crypto`. It returns exactly `T-` plus 10 lowercase hex characters.
- [ ] Add a resolver test with two ids sharing `call_00_`; their stable references must differ, and each `/tool T-…` resolves uniquely.
- [ ] Change `findToolActivity` to accept either (a) a provider id prefix or (b) a case-insensitive `T-` reference prefix. Prefer exact/full provider id matching where possible; retain case-sensitive provider-id matching.
- [ ] Change ambiguous output from repeated `id.slice(0, 8)` rows to e.g. `T-19ac41b0d2  run_command`.
- [ ] Change the renderer card hint to use `toolReference(id)`, never `id.slice(0, 8)`.
- [ ] Keep the detail panel's `Id` field as the full provider id and add `Reference` as `T-…`.
- [ ] Update README help/example to show `/tool T-19ac41b0d2` rather than an opaque provider prefix.
- [ ] Run:
  ```bash
  npm test -- tests/unit/cli/tool-activity.test.ts tests/unit/cli/renderer.test.ts tests/unit/cli/commands/tool-command.test.ts
  ```

## Task 3: Accept the Safe `license` Frontmatter Field

**Files:**
- Modify: `src/skills/skill.ts`
- Modify: `tests/unit/skills/skill.test.ts`
- Modify: `README.md`

**Required behaviour:**

The following remains a valid project Skill. `license` is preserved in the file but is metadata only; it must not be injected into the active skill instructions or treated as executable configuration.

```yaml
---
name: frontend-design
description: Guidance for distinctive, intentional visual design.
license: Complete terms in LICENSE.txt
---
```

- [ ] First add a failing parser test using the exact three-line frontmatter above plus non-empty body. Assert it loads as `name: "frontend-design"` and retains the normal instruction body.
- [ ] Add a regression test that an arbitrary unknown field such as `version: 2` still throws `SKILL_INVALID` with `unknown field: version`.
- [ ] Add an optional local `license` variable in `parseSkillFile`. Permit it once only, require a non-empty single-line value, and ignore it in the returned `Skill` type for this phase.
- [ ] Keep all existing restrictions: only simple scalar frontmatter, no nested YAML, name/dir match, 32 KiB cap, project path checks, and unknown-field rejection.
- [ ] Update README to state that `name`, `description`, and optional `license` are accepted metadata fields.
- [ ] Run: `npm test -- tests/unit/skills/skill.test.ts tests/unit/skills/skill-loader.test.ts`

## Task 4: Verify the Actual User Flow

**Files:**
- Modify/Create: `tests/integration/skill-lifecycle.test.ts`
- Modify/Create: `tests/integration/agent.test.ts`

- [ ] Add an integration fixture with `.nju-agent/skills/frontend-design/SKILL.md` using the `license` field. Refresh registry and assert `/skills` finds it and `/skill frontend-design` activates it.
- [ ] Add an end-to-end renderer/executor test where an approval is accepted, a tool streams output, and then completes. Assert ordering: permission card → `Allowed` → visible `running` status → single compact result card.
- [ ] Run the two targeted integration files plus `npm run build`:
  ```bash
  npm test -- tests/integration/skill-lifecycle.test.ts tests/integration/agent.test.ts
  npm run build
  ```
- [ ] Report targeted test/build results precisely. Run `npm test` only once at final handoff if time and token budget permit.

## Acceptance Checklist

- [ ] After pressing `y`, the terminal immediately and continuously indicates the approved tool is running until a result card appears.
- [ ] A user never needs Ctrl-C merely to determine whether approval was accepted.
- [ ] A card hint from an Anthropic-style `call_00_…` ID is directly usable with `/tool`.
- [ ] `/tool <reference>` displays retained stored output; ambiguous choices show distinguishable references.
- [ ] The official Skill shown in the report loads under `2048/.nju-agent/skills/frontend-design/` and appears in `/skills`.
- [ ] Unknown frontmatter remains rejected; accepting `license` does not weaken general parser safety.
