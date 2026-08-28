import type { TerminalTheme } from "./theme.js";

export type MarkdownRenderResult = {
  text: string;
  lineOpen: boolean;
};

type InlineMode = "plain" | "bold" | "italic" | "code";
const MAX_LINK_CANDIDATE = 2048;

/**
 * Incrementally renders the inline Markdown subset (bold, italic, inline code,
 * links, newlines) to styled terminal text. Provider chunks may split syntax
 * anywhere; every emitted chunk is independently ANSI-safe because each visible
 * run is wrapped with the current theme style before leaving this class.
 */
export class StreamingMarkdownRenderer {
  readonly #theme: TerminalTheme;
  #pending = "";
  #inlineMode: InlineMode = "plain";
  #lineOpen = false;

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
    return { text: rendered, lineOpen: this.#lineOpen };
  }

  reset(): void {
    this.#pending = "";
    this.#inlineMode = "plain";
    this.#lineOpen = false;
  }

  #style(text: string): string {
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
    };

    while (this.#pending !== "") {
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
        output += "\n";
        this.#pending = this.#pending.slice(1);
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
        output += this.#theme.underline(link[1]!) + this.#theme.muted(` (${link[2]})`);
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
