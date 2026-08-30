import { stripVTControlCharacters } from "node:util";

function isCombining(codePoint: number): boolean {
  return (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
    codePoint === 0xfe0f;
}

function isWide(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f ||
    codePoint === 0x2329 || codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

/** Width in terminal cells of `text`, ignoring ANSI escapes and combining marks. */
export function terminalWidth(text: string): number {
  let width = 0;
  for (const char of stripVTControlCharacters(text)) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint === 0 || isCombining(codePoint)) continue;
    width += isWide(codePoint) ? 2 : 1;
  }
  return width;
}

/**
 * Removes ANSI control sequences and collapses all whitespace runs (including
 * CR/LF and tabs) into single spaces, trimmed. Safe for rendering untrusted
 * descriptor text: no control sequence can leak through.
 */
export function sanitizeTerminalText(text: string): string {
  return stripVTControlCharacters(text).replace(/\s+/gu, " ").trim();
}

/**
 * Truncates `text` so its terminal width fits within `maxWidth`, reserving one
 * cell for the trailing `…` when truncation is needed. Inputs are unstyled
 * values; ANSI inside the input is not preserved while slicing.
 */
export function truncateToTerminalWidth(text: string, maxWidth: number): string {
  if (terminalWidth(text) <= maxWidth) {
    return text;
  }
  const budget = maxWidth - 1;
  let width = 0;
  let result = "";
  for (const char of text) {
    const charWidth = terminalWidth(char);
    if (width + charWidth > budget) {
      break;
    }
    result += char;
    width += charWidth;
  }
  return `${result}…`;
}
