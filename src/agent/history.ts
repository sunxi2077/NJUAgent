import {
  assertValidHistory,
  type AssistantMessage,
  type Message,
  type ToolResultBlock,
  type UserMessage,
} from "./messages.js";

export class ConversationHistory {
  readonly #messages: Message[] = [];

  static from(messages: readonly Message[]): ConversationHistory {
    const history = new ConversationHistory();
    history.replace(messages);
    return history;
  }

  get length(): number {
    return this.#messages.length;
  }

  appendUserText(text: string): void {
    this.append({ role: "user", content: [{ type: "text", text }] });
  }

  appendAssistant(message: AssistantMessage): void {
    this.append(message);
  }

  appendToolResults(results: readonly ToolResultBlock[]): void {
    this.append({ role: "user", content: [...results] });
  }

  /** Validates a candidate set first; never partially replaces on failure. */
  replace(messages: readonly Message[]): void {
    const candidate = structuredClone(messages);
    assertValidHistory(candidate);
    this.#messages.splice(0, this.#messages.length, ...candidate);
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
