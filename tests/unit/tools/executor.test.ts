import { describe, expect, test } from "vitest";

import {
  AllowAllPermissionPolicy,
  type PermissionPolicy,
} from "../../../src/security/permission-policy.js";
import { ToolExecutor } from "../../../src/tools/executor.js";
import { ToolRegistry } from "../../../src/tools/registry.js";
import type { Tool } from "../../../src/tools/tool.js";

type EchoInput = { value: string };

function createEchoTool(onExecute: () => void = () => undefined): Tool<EchoInput> {
  return {
    name: "echo",
    description: "Echo a string.",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    execute: async (input) => {
      onExecute();
      return { content: input.value };
    },
  };
}

function createExecutor(options?: {
  tool?: Tool;
  policy?: PermissionPolicy;
  confirm?: (reason: string) => Promise<boolean>;
}): ToolExecutor {
  const registry = new ToolRegistry();
  registry.register(options?.tool ?? createEchoTool());
  return new ToolExecutor({
    registry,
    permissionPolicy: options?.policy ?? new AllowAllPermissionPolicy(),
    confirm: async (_call, reason) => options?.confirm?.(reason) ?? false,
  });
}

describe("ToolRegistry", () => {
  test("rejects a duplicate tool name", () => {
    const registry = new ToolRegistry();
    registry.register(createEchoTool());
    expect(() => registry.register(createEchoTool())).toThrow(/duplicate.*echo/i);
  });
});

describe("ToolExecutor", () => {
  test("returns invalid_input without executing when input violates the schema", async () => {
    let executions = 0;
    const executor = createExecutor({ tool: createEchoTool(() => executions += 1) });

    const result = await executor.execute(
      { id: "c1", name: "echo", input: { value: 42 } },
      new AbortController().signal,
    );

    expect(result).toMatchObject({ toolCallId: "c1", isError: true, code: "invalid_input" });
    expect(result.content).toContain("value");
    expect(executions).toBe(0);
  });

  test("returns unknown_tool for an unregistered name", async () => {
    const executor = createExecutor();
    const result = await executor.execute(
      { id: "c2", name: "missing", input: {} },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ toolCallId: "c2", isError: true, code: "unknown_tool" });
  });

  test("returns permission_denied when policy denies the call", async () => {
    const policy: PermissionPolicy = {
      decide: () => ({ action: "deny", reason: "blocked by policy" }),
    };
    const result = await createExecutor({ policy }).execute(
      { id: "c3", name: "echo", input: { value: "secret" } },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ code: "permission_denied", isError: true });
    expect(result.content).toContain("blocked by policy");
  });

  test("asks for confirmation and returns permission_denied when declined", async () => {
    const policy: PermissionPolicy = {
      decide: () => ({ action: "ask", reason: "needs approval" }),
    };
    const result = await createExecutor({
      policy,
      confirm: async (reason) => {
        expect(reason).toBe("needs approval");
        return false;
      },
    }).execute(
      { id: "c4", name: "echo", input: { value: "hello" } },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ code: "permission_denied", isError: true });
  });

  test("executes an allowed valid call and preserves its id", async () => {
    const result = await createExecutor().execute(
      { id: "c5", name: "echo", input: { value: "hello" } },
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      toolCallId: "c5",
      content: "hello",
      isError: false,
    });
  });

  test("converts a thrown tool error into execution_failed", async () => {
    const tool: Tool = {
      ...createEchoTool(),
      execute: async () => {
        throw new Error("disk unavailable");
      },
    };
    const result = await createExecutor({ tool }).execute(
      { id: "c6", name: "echo", input: { value: "hello" } },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ code: "execution_failed", isError: true });
    expect(result.content).toContain("disk unavailable");
  });

  test("preserves an unsuccessful tool outcome and its metadata", async () => {
    const tool: Tool = {
      ...createEchoTool(),
      execute: async () => ({
        content: "exit_code: 2",
        isError: true,
        metadata: { exitCode: 2 },
      }),
    };
    const result = await createExecutor({ tool }).execute(
      { id: "c-command", name: "echo", input: { value: "hello" } },
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      toolCallId: "c-command",
      content: "exit_code: 2",
      isError: true,
      metadata: { exitCode: 2 },
    });
  });

  test("returns cancelled before executing when the signal is aborted", async () => {
    let executions = 0;
    const controller = new AbortController();
    controller.abort();
    const result = await createExecutor({
      tool: createEchoTool(() => executions += 1),
    }).execute(
      { id: "c7", name: "echo", input: { value: "hello" } },
      controller.signal,
    );
    expect(result).toMatchObject({ code: "cancelled", isError: true });
    expect(executions).toBe(0);
  });

  describe("onResult observer", () => {
    function observedExecutor(options?: { policy?: PermissionPolicy; confirm?: () => Promise<boolean> }) {
      const registry = new ToolRegistry();
      registry.register(createEchoTool());
      const observed: Array<{ name: string; isError: boolean; code?: string }> = [];
      const observerErrors: unknown[] = [];
      const executor = new ToolExecutor({
        registry,
        permissionPolicy: options?.policy ?? new AllowAllPermissionPolicy(),
        confirm: async () => options?.confirm?.() ?? false,
        onResult: (call, result) => {
          observed.push({
            name: call.name,
            isError: result.isError,
            ...(result.code === undefined ? {} : { code: result.code }),
          });
        },
        onObserverError: (error) => {
          observerErrors.push(error);
        },
      });
      return { executor, observed, observerErrors };
    }

    test("observes success exactly once", async () => {
      const { executor, observed } = observedExecutor();
      await executor.execute(
        { id: "c1", name: "echo", input: { value: "hi" } },
        new AbortController().signal,
      );
      expect(observed).toEqual([{ name: "echo", isError: false }]);
    });

    test("observes unknown-tool, invalid-input, and denial paths exactly once", async () => {
      const { executor, observed } = observedExecutor({
        policy: { decide: () => ({ action: "deny" as const, reason: "no" }) },
      });
      await executor.execute(
        { id: "c1", name: "nope", input: {} },
        new AbortController().signal,
      );
      await executor.execute(
        { id: "c2", name: "echo", input: { value: 42 } },
        new AbortController().signal,
      );
      await executor.execute(
        { id: "c3", name: "echo", input: { value: "x" } },
        new AbortController().signal,
      );
      expect(observed).toEqual([
        { name: "nope", isError: true, code: "unknown_tool" },
        { name: "echo", isError: true, code: "invalid_input" },
        { name: "echo", isError: true, code: "permission_denied" },
      ]);
    });

    test("a throwing observer never alters the tool result", async () => {
      const registry = new ToolRegistry();
      registry.register(createEchoTool());
      const observerErrors: unknown[] = [];
      const executor = new ToolExecutor({
        registry,
        permissionPolicy: new AllowAllPermissionPolicy(),
        confirm: async () => false,
        onResult: () => {
          throw new Error("observer exploded");
        },
        onObserverError: (error) => {
          observerErrors.push(error);
        },
      });
      const result = await executor.execute(
        { id: "c1", name: "echo", input: { value: "hi" } },
        new AbortController().signal,
      );
      expect(result).toMatchObject({ toolCallId: "c1", isError: false });
      expect(observerErrors).toHaveLength(1);
    });
  });
});
