import { buildSystemPrompt } from "./system-prompt.js";
import type { CompactorPort } from "./compactor.js";
import {
  type ContextCheckpoint,
  type ContextState,
  type ContextStatus,
  type PreparedContext,
} from "./context-types.js";
import { ContextPolicy, type DeterministicContextView } from "./context-policy.js";
import { AppError } from "../errors/app-error.js";
import type { Message } from "./messages.js";
import type { ModelToolDefinition } from "../providers/provider.js";

export type ContextPrepareInput = {
  baseSystemPrompt: string;
  messages: readonly Message[];
  tools: readonly ModelToolDefinition[];
  signal: AbortSignal;
};

export type ContextManagerOptions = {
  policy: ContextPolicy;
  compactor: CompactorPort;
  initialState?: ContextState;
  clock?: () => Date;
};

const NOTHING_TO_COMPACT = "Nothing to compact yet.";

/**
 * Async context state machine around the deterministic ContextPolicy.
 * Checkpoints are committed only after a validated candidate view is built,
 * so a failed or cancelled compaction leaves the previous checkpoint intact.
 */
export class ContextManager {
  readonly #policy: ContextPolicy;
  readonly #compactor: CompactorPort;
  readonly #clock: () => Date;
  #state: ContextState;

  constructor(options: ContextManagerOptions) {
    this.#policy = options.policy;
    this.#compactor = options.compactor;
    this.#clock = options.clock ?? (() => new Date());
    this.#state = options.initialState ?? { compactionCount: 0 };
  }

  recordUsage(inputTokens: number): void {
    this.#state.lastInputTokens = inputTokens;
  }

  state(): ContextState {
    return structuredClone(this.#state);
  }

  status(input: Omit<ContextPrepareInput, "signal">): ContextStatus {
    const systemPrompt = this.#systemPromptWithSummary(input.baseSystemPrompt);
    const estimatedTokens = this.#policy.estimate({
      systemPrompt,
      messages: input.messages,
      tools: input.tools,
    });
    return {
      estimatedTokens,
      thresholdTokens: this.#policy.thresholdTokens(),
      hardInputTokens: this.#policy.hardInputTokens(),
      contextWindowTokens: this.#policy.contextWindowTokens(),
      coveredMessageCount: this.#state.checkpoint?.coveredMessageCount ?? 0,
      totalMessageCount: input.messages.length,
      compactionCount: this.#state.compactionCount,
      ...(this.#state.lastInputTokens === undefined
        ? {}
        : { lastInputTokens: this.#state.lastInputTokens }),
    };
  }

  async prepare(input: ContextPrepareInput): Promise<PreparedContext> {
    const systemPrompt = this.#systemPromptWithSummary(input.baseSystemPrompt);
    const estimate = this.#policy.estimate({
      systemPrompt,
      messages: input.messages,
      tools: input.tools,
    });
    if (estimate < this.#policy.thresholdTokens()) {
      return {
        action: "continue",
        systemPrompt,
        messages: input.messages,
        estimatedTokens: estimate,
        compactedToolResults: 0,
      };
    }

