import type { CommandContext, RouteResult, SlashCommand } from "./command.js";

/**
 * Parses one line of input into either ordinary agent text or a locally
 * handled slash command. Command names are lowercased; `//text` escapes to
 * `/text`; unknown commands are reported without ever reaching the model.
 */
export class SlashCommandRouter {
  readonly #commands = new Map<string, SlashCommand>();

  register(command: SlashCommand): void {
    const name = command.name.toLowerCase();
    if (this.#commands.has(name)) {
      throw new Error(`Duplicate command name: ${name}`);
    }
    this.#commands.set(name, command);
  }

  commands(): SlashCommand[] {
    return [...this.#commands.values()];
  }

  async route(text: string, context: CommandContext): Promise<RouteResult> {
    if (!text.startsWith("/")) {
      return { kind: "not_command", text };
    }
    if (text.startsWith("//")) {
      return { kind: "not_command", text: text.slice(1) };
    }

    const remainder = text.slice(1);
    const match = /^([^\s]*)(?:\s*)([\s\S]*)$/u.exec(remainder);
    const name = (match?.[1] ?? "").toLowerCase();
    if (name === "") {
      return { kind: "handled", stateChanged: false };
    }

    const command = this.#commands.get(name);
    if (command === undefined) {
      context.renderer.error(`Unknown command "/${name}". Type /help.`);
      return { kind: "handled", stateChanged: false };
    }

    const args = (match?.[2] ?? "").trim();
    const result = await command.execute(args, context);
    if (result.kind === "exit") {
      return { kind: "exit" };
    }
    return { kind: "handled", stateChanged: result.stateChanged };
  }
}
