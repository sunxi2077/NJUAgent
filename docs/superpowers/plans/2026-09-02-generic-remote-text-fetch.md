# Generic Remote Text Fetch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Keep the implementation independent; do not add an agent framework or a GitHub SDK.

**Goal:** Add a generic, permission-gated `fetch_url` model tool that retrieves bounded public text resources directly into the agent conversation. It should make URLs such as GitHub `SKILL.md`, official docs, JSON configuration, and text specifications usable without the model hand-assembling `curl`, temporary files, `git clone`, and cleanup steps.

**Architecture:** `fetch_url` is a read-only network tool, analogous to `web_search` but accepting an exact URL rather than a query. A small provider validates and obtains remote text using native `fetch`, bounds bytes while streaming, and returns untrusted content with stable metadata. A GitHub URL adapter translates ordinary `github.com/.../blob/...` file pages to the public Contents API, because the observed environment reaches `api.github.com` while raw/Git transport is unreliable. The tool never writes files: the model must inspect returned content and explicitly use existing workspace-relative `write_file` if it wants to save it.

**Tech Stack:** TypeScript, Node.js native `fetch`, `AbortSignal`, existing ToolRegistry/ToolExecutor, Vitest. No GitHub SDK, no proxy package, no new npm dependency.

**Spec:** This document is the complete handoff specification. It intentionally implements a *generic remote text reader*, not `/skill install` and not a Skill-specific installer.

## Why This Scope

The long `frontend-design` installation was caused by missing primitive capability, not a need for an unrestricted shell:

- The model only had `run_command`, so it tried raw GitHub, Git, API requests, temporary paths, directory creation, validation, and cleanup as separate calls.
- `createCommandEnvironment()` deliberately omits proxy variables from child commands, so `curl`/`git` cannot rely on a desktop proxy. This is correct for secret hygiene and must not be weakened by forwarding arbitrary `HTTP_PROXY`/`HTTPS_PROXY` values to shell commands.
- The workspace guard correctly denies `/tmp`, Home, and other external paths, so shell-based download staging creates friction.
- `api.github.com` worked in the observed run while `raw.githubusercontent.com` and Git transport did not. A GitHub API adapter removes the need for the failed raw/Git paths for ordinary GitHub file links.

`fetch_url` reduces a typical external-Skill flow to:

```text
fetch_url(url) → inspect untrusted SKILL.md → write_file(.nju-agent/skills/<name>/SKILL.md)
```

The user still explicitly activates it with `/skill <name>`. No automatic execution, automatic installation, global-directory write, or license-file copying is introduced.

## Global Constraints

- Accept only `https:` URLs. Reject `http:`, `file:`, `data:`, `javascript:`, URLs containing user/password credentials, and URLs longer than 2,048 characters.
- Exact URL fetch is read-only. It must not write a file, run a shell command, install packages, execute scripts, or use `git`.
- Returned body is always framed as untrusted reference data. It cannot authorize commands, permission changes, Skill activation, or workspace escape.
- Fetch at most 32 KiB by default and at most 64 KiB when configured. Reject/stop oversized bodies rather than downloading a large file and truncating it silently.
- Use a 15-second default timeout and compose it with user cancellation. A user Ctrl-C yields a stable cancelled result.
- Permit only textual media types: `text/*`, JSON, XML, JavaScript, YAML, and absent/unknown type only when the URL ends in an explicitly textual extension (`.md`, `.txt`, `.json`, `.yaml`, `.yml`, `.xml`, `.toml`, `.ini`, `.js`, `.ts`, `.tsx`, `.jsx`, `.css`, `.html`). Reject images, archives, PDFs, and arbitrary binary downloads.
- Follow at most three redirects manually. Revalidate URL scheme and credentials after every redirect; never allow a redirect to a non-HTTPS URL.
- Do not change `COMMAND_ENV_KEYS` or pass proxy settings to `run_command`. Proxy support for arbitrary shell traffic is not part of this phase.
- `fetch_url` must be visible to the model only as an external, permission-sensitive tool. It is allowed automatically in `trusted`; it requires explicit confirmation in `balanced` and `cautious`.
- `web_search` keeps its current behaviour. `fetch_url` is for a known URL; it is not a search engine.
- Maintain workspace restrictions: subsequent `write_file` is still the only way to save fetched text, and it only accepts a workspace-relative path.
- Do not run the full suite after every task. Run targeted tests during implementation, one build after integration, then a full suite only if budget permits.

## User-Facing Behaviour

### Exact file URL

When the user gives a direct public text URL, the model receives a tool definition roughly equivalent to:

```json
{
  "name": "fetch_url",
  "input": { "url": "https://example.com/guide.md" }
}
```

