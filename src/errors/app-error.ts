export type AppErrorCode =
  | "CONFIG_INVALID"
  | "CONFIG_MISSING_API_KEY"
  | "PROVIDER_AUTH"
  | "PROVIDER_RATE_LIMIT"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_PROTOCOL"
  | "SESSION_IO"
  | "SESSION_CORRUPT"
  | "CONTEXT_LIMIT"
  | "COMPACTION_FAILED"
  | "SKILL_INVALID"
  | "PLAN_INVALID"
  | "USER_CANCELLED"
  | "INTERNAL";

export type AppErrorOptions = {
  code: AppErrorCode;
  userMessage: string;
  retryable?: boolean;
  cause?: unknown;
};

export class AppError extends Error {
  override readonly name: string = "AppError";
  readonly code: AppErrorCode;
  readonly userMessage: string;
  readonly retryable: boolean;

  constructor(options: AppErrorOptions) {
    super(options.userMessage, { cause: options.cause });
    this.code = options.code;
    this.userMessage = options.userMessage;
    this.retryable = options.retryable ?? false;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
