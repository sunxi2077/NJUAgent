import type { PermissionPolicy } from "../security/permission-policy.js";
import { ToolRegistry } from "./registry.js";
import type {
  ToolErrorCode,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolOutputStream,
} from "./tool.js";

export type PermissionConfirmation = (
  call: ToolExecutionRequest,
  reason: string,
  signal: AbortSignal,
) => Promise<boolean>;

export type ToolOutputHandler = (
  call: ToolExecutionRequest,
  stream: ToolOutputStream,
  text: string,
) => void;

export type ToolExecutorOptions = {
  registry: ToolRegistry;
  permissionPolicy: PermissionPolicy;
  confirm: PermissionConfirmation;
  onOutput?: ToolOutputHandler;
};

export class ToolExecutor {
  constructor(private readonly options: ToolExecutorOptions) {}

  definitions() {
    return this.options.registry.definitions();
  }

  async execute(
    call: ToolExecutionRequest,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const startedAt = performance.now();
    if (signal.aborted) {
      return this.error(call, "cancelled", "Tool execution was cancelled", startedAt);
    }

    const registered = this.options.registry.resolve(call.name);
    if (registered === undefined) {
      return this.error(call, "unknown_tool", `Unknown tool: ${call.name}`, startedAt);
    }

    if (!registered.validate(call.input)) {
      const details = this.options.registry.validationErrors(registered.validate);
      return this.error(
        call,
        "invalid_input",
        `Invalid input for ${call.name}: ${details}`,
        startedAt,
      );
    }

    const decision = await this.options.permissionPolicy.decide(call);
    if (decision.action === "deny") {
      return this.error(call, "permission_denied", decision.reason, startedAt);
    }
    if (decision.action === "ask") {
      const approved = await this.options.confirm(call, decision.reason, signal);
      if (!approved || signal.aborted) {
        return this.error(
          call,
          signal.aborted ? "cancelled" : "permission_denied",
          signal.aborted ? "Tool execution was cancelled" : decision.reason,
          startedAt,
        );
      }
    }

    try {
      const output = await registered.tool.execute(call.input, {
        signal,
        emitOutput: (stream, text) => this.options.onOutput?.(call, stream, text),
      });
      if (signal.aborted) {
        return this.error(call, "cancelled", "Tool execution was cancelled", startedAt);
      }
      return {
        type: "tool_result",
        toolCallId: call.id,
        content: output.content,
        isError: output.isError ?? false,
        durationMs: performance.now() - startedAt,
        ...(output.isError === true ? { code: "execution_failed" as const } : {}),
        ...(output.metadata === undefined ? {} : { metadata: output.metadata }),
      };
    } catch (error) {
      if (signal.aborted) {
        return this.error(call, "cancelled", "Tool execution was cancelled", startedAt);
      }
      return this.error(
        call,
        "execution_failed",
        error instanceof Error ? error.message : String(error),
        startedAt,
      );
    }
  }

  private error(
    call: ToolExecutionRequest,
    code: ToolErrorCode,
    content: string,
    startedAt: number,
  ): ToolExecutionResult {
    return {
      type: "tool_result",
      toolCallId: call.id,
      content,
      isError: true,
      code,
      durationMs: performance.now() - startedAt,
    };
  }
}
