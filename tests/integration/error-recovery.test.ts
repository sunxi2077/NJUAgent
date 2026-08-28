import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConversationHistory } from "../../src/agent/history.js";
import { AgentRunner, type ToolExecutorPort } from "../../src/agent/runner.js";
import type { AgentEvent } from "../../src/agent/events.js";
import { ProviderError } from "../../src/providers/provider.js";
import type { ModelProvider, ProviderEvent } from "../../src/providers/provider.js";
import { SkillLoader } from "../../src/skills/skill-loader.js";
import type { AssistantMessage } from "../../src/agent/messages.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "nju-recovery-"));
  temporaryDirectories.push(dir);
  return dir;
}

const textAssistant = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

const emptyTools: ToolExecutorPort = {
  definitions: () => [],
  execute: async () => {
    throw new Error("no tools expected");
  },
};

describe("runtime failure recovery", () => {
  test("a 429 rate limit retries to the limit and emits retry events", async () => {
    let attempts = 0;
    const provider: ModelProvider = {
      async *stream() {
        attempts += 1;
        if (attempts < 3) {
          throw new ProviderError("Model rate limit reached", {
            kind: "rate_limit",
            retryable: true,
          });
        }
        yield {
          type: "message_completed",
          message: textAssistant("recovered"),
          stopReason: "end_turn",
        };
      },
    };
    const events: AgentEvent[] = [];
    const runner = new AgentRunner({
      provider,
      history: new ConversationHistory(),
      tools: emptyTools,
      maxSteps: 4,
      systemPrompt: "s",
      retryPolicy: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
      onEvent: (event) => events.push(event),
    });

    const result = await runner.run("task", new AbortController().signal);

    expect(result.status).toBe("completed");
    expect(attempts).toBe(3);
    expect(events.filter((event) => event.type === "retrying")).toHaveLength(2);
  });

  test("Ctrl-C during retry backoff ends immediately as cancelled", async () => {
    let attempts = 0;
    const provider: ModelProvider = {
      async *stream() {
        attempts += 1;
        throw new ProviderError("temporary", { kind: "unavailable", retryable: true });
      },
    };
    const controller = new AbortController();
    const runner = new AgentRunner({
      provider,
      history: new ConversationHistory(),
      tools: emptyTools,
      maxSteps: 4,
      systemPrompt: "s",
      retryPolicy: { maxAttempts: 5, baseDelayMs: 10_000, maxDelayMs: 10_000, jitterRatio: 0 },
    });
    const running = runner.run("task", controller.signal);
    setTimeout(() => controller.abort(), 20);

    const result = await running;

    expect(result.status).toBe("cancelled");
    expect(attempts).toBe(1);
  });

  test("an auth failure returns a safe classified message without credentials", async () => {
    const provider: ModelProvider = {
      async *stream() {
        throw new ProviderError("Model authentication failed", {
          kind: "auth",
          retryable: false,
          cause: new Error("401 sk-ant-fake-secret-should-not-leak"),
        });
      },
    };
    const runner = new AgentRunner({
      provider,
      history: new ConversationHistory(),
      tools: emptyTools,
      maxSteps: 4,
      systemPrompt: "s",
      retryPolicy: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
    });

    const result = await runner.run("task", new AbortController().signal);

    expect(result.status).toBe("model_failed");
    if (result.status === "model_failed") {
      expect(result.message).toContain("authentication");
      expect(result.message).not.toContain("sk-ant-");
      expect(result.message).not.toContain("fake-secret");
    }
  });

  test("an invalid skill file does not crash discovery", async () => {
    const root = await tempRoot();
    await mkdir(path.join(root, "broken"), { recursive: true });
    await writeFile(path.join(root, "broken", "SKILL.md"), "not frontmatter", "utf8");

    const loader = new SkillLoader();
    const result = await loader.loadRoot(root, "user");

    expect(result.skills).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ name: "broken" });
  });
});
