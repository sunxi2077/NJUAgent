import { emitKeypressEvents, type Key } from "node:readline";
import { PassThrough } from "node:stream";

export type TerminalKey = {
  sequence: string;
  name?: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
};

export type TerminalKeyDecision = "forward" | "consume";

export type TerminalKeyHandler = (
  text: string,
  key: TerminalKey,
) => TerminalKeyDecision;

export interface TerminalInputRouterPort {
  readonly readlineInput: NodeJS.ReadableStream;
  setHandler(handler: TerminalKeyHandler | undefined): void;
  close(): void;
}

/**
 * Readable proxy handed to `node:readline`. It exposes the real source's
 * `isTTY`, proxies `setRawMode` back to the source, and receives forwarded
 * bytes. `close()` ends the proxy without closing the real stdin.
 */
class RoutedReadStream extends PassThrough {
  readonly #source: NodeJS.ReadableStream;

  constructor(source: NodeJS.ReadableStream) {
    super();
    this.#source = source;
  }

  get isTTY(): boolean {
    return (this.#source as { isTTY?: boolean }).isTTY === true;
  }

  setRawMode(mode: boolean): this {
    const setter = (this.#source as { setRawMode?: (value: boolean) => unknown })
      .setRawMode;
    setter?.call(this.#source, mode);
    return this;
  }
}

/**
 * The only byte channel between real stdin and readline. Listens for
 * `keypress` events on the source, asks the installed handler whether the key
 * belongs to the slash palette, and either forwards the raw sequence to the
 * readline proxy or consumes it. In normal mode every sequence is forwarded
 * verbatim; readline never sees a consumed key.
 */
export class TerminalInputRouter implements TerminalInputRouterPort {
  readonly #source: NodeJS.ReadableStream;
  readonly #readlineInput: RoutedReadStream;
  readonly #onKeypress: (text: string, key?: Key) => void;
  #handler: TerminalKeyHandler | undefined;

  constructor(source: NodeJS.ReadableStream) {
    this.#source = source;
    this.#readlineInput = new RoutedReadStream(source);
    this.#onKeypress = (text, rawKey) => this.#route(text, rawKey);
    emitKeypressEvents(source);
    source.on("keypress", this.#onKeypress);
  }

  get readlineInput(): NodeJS.ReadableStream {
    return this.#readlineInput;
  }

  setHandler(handler: TerminalKeyHandler | undefined): void {
    this.#handler = handler;
  }

  close(): void {
    this.#source.removeListener("keypress", this.#onKeypress);
    this.#handler = undefined;
    if (!this.#readlineInput.destroyed) {
      this.#readlineInput.end();
    }
  }

  #route(text: string, rawKey?: Key): void {
    const key: TerminalKey = {
      sequence: typeof rawKey?.sequence === "string" ? rawKey.sequence : "",
      ...(rawKey?.name === undefined ? {} : { name: rawKey.name }),
      ctrl: rawKey?.ctrl === true,
      meta: rawKey?.meta === true,
      shift: rawKey?.shift === true,
    };
    const sequence = key.sequence !== "" ? key.sequence : text;
    if (sequence === "") {
      return;
    }
    const handler = this.#handler;
    if (handler === undefined) {
      this.#forward(sequence);
      return;
    }
    try {
      const decision = handler(text, key);
      if (decision !== "consume") {
        this.#forward(sequence);
      }
    } catch {
      // A broken palette must never trap user input: disable the handler and
      // forward this sequence; do not log raw input.
      this.#handler = undefined;
      this.#forward(sequence);
    }
  }

  #forward(sequence: string): void {
    if (!this.#readlineInput.destroyed) {
      this.#readlineInput.write(sequence);
    }
  }
}
