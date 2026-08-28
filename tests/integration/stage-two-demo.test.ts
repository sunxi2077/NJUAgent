import { afterEach, describe, expect, test } from "vitest";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AppConfig } from "../../src/config.js";
import type { Prompt } from "../../src/cli/prompt.js";
import type { Renderer } from "../../src/cli/renderer.js";
import type { ModelProvider, ModelRequest, ProviderEvent } from "../../src/providers/provider.js";
import { createRuntime } from "../../src/runtime/create-runtime.js";
import { SkillRegistry } from "../../src/skills/skill-registry.js";
import { SessionManager } from "../../src/sessions/session-manager.js";
import { SessionStore } from "../../src/sessions/session-store.js";
import { createEmptySession } from "../../src/sessions/session-schema.js";
import { resolveAppPaths } from "../../src/storage/paths.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function tempDirectory(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}

const FIXTURE = new URL("../fixtures/demo-project", import.meta.url).pathname;

const FIX_EDIT = {
  path: "src/validate.mjs",
  oldText: "  const port = Number(value);\n  return port;",
  newText:
    "  const port = Number(value);\n" +
    '  if (!Number.isInteger(port) || port < 0 || port > 65535) {\n    throw new RangeError("Invalid port: " + value);\n  }\n' +
    "  return port;",
};

/**
 * Scripted provider that distinguishes compaction requests (no tools) from
 * ordinary turns and drives a fail → fix → pass coding loop plus follow-ups.
 */
class ScriptedProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];
  ordinaryIndex = 0;

  async *stream(request: ModelRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(structuredClone(request));
    const isCompaction = request.tools.length === 0 &&
      request.system.includes("summarize a coding-agent conversation");
    if (isCompaction) {
      yield this.#complete("summary of earlier work");
      return;
    }
    this.ordinaryIndex += 1;
    switch (this.ordinaryIndex) {
      case 1:
        yield this.#tools([
          { id: "c1", name: "run_command", input: { command: "npm test" } },
        ]);
        return;
      case 2:
        yield this.#tools([
          { id: "c2", name: "edit_file", input: FIX_EDIT },
        ]);
        return;
      case 3:
        yield this.#tools([
          { id: "c3", name: "run_command", input: { command: "npm test" } },
        ]);
        return;
      default:
        yield this.#complete(`ack-${this.ordinaryIndex}`);
    }
  }

  #tools(calls: Array<{ id: string; name: string; input: unknown }>): ProviderEvent {
    return {
      type: "message_completed",
      message: {
        role: "assistant",
        content: calls.map((call) => ({ type: "tool_call" as const, ...call })),
      },
      stopReason: "tool_use",
    };
  }

  #complete(text: string): ProviderEvent {
    return {
      type: "message_completed",
      message: { role: "assistant", content: [{ type: "text", text }] },
      stopReason: "end_turn",
    };
  }
}

class FakePrompt implements Prompt {
  confirm(): Promise<boolean> {
    return Promise.resolve(true);
  }
  read(): Promise<string | null> {
    return Promise.resolve(null);
  }
  onSigint(): void {}
  interrupt(): void {}
  suspendForOutput(): void {}
  resumeAfterOutput(): void {}
  close(): void {}
}

class MemoryRenderer implements Renderer {
  handle(): void {}
  toolOutput(): void {}
  print(): void {}
  error(): void {}
}

function makeConfig(workspaceRoot: string): AppConfig {
  return {
    apiKey: "test-key",
    baseURL: "https://api.example.com/anthropic",
    model: "deepseek-v4-flash",
    maxTokens: 512,
    maxSteps: 8,
    commandTimeoutMs: 5000,
    toolOutputMaxBytes: 8192,
    uiOutputMaxBytes: 65536,
    contextWindowTokens: 48000,
    contextCompactRatio: 0.7,
    contextRecentMessages: 12,
    contextSafetyTokens: 2048,
    workspaceRoot,
    permissionMode: "balanced",
    debug: false,
  };
}

