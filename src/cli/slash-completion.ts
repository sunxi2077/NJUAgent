import type { SlashCommandDescriptor } from "./command.js";

export type SlashCompletionSnapshot = {
  active: boolean;
  prefix: string;
  selectedIndex: number;
  matches: readonly SlashCommandDescriptor[];
};

const DEFAULT_MAX_VISIBLE = 6;
const LEGAL_PREFIX = /^[a-z0-9-]*$/iu;

/**
 * Pure candidate-filtering and selection state machine for the slash palette.
 * Knows nothing about streams, readline, the renderer, or sessions; every
 * public value is a defensive copy.
 */
export class SlashCompletionModel {
  readonly #maxVisible: number;
  #commands: readonly SlashCommandDescriptor[] = [];
  #active = false;
  #prefix = "";
  #selectedIndex = -1;

  constructor(options?: { maxVisible?: number }) {
    const maxVisible = options?.maxVisible ?? DEFAULT_MAX_VISIBLE;
    if (!Number.isInteger(maxVisible) || maxVisible <= 0) {
      throw new RangeError("maxVisible must be a positive integer");
    }
    this.#maxVisible = maxVisible;
  }

  open(commands: readonly SlashCommandDescriptor[]): SlashCompletionSnapshot {
    this.#commands = commands.map((command) => this.#copy(command));
    this.#active = true;
    this.#prefix = "";
    this.#selectedIndex = -1;
    return this.#rebuild();
  }

  updatePrefix(prefix: string): SlashCompletionSnapshot {
    if (!LEGAL_PREFIX.test(prefix)) {
      throw new TypeError(`Illegal slash prefix: ${JSON.stringify(prefix)}`);
    }
    const previous = this.#active && this.#selectedIndex >= 0
      ? this.#matches()[this.#selectedIndex]?.name
      : undefined;
    this.#prefix = prefix;
    return this.#rebuild(previous);
  }

  move(delta: -1 | 1): SlashCompletionSnapshot {
    if (!this.#active || this.#matches().length === 0) {
      return this.snapshot();
    }
    const count = this.#matches().length;
    this.#selectedIndex = (this.#selectedIndex + delta + count) % count;
    return this.snapshot();
  }

  selected(): SlashCommandDescriptor | undefined {
    const matches = this.#matches();
    if (this.#selectedIndex < 0 || this.#selectedIndex >= matches.length) {
      return undefined;
    }
    return this.#copy(matches[this.#selectedIndex]!);
  }

  close(): SlashCompletionSnapshot {
    this.#active = false;
    this.#selectedIndex = -1;
    this.#commands = [];
    return this.snapshot();
  }

  snapshot(): SlashCompletionSnapshot {
    return {
      active: this.#active,
      prefix: this.#prefix,
      selectedIndex: this.#selectedIndex,
      matches: this.#matches().map((command) => this.#copy(command)),
    };
  }

  #matches(): readonly SlashCommandDescriptor[] {
    if (!this.#active) {
      return [];
    }
    const prefix = this.#prefix.toLowerCase();
    return this.#commands
      .filter((command) => command.name.toLowerCase().startsWith(prefix))
      .slice(0, this.#maxVisible);
  }

  #rebuild(previousName?: string): SlashCompletionSnapshot {
    const matches = this.#matches();
    if (matches.length === 0) {
      this.#selectedIndex = -1;
      return this.snapshot();
    }
    const preserved = previousName === undefined
      ? undefined
      : matches.find((command) => command.name === previousName);
    this.#selectedIndex = preserved === undefined
      ? 0
      : matches.indexOf(preserved);
    return this.snapshot();
  }

  #copy(command: SlashCommandDescriptor): SlashCommandDescriptor {
    return {
      name: command.name,
      usage: command.usage,
      description: command.description,
    };
  }
}
