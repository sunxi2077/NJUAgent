import { describe, expect, test } from "vitest";
import { AppError, isAppError } from "../../../src/errors/app-error.js";

describe("AppError", () => {
  test("keeps a stable code, safe message, retryability, and cause", () => {
    const cause = new Error("socket closed");
    const error = new AppError({
      code: "PROVIDER_UNAVAILABLE",
      userMessage: "The model service is temporarily unavailable.",
      retryable: true,
      cause,
    });
    expect(isAppError(error)).toBe(true);
    expect(error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(error.userMessage).toBe("The model service is temporarily unavailable.");
    expect(error.retryable).toBe(true);
    expect(error.cause).toBe(cause);
  });
});
