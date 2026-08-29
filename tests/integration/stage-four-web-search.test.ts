import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AppConfig } from "../../src/config.js";
import { SlashCommandRouter } from "../../src/cli/command-router.js";
import { registerCoreCommands } from "../../src/cli/commands/register-core-commands.js";
import { CliSession } from "../../src/cli/session.js";
import { createRuntime } from "../../src/runtime/create-runtime.js";
import { SkillRegistry } from "../../src/skills/skill-registry.js";
import { SessionManager } from "../../src/sessions/session-manager.js";
import { SessionStore } from "../../src/sessions/session-store.js";
import {
  createEmptySession,
  type PersistedSessionV1,
} from "../../src/sessions/session-schema.js";
import { resolveAppPaths } from "../../src/storage/paths.js";
import type { Renderer } from "../../src/cli/renderer.js";
import type { Prompt } from "../../src/cli/prompt.js";
import type { ModelProvider, ModelRequest, ProviderEvent } from "../../src/providers/provider.js";
import type { WebSearchProvider, WebSearchQuery, WebSearchResult } from "../../src/web/web-search.js";

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

class FakeWebProvider implements WebSearchProvider {
  queries: WebSearchQuery[] = [];
  search(query: WebSearchQuery): Promise<readonly WebSearchResult[]> {
    this.queries.push(query);
    return Promise.resolve([
      {
        title: "AbortSignal - Node.js",
        url: "https://nodejs.org/api/abort.html",
        snippet: "official docs",
        content: "AbortSignal.timeout returns an AbortSignal that aborts after ms.",
      },
    ]);
  }
}

class ScriptedProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];
  ordinaryIndex = 0;

  async *stream(request: ModelRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(structuredClone(request));
    if (request.tools.length === 0) {
      yield this.#complete("summary");
      return;
    }
    this.ordinaryIndex += 1;
    if (this.ordinaryIndex === 1) {
      yield this.#tools([
        { id: "w1", name: "web_search", input: { query: "AbortSignal timeout fetch" } },
      ]);
      return;
    }
    yield this.#complete(`ack-${this.ordinaryIndex}`);
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
  confirmResult = true;
  confirm(): Promise<boolean> {
    return Promise.resolve(this.confirmResult);
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

function makeConfig(
  workspaceRoot: string,
  overrides: Partial<AppConfig> = {},
): AppConfig {
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
    webSearchTimeoutMs: 15000,
    webSearchMaxContentChars: 6000,
    ...overrides,
  };
}

async function makeRuntime(options: {
  workspace: string;
  config: AppConfig;
  provider: ScriptedProvider;
  webSearchProvider?: WebSearchProvider;
}) {
  const store = new SessionStore(resolveAppPaths({ NJU_AGENT_HOME: options.workspace }, options.workspace).sessionsDirectory);
  const session = createEmptySession({
    id: crypto.randomUUID(),
    now: new Date().toISOString(),
    workspaceRoot: options.workspace,
    modelId: "deepseek-v4-flash",
    permissionMode: "balanced",
  });
  await store.save(session);
  const renderer = new MemoryRenderer();
  const prompt = new FakePrompt();
  const deps = {
    env: {},
    config: options.config,
    prompt,
    renderer,
    provider: options.provider,
    ...(options.webSearchProvider === undefined
      ? {}
      : { webSearchProvider: options.webSearchProvider }),
  };
  const initialRuntime = await createRuntime(session, deps);
  const registry = {
    resolve: () => undefined,
    refresh: async () => ({ skills: [], diagnostics: [] }),
    list: () => [],
    diagnostics: () => [],
  } as unknown as SkillRegistry;
  const manager = new SessionManager({
    initialRuntime,
    store,
    runtimeFactory: (target) => createRuntime(target, deps),
    registry,
    clock: () => new Date("2026-08-29T12:00:00.000Z"),
  });
  const router = new SlashCommandRouter();
  registerCoreCommands(router);
  const sessionInstance = new CliSession({
    prompt,
    renderer,
    runTurn: (text, signal) => manager.runTurn(text, signal),
    router,
    commandContext: {
      renderer,
      theme: renderer as never,
      sessionManager: manager,
      store,
      skillRegistry: registry,
      webSearchAvailable: options.config.tavilyApiKey !== undefined,
      signal: new AbortController().signal,
    } as never,
  });
  return { manager, session, renderer, prompt, provider: options.provider, sessionInstance };
}

describe("stage four web search", () => {
  test("no Tavily key registers no web_search and never calls the provider", async () => {
    const workspace = await tempDirectory("nju-web-no-key-");
    const provider = new ScriptedProvider();
    const { manager } = await makeRuntime({
      workspace,
      config: makeConfig(workspace),
      provider,
    });
    const result = await manager.runTurn("hello", new AbortController().signal);
    expect(result.status).toBe("completed");

    const toolNames = provider.requests.flatMap((request) =>
      request.tools.map((tool) => tool.name),
    );
    expect(toolNames).not.toContain("web_search");
  });

  test("a key plus injected fake provider registers web_search and returns untrusted results", async () => {
    const workspace = await tempDirectory("nju-web-key-");
    const provider = new ScriptedProvider();
    const webProvider = new FakeWebProvider();
    const { manager } = await makeRuntime({
      workspace,
      config: makeConfig(workspace, { tavilyApiKey: "tvly-test" }),
      provider,
      webSearchProvider: webProvider,
    });
    const result = await manager.runTurn(
      "find current AbortSignal timeout usage",
      new AbortController().signal,
    );
    expect(result.status).toBe("completed");
    expect(webProvider.queries).toHaveLength(1);
    expect(webProvider.queries[0]!.query).toContain("AbortSignal");
    const history = JSON.stringify(manager.active().messages);
    expect(history).toContain("untrusted_web_results");
    expect(history).toContain("https://nodejs.org/api/abort.html");
  });

  test("permission rejection returns a valid tool result and still completes", async () => {
    const workspace = await tempDirectory("nju-web-deny-");
    const provider = new ScriptedProvider();
    const webProvider = new FakeWebProvider();
    const { manager, prompt } = await makeRuntime({
      workspace,
      config: makeConfig(workspace, { tavilyApiKey: "tvly-test" }),
      provider,
      webSearchProvider: webProvider,
    });
    prompt.confirmResult = false;
    const result = await manager.runTurn("search the web", new AbortController().signal);
    expect(result.status).toBe("completed");
    expect(webProvider.queries).toHaveLength(0);
    const history = manager.active().messages;
    expect(JSON.stringify(history)).toContain(
      "Web search sends the query to an external service",
    );
  });
});
