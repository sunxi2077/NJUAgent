import { expect, test } from "vitest";
import { AppError } from "../../../src/errors/app-error.js";
import { formatError } from "../../../src/errors/error-presenter.js";

test("default errors expose only code and public message", () => {
  const error = new AppError({
    code: "SESSION_IO",
    userMessage: "Could not save the session. Your in-memory session is still active.",
    cause: new Error("ANTHROPIC_API_KEY=must-not-appear"),
  });
  const text = formatError(error, { debug: false });
  expect(text).toBe("[SESSION_IO] Could not save the session. Your in-memory session is still active.");
  expect(text).not.toContain("must-not-appear");
});

test("debug includes a controlled cause name and message", () => {
  const error = new AppError({
    code: "INTERNAL",
    userMessage: "Unexpected internal failure.",
    cause: new TypeError("invalid state"),
  });
  expect(formatError(error, { debug: true })).toContain("Cause: TypeError: invalid state");
});
