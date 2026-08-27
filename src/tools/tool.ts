import type { ToolCallBlock, ToolResultBlock } from "../agent/messages.js";
import type { ModelToolDefinition } from "../providers/provider.js";

export type ToolOutput = {
  content: string;
  metadata?: Record<string, unknown>;
};

export type ToolOutputStream = "stdout" | "stderr";

export type ToolContext = {
  signal: AbortSignal;
  emitOutput(stream: ToolOutputStream, text: string): void;
};

export interface Tool<TInput = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(input: TInput, context: ToolContext): Promise<ToolOutput>;
}

export type ToolErrorCode =
  | "unknown_tool"
  | "invalid_input"
  | "permission_denied"
  | "execution_failed"
  | "cancelled";

export type ToolExecutionResult = ToolResultBlock & {
  durationMs: number;
  code?: ToolErrorCode;
  metadata?: Record<string, unknown>;
};

export type ToolExecutionRequest = Omit<ToolCallBlock, "type">;

export type ToolDefinition = ModelToolDefinition;