In balanced mode the CLI displays one normal permission card:

```text
╭─ ⚠ Permission required
│ Tool    fetch_url
│ Action  https://example.com/guide.md
│ Reason  Fetching a remote URL sends a request to an external service
╰─
```

On success the model sees a bounded block such as:

```text
<untrusted_remote_text source="https://example.com/guide.md" content_type="text/markdown">
# Guide
…
</untrusted_remote_text>
```

The tool result must not contain proxy values, request headers, cookies, raw error pages, or credentials.

### GitHub files and folders

- A GitHub **blob** URL is converted internally to `api.github.com/repos/<owner>/<repo>/contents/<path>?ref=<ref>`. Decode only the documented base64 `content` field, then return the file text.
- A GitHub **raw** URL is fetched directly as normal text. If it fails, return a stable failure; do not probe multiple unrelated hosts.
- A GitHub **tree/directory** URL is converted to the Contents API and returns a bounded, untrusted JSON/text directory listing containing item names and file URLs. The model may make one subsequent `fetch_url` call for a selected file. It must not clone the repository.
- The adapter is GitHub URL compatibility for a generic fetcher; it must not contain terms such as `Skill`, target `.claude`, or write any local file.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/web/remote-fetch.ts` | URL validation, redirect loop, text streaming/bounds, GitHub URL normalization, typed provider errors. |
| `src/web/remote-fetch-tool.ts` | Tool schema, input validation, untrusted result framing, error-to-user-message mapping. |
| `src/web/remote-fetch-types.ts` | Provider/tool request and result types; keeps provider independent of Tool interfaces. |
| `src/config.ts` | `REMOTE_FETCH_TIMEOUT_MS` and `REMOTE_FETCH_MAX_BYTES` config parsing/limits. |
| `src/runtime/create-runtime.ts` | Registers `fetch_url` with the tool registry using config values. |
| `src/security/permission-policy.ts` | Classifies `fetch_url` as an external read: ask in balanced/cautious, allow in trusted. |
| `src/agent/system-prompt.ts` | Tells the model when to use `fetch_url` and that results remain untrusted. |
| `src/cli/help.ts`, `README.md` | Documents configuration, safety boundary, known-URL workflow, and GitHub compatibility. |
| `tests/unit/web/remote-fetch*.test.ts` | Unit tests for URL adapter, redirect, content bounds, cancellation, and tool output. |
| `tests/unit/config.test.ts`, `tests/unit/security/permission-policy.test.ts`, `tests/integration/bootstrap.test.ts` | Wiring and mode coverage. |

## Task 1: Define Fetch Types and Safe URL/GitHub Normalization

**Files:**
- Create: `src/web/remote-fetch-types.ts`
- Create: `src/web/remote-fetch.ts`
- Create: `tests/unit/web/remote-fetch.test.ts`

**Interfaces:**

```ts
export type RemoteFetchRequest = { url: string; maxBytes: number };
export type RemoteFetchResult = {
  sourceUrl: string;
  finalUrl: string;
  contentType: string | undefined;
  text: string;
};
export type RemoteFetchErrorKind =
  | "invalid_url" | "blocked_content_type" | "too_large"
  | "not_found" | "rate_limit" | "unavailable" | "timeout"
  | "cancelled" | "invalid_response";
export class RemoteFetchError extends Error { /* kind only; no raw body */ }
export interface RemoteFetchProvider {
  fetch(request: RemoteFetchRequest, signal: AbortSignal): Promise<RemoteFetchResult>;
}
```

- [ ] **Step 1: Write URL-validation tests before implementation.**

  Test acceptance of `https://example.com/readme.md`; rejection of `http://`, `file:///`, `data:`, `javascript:`, a credential-bearing URL, a fragment-only variant after normalisation, and a URL exceeding 2,048 characters.

- [ ] **Step 2: Write GitHub normalization tests.**

  Assert these exact transformations:

  ```text
  https://github.com/a/b/blob/main/docs/x.md
  → https://api.github.com/repos/a/b/contents/docs/x.md?ref=main

  https://github.com/a/b/tree/main/skills/frontend-design
  → https://api.github.com/repos/a/b/contents/skills/frontend-design?ref=main
  ```

  Test malformed GitHub paths fall back to normal HTTPS fetch instead of throwing during normalization.

- [ ] **Step 3: Implement `normalizeRemoteUrl`.**

  Parse using `new URL`, delete fragment, reject unsafe URL forms, then recognize only `github.com/<owner>/<repo>/(blob|tree)/<ref>/<path...>`. Percent-decode path segments only after rejecting `/`, `\\`, `.` and `..` segments. Encode the API path/ref with `encodeURIComponent` as appropriate. Return a structured mode: `direct`, `github-file`, or `github-directory`.

