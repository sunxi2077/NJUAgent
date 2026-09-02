import { terminalWidth } from "./terminal-text.js";
import type { TerminalTheme } from "./theme.js";

export type MarkdownRenderResult = {
  text: string;
  lineOpen: boolean;
};

type InlineMode = "plain" | "bold" | "italic" | "code";
type BlockMode = "normal" | "code";
const MAX_LINK_CANDIDATE = 2048;
const HEADING_DIVIDER_CAP = 24;

/**
 * Incrementally renders the Markdown subset (headings, lists, quotes, fenced
 * code, bold, italic, inline code, links, newlines) to styled terminal text.
 * Provider chunks may split syntax anywhere; every emitted chunk is
 * independently ANSI-safe because each visible run is wrapped with the current
 * theme style before leaving this class. Only an undecided line prefix or
 * fence line is buffered, never an ordinary paragraph.
 */
export class StreamingMarkdownRenderer {
  readonly #theme: TerminalTheme;
  #pending = "";
  #inlineMode: InlineMode = "plain";
  #lineOpen = false;
  #blockMode: BlockMode = "normal";
  #atLineStart = true;
  #headingLevel: number | undefined;
  #headingVisibleWidth = 0;
  #codeLineStarted = false;

  constructor(theme: TerminalTheme) {
    this.#theme = theme;
  }

