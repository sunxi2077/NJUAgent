import type { SlashCommandDescriptor } from "./command.js";

export type SlashCompletionSnapshot = {
  active: boolean;
  prefix: string;
  selectedIndex: number;
  windowStart: number;
  totalMatches: number;
  matches: readonly SlashCommandDescriptor[];
  visibleMatches: readonly SlashCommandDescriptor[];
};

const DEFAULT_PAGE_SIZE = 6;
const LEGAL_PREFIX = /^[a-z0-9-]*$/iu;

/**
 * Pure candidate-filtering and selection state machine for the slash palette.
 * `matches` holds every prefix match (never truncated); `visibleMatches` is a
 * `pageSize`-sized window around the absolute `selectedIndex`. Knows nothing
 * about streams, readline, the renderer, or sessions; every public value is a
 * defensive copy.
 */
export class SlashCompletionModel {
  readonly #pageSize: number;
  #commands: readonly SlashCommandDescriptor[] = [];
  #active = false;
  #prefix = "";
  #selectedIndex = -1;
  #windowStart = 0;

  constructor(options?: { pageSize?: number }) {
    const pageSize = options?.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(pageSize) || pageSize <= 0) {
      throw new RangeError("pageSize must be a positive integer");
    }
    this.#pageSize = pageSize;
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
    const total = this.#matches().length;
    this.#selectedIndex = (this.#selectedIndex + delta + total) % total;
    this.#fitWindow(total);
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
    this.#windowStart = 0;
    this.#commands = [];
    return this.snapshot();
  }

  snapshot(): SlashCompletionSnapshot {
    const matches = this.#matches().map((command) => this.#copy(command));
    const visibleMatches = matches
      .slice(this.#windowStart, this.#windowStart + this.#pageSize)
      .map((command) => this.#copy(command));
    return {
      active: this.#active,
      prefix: this.#prefix,
      selectedIndex: this.#selectedIndex,
      windowStart: this.#windowStart,
      totalMatches: matches.length,
      matches,
      visibleMatches,
    };
  }

  #matches(): readonly SlashCommandDescriptor[] {
    if (!this.#active) {
      return [];
    }
    const prefix = this.#prefix.toLowerCase();
    return this.#commands.filter((command) =>
      command.name.toLowerCase().startsWith(prefix),
    );
  }

  #rebuild(previousName?: string): SlashCompletionSnapshot {
    const matches = this.#matches();
    if (matches.length === 0) {
      this.#selectedIndex = -1;
      this.#windowStart = 0;
      return this.snapshot();
    }
    const preserved = previousName === undefined
      ? undefined
      : matches.find((command) => command.name === previousName);
    this.#selectedIndex = preserved === undefined
      ? 0
      : matches.indexOf(preserved);
    this.#fitWindow(matches.length);
    return this.snapshot();
  }

  /** Keeps the window anchored so the selected item is always visible. */
  #fitWindow(total: number): void {
    if (total === 0 || this.#selectedIndex < 0) {
      this.#windowStart = 0;
      return;
    }
    if (this.#selectedIndex < this.#windowStart) {
      this.#windowStart = this.#selectedIndex;
    } else if (this.#selectedIndex >= this.#windowStart + this.#pageSize) {
      this.#windowStart = this.#selectedIndex - this.#pageSize + 1;
    }
    this.#windowStart = Math.min(
      this.#windowStart,
      Math.max(0, total - this.#pageSize),
    );
  }

  #copy(command: SlashCommandDescriptor): SlashCommandDescriptor {
    return {
      name: command.name,
      usage: command.usage,
      description: command.description,
    };
  }
}
