import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import type { AgentEvent } from "../../src/agent/events.js";
import { ConversationHistory } from "../../src/agent/history.js";
import {
  assertValidHistory,
  type AssistantMessage,
  type Message,
  type ToolResultBlock,
} from "../../src/agent/messages.js";
import { AgentRunner } from "../../src/agent/runner.js";
import type { CommandContext } from "../../src/cli/command.js";
import { createToolCommand } from "../../src/cli/commands/tool-command.js";
import { TerminalRenderer } from "../../src/cli/renderer.js";
import { createTheme } from "../../src/cli/theme.js";
import type {
  ModelProvider,
  ModelRequest,
  ProviderEvent,
} from "../../src/providers/provider.js";
import { BalancedPermissionPolicy } from "../../src/security/permission-policy.js";
import { Workspace } from "../../src/security/workspace.js";
import { createRunCommandTool } from "../../src/tools/command-tool.js";
import { ToolExecutor } from "../../src/tools/executor.js";
import {
  createEditFileTool,
  createReadFileTool,
  createWriteFileTool,
} from "../../src/tools/file-tools.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import {
  createListFilesTool,
  createSearchTextTool,
} from "../../src/tools/search-tools.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/demo-project", import.meta.url));

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeTempWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "njuagent-it-"));
  tempDirs.push(dir);
  await cp(FIXTURE, dir, { recursive: true });
  return dir;
}

function textAssistant(text: string): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function complete(message: AssistantMessage): ProviderEvent {
  return { type: "message_completed", message, stopReason: "end_turn" };
}

function toolAssistant(
  calls: readonly { id: string; name: string; input: unknown }[],
): AssistantMessage {
  return {
    role: "assistant",
    content: calls.map((call) => ({ type: "tool_call" as const, ...call })),
  };
}

class ScriptedProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly scripts: readonly (readonly ProviderEvent[])[]) {}

  async *stream(request: ModelRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(structuredClone(request));
    const script = this.scripts[this.requests.length - 1];
    if (script === undefined) {
      throw new Error("No scripted response");
    }
    for (const event of script) {
      yield event;
    }
  }
}

async function buildAgent(tempDir: string) {
  const workspace = await Workspace.open(tempDir);
  const registry = new ToolRegistry();
  const maxOutputBytes = 8192;
  registry.register(createReadFileTool({ workspace, maxOutputBytes }));
  registry.register(createWriteFileTool({ workspace }));
  registry.register(createEditFileTool({ workspace }));
  registry.register(
    createListFilesTool({ workspace, maxOutputBytes, maxResults: 100 }),
  );
  registry.register(
    createSearchTextTool({
      workspace,
      maxOutputBytes,
      maxResults: 100,
      maxFileBytes: 100_000,
    }),
  );
  registry.register(
    createRunCommandTool({ workspace, defaultTimeoutMs: 15_000, maxOutputBytes }),
  );
  const executor = new ToolExecutor({
    registry,
    permissionPolicy: new BalancedPermissionPolicy(),
    confirm: async () => true,
  });
  const history = new ConversationHistory();
  return { workspace, executor, history };
}

function toolResultsOf(messages: readonly Message[]): ToolResultBlock[] {
  const results: ToolResultBlock[] = [];
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    for (const block of message.content) {
      if (block.type === "tool_result") {
        results.push(block);
      }
    }
  }
  return results;
}

