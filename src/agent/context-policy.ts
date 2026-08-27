import type { Message, ToolResultBlock } from "./messages.js";

export type ContextDecision = {
  action: "continue" | "compacted" | "stop";
  messages: readonly Message[];
  estimatedTokens: number;
  compactedToolResults: number;
};

export type ContextPolicyOptions = {
  maxEstimatedTokens: number;
  compactAtRatio: number;
  recentMessages: number;
  charsPerToken: number;
};

export interface ContextPolicyPort {
  prepare(messages: readonly Message[], lastInputTokens?: number): ContextDecision;
}

function estimateTokens(messages: readonly Message[], charsPerToken: number): number {
  return Math.ceil(JSON.stringify(messages).length / charsPerToken);
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

export class ContextPolicy implements ContextPolicyPort {
  constructor(private readonly options: ContextPolicyOptions) {
    if (options.maxEstimatedTokens <= 0) {
      throw new Error("maxEstimatedTokens must be positive");
    }
    if (options.compactAtRatio <= 0 || options.compactAtRatio > 1) {
      throw new Error("compactAtRatio must be in (0, 1]");
    }
    if (options.recentMessages < 0 || options.charsPerToken <= 0) {
      throw new Error("recentMessages cannot be negative and charsPerToken must be positive");
    }
  }

  prepare(messages: readonly Message[], lastInputTokens?: number): ContextDecision {
    const estimatedTokens = Math.max(
      estimateTokens(messages, this.options.charsPerToken),
      lastInputTokens ?? 0,
    );
    if (estimatedTokens < this.options.maxEstimatedTokens * this.options.compactAtRatio) {
      return {
        action: "continue",
        messages,
        estimatedTokens,
        compactedToolResults: 0,
      };
    }

    const compactBefore = Math.max(0, messages.length - this.options.recentMessages);
    let compactedToolResults = 0;
    const compacted = messages.map((message, index): Message => {
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
    const compactedEstimate = estimateTokens(compacted, this.options.charsPerToken);
    if (compactedEstimate > this.options.maxEstimatedTokens) {
      return {
        action: "stop",
        messages: compacted,
        estimatedTokens: compactedEstimate,
        compactedToolResults,
      };
    }
    return {
      action: compactedToolResults > 0 ? "compacted" : "continue",
      messages: compactedToolResults > 0 ? compacted : messages,
      estimatedTokens: compactedEstimate,
      compactedToolResults,
    };
  }
}