  push(text: string): MarkdownRenderResult {
    this.#pending += text;
    const rendered = this.#drain(false);
    return { text: rendered, lineOpen: this.#lineOpen };
  }

  flush(): MarkdownRenderResult {
    const rendered = this.#drain(true);
    this.#inlineMode = "plain";
    this.#blockMode = "normal";
    this.#headingLevel = undefined;
    this.#headingVisibleWidth = 0;
    this.#atLineStart = true;
    this.#codeLineStarted = false;
    return { text: rendered, lineOpen: this.#lineOpen };
  }

  reset(): void {
    this.#pending = "";
    this.#inlineMode = "plain";
    this.#blockMode = "normal";
    this.#atLineStart = true;
    this.#headingLevel = undefined;
    this.#headingVisibleWidth = 0;
    this.#codeLineStarted = false;
    this.#lineOpen = false;
  }

  #style(text: string): string {
    if (this.#blockMode === "code") {
      return this.#theme.code(text);
    }
    if (this.#headingLevel !== undefined) {
      return this.#theme.heading(text);
    }
    switch (this.#inlineMode) {
      case "bold":
        return this.#theme.bold(text);
      case "italic":
        return this.#theme.italic(text);
      case "code":
        return this.#theme.code(text);
      case "plain":
        return text;
    }
  }

  #drain(flush: boolean): string {
    let output = "";
    const emit = (visible: string): void => {
      if (visible === "") return;
      output += this.#style(visible);
      this.#lineOpen = !visible.endsWith("\n");
      if (this.#headingLevel !== undefined && !visible.endsWith("\n")) {
        this.#headingVisibleWidth += terminalWidth(visible);
      }
    };

    while (this.#pending !== "") {
      if (this.#atLineStart && this.#blockMode === "normal") {
        const indentMatch = /^ */u.exec(this.#pending);
        const indent = indentMatch?.[0] ?? "";
        const rest = this.#pending.slice(indent.length);
        if (rest === "") {
          // A whitespace-only line: fall through to inline newline handling.
          this.#atLineStart = false;
        } else {
          const fenceMatch = /^(`{1,3})/u.exec(rest);
          if (fenceMatch !== null) {
            const backticks = fenceMatch[1]!;
            const afterFence = rest.slice(backticks.length);
            if (/^`+$/u.test(backticks)) {
              if (backticks.length === 3) {
                // Possible fence opener; wait for the newline unless flushing.
                const nl = rest.indexOf("\n");
                if (nl < 0 && !flush) break;
                this.#pending = nl < 0 ? "" : rest.slice(nl + 1);
                this.#blockMode = "code";
                this.#codeLineStarted = false;
                this.#atLineStart = true;
                continue;
              }
              // One or two backticks: may still form a triple fence.
              if (afterFence === "" && !flush) break;
              this.#atLineStart = false;
            } else {
              // Backticks followed by content: inline code or plain text.
              this.#atLineStart = false;
            }
          } else {
            const headingMatch = /^(#{1,6})(.*)/u.exec(rest);
            if (headingMatch !== null) {
              const hashes = headingMatch[1]!;
              const after = headingMatch[2]!;
              if (after === "") {
                if (!flush) break;
                this.#atLineStart = false;
              } else if (after[0] === " ") {
                if (indent !== "") output += indent;
                // Slice from `rest`: `after` excludes the trailing newline.
                this.#pending = rest.slice(hashes.length + 1);
                this.#headingLevel = hashes.length;
                this.#atLineStart = false;
                continue;
              } else {
                // A hash not followed by a heading space is ordinary text.
                this.#atLineStart = false;
              }
            } else {
              const digitsMatch = /^(\d{1,9})(.*)/u.exec(rest);
              if (digitsMatch !== null) {
                const number = digitsMatch[1]!;
                const after = digitsMatch[2]!;
                if (after === "" || after === ".") {
                  if (!flush) break;
                  this.#atLineStart = false;
                } else if (after[0] === "." && after[1] === " ") {
                  if (indent !== "") output += indent;
                  // Slice from `rest`: `after` excludes the trailing newline.
                  output += `${number}. `;
                  this.#pending = rest.slice(number.length + 2);
                  this.#atLineStart = false;
                  continue;
                } else {
                  this.#atLineStart = false;
                }
              } else if (/^[-*]/u.test(rest)) {
                const after = rest.slice(1);
                if (after === "") {
                  if (!flush) break;
                  this.#atLineStart = false;
                } else if (after[0] === " ") {
                  if (indent !== "") output += indent;
                  output += "• ";
                  this.#pending = after.slice(1);
                  this.#atLineStart = false;
                  continue;
                } else {
                  this.#atLineStart = false;
                }
              } else if (rest[0] === ">") {
                const after = rest.slice(1);
                if (after === "") {
                  if (!flush) break;
                  this.#atLineStart = false;
                } else if (after[0] === " ") {
                  if (indent !== "") output += indent;
                  output += this.#theme.quote("│ ");
                  this.#pending = after.slice(1);
                  this.#atLineStart = false;
                  continue;
                } else {
                  if (indent !== "") output += indent;
                  output += this.#theme.quote("│ ");
                  this.#pending = after;
                  this.#atLineStart = false;
                  continue;
                }
              } else {
                this.#atLineStart = false;
              }
            }
          }
        }
      }

      if (this.#blockMode === "code") {
        if (this.#atLineStart) {
          const fenceCandidate = /^(`{1,3})/u.exec(this.#pending);
          if (fenceCandidate !== null) {
            const backticks = fenceCandidate[1]!;
            const afterFence = this.#pending.slice(backticks.length);
            if (backticks.length < 3 && afterFence === "") {
              if (!flush) break;
            } else {
              const nl = afterFence.indexOf("\n");
              const lineRest = nl < 0 ? afterFence : afterFence.slice(0, nl);
              if (backticks.length === 3 && /^[ \t]*$/u.test(lineRest)) {
                this.#pending = nl < 0 ? "" : afterFence.slice(nl + 1);
                this.#blockMode = "normal";
                this.#atLineStart = true;
                this.#codeLineStarted = false;
                continue;
              }
            }
          }
          output += this.#theme.quote("  │ ");
          this.#codeLineStarted = true;
          this.#atLineStart = false;
          this.#lineOpen = true;
        }
        const lineEnd = this.#pending.indexOf("\n");
        if (lineEnd < 0) {
          emit(this.#pending);
          this.#pending = "";
          break;
        }
        emit(this.#pending.slice(0, lineEnd));
        output += "\n";
        this.#pending = this.#pending.slice(lineEnd + 1);
        this.#atLineStart = true;
        this.#codeLineStarted = false;
        this.#lineOpen = false;
        continue;
      }

      if (this.#inlineMode === "code") {
        const close = this.#pending.indexOf("`");
        if (close < 0) {
          emit(this.#pending);
          this.#pending = "";
          break;
        }
        emit(this.#pending.slice(0, close));
        this.#pending = this.#pending.slice(close + 1);
        this.#inlineMode = "plain";
        continue;
      }

      const special = this.#pending.search(/[*`[\n]/u);
      if (special < 0) {
        emit(this.#pending);
        this.#pending = "";
        break;
      }
      if (special > 0) {
        emit(this.#pending.slice(0, special));
        this.#pending = this.#pending.slice(special);
        continue;
      }

      if (this.#pending[0] === "\n") {
        this.#pending = this.#pending.slice(1);
        if (this.#headingLevel !== undefined && this.#headingLevel <= 2) {
          output += "\n";
          output += this.#theme.muted(
            "─".repeat(Math.min(HEADING_DIVIDER_CAP, Math.max(1, this.#headingVisibleWidth))),
          );
          output += "\n";
        } else {
          output += "\n";
        }
        this.#headingLevel = undefined;
        this.#headingVisibleWidth = 0;
        this.#atLineStart = true;
        this.#lineOpen = false;
        continue;
      }
      if (this.#pending[0] === "`") {
        this.#pending = this.#pending.slice(1);
        this.#inlineMode = "code";
        continue;
      }
      if (this.#pending[0] === "*") {
        if (this.#pending.length === 1 && !flush) break;
        if (this.#pending.startsWith("**")) {
          this.#pending = this.#pending.slice(2);
          this.#inlineMode = this.#inlineMode === "bold" ? "plain" : "bold";
        } else {
          this.#pending = this.#pending.slice(1);
          this.#inlineMode = this.#inlineMode === "italic" ? "plain" : "italic";
        }
        continue;
      }

      const link = /^\[([^\]\n]{1,1024})\]\(([^)\n]{1,1024})\)/u.exec(this.#pending);
      if (link !== null) {
        // The label becomes a clickable OSC 8 hyperlink when the theme is
        // enabled; the plain "(url)" suffix stays for terminals without link
        // support and for plain output.
        const label = this.#theme.hyperlink(
          this.#theme.underline(link[1]!),
          link[2]!,
        );
        output += label + this.#theme.muted(` (${link[2]})`);
        this.#lineOpen = true;
        this.#pending = this.#pending.slice(link[0].length);
        continue;
      }
      const newline = this.#pending.indexOf("\n");
      if (!flush && newline < 0 && this.#pending.length <= MAX_LINK_CANDIDATE) break;
      emit("[");
      this.#pending = this.#pending.slice(1);
    }

    if (flush && this.#pending !== "") {
      emit(this.#pending);
      this.#pending = "";
    }
    return output;
  }
}
