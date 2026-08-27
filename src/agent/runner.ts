import type { AgentEventHandler } from "./events.js";
import type { ContextPolicyPort } from "./context-policy.js";
import { ConversationHistory } from "./history.js";
import type { ToolCallBlock, ToolResultBlock } from "./messages.js";
import type { RunResult } from "./result.js";
import type {
  ModelProvider,
  ModelToolDefinition,
  ProviderEvent,
} from "../providers/provider.js";
import { withModelRetry, type RetryPolicy } from "../providers/retry.js";

export type ToolPortResult = ToolResultBlock & { durationMs?: number };

export interface ToolExecutorPort {
  definitions(): readonly ModelToolDefinition[];
  execute(
    call: ToolCallBlock,
    signal: AbortSignal,
  ): Promise<ToolPortResult>;
}

export type AgentRunnerOptions = {
  provider: ModelProvider;
  history: ConversationHistory;
  tools: ToolExecutorPort;
  maxSteps: number;
  systemPrompt: string;
  contextPolicy?: ContextPolicyPort;
  retryPolicy?: RetryPolicy;
  onEvent?: AgentEventHandler;
};

export class AgentRunner {
  constructor(private readonly options: AgentRunnerOptions) {}

  async run(userText: string, signal: AbortSignal): Promise<RunResult> {
    const startedAt = performance.now();
    let steps = 0;
    let toolCalls = 0;
    let lastInputTokens: number | undefined;
    this.options.history.appendUserText(userText);

    if (signal.aborted) {
      return this.finish({
        status: "cancelled",
        steps,
        toolCalls,
        durationMs: performance.now() - startedAt,
      });
    }

    while (steps < this.options.maxSteps) {
      const historySnapshot = this.options.history.snapshot();
      const context = this.options.contextPolicy?.prepare(
        historySnapshot,
        lastInputTokens,
      ) ?? {
        action: "continue" as const,
        messages: historySnapshot,
        estimatedTokens: 0,
        compactedToolResults: 0,
      };
      if (context.action === "stop") {
        return this.finish({
          status: "context_limit",
          steps,
          toolCalls,
          durationMs: performance.now() - startedAt,
        });
      }

      steps += 1;
      this.emit({ type: "model_started", step: steps });

      let completed: Extract<ProviderEvent, { type: "message_completed" }> | undefined;
      try {
        const request = {
          system: this.options.systemPrompt,
          messages: context.messages,
          tools: this.options.tools.definitions(),
        };
        const openStream = () => this.options.provider.stream(request, signal);
        const stream = this.options.retryPolicy === undefined
          ? openStream()
          : withModelRetry(
              openStream,
              this.options.retryPolicy,
              signal,
              (event) => this.emit({ type: "retrying", ...event }),
            );

        for await (const event of stream) {
          if (signal.aborted) {
            return this.finish({
              status: "cancelled",
              steps,
              toolCalls,
              durationMs: performance.now() - startedAt,
            });
          }
          if (event.type === "usage") {
            lastInputTokens = event.inputTokens;
            this.emit(event);
          } else if (event.type === "text_delta") {
            this.emit(event);
          } else {
            completed = event;
          }
        }
      } catch (error) {
        if (signal.aborted) {
          return this.finish({
            status: "cancelled",
            steps,
            toolCalls,
            durationMs: performance.now() - startedAt,
          });
        }
        return this.finish({
          status: "model_failed",
          message: error instanceof Error ? error.message : String(error),
          steps,
          toolCalls,
          durationMs: performance.now() - startedAt,
        });
      }

      if (completed === undefined) {
        return this.finish({
          status: "model_failed",
          message: "Provider stream ended without a completed assistant message",
          steps,
          toolCalls,
          durationMs: performance.now() - startedAt,
        });
      }

      this.options.history.appendAssistant(completed.message);
      this.emit({ type: "model_completed", stopReason: completed.stopReason });
      const calls = completed.message.content.filter(
        (block): block is ToolCallBlock => block.type === "tool_call",
      );
      toolCalls += calls.length;

      if (calls.length === 0) {
        return this.finish({
          status: "completed",
          steps,
          toolCalls,
          durationMs: performance.now() - startedAt,
        });
      }

      const results: ToolResultBlock[] = [];
      for (const call of calls) {
        this.emit({
          type: "tool_started",
          id: call.id,
          name: call.name,
          summary: summarizeToolCall(call),
        });
        const result = signal.aborted
          ? this.cancelledResult(call)
          : await this.options.tools.execute(call, signal);
        results.push({
          type: "tool_result",
          toolCallId: result.toolCallId,
          content: result.content,
          isError: result.isError,
        });
        this.emit({
          type: "tool_completed",
          id: call.id,
          name: call.name,
          ok: !result.isError,
          durationMs: result.durationMs ?? 0,
        });
      }
      this.options.history.appendToolResults(results);

      if (signal.aborted) {
        return this.finish({
          status: "cancelled",
          steps,
          toolCalls,
          durationMs: performance.now() - startedAt,
        });
      }
    }

    return this.finish({
      status: "limit_reached",
      steps,
      toolCalls,
      durationMs: performance.now() - startedAt,
    });
  }

  private emit(event: Parameters<AgentEventHandler>[0]): void {
    this.options.onEvent?.(event);
  }

  private finish(result: RunResult): RunResult {
    this.emit({ type: "run_finished", result });
    return result;
  }

  private cancelledResult(call: ToolCallBlock): ToolPortResult {
    return {
      type: "tool_result",
      toolCallId: call.id,
      content: "Tool execution was cancelled",
      isError: true,
    };
  }
}

const MAX_TOOL_SUMMARY_CHARS = 100;

function summarizeToolCall(call: ToolCallBlock): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(call.input);
  } catch {
    serialized = String(call.input);
  }
  if (serialized === undefined) {
    serialized = String(call.input);
  }
  return serialized.length > MAX_TOOL_SUMMARY_CHARS
    ? `${serialized.slice(0, MAX_TOOL_SUMMARY_CHARS)}…`
    : serialized;
}
