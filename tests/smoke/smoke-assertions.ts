import type { Message } from "../../src/agent/messages.js";

/**
 * Inspects a smoke-test conversation and returns booleans only. It never
 * returns response text, tool content, request headers, or environment
 * values, so the smoke gate cannot leak local data.
 */
export function inspectSmokeHistory(messages: readonly Message[]): {
  hasAssistantText: boolean;
  hasSuccessfulRead: boolean;
} {
  const readCallIds = new Set<string>();
  let hasAssistantText = false;
  let hasSuccessfulRead = false;

  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "text" && block.text.trim() !== "") {
          hasAssistantText = true;
        }
        if (block.type === "tool_call" && block.name === "read_file") {
          readCallIds.add(block.id);
        }
      }
      continue;
    }
    for (const block of message.content) {
      if (
        block.type === "tool_result" &&
        readCallIds.has(block.toolCallId) &&
        !block.isError
      ) {
        hasSuccessfulRead = true;
      }
    }
  }
  return { hasAssistantText, hasSuccessfulRead };
}