describe("offline end-to-end agent workflow", () => {
  test(
    "lists, reads, edits, runs a failing test, fixes, and passes",
    async () => {
      const tempDir = await makeTempWorkspace();

      const firstEdit = {
        oldText: "  const port = Number(value);\n  return port;",
        newText:
          "  const port = Number(value);\n" +
          '  if (!Number.isInteger(port)) {\n    throw new RangeError("Invalid port: " + value);\n  }\n' +
          "  return port;",
      };
      const secondEdit = {
        oldText:
          "  if (!Number.isInteger(port)) {\n    throw new RangeError(\"Invalid port: \" + value);\n  }\n  return port;",
        newText:
          "  if (!Number.isInteger(port) || port < 0 || port > 65535) {\n" +
          '    throw new RangeError("Invalid port: " + value);\n  }\n' +
          "  return port;",
      };

      const provider = new ScriptedProvider([
        [
          complete(toolAssistant([
            { id: "c1", name: "list_files", input: {} },
            { id: "c2", name: "read_file", input: { path: "src/validate.mjs" } },
          ])),
        ],
        [
          complete(toolAssistant([
            { id: "c3", name: "read_file", input: { path: "test/validate.test.mjs" } },
          ])),
        ],
        [
          complete(toolAssistant([
            {
              id: "c4",
              name: "edit_file",
              input: { path: "src/validate.mjs", ...firstEdit },
            },
          ])),
        ],
        [
          complete(toolAssistant([
            { id: "c5", name: "run_command", input: { command: "npm test" } },
          ])),
        ],
        [
          complete(toolAssistant([
            {
              id: "c6",
              name: "edit_file",
              input: { path: "src/validate.mjs", ...secondEdit },
            },
          ])),
        ],
        [
          complete(toolAssistant([
            { id: "c7", name: "run_command", input: { command: "npm test" } },
          ])),
        ],
        [
          { type: "text_delta", text: "Fixed and verified." },
          complete(textAssistant("Fixed and verified.")),
        ],
      ]);

      const { executor, history } = await buildAgent(tempDir);
      const events: AgentEvent[] = [];
      const runner = new AgentRunner({
        provider,
        history,
        tools: executor,
        maxSteps: 10,
        systemPrompt: "Be precise.",
        onEvent: (event) => events.push(event),
      });

      const result = await runner.run(
        "Add input validation to parsePort and make the tests pass.",
        new AbortController().signal,
      );

      expect(result).toMatchObject({ status: "completed", steps: 7, toolCalls: 7 });
      assertValidHistory(history.snapshot());

      const finalSource = await readFile(path.join(tempDir, "src/validate.mjs"), "utf8");
      expect(finalSource).toContain("port > 65535");

      const types = events.map((event) => event.type);
      expect(types.at(-1)).toBe("run_finished");
      expect(types.filter((type) => type === "tool_started")).toHaveLength(7);

      const runResults = toolResultsOf(history.snapshot()).filter(
        (block) => block.toolCallId === "c5" || block.toolCallId === "c7",
      );
      const failing = runResults.find((block) => block.toolCallId === "c5");
      const passing = runResults.find((block) => block.toolCallId === "c7");
      expect(failing?.isError).toBe(true);
      expect(failing?.content).toContain("ERR_ASSERTION");
      expect(passing?.isError).toBe(false);
      expect(passing?.content).toContain("all tests passed");
    },
    20_000,
  );

  test("denies a dangerous command and lets the model recover", async () => {
    const tempDir = await makeTempWorkspace();
    const provider = new ScriptedProvider([
      [
        complete(toolAssistant([
          { id: "c1", name: "run_command", input: { command: "sudo rm -rf /" } },
        ])),
      ],
      [
        { type: "text_delta", text: "I cannot do that." },
        complete(textAssistant("I cannot do that.")),
      ],
    ]);

    const { executor, history } = await buildAgent(tempDir);
    const runner = new AgentRunner({
      provider,
      history,
      tools: executor,
      maxSteps: 5,
      systemPrompt: "Be precise.",
    });

    const result = await runner.run("clean the machine", new AbortController().signal);

    expect(result).toMatchObject({ status: "completed", steps: 2, toolCalls: 1 });
    assertValidHistory(history.snapshot());
    const denied = toolResultsOf(history.snapshot()).find(
      (block) => block.toolCallId === "c1",
    );
    expect(denied).toMatchObject({ isError: true });
    expect(denied?.content).toMatch(/privileged|outside-workspace/iu);
  });

  test(
    "cancels a running command and keeps the history valid",
    async () => {
      const tempDir = await makeTempWorkspace();
      const provider = new ScriptedProvider([
        [
          complete(toolAssistant([
            { id: "c1", name: "run_command", input: { command: "sleep 5" } },
          ])),
        ],
      ]);

      const controller = new AbortController();
      const { executor, history } = await buildAgent(tempDir);
      const events: AgentEvent[] = [];
      const runner = new AgentRunner({
        provider,
        history,
        tools: executor,
        maxSteps: 5,
        systemPrompt: "Be precise.",
        onEvent: (event) => events.push(event),
      });

      const running = runner.run("wait a bit", controller.signal);
      await new Promise<void>((resolve) => {
        const poll = setInterval(() => {
          const started = events.some(
            (event) => event.type === "tool_started" && event.name === "run_command",
          );
          if (started) {
            clearInterval(poll);
            controller.abort();
            resolve();
          }
        }, 5);
      });

      const result = await running;
      expect(result.status).toBe("cancelled");
      assertValidHistory(history.snapshot());
      const cancelled = toolResultsOf(history.snapshot()).find(
        (block) => block.toolCallId === "c1",
      );
      expect(cancelled).toMatchObject({ isError: true });
      expect(cancelled?.content).toContain("cancelled");
    },
    15_000,
  );
});

