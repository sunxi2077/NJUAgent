import { describe, expect, test } from "vitest";

import { LiveOutputLimiter } from "../../../src/cli/output-limiter.js";

describe("LiveOutputLimiter", () => {
  test("limits each tool call independently and announces suppression once", () => {
    const limiter = new LiveOutputLimiter(5);
    expect(limiter.consume("a", "abc")).toEqual({
      text: "abc",
      suppressionStarted: false,
    });
    expect(limiter.consume("a", "def")).toEqual({
      text: "de",
      suppressionStarted: true,
    });
    expect(limiter.consume("a", "more")).toEqual({
      text: "",
      suppressionStarted: false,
    });
    expect(limiter.consume("b", "xyz")).toEqual({
      text: "xyz",
      suppressionStarted: false,
    });
  });

  test("never returns a broken UTF-8 character", () => {
    const limiter = new LiveOutputLimiter(4);
    const result = limiter.consume("a", "你a好");
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(4);
    expect(result.text).toBe("你a");
    expect(result.suppressionStarted).toBe(true);
  });

  test("forgets completed call state", () => {
    const limiter = new LiveOutputLimiter(2);
    limiter.consume("a", "abcd");
    limiter.finish("a");
    expect(limiter.consume("a", "xy")).toEqual({
      text: "xy",
      suppressionStarted: false,
    });
  });
});
