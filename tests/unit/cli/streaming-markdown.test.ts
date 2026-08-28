import { describe, expect, test } from "vitest";
import { stripVTControlCharacters } from "node:util";

import { createTheme } from "../../../src/cli/theme.js";
import { StreamingMarkdownRenderer } from "../../../src/cli/streaming-markdown.js";

function render(chunks: string[]): { raw: string; visible: string } {
  const renderer = new StreamingMarkdownRenderer(createTheme({ enabled: true }));
  const raw = chunks.map((chunk) => renderer.push(chunk).text).join("") + renderer.flush().text;
  return { raw, visible: stripVTControlCharacters(raw) };
}

describe("StreamingMarkdownRenderer", () => {
  test("streams ordinary text before completion", () => {
    const renderer = new StreamingMarkdownRenderer(createTheme({ enabled: true }));
    expect(renderer.push("hello").text).toContain("hello");
  });

  test.each([
    [["**important**"]],
    [["*", "*important*", "*"]],
    [["**impor", "tant", "**"]],
  ])("renders fragmented bold without visible delimiters", (chunks) => {
    const result = render(chunks);
    expect(result.visible).toBe("important");
    expect(result.raw).toContain("\x1b[");
  });

  test("renders italic, inline code and a non-clickable link", () => {
    const result = render(["Use *small* and `npm test`; read [docs](https://example.com)."]);
    expect(result.visible).toBe("Use small and npm test; read docs (https://example.com).");
    expect(result.visible).not.toContain("`");
    expect(result.visible).not.toContain("*");
  });

  test("bounds an incomplete link candidate and flushes it as readable text", () => {
    const renderer = new StreamingMarkdownRenderer(createTheme({ enabled: true }));
    const prefix = renderer.push("[" + "x".repeat(2048)).text;
    const suffix = renderer.flush().text;
    expect(stripVTControlCharacters(prefix + suffix)).toBe("[" + "x".repeat(2048));
  });

  test("flush closes state and the next segment starts clean", () => {
    const renderer = new StreamingMarkdownRenderer(createTheme({ enabled: true }));
    const first = renderer.push("**open").text + renderer.flush().text;
    renderer.reset();
    const second = renderer.push("plain").text + renderer.flush().text;
    expect(stripVTControlCharacters(first)).toContain("open");
    expect(stripVTControlCharacters(second)).toBe("plain");
  });

  test("common chunk partitions have identical visible output", () => {
    const source = "中文 **重点** 与 `代码` 😀\n";
    const expected = render([source]).visible;
    expect(render([...source]).visible).toBe(expected);
    expect(render([source.slice(0, 3), source.slice(3, 8), source.slice(8)]).visible).toBe(expected);
  });

  test("reports whether the rendered cursor is inside a line", () => {
    const renderer = new StreamingMarkdownRenderer(createTheme({ enabled: true }));
    expect(renderer.push("hello").lineOpen).toBe(true);
    expect(renderer.push("\n").lineOpen).toBe(false);
  });
});