async function makeManager(options: {
  home: string;
  workspace: string;
  provider: ScriptedProvider;
}) {
  const { home, workspace, provider } = options;
  const paths = resolveAppPaths({ NJU_AGENT_HOME: home }, home);
  const store = new SessionStore(paths.sessionsDirectory);
  const session = createEmptySession({
    id: crypto.randomUUID(),
    now: new Date().toISOString(),
    workspaceRoot: workspace,
    modelId: "deepseek-v4-flash",
    permissionMode: "balanced",
  });
  await store.save(session);
  const config = makeConfig(workspace);
  const prompt = new FakePrompt();
  const renderer = new MemoryRenderer();
  const deps = { env: {}, config, prompt, renderer, provider };
  const runtime = await createRuntime(session, deps);
  const registry = new SkillRegistry(
    paths.userSkillsDirectory,
    path.join(workspace, ".nju-agent", "skills"),
  );
  await registry.refresh();
  const manager = new SessionManager({
    initialRuntime: runtime,
    store,
    runtimeFactory: (target) => createRuntime(target, deps),
    registry,
  });
  return { manager, store, session, provider, registry, paths };
}

describe("stage-two offline demonstration", () => {
  test("fail → fix → pass loop with sessions, compact, resume, and skill", async () => {
    const home = await tempDirectory("nju-demo-");
    const workspace = await tempDirectory("nju-demo-work-");
    await cp(FIXTURE, workspace, { recursive: true });
    const provider = new ScriptedProvider();
    const { manager, store, session, registry, paths } = await makeManager({
      home,
      workspace,
      provider,
    });

    // 1. Coding loop: run failing test → edit → run passing test → done.
    const result = await manager.runTurn("Fix parsePort and make tests pass.", new AbortController().signal);
    expect(result.status).toBe("completed");
    const source = await (await import("node:fs/promises")).readFile(
      path.join(workspace, "src", "validate.mjs"),
      "utf8",
    );
    expect(source).toContain("port > 65535");

    // More turns so the transcript exceeds the recent-messages window.
    for (let index = 0; index < 3; index += 1) {
      await manager.runTurn(`follow-up ${index}`, new AbortController().signal);
    }

    // 2. Manual compact creates a checkpoint.
    await manager.compact("wrap up", new AbortController().signal);
    expect(manager.contextStatus().compactionCount).toBe(1);
    const covered = manager.contextStatus().coveredMessageCount;
    expect(covered).toBeGreaterThan(0);

    // 3. /new starts a second session file.
    const created = await manager.createNew();
    expect((await store.list()).sessions).toHaveLength(2);

    // 4. Resume switches back; the complete transcript survives.
    await manager.resume(session.id.slice(0, 8));
    expect(manager.active().id).toBe(session.id);
    expect(manager.contextStatus().coveredMessageCount).toBe(covered);

    // 5. A project skill activates and its layer reaches the provider once.
    await writeSkill(
      path.join(workspace, ".nju-agent", "skills"),
      "test-first",
      "test-first",
    );
    await registry.refresh();
    const activated = await manager.activateSkill("test-first");
    expect(activated.source).toBe("project");
    await manager.runTurn("format with skill", new AbortController().signal);
    const last = provider.requests.at(-1)!;
    expect(last.system).toContain('<active_skill name="test-first" source="project">');
    expect(last.system.match(/<active_skill/gu)).toHaveLength(1);

    // 6. Restart/resume rebuilds session with complete original messages.
    const loaded = await store.load(session.id);
    expect(loaded.messages.length).toBeGreaterThan(4);
    expect(loaded.context.checkpoint?.coveredMessageCount).toBe(covered);

    // 7. No slash command text was written into the message history.
    const messageText = JSON.stringify(loaded.messages);
    expect(messageText).not.toContain("/compact");
    expect(messageText).not.toContain("/new");

    // 8. No temporary app-home path leaks into the repository tree.
    const repoRoot = path.resolve(".");
    const repoFiles = await (await import("node:fs/promises")).readdir(repoRoot, { recursive: true });
    for (const file of repoFiles.slice(0, 50)) {
      expect(String(file)).not.toContain(home);
    }
  });
});

async function writeSkill(root: string, name: string, body: string): Promise<void> {
  const dir = path.join(root, name);
  await (await import("node:fs/promises")).mkdir(dir, { recursive: true });
  await (await import("node:fs/promises")).writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: project skill\n---\n\n${body} instructions\n`,
    "utf8",
  );
}