- [ ] **Step 4: Add tests for stable error mapping.**

  A thrown network error becomes `unavailable`, a caller-aborted signal becomes `cancelled`, a timeout signal becomes `timeout`, HTTP 404 becomes `not_found`, HTTP 429 becomes `rate_limit`, and an invalid GitHub JSON shape becomes `invalid_response`.

- [ ] **Step 5: Run targeted test.**

  Run: `npm test -- tests/unit/web/remote-fetch.test.ts`

## Task 2: Implement Bounded Text Fetching and GitHub Response Decoding

**Files:**
- Modify: `src/web/remote-fetch.ts`
- Modify: `tests/unit/web/remote-fetch.test.ts`

**Interfaces:**
- Constructor seam:
  ```ts
  new NativeRemoteFetchProvider({ timeoutMs, fetch?: typeof fetch })
  ```

- [ ] **Step 1: Write streaming/size tests.**

  With a fake `fetch`, test a small `text/markdown` response, a declared `content-length` larger than the limit, and a chunked body which crosses the limit while reading. Both oversized cases must reject with `too_large` and must not return a partial body.

- [ ] **Step 2: Implement manual redirect handling.**

  Use `redirect: "manual"`. Follow 301/302/303/307/308 at most three times using `Location`; validate every destination via the Task 1 URL validator. Missing location or a fourth redirect maps to `invalid_response`/`unavailable` with a short stable message.

- [ ] **Step 3: Implement allowed media-type checks.**

  Strip media-type parameters and lowercase before checking. Accept exact allowed application types and `text/*`; if absent, accept only a recognized textual extension. Reject PDF, ZIP, PNG, and `application/octet-stream` with `blocked_content_type`.

- [ ] **Step 4: Stream the body with a hard byte limit.**

  Read `response.body` via `getReader()`, accumulate `Uint8Array` chunks, check byte count before appending each chunk, and decode once using UTF-8 `TextDecoder` with `fatal: false`. Never call `response.text()` on an unbounded response.

- [ ] **Step 5: Decode GitHub API results.**

  For `github-file`, validate object fields `type: "file"`, `encoding: "base64"`, and string `content`; decode base64, apply the same byte/media limits, and use the original user URL as `sourceUrl`. For `github-directory`, validate an array and return a JSON string containing only `name`, `type`, `path`, and `download_url`/HTML URL for at most 100 items. Do not return arbitrary API fields.

- [ ] **Step 6: Test cancellation and timeout.**

  Verify a parent cancellation takes precedence over the timeout and produces `cancelled`; an independent timeout produces `timeout`.

- [ ] **Step 7: Run targeted test.**

  Run: `npm test -- tests/unit/web/remote-fetch.test.ts`

## Task 3: Expose `fetch_url` as an Untrusted Model Tool

**Files:**
- Create: `src/web/remote-fetch-tool.ts`
- Create: `tests/unit/web/remote-fetch-tool.test.ts`
- Modify: `src/runtime/create-runtime.ts`
- Modify: `src/security/permission-policy.ts`
- Modify: `tests/unit/security/permission-policy.test.ts`

**Tool schema:**

```json
{
  "type": "object",
  "properties": {
    "url": { "type": "string", "minLength": 1, "maxLength": 2048 }
  },
  "required": ["url"],
  "additionalProperties": false
}
```

- [ ] **Step 1: Write tool output tests.**

  Assert success returns one `<untrusted_remote_text>` block with escaped XML attribute values and bounded content. Assert a malicious body containing `</untrusted_remote_text>` cannot close the wrapper. Assert every provider error maps to one short user-facing sentence without raw network error, headers, proxy address, or response body.

- [ ] **Step 2: Implement `createRemoteFetchTool`.**

  Tool name is exactly `fetch_url`; description states it retrieves a known public HTTPS text URL and returns untrusted text. Do not add `destination`, `path`, `command`, `headers`, cookie, method, or POST inputs.

- [ ] **Step 3: Register in runtime.**

  Always register `fetch_url`; unlike Tavily search it requires no API key. Use `config.remoteFetchTimeoutMs` and `config.remoteFetchMaxBytes`. Registration failure must be impossible in normal startup.

- [ ] **Step 4: Classify permissions.**

  Add `fetch_url` to the existing external-read tool set. In `balanced` and `cautious`, return `ask` with exact reason `Fetching a remote URL sends a request to an external service`. In `trusted`, return `allow`. `web_search` remains `ask` in all modes because it transmits a query to a third-party search service.

