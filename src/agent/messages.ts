export type UserTextBlock = {
  type: "text";
  text: string;
};

export type ToolResultBlock = {
  type: "tool_result";
  toolCallId: string;
  content: string;
  isError: boolean;
};

export type UserBlock = UserTextBlock | ToolResultBlock;

export type AssistantTextBlock = {
  type: "text";
  text: string;
};

export type ToolCallBlock = {
  type: "tool_call";
  id: string;
  name: string;
  input: unknown;
};

export type AssistantBlock = AssistantTextBlock | ToolCallBlock;

export type UserMessage = {
  role: "user";
  content: UserBlock[];
};

export type AssistantMessage = {
  role: "assistant";
  content: AssistantBlock[];
};

export type Message = UserMessage | AssistantMessage;

function toolCalls(message: AssistantMessage): ToolCallBlock[] {
  return message.content.filter(
    (block): block is ToolCallBlock => block.type === "tool_call",
  );
}

function toolResults(message: UserMessage): ToolResultBlock[] {
  return message.content.filter(
    (block): block is ToolResultBlock => block.type === "tool_result",
  );
}

export function assertValidHistory(messages: readonly Message[]): void {
  const knownCallIds = new Set<string>();

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message === undefined) {
      continue;
    }

    if (message.role === "assistant") {
      const calls = toolCalls(message);
      for (const call of calls) {
        if (knownCallIds.has(call.id)) {
          throw new Error(`Duplicate tool-call id: ${call.id}`);
        }
        knownCallIds.add(call.id);
      }

      if (calls.length === 0 || index === messages.length - 1) {
        continue;
      }

      const nextMessage = messages[index + 1];
      if (nextMessage?.role !== "user") {
        throw new Error(`Missing tool results for ${calls[0]?.id ?? "unknown call"}`);
      }

      const results = toolResults(nextMessage);
      if (results.length !== nextMessage.content.length) {
        throw new Error(`Tool result batch for ${calls[0]?.id ?? "unknown call"} contains non-result content`);
      }

      for (let callIndex = 0; callIndex < calls.length; callIndex += 1) {
        const call = calls[callIndex];
        const result = results[callIndex];
        if (call === undefined) {
          continue;
        }
        if (result === undefined) {
          throw new Error(`Missing tool result for ${call.id}`);
        }
        if (result.toolCallId !== call.id) {
          throw new Error(
            `Tool result order mismatch: received ${result.toolCallId}, expected ${call.id}`,
          );
        }
      }

      if (results.length > calls.length) {
        const extra = results[calls.length];
        throw new Error(`Unexpected tool result: ${extra?.toolCallId ?? "unknown result"}`);
      }

      index += 1;
      continue;
    }

    for (const result of toolResults(message)) {
      throw new Error(`Unexpected tool result without preceding call: ${result.toolCallId}`);
    }
  }
}
