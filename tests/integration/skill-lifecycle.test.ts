import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

class RecordingProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(structuredClone(request));
    yield {
      type: "message_completed",
      message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
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

async function writeSkill(root: string, name: string, description: string, body: string): Promise<void> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
    "utf8",
  );
}

async function makeManager(options: {
  home: string;
  workspace: string;
  provider: RecordingProvider;
  userSkillsRoot: string;
  projectSkillsRoot: string;
}) {
  const { home, workspace, provider, userSkillsRoot, projectSkillsRoot } = options;
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
  const registry = new SkillRegistry(userSkillsRoot, projectSkillsRoot);
  await registry.refresh();
  const manager = new SessionManager({
    initialRuntime: runtime,
    store,
    runtimeFactory: (target) => createRuntime(target, deps),
    registry,
  });
  return { manager, store, session, provider, registry };
}

describe("skill lifecycle", () => {
  test("activation persists, survives resume, and project overrides user", async () => {
    const home = await tempDirectory("nju-skill-");
    const workspace = await tempDirectory("nju-skill-work-");
    const userRoot = await tempDirectory("nju-skill-user-");
    const projectRoot = await tempDirectory("nju-skill-proj-");
    await writeSkill(userRoot, "fmt", "user fmt", "user instructions");
    await writeSkill(projectRoot, "fmt", "project fmt", "project instructions");
    const provider = new RecordingProvider();
    const { manager, store, session, registry } = await makeManager({
      home,
      workspace,
      provider,
      userSkillsRoot: userRoot,
      projectSkillsRoot: projectRoot,
    });

    const activated = await manager.activateSkill("fmt");
    expect(activated.source).toBe("project");
    await manager.runTurn("format the file", new AbortController().signal);

    // The recorded Provider request carries the project skill layer exactly once.
    const request = provider.requests[0]!;
    expect(request.system).toContain("project instructions");
    expect(request.system).toContain('<active_skill name="fmt" source="project">');
    expect(request.system.match(/<active_skill/gu)).toHaveLength(1);
    expect(request.system).not.toContain("user instructions");

    // Resume rebuilds activation from the persisted session.
    const loaded = await store.load(session.id);
    expect(loaded.activeSkill).toBe("fmt");
    const config = makeConfig(workspace);
    const prompt = new FakePrompt();
    const renderer = new MemoryRenderer();
    const deps = { env: {}, config, prompt, renderer, provider };
    const runtime = await createRuntime(loaded, deps);
    const manager2 = new SessionManager({
      initialRuntime: runtime,
      store: new SessionStore(path.join(home, ".nju-agent", "sessions")),
      runtimeFactory: (target) => createRuntime(target, deps),
      registry,
    });
    expect(manager2.activeSkill()?.source).toBe("project");
    await manager2.runTurn("again", new AbortController().signal);
    const request2 = provider.requests.at(-1)!;
    expect(request2.system).toContain("project instructions");
  });

  test("a deleted project skill falls back to the user skill on resume", async () => {
    const home = await tempDirectory("nju-skill-");
    const workspace = await tempDirectory("nju-skill-work-");
    const userRoot = await tempDirectory("nju-skill-user-");
    const projectRoot = await tempDirectory("nju-skill-proj-");
    await writeSkill(userRoot, "fmt", "user fmt", "user instructions");
    await writeSkill(projectRoot, "fmt", "project fmt", "project instructions");
    const provider = new RecordingProvider();
    const { manager, store, session } = await makeManager({
      home,
      workspace,
      provider,
      userSkillsRoot: userRoot,
      projectSkillsRoot: projectRoot,
    });
    await manager.activateSkill("fmt");

    // Remove the project override; refresh makes only the user skill visible.
    await rm(path.join(projectRoot, "fmt"), { recursive: true, force: true });
    const registry2 = new SkillRegistry(userRoot, projectRoot);
    await registry2.refresh();

    const loaded = await store.load(session.id);
    const config = makeConfig(workspace);
    const prompt = new FakePrompt();
    const renderer = new MemoryRenderer();
    const deps = { env: {}, config, prompt, renderer, provider };
    const runtime = await createRuntime(loaded, deps);
    const manager2 = new SessionManager({
      initialRuntime: runtime,
      store: new SessionStore(path.join(home, ".nju-agent", "sessions")),
      runtimeFactory: (target) => createRuntime(target, deps),
      registry: registry2,
    });

    // The user skill with the same name is still resolvable, so it is restored.
    expect(manager2.activeSkill()?.source).toBe("user");
    await manager2.runTurn("again", new AbortController().signal);
    expect(provider.requests.at(-1)!.system).toContain("user instructions");
  });
});
