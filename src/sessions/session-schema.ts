import { Ajv, type AnySchema } from "ajv";

import type { ContextState } from "../agent/context-types.js";
import { assertValidHistory, type Message } from "../agent/messages.js";
import type { PermissionMode } from "../config.js";
import { AppError } from "../errors/app-error.js";
import type { RunResult } from "../agent/result.js";

export type PersistedSessionV1 = {
  schemaVersion: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  workspaceRoot: string;
  modelId: string;
  permissionMode: PermissionMode;
  activeSkill: string | null;
  messages: Message[];
  context: ContextState;
  stats: {
    turns: number;
    toolCalls: number;
    lastRunStatus?: RunResult["status"];
  };
};

export type CreateEmptySessionInput = {
  id: string;
  now: string;
  workspaceRoot: string;
  modelId: string;
  permissionMode: PermissionMode;
};

export function createEmptySession(input: CreateEmptySessionInput): PersistedSessionV1 {
  return {
    schemaVersion: 1,
    id: input.id,
    title: "New session",
    createdAt: input.now,
    updatedAt: input.now,
    workspaceRoot: input.workspaceRoot,
    modelId: input.modelId,
    permissionMode: input.permissionMode,
    activeSkill: null,
    messages: [],
    context: { compactionCount: 0 },
    stats: { turns: 0, toolCalls: 0 },
  };
}

/** Collapses whitespace, trims, and limits to 48 code points. */
export function deriveSessionTitle(text: string): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (collapsed === "") {
    return "New session";
  }
  return [...collapsed].slice(0, 48).join("");
}

const UUID_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

const SESSION_SCHEMA = {
  type: "object",
  properties: {
    schemaVersion: { const: 1 },
    id: { type: "string", pattern: UUID_PATTERN },
    title: { type: "string", minLength: 1 },
    createdAt: { type: "string", minLength: 1 },
    updatedAt: { type: "string", minLength: 1 },
    workspaceRoot: { type: "string", minLength: 1 },
    modelId: { type: "string", minLength: 1 },
    permissionMode: { enum: ["balanced", "cautious"] },
    activeSkill: { type: ["string", "null"] },
    messages: { type: "array" },
    context: {
      type: "object",
      properties: {
        checkpoint: {
          type: "object",
          properties: {
            summary: { type: "string" },
            coveredMessageCount: { type: "integer", minimum: 0 },
            createdAt: { type: "string", minLength: 1 },
            sourceEstimatedTokens: { type: "integer", minimum: 0 },
          },
          required: ["summary", "coveredMessageCount", "createdAt", "sourceEstimatedTokens"],
          additionalProperties: false,
        },
        lastInputTokens: { type: "integer", minimum: 0 },
        compactionCount: { type: "integer", minimum: 0 },
      },
      required: ["compactionCount"],
      additionalProperties: false,
    },
    stats: {
      type: "object",
      properties: {
        turns: { type: "integer", minimum: 0 },
        toolCalls: { type: "integer", minimum: 0 },
        lastRunStatus: {
          enum: ["completed", "limit_reached", "context_limit", "cancelled", "model_failed", "internal_failed"],
        },
      },
      required: ["turns", "toolCalls"],
      additionalProperties: false,
    },
  },
  required: [
    "schemaVersion",
    "id",
    "title",
    "createdAt",
    "updatedAt",
    "workspaceRoot",
    "modelId",
    "permissionMode",
    "activeSkill",
    "messages",
    "context",
    "stats",
  ],
  additionalProperties: false,
} as const;

function isIsoDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

/**
 * Validates JSON structure with Ajv (rejecting unknown properties), then
 * checks message-history invariants, checkpoint coverage, and date formats.
 * Returns a defensive clone. Failures are `SESSION_CORRUPT` and never echo the
 * whole session document.
 */
export function parseSession(value: unknown): PersistedSessionV1 {
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(SESSION_SCHEMA as AnySchema);
  if (!validate(value)) {
    const detail = ajv.errorsText(validate.errors, { separator: "; " });
    throw new AppError({
      code: "SESSION_CORRUPT",
      userMessage: `Session file is invalid: ${detail}`,
    });
  }

  const session = value as PersistedSessionV1;
  const diagnostics: string[] = [];
  if (!isIsoDate(session.createdAt)) {
    diagnostics.push("createdAt is not a valid date");
  }
  if (!isIsoDate(session.updatedAt)) {
    diagnostics.push("updatedAt is not a valid date");
  }
  if (
    session.context.checkpoint !== undefined &&
    !isIsoDate(session.context.checkpoint.createdAt)
  ) {
    diagnostics.push("checkpoint.createdAt is not a valid date");
  }
  if (session.context.checkpoint !== undefined &&
    session.context.checkpoint.coveredMessageCount > session.messages.length) {
    diagnostics.push("checkpoint covers more messages than exist");
  }
  if (diagnostics.length > 0) {
    throw new AppError({
      code: "SESSION_CORRUPT",
      userMessage: `Session file is invalid: ${diagnostics.join("; ")}`,
    });
  }

  try {
    assertValidHistory(session.messages);
  } catch (error) {
    throw new AppError({
      code: "SESSION_CORRUPT",
      userMessage: `Session history is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
      cause: error,
    });
  }

  return structuredClone(session);
}