describe("tool card and /tool inspector end-to-end", () => {
  async function runToolCommand(
    messages: readonly Message[],
    prefix: string,
  ): Promise<string[]> {
    const printed: string[] = [];
    const renderer = {
      permissionRequest(): void {},
      permissionDecision(): void {},
      handle(): void {},
      toolOutput(): void {},
      print(text: string): void {
        printed.push(text);
      },
      error(): void {},
    };
    const unused = (): never => {
      throw new Error("unused");
    };
    const context: CommandContext = {
      renderer,
      theme: createTheme({ enabled: false }),
      signal: new AbortController().signal,
      webSearchAvailable: false,
      display: { enhanced: false, columns: () => 80 },
      skillRegistry: {
        refresh: async () => ({ skills: [], diagnostics: [] }),
        list: () => [],
        resolve: () => undefined,
        diagnostics: () => [],
      },
      sessionManager: {
        messages: () => messages,
        active: unused,
        isDirty: () => false,
        flush: async () => undefined,
        createNew: unused,
        resume: unused,
        contextStatus: unused,
        compact: unused,
        activeSkill: () => undefined,
        activateSkill: unused,
        deactivateSkill: async () => undefined,
        plan: () => ({ items: [] }),
        clearPlan: async () => ({ items: [] }),
        goal: () => null,
        setGoal: unused,
        clearGoal: async () => undefined,
      },
      store: { list: async () => ({ sessions: [], diagnostics: [] }) },
    };
    await createToolCommand().execute(prefix, context);
    return printed;
  }

  test(
    "a long command renders one compact card and /tool reveals the retained result",
    async () => {
      const tempDir = await makeTempWorkspace();
      const callId = "tool1234abcd";
      const provider = new ScriptedProvider([
        [
          complete(toolAssistant([
            {
              id: callId,
              name: "run_command",
              input: { command: "printf '1\\n2\\n3\\n4\\n5\\n'" },
            },
          ])),
        ],
        [
          { type: "text_delta", text: "Done." },
          complete(textAssistant("Done.")),
        ],
      ]);
      const workspace = await Workspace.open(tempDir);
      const registry = new ToolRegistry();
      registry.register(
        createRunCommandTool({
          workspace,
          defaultTimeoutMs: 15_000,
          maxOutputBytes: 8192,
        }),
      );
      const chunks: string[] = [];
      const stdout = {
        write(chunk: string): boolean {
          chunks.push(chunk);
          return true;
        },
      };
      const renderer = new TerminalRenderer({ stdout, isTTY: true, noColor: false });
      const executor = new ToolExecutor({
        registry,
        permissionPolicy: new BalancedPermissionPolicy(),
        confirm: async () => true,
        onOutput: (call, stream, text) => renderer.toolOutput(call, stream, text),
      });
      const history = new ConversationHistory();
      const runner = new AgentRunner({
        provider,
        history,
        tools: executor,
        maxSteps: 5,
        systemPrompt: "Be precise.",
        onEvent: (event) => renderer.handle(event),
      });

      const result = await runner.run("print lines", new AbortController().signal);

      expect(result.status).toBe("completed");
      assertValidHistory(history.snapshot());
      const visible = stripVTControlCharacters(chunks.join(""));
      // Exactly one compact card; hidden lines never stream to the transcript.
      expect(visible).toContain("╭─ ⚙ run_command · succeeded");
      expect(visible).toContain("│ stdout  1");
      expect(visible).toContain("… 2 more lines hidden · /tool tool1234");
      expect(visible).not.toContain("│ stdout  4");
      expect(visible).not.toContain("│ stdout  5");

      // /tool with the card's 8-character prefix prints the retained result.
      const printed = await runToolCommand(history.snapshot(), "tool1234");
      const text = printed.join("\n");
      expect(text).toContain(`Tool ${callId} (run_command)`);
      expect(text).toContain("Stored result:");
      expect(text).toContain("stdout:\n1\n2\n3\n4\n5");
    },
    20_000,
  );
});
