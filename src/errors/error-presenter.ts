import { AppError, isAppError } from "./app-error.js";

export type ErrorFormatOptions = {
  debug: boolean;
};

/**
 * Formats an error for terminal output. Default output exposes only the
 * stable code and public message. Debug output appends a controlled cause
 * line and the AppError stack; it never serializes environment, config, or
 * request objects.
 */
export function formatError(error: unknown, options: ErrorFormatOptions): string {
  if (isAppError(error)) {
    const line = `[${error.code}] ${error.userMessage}`;
    if (!options.debug) {
      return line;
    }
    const parts = [line];
    if (error.cause !== undefined) {
      const causeName = error.cause instanceof Error ? error.cause.name : "unknown";
      const causeMessage = error.cause instanceof Error
        ? error.cause.message
        : String(error.cause);
      parts.push(`Cause: ${causeName}: ${causeMessage}`);
    }
    if (error.stack !== undefined) {
      parts.push(error.stack);
    }
    return parts.join("\n");
  }
  const message = error instanceof Error ? error.message : String(error);
  return options.debug ? message : message;
}