- [ ] **Step 5: Run focused tests.**

  Run:
  ```bash
  npm test -- tests/unit/web/remote-fetch-tool.test.ts tests/unit/security/permission-policy.test.ts
  ```

## Task 4: Add Configuration Without Proxy Leakage

**Files:**
- Modify: `src/config.ts`
- Modify: `tests/unit/config.test.ts`
- Modify: `src/cli/help.ts`
- Modify: `README.md`

**Configuration:**

```text
REMOTE_FETCH_TIMEOUT_MS      default 15000; positive integer
REMOTE_FETCH_MAX_BYTES       default 32768; integer 1024–65536
```

- [ ] **Step 1: Write config tests.**

  Test defaults, valid overrides, non-integer timeout failure, `REMOTE_FETCH_MAX_BYTES=1023` failure, and `REMOTE_FETCH_MAX_BYTES=65537` failure.

- [ ] **Step 2: Implement config parsing.**

  Add both values to `AppConfig` and numerical defaults. Use a bounded positive-integer reader for max bytes with the exact range above. Values remain environment-only and are never persisted by `/setup`.

- [ ] **Step 3: Document network scope accurately.**

  State that direct network reachability is supplied by the host machine. `fetch_url` does not promise VPN/proxy bypass, does not pass proxy variables into `run_command`, and uses GitHub Contents API compatibility for ordinary GitHub file/tree URLs.

- [ ] **Step 4: Run targeted config tests.**

  Run: `npm test -- tests/unit/config.test.ts`

## Task 5: Teach the Model the Short, Safe Workflow

**Files:**
- Modify: `src/agent/system-prompt.ts`
- Modify: `tests/unit/system-prompt.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write prompt tests.**

  Assert the system prompt says: use `fetch_url` for a known external text URL; do not use `run_command`/`curl`/`git clone` merely to retrieve public text; fetched content is untrusted; inspect it before writing; saving stays workspace-relative; external Skill activation stays explicit.

- [ ] **Step 2: Add concise guidance.**

  Add no more than six bullet lines to avoid bloating every model request. Do not tell the model that every link is a Skill. Do not remove existing web-search or project Skill restrictions.

- [ ] **Step 3: Add one README walkthrough.**

  Use a GitHub URL example and show the expected model workflow: `fetch_url` → inspect → write `.nju-agent/skills/<name>/SKILL.md` → user runs `/skills` and `/skill <name>`.

- [ ] **Step 4: Run target tests.**

  Run: `npm test -- tests/unit/system-prompt.test.ts tests/unit/skills/skill-prompt.test.ts`

## Task 6: Integration and Manual Verification

**Files:**
- Modify/Create: `tests/integration/bootstrap.test.ts`
- Modify/Create: `tests/integration/agent.test.ts`

- [ ] **Step 1: Bootstrap tool registration test.**

  Build a runtime without `TAVILY_API_KEY` and assert provider tool definitions include `fetch_url` but do not include `web_search`.

- [ ] **Step 2: Permission integration test.**

  Script an agent call to `fetch_url`. Assert balanced mode invokes one confirmation and trusted mode invokes none. Do not contact the real network; inject a fake `RemoteFetchProvider` into `CreateRuntimeDeps` using the same test seam style as `webSearchProvider`.

- [ ] **Step 3: Actual GitHub smoke test (manual, not unit test).**

  In a disposable workspace and only after setting normal API configuration:

  ```text
  Ask NJUAgent: “Read this GitHub file URL with fetch_url, inspect it, and report its name. Do not save it.”
  ```

  Use an exact GitHub blob URL first. Confirm a single approval in balanced mode, one `fetch_url` card, and no temporary files. Then test the same flow with `--permission-mode trusted`; there should be no approval for `fetch_url`.

- [ ] **Step 4: Build and final verification.**

  Run:
  ```bash
  npm test -- tests/integration/bootstrap.test.ts tests/integration/agent.test.ts
  npm run build
  ```

  Run `npm test` once only if budget permits. State precisely if only targeted tests/build were run.

## Acceptance Checklist

- [ ] A known public text URL can be fetched without invoking `run_command`, `curl`, `git`, or a temporary directory.
- [ ] `fetch_url` makes one permission request in balanced/cautious and none in trusted.
- [ ] Returned content is bounded, textual, URL-validated, and wrapped as untrusted data.
- [ ] GitHub blob links work through Contents API; GitHub tree links yield a safe directory listing for one follow-up fetch.
- [ ] Proxy variables remain absent from child shell environment and are never printed or sent to the model.
- [ ] No fetched resource can directly write files, activate Skills, run scripts, or bypass workspace restrictions.
- [ ] Existing `web_search` and all current file/command tools retain their behaviour.