    const deterministic = this.#policy.prepareDeterministic({
      systemPrompt,
      messages: input.messages,
      tools: input.tools,
    });
    if (deterministic.estimatedTokens < this.#policy.thresholdTokens()) {
      return {
        action: "continue",
        systemPrompt,
        messages: deterministic.messages,
        estimatedTokens: deterministic.estimatedTokens,
        compactedToolResults: deterministic.compactedToolResults,
      };
    }

    return this.#semanticCompact(input, systemPrompt, estimate, deterministic, undefined);
  }

  async compactNow(
    input: ContextPrepareInput & { focus?: string },
  ): Promise<PreparedContext> {
    const systemPrompt = this.#systemPromptWithSummary(input.baseSystemPrompt);
    const estimate = this.#policy.estimate({
      systemPrompt,
      messages: input.messages,
      tools: input.tools,
    });
    return this.#semanticCompact(input, systemPrompt, estimate, undefined, input.focus);
  }

  async #semanticCompact(
    input: ContextPrepareInput,
    systemPrompt: string,
    estimate: number,
    deterministic: DeterministicContextView | undefined,
    focus: string | undefined,
  ): Promise<PreparedContext> {
    const oldCovered = this.#state.checkpoint?.coveredMessageCount ?? 0;
    const cut = this.#policy.selectCompactionCut(input.messages, oldCovered);
    if (cut === null) {
      return {
        action: "continue",
        systemPrompt,
        messages: deterministic?.messages ?? input.messages,
        estimatedTokens: estimate,
        compactedToolResults: deterministic?.compactedToolResults ?? 0,
        reason: NOTHING_TO_COMPACT,
      };
    }

    let summary: string;
    try {
      summary = await this.#compactor.compact({
        ...(this.#state.checkpoint === undefined
          ? {}
          : { previousSummary: this.#state.checkpoint.summary }),
        messages: input.messages.slice(oldCovered, cut),
        ...(focus === undefined ? {} : { focus }),
        signal: input.signal,
      });
    } catch (error) {
      // Rollback: nothing was committed; continue below the hard limit or stop.
      if (estimate < this.#policy.hardInputTokens()) {
        return {
          action: "continue",
          systemPrompt,
          messages: deterministic?.messages ?? input.messages,
          estimatedTokens: estimate,
          compactedToolResults: deterministic?.compactedToolResults ?? 0,
          reason: `Automatic compaction failed (${error instanceof Error ? error.message : String(error)}); continuing with the current view.`,
        };
      }
      return {
        action: "stop",
        systemPrompt,
        messages: deterministic?.messages ?? input.messages,
        estimatedTokens: estimate,
        compactedToolResults: deterministic?.compactedToolResults ?? 0,
        reason: `Automatic compaction failed and the request exceeds the hard input budget.`,
      };
    }

    if (summary.trim() === "") {
      throw new AppError({
        code: "COMPACTION_FAILED",
        userMessage: "The summarizer returned an empty summary.",
      });
    }
    if (cut <= oldCovered) {
      throw new AppError({
        code: "COMPACTION_FAILED",
        userMessage: "Compaction coverage must increase monotonically.",
      });
    }

    // Commit-after-validate: build the candidate checkpoint and view first.
    const candidate: ContextCheckpoint = {
      summary,
      coveredMessageCount: cut,
      createdAt: this.#clock().toISOString(),
      sourceEstimatedTokens: estimate,
    };
    const candidateSystemPrompt = this.#systemPromptWithSummary(
      input.baseSystemPrompt,
      summary,
    );
    const candidateMessages = input.messages.slice(cut);
    const candidateEstimate = this.#policy.estimate({
      systemPrompt: candidateSystemPrompt,
      messages: candidateMessages,
      tools: input.tools,
    });

    this.#state.checkpoint = candidate;
    this.#state.compactionCount += 1;

    if (candidateEstimate > this.#policy.hardInputTokens()) {
      return {
        action: "stop",
        systemPrompt: candidateSystemPrompt,
        messages: candidateMessages,
        estimatedTokens: candidateEstimate,
        compactedToolResults: deterministic?.compactedToolResults ?? 0,
        checkpoint: candidate,
        reason: "The context still exceeds the hard input budget after compaction.",
      };
    }

    return {
      action: "compacted",
      systemPrompt: candidateSystemPrompt,
      messages: candidateMessages,
      estimatedTokens: candidateEstimate,
      compactedToolResults: deterministic?.compactedToolResults ?? 0,
      checkpoint: candidate,
    };
  }

  #systemPromptWithSummary(
    baseSystemPrompt: string,
    summary?: string,
  ): string {
    const active = summary ?? this.#state.checkpoint?.summary;
    if (active === undefined || active === "") {
      return baseSystemPrompt;
    }
    return `${baseSystemPrompt}\n\n<conversation_summary>\n${active}\n</conversation_summary>`;
  }
}
