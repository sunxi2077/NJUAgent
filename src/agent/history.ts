import {
  assertValidHistory,
  type AssistantMessage,
  type Message,
  type ToolResultBlock,
  type UserMessage,
} from "./messages.js";

export class ConversationHistory {
  readonly #messages: Message[] = [];

  appendUserText(text: string): void {
    this.append({ role: "user", content: [{ type: "text", text }] });
  }

  appendAssistant(message: AssistantMessage): void {
    this.append(message);
  }

  appendToolResults(results: readonly ToolResultBlock[]): void {
    this.append({ role: "user", content: [...results] });
  }

  snapshot(): Message[] {
    return structuredClone(this.#messages);
  }

  private append(message: UserMessage | AssistantMessage): void {
    const candidate = [...this.#messages, structuredClone(message)];
    assertValidHistory(candidate);
    this.#messages.push(structuredClone(message));
  }
}
