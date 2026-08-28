import { createColors } from "picocolors";

export type TerminalTheme = {
  enabled: boolean;
  brand(text: string): string;
  brandBase(text: string): string;
  success(text: string): string;
  warning(text: string): string;
  error(text: string): string;
  muted(text: string): string;
};

const identity = (text: string): string => text;

/** Builds a foreground ANSI 256-color formatter that closes its own sequence. */
function ansi256(code: number): (text: string) => string {
  return (text) => `\x1b[38;5;${code}m${text}\x1b[0m`;
}

/**
 * Centralized terminal styles. Brand colors use readable ANSI 256 purple
 * (141) with a dark base approximation (54); semantic colors reuse standard
 * green/yellow/red/dim. Color enablement follows the `enabled` flag exactly
 * (computed by the caller from TTY and NO_COLOR); the disabled theme is a set
 * of identity functions.
 */
export function createTheme(options: { enabled: boolean }): TerminalTheme {
  const semantic = createColors(options.enabled);
  if (!options.enabled) {
    return {
      enabled: false,
      brand: identity,
      brandBase: identity,
      success: identity,
      warning: identity,
      error: identity,
      muted: identity,
    };
  }
  return {
    enabled: true,
    brand: ansi256(141),
    brandBase: ansi256(54),
    success: semantic.green,
    warning: semantic.yellow,
    error: semantic.red,
    muted: semantic.dim,
  };
}
