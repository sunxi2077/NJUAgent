import { Ajv, type AnySchema } from "ajv";

import type { ContextState } from "../agent/context-types.js";
import { assertValidHistory, type Message } from "../agent/messages.js";
import type { PermissionMode } from "../config.js";
import { AppError } from "../errors/app-error.js";
import type { RunResult } from "../agent/result.js";
import { createEmptyEvidenceState, type EvidenceState, type GoalState } from "../goals/goal.js";
import { validatePlanItems, type PlanState } from "../planning/plan.js";

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
  plan: PlanState;
  goal: GoalState | null;
  evidence: EvidenceState;
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
    plan: { items: [] },
    goal: null,
    evidence: createEmptyEvidenceState(),
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
          enum: ["completed", "goal_verified", "goal_incomplete", "limit_reached", "context_limit", "cancelled", "model_failed", "internal_failed"],
        },
      },
      required: ["turns", "toolCalls"],
      additionalProperties: false,
    },
    plan: {
      type: "object",
      properties: {
        items: {
          type: "array",
          maxItems: 12,
          items: {
            type: "object",
            properties: {
              id: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,31}$" },
              content: { type: "string", minLength: 1, maxLength: 200 },
              status: { enum: ["pending", "in_progress", "completed"] },
            },
            required: ["id", "content", "status"],
            additionalProperties: false,
          },
        },
        updatedAt: { type: "string", minLength: 1 },
      },
      required: ["items"],
      additionalProperties: false,
    },
    goal: {
      type: ["object", "null"],
      properties: {
        condition: { type: "string", minLength: 1, maxLength: 1000 },
        status: { enum: ["active", "verified", "cancelled"] },
        createdAt: { type: "string", minLength: 1 },
        updatedAt: { type: "string", minLength: 1 },
        automaticContinuations: { type: "integer", minimum: 0 },
        lastDecision: {
          type: "object",
          properties: {
            satisfied: { type: "boolean" },
            reason: { type: "string", minLength: 1, maxLength: 500 },
            missingEvidence: {
              type: "array",
              maxItems: 8,
              items: { type: "string", minLength: 1, maxLength: 300 },
            },
            evaluatedAt: { type: "string", minLength: 1 },
          },
          required: ["satisfied", "reason", "missingEvidence", "evaluatedAt"],
          additionalProperties: false,
        },
      },
      required: ["condition", "status", "createdAt", "updatedAt", "automaticContinuations"],
      additionalProperties: false,
    },
    evidence: {
      type: "object",
      properties: {
        workspaceRevision: { type: "integer", minimum: 0 },
        changedPaths: {
          type: "array",
          items: { type: "string" },
        },
        commands: {
          type: "array",
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              command: { type: "string", minLength: 1 },
              exitCode: { type: ["integer", "null"] },
              timedOut: { type: "boolean" },
              cancelled: { type: "boolean" },
              isVerification: { type: "boolean" },
              workspaceRevision: { type: "integer", minimum: 0 },
              observedAt: { type: "string", minLength: 1 },
            },
            required: [
              "command",
              "exitCode",
              "timedOut",
              "cancelled",
              "isVerification",
              "workspaceRevision",
              "observedAt",
            ],
            additionalProperties: false,
          },
        },
      },
      required: ["workspaceRevision", "changedPaths", "commands"],
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
    "plan",
    "goal",
    "evidence",
  ],
  additionalProperties: false,
} as const;

function isIsoDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

/**
 * Builds a non-mutating candidate that supplies deterministic defaults for the
 * Stage Four fields, so pre-Stage-Four documents load before strict validation.
 */
function normalizeSessionCandidate(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  return {
    ...record,
    plan: record.plan ?? { items: [] },
    goal: record.goal ?? null,
    evidence: record.evidence ?? createEmptyEvidenceState(),
  };
}

/**
 * Validates JSON structure with Ajv (rejecting unknown properties), then
 * checks message-history invariants, checkpoint coverage, date formats, and
 * the Stage Four cross-field Plan rule. Returns a defensive clone. Failures
 * are `SESSION_CORRUPT` and never echo the whole session document.
 */
export function parseSession(value: unknown): PersistedSessionV1 {
  const candidate = normalizeSessionCandidate(value);
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(SESSION_SCHEMA as AnySchema);
  if (!validate(candidate)) {
    const detail = ajv.errorsText(validate.errors, { separator: "; " });
    throw new AppError({
      code: "SESSION_CORRUPT",
      userMessage: `Session file is invalid: ${detail}`,
    });
  }

  const session = candidate as PersistedSessionV1;
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
  if (session.plan.updatedAt !== undefined && !isIsoDate(session.plan.updatedAt)) {
    diagnostics.push("plan.updatedAt is not a valid date");
  }
  if (session.goal !== null) {
    if (!isIsoDate(session.goal.createdAt)) {
      diagnostics.push("goal.createdAt is not a valid date");
    }
    if (!isIsoDate(session.goal.updatedAt)) {
      diagnostics.push("goal.updatedAt is not a valid date");
    }
    if (session.goal.lastDecision !== undefined &&
      !isIsoDate(session.goal.lastDecision.evaluatedAt)) {
      diagnostics.push("goal.lastDecision.evaluatedAt is not a valid date");
    }
  }
  for (const command of session.evidence.commands) {
    if (!isIsoDate(command.observedAt)) {
      diagnostics.push("evidence command observedAt is not a valid date");
      break;
    }
  }
  const planCheck = validatePlanItems(session.plan.items);
  if (!planCheck.ok) {
    diagnostics.push(planCheck.message);
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
