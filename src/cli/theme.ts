import { createColors } from "picocolors";

export type TerminalTheme = {
  enabled: boolean;
  brandStrong(text: string): string;
  brandBorder(text: string): string;
  userLabel(text: string): string;
  assistantLabel(text: string): string;
  heading(text: string): string;
  code(text: string): string;
  quote(text: string): string;
  success(text: string): string;
  warning(text: string): string;
  error(text: string): string;
  muted(text: string): string;
  bold(text: string): string;
  italic(text: string): string;
  underline(text: string): string;
};

const identity = (text: string): string => text;

/** Builds a foreground ANSI 256-color formatter that closes its own sequence. */
function ansi256(code: number): (text: string) => string {
  return (text) => `\x1b[38;5;${code}m${text}\x1b[0m`;
}

/**
 * Decides whether enhanced terminal output should be enabled at the
 * composition root. Enhanced output requires a real TTY, an unset or empty
 * `NO_COLOR`, and `TERM` different from `dumb`.
 */
export function shouldEnableTerminalTheme(options: {
  isTTY: boolean;
  env: NodeJS.ProcessEnv;
}): boolean {
  const noColor = options.env.NO_COLOR;
  return options.isTTY &&
    !(noColor !== undefined && noColor !== "") &&
    options.env.TERM !== "dumb";
}

/**
 * Centralized semantic terminal styles. Callers use semantics, never raw ANSI
 * color numbers. Brand colors use readable ANSI 256 purple (141) with a
 * visibly lighter border (99); the user label is a high-contrast cyan (45);
 * code uses a lighter cyan (81). The disabled theme is a set of identity
 * functions.
 */
export function createTheme(options: { enabled: boolean }): TerminalTheme {
  const semantic = createColors(options.enabled);
  if (!options.enabled) {
    return {
      enabled: false,
      brandStrong: identity,
      brandBorder: identity,
      userLabel: identity,
      assistantLabel: identity,
      heading: identity,
      code: identity,
      quote: identity,
      success: identity,
      warning: identity,
      error: identity,
      muted: identity,
      bold: identity,
      italic: identity,
      underline: identity,
    };
  }
  const brandStrong = ansi256(141);
  const border = ansi256(99);
  return {
    enabled: true,
    brandStrong,
    brandBorder: border,
    userLabel: (text) => semantic.bold(ansi256(45)(text)),
    assistantLabel: (text) => semantic.bold(brandStrong(text)),
    heading: (text) => semantic.bold(brandStrong(text)),
    code: ansi256(81),
    quote: semantic.dim,
    success: semantic.green,
    warning: semantic.yellow,
    error: semantic.red,
    muted: semantic.dim,
    bold: semantic.bold,
    italic: semantic.italic,
    underline: semantic.underline,
  };
}
