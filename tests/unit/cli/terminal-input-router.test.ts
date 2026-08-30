import { describe, expect, test, vi } from "vitest";
import { EventEmitter, Readable } from "node:stream";

import { TerminalInputRouter } from "../../../src/cli/terminal-input-router.js";
import type { TerminalKey } from "../../../src/cli/terminal-input-router.js";

class FakeSource extends Readable {
  isTTY = true;
  readonly rawModes: boolean[] = [];
  readonly keypressListeners: Array<(...args: unknown[]) => void> = [];
  override destroyed = false;
  override closed = false;

  constructor() {
    super({ read() {} });
  }

  setRawMode(mode: boolean): this {
    this.rawModes.push(mode);
    return this;
  }

  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    if (event === "keypress") {
      this.keypressListeners.push(listener);
    }
    return super.on(event, listener);
  }

  override removeListener(event: string | symbol, listener: (...args: any[]) => void): this {
    if (event === "keypress") {
      const index = this.keypressListeners.indexOf(listener);
      if (index >= 0) {
        this.keypressListeners.splice(index, 1);
      }
    }
    return super.removeListener(event, listener);
  }

  emitKey(text: string, key: TerminalKey): void {
    for (const listener of [...this.keypressListeners]) {
      listener(text, key);
    }
  }
}

function key(overrides: Partial<TerminalKey> = {}): TerminalKey {
  return { sequence: "x", ctrl: false, meta: false, shift: false, ...overrides };
}

function makeRouter() {
  const source = new FakeSource();
  const router = new TerminalInputRouter(source);
  const received: string[] = [];
  const sink = router.readlineInput;
  const onData = (chunk: Buffer | string) => {
    received.push(chunk.toString());
  };
  sink.on("data", onData);
  return { source, router, received, onData };
}

describe("TerminalInputRouter", () => {
  test("forwards a sequence exactly once when no handler is set", () => {
    const { source, received } = makeRouter();
    source.emitKey("a", key({ sequence: "a" }));
    expect(received).toEqual(["a"]);
  });

  test("forwards once when the handler returns forward", () => {
    const { source, router, received } = makeRouter();
    router.setHandler(() => "forward");
    source.emitKey("b", key({ sequence: "b" }));
    expect(received).toEqual(["b"]);
  });

  test("does not forward a consumed sequence", () => {
    const { source, router, received } = makeRouter();
    router.setHandler(() => "consume");
    source.emitKey("\x1b[B", key({ sequence: "\x1b[B", name: "down" }));
    expect(received).toEqual([]);
  });

  test("falls back to text when sequence is empty", () => {
    const { source, received } = makeRouter();
    source.emitKey("字", key({ sequence: "" }));
    expect(received).toEqual(["字"]);
  });

  test("ignores when both sequence and text are empty", () => {
    const { source, received } = makeRouter();
    source.emitKey("", key({ sequence: "" }));
    expect(received).toEqual([]);
  });

  test("a throwing handler forwards the current sequence and disables itself", () => {
    const { source, router, received } = makeRouter();
    let calls = 0;
    router.setHandler(() => {
      calls += 1;
      throw new Error("handler exploded");
    });
    source.emitKey("a", key({ sequence: "a" }));
    source.emitKey("b", key({ sequence: "b" }));
    expect(received).toEqual(["a", "b"]);
    expect(calls).toBe(1);
  });

  test("readlineInput exposes the source isTTY value", () => {
    const { source, router } = makeRouter();
    expect((router.readlineInput as { isTTY?: boolean }).isTTY).toBe(source.isTTY);
    source.isTTY = false;
    expect((router.readlineInput as { isTTY?: boolean }).isTTY).toBe(false);
  });

  test("setRawMode proxies to the source and returns the proxy", () => {
    const { source, router } = makeRouter();
    const proxy = router.readlineInput as unknown as { setRawMode: (mode: boolean) => unknown };
    const returned = proxy.setRawMode(true);
    expect(source.rawModes).toEqual([true]);
    expect(returned).toBe(router.readlineInput);
  });

  test("close removes the keypress listener and ends the proxy without closing the source", () => {
    const { source, router, received } = makeRouter();
    router.setHandler(() => "forward");
    router.close();
    expect(source.keypressListeners).toHaveLength(0);
    source.emitKey("a", key({ sequence: "a" }));
    expect(received).toEqual([]);
    expect(source.closed).toBe(false);
    expect(source.destroyed).toBe(false);
  });

  test("repeated close is idempotent", () => {
    const { router } = makeRouter();
    expect(() => {
      router.close();
      router.close();
    }).not.toThrow();
  });

  test("forwards control, arrow, and pasted CJK sequences unmodified", () => {
    const { source, router, received } = makeRouter();
    router.setHandler((_text, terminalKey) =>
      terminalKey.name === "down" ? "consume" : "forward",
    );
    source.emitKey("\x03", key({ sequence: "\x03", ctrl: true, name: "c" }));
    source.emitKey("\x1b[B", key({ sequence: "\x1b[B", name: "down" }));
    source.emitKey("/goal 完成测试", key({ sequence: "/goal 完成测试" }));
    expect(received).toEqual(["\x03", "/goal 完成测试"]);
  });
});
