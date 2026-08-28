import type { ContextBudget } from "./context-types.js";
import type { Message, ToolResultBlock } from "./messages.js";
import type { ModelToolDefinition } from "../providers/provider.js";

export type EstimateInput = {
  systemPrompt: string;
  messages: readonly Message[];
  tools: readonly ModelToolDefinition[];
  lastInputTokens?: number;
};

export type DeterministicContextView = {
  messages: readonly Message[];
  estimatedTokens: number;
  compactedToolResults: number;
};

// Legacy runner-facing surface kept until the ContextManager integration task.
export type ContextDecision = {
  action: "continue" | "compacted" | "stop";
  messages: readonly Message[];
  estimatedTokens: number;
  compactedToolResults: number;
};

export interface ContextPolicyPort {
  prepare(messages: readonly Message[], lastInputTokens?: number): ContextDecision;
}

function compactedResult(block: ToolResultBlock): ToolResultBlock {
  return {
    ...block,
    content:
      `[older tool output omitted: tool_call_id=${block.toolCallId}, ` +
      `original_bytes=${Buffer.byteLength(block.content, "utf8")}, ` +
      `is_error=${String(block.isError)}]`,
  };
}

/**
 * Deterministic context estimator and transformer. It never calls a
 * Provider, mutates a checkpoint, reads the clock, or writes a Session.
 */
export class ContextPolicy implements ContextPolicyPort {
  constructor(private readonly budget: ContextBudget) {
    if (budget.contextWindowTokens <= 0) {
      throw new Error("contextWindowTokens must be positive");
    }
    if (budget.maxOutputTokens <= 0 || budget.safetyTokens < 0) {
      throw new Error("maxOutputTokens must be positive and safetyTokens non-negative");
    }
    if (budget.compactAtRatio <= 0 || budget.compactAtRatio > 1) {
      throw new Error("compactAtRatio must be in (0, 1]");
    }
    if (budget.recentMessages < 0 || budget.charsPerToken <= 0) {
      throw new Error("recentMessages cannot be negative and charsPerToken must be positive");
    }
    if (this.hardInputTokens() <= 0) {
      throw new Error("The hard input budget must be positive");
    }
  }

  estimate(input: EstimateInput): number {
    const serialized = JSON.stringify({
      system: input.systemPrompt,
      tools: input.tools,
      messages: input.messages,
    });
    const estimate = Math.ceil(serialized.length / this.budget.charsPerToken);
    return Math.max(estimate, input.lastInputTokens ?? 0);
  }

  thresholdTokens(): number {
    return Math.floor(this.budget.contextWindowTokens * this.budget.compactAtRatio);
  }

  hardInputTokens(): number {
    return (
      this.budget.contextWindowTokens -
      this.budget.maxOutputTokens -
      this.budget.safetyTokens
    );
  }

  contextWindowTokens(): number {
    return this.budget.contextWindowTokens;
  }

  prepareDeterministic(input: EstimateInput): DeterministicContextView {
    const estimatedTokens = this.estimate(input);
    if (estimatedTokens < this.thresholdTokens()) {
      return {
        messages: input.messages,
        estimatedTokens,
        compactedToolResults: 0,
      };
    }

    const compactBefore = Math.max(0, input.messages.length - this.budget.recentMessages);
    let compactedToolResults = 0;
    const compacted = input.messages.map((message, index): Message => {
      if (index >= compactBefore || message.role !== "user") {
        return structuredClone(message);
      }
      return {
        role: "user",
        content: message.content.map((block) => {
          if (block.type !== "tool_result") {
            return structuredClone(block);
          }
          compactedToolResults += 1;
          return compactedResult(block);
        }),
      };
    });
    const compactedEstimate = this.estimate({ ...input, messages: compacted });
    return {
      messages: compacted,
      estimatedTokens: compactedEstimate,
      compactedToolResults,
    };
  }

  /**
   * Returns the cut index for semantic compaction: messages before `cut` may
   * be summarized, messages from `cut` on stay verbatim. The cut never splits
   * an assistant tool-call message from its immediately following user
   * tool-result batch, and never moves past `alreadyCovered`.
   */
  selectCompactionCut(
    messages: readonly Message[],
    alreadyCovered: number,
  ): number | null {
    let cut = messages.length - this.budget.recentMessages;
    if (cut <= alreadyCovered) {
      return null;
    }
    while (cut > alreadyCovered) {
      const firstKept = messages[cut];
      if (
        firstKept?.role === "user" &&
        firstKept.content.some((block) => block.type === "tool_result")
      ) {
        cut -= 1;
        continue;
      }
      break;
    }
    if (cut <= alreadyCovered) {
      return null;
    }
    return cut;
  }

  // Legacy adapter used by AgentRunner until the ContextManager integration.
  prepare(messages: readonly Message[], lastInputTokens?: number): ContextDecision {
    const view = this.prepareDeterministic({
      systemPrompt: "",
      messages,
      tools: [],
      ...(lastInputTokens === undefined ? {} : { lastInputTokens }),
    });
    return {
      action: view.compactedToolResults > 0 ? "compacted" : "continue",
      messages: view.messages,
      estimatedTokens: view.estimatedTokens,
      compactedToolResults: view.compactedToolResults,
    };
  }
}
