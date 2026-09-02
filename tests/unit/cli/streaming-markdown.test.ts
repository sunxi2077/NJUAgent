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

  test("renders headings, lists and quotes", () => {
    const result = render([
      "## 主要问题\n",
      "- first\n",
      "* second\n",
      "1. numbered\n",
      "> quoted\n",
      "### Smaller\n",
    ]);
    expect(result.visible).toBe([
      "主要问题",
      "────────",
      "• first",
      "• second",
      "1. numbered",
      "│ quoted",
      "Smaller",
      "",
    ].join("\n"));
  });

  test("renders fragmented fenced code without parsing markdown inside", () => {
    const result = render([
      "`", "``ts\n",
      "const value = **raw**;\n",
      "`", "``\n",
    ]);
    expect(result.visible).toBe("  │ const value = **raw**;\n");
    expect(result.visible).not.toContain("```ts");
  });

  test("flushes an unclosed fence and resets for the next segment", () => {
    const renderer = new StreamingMarkdownRenderer(createTheme({ enabled: true }));
    const first = renderer.push("```\ncode").text + renderer.flush().text;
    renderer.reset();
    const second = renderer.push("plain").text + renderer.flush().text;
    expect(stripVTControlCharacters(first)).toBe("  │ code");
    expect(stripVTControlCharacters(second)).toBe("plain");
  });

  test("caps synthesized heading dividers at 24 cells", () => {
    const visible = render(["# " + "x".repeat(40) + "\n"]).visible;
    expect(visible).toBe("x".repeat(40) + "\n" + "─".repeat(24) + "\n");
  });

  test("preserves a hash that is not followed by a heading space", () => {
    expect(render(["#not-a-heading\n"]).visible).toBe("#not-a-heading\n");
  });

  test.each([1, 2, 3, 4, 5, 6])("renders heading level %i without raw hashes", (level) => {
    const visible = render([`${"#".repeat(level)} Heading\n`]).visible;
    expect(visible.startsWith("Heading\n")).toBe(true);
    expect(visible).not.toContain("#");
    expect(visible.includes("───────\n")).toBe(level <= 2);
  });

  test.each([
    { chunks: ["#", "# Title\n"], expected: "Title\n─────\n" },
    { chunks: ["-", " item\n"], expected: "• item\n" },
    { chunks: ["1", ". item\n"], expected: "1. item\n" },
    { chunks: [">", " quote\n"], expected: "│ quote\n" },
    { chunks: ["`", "`", "`js\ncode\n", "```\n"], expected: "  │ code\n" },
  ])("recognizes $chunks across block-prefix chunk boundaries", ({ chunks, expected }) => {
    expect(render(chunks).visible).toBe(expected);
  });

  test("markdown links become OSC 8 hyperlinks when the theme is enabled", () => {
    const result = render(["Read [the docs](https://nodejs.org/api/abort.html) now."]);
    expect(result.visible).toBe("Read the docs (https://nodejs.org/api/abort.html) now.");
    expect(result.raw).toContain("\x1b]8;;https://nodejs.org/api/abort.html\x1b\\");
    expect(result.raw).toContain("\x1b]8;;\x1b\\");
    // Exactly one opener and one closer beyond the plain suffix URL.
    expect(result.raw.split("\x1b]8;;")).toHaveLength(3);
  });

  test("a disabled theme renders links as plain text without OSC 8", () => {
    const renderer = new StreamingMarkdownRenderer(createTheme({ enabled: false }));
    const raw =
      renderer.push("Read [the docs](https://nodejs.org/api/abort.html) now.").text +
      renderer.flush().text;
    expect(raw).toBe("Read the docs (https://nodejs.org/api/abort.html) now.");
    expect(raw).not.toContain("\x1b]8;;");
  });
});
