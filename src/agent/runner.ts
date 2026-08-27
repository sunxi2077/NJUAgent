import type { AgentEventHandler } from "./events.js";
import { ConversationHistory } from "./history.js";
import type { ToolCallBlock, ToolResultBlock } from "./messages.js";
import type { RunResult } from "./result.js";
import type {
  ModelProvider,
  ModelToolDefinition,
  ProviderEvent,
} from "../providers/provider.js";

export interface ToolExecutorPort {
  definitions(): readonly ModelToolDefinition[];
  execute(call: ToolCallBlock, signal: AbortSignal): Promise<ToolResultBlock>;
}

export type AgentRunnerOptions = {
  provider: ModelProvider;
  history: ConversationHistory;
  tools: ToolExecutorPort;
  maxSteps: number;
  systemPrompt: string;
  onEvent?: AgentEventHandler;
};

export class AgentRunner {
  constructor(private readonly options: AgentRunnerOptions) {}

  async run(userText: string, signal: AbortSignal): Promise<RunResult> {
    const startedAt = performance.now();
    let steps = 0;
    let toolCalls = 0;
    this.options.history.appendUserText(userText);

    if (signal.aborted) {
      return this.finish({
        status: "cancelled",
        steps,
        toolCalls,
        durationMs: performance.now() - startedAt,
      });
    }

    steps += 1;
    this.emit({ type: "model_started", step: steps });

    let completed: Extract<ProviderEvent, { type: "message_completed" }> | undefined;
    try {
      const stream = this.options.provider.stream(
        {
          system: this.options.systemPrompt,
          messages: this.options.history.snapshot(),
          tools: this.options.tools.definitions(),
        },
        signal,
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
        if (event.type === "text_delta") {
          this.emit(event);
        } else if (event.type === "usage") {
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
    toolCalls = completed.message.content.filter(
      (block) => block.type === "tool_call",
    ).length;
    this.emit({ type: "model_completed", stopReason: completed.stopReason });

    return this.finish({
      status: "completed",
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
}
