import type { AgentEventHandler } from "./events.js";
import type { ContextPrepareInput, PreparedContext } from "./context-types.js";
import { ConversationHistory } from "./history.js";
import type { ToolCallBlock, ToolResultBlock } from "./messages.js";
import type { RunResult } from "./result.js";
import type { StopGate, StopGateDecision } from "./stop-gate.js";
import type {
  ModelProvider,
  ModelToolDefinition,
  ProviderEvent,
} from "../providers/provider.js";
import { ProviderError } from "../providers/provider.js";
import { withModelRetry, type RetryPolicy } from "../providers/retry.js";

/** Extra retries granted for output-limit truncation before giving up. */
const MAX_OUTPUT_RECOVERIES = 2;
const OUTPUT_RECOVERY_NOTE =
  "Your previous reply ended before producing a usable result (the model hit " +
  "its output token limit or returned nothing). Continue the task now. If you " +
  "were writing a file, keep every single write small enough to finish in one " +
  "reply: write a skeleton first, then fill it in with separate edit_file " +
  "calls. Do not repeat work that already completed.";

function isOutputLimitError(error: unknown): error is ProviderError {
  return error instanceof ProviderError && error.kind === "output_limit";
}

export type ToolPortResult = ToolResultBlock & { durationMs?: number };

export interface ToolExecutorPort {
  definitions(): readonly ModelToolDefinition[];
  execute(
    call: ToolCallBlock,
    signal: AbortSignal,
  ): Promise<ToolPortResult>;
}

export interface ContextManagerPort {
  prepare(input: ContextPrepareInput): Promise<PreparedContext>;
  recordUsage(inputTokens: number): void;
}

export type AgentRunnerOptions = {
  provider: ModelProvider;
  history: ConversationHistory;
  tools: ToolExecutorPort;
  maxSteps: number;
  systemPrompt: string;
  /** Dynamic prompt source (e.g. the active Skill layer) read every step. */
  systemPromptProvider?: () => string;
  contextManager?: ContextManagerPort;
  retryPolicy?: RetryPolicy;
  stopGate?: StopGate;
  onEvent?: AgentEventHandler;
};

export class AgentRunner {
  constructor(private readonly options: AgentRunnerOptions) {}

  async run(userText: string, signal: AbortSignal): Promise<RunResult> {
    const startedAt = performance.now();
    let steps = 0;
    let toolCalls = 0;
    let lastInputTokens: number | undefined;
    // Output-limit truncation (max_tokens mid-tool-call or an empty reply) is
    // recovered in place: retry with a smaller-step note instead of failing.
    let outputRecoveries = 0;
    let recoveryNote: string | undefined;
    const historyBeforeRun = this.options.history.snapshot();
    this.options.stopGate?.beginRun?.();
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
      let context: PreparedContext;
      if (this.options.contextManager === undefined) {
        context = {
          action: "continue",
          systemPrompt: this.options.systemPrompt,
          messages: historySnapshot,
          estimatedTokens: 0,
          compactedToolResults: 0,
        };
      } else {
        try {
          context = await this.options.contextManager.prepare({
            baseSystemPrompt:
              this.options.systemPromptProvider?.() ?? this.options.systemPrompt,
            messages: historySnapshot,
            tools: this.options.tools.definitions(),
            signal,
          });
        } catch (error) {
          if (signal.aborted) {
            return this.finish({
              status: "cancelled",
              steps,
              toolCalls,
              durationMs: performance.now() - startedAt,
            });
          }
          this.emit({
            type: "context_warning",
            message: error instanceof Error ? error.message : String(error),
          });
          return this.finish({
            status: "internal_failed",
            message: "Context preparation failed before the model request.",
            steps,
            toolCalls,
            durationMs: performance.now() - startedAt,
          });
        }
      }
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
        const system = recoveryNote === undefined
          ? context.systemPrompt
          : `${context.systemPrompt}\n\n${recoveryNote}`;
        // The recovery note applies only to the retried request.
        recoveryNote = undefined;
        const request = {
          system,
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
            this.options.contextManager?.recordUsage(event.inputTokens);
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
        if (isOutputLimitError(error) && outputRecoveries < MAX_OUTPUT_RECOVERIES) {
          outputRecoveries += 1;
          recoveryNote = OUTPUT_RECOVERY_NOTE;
          this.emit({
            type: "retrying",
            attempt: outputRecoveries,
            delayMs: 0,
            reason: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        this.options.history.replace(historyBeforeRun);
        return this.finish({
          status: "model_failed",
          message: error instanceof Error ? error.message : String(error),
          steps,
          toolCalls,
          durationMs: performance.now() - startedAt,
        });
      }

      if (completed === undefined) {
        this.options.history.replace(historyBeforeRun);
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
        if (this.options.stopGate === undefined) {
          return this.finish({
            status: "completed",
            steps,
            toolCalls,
            durationMs: performance.now() - startedAt,
          });
        }
        let decision: StopGateDecision;
        try {
          decision = await this.options.stopGate.evaluate({
            messages: this.options.history.snapshot(),
            signal,
          });
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
            status: "internal_failed",
            message: error instanceof Error ? error.message : String(error),
            steps,
            toolCalls,
            durationMs: performance.now() - startedAt,
          });
        }
        if (decision.action === "continue") {
          this.options.history.appendUserText(decision.feedback);
          continue;
        }
        if (decision.action === "fail") {
          return this.finish({
            status: "internal_failed",
            message: decision.message,
            steps,
            toolCalls,
            durationMs: performance.now() - startedAt,
          });
        }
        if (decision.outcome === "verified" && decision.verification !== undefined) {
          return this.finish({
            status: "goal_verified",
            verification: decision.verification,
            steps,
            toolCalls,
            durationMs: performance.now() - startedAt,
          });
        }
        if (decision.outcome === "incomplete" && decision.verification !== undefined) {
          return this.finish({
            status: "goal_incomplete",
            verification: decision.verification,
            steps,
            toolCalls,
            durationMs: performance.now() - startedAt,
          });
        }
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
