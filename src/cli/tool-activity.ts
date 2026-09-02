import { createHash } from "node:crypto";

import type {
  Message,
  ToolCallBlock,
  ToolResultBlock,
} from "../agent/messages.js";

export type ToolActivity = {
  id: string;
  name: string;
  input: unknown;
  result?: { content: string; isError?: boolean; metadata?: Record<string, unknown> };
};

export type ToolActivityMatch =
  | { kind: "found"; activity: ToolActivity }
  | { kind: "none" }
  | { kind: "ambiguous"; matches: readonly Pick<ToolActivity, "id" | "name">[] };

export type ToolPreviewLine = { text: string; stream: "stdout" | "stderr" };

export type ToolPreview = {
  lines: readonly ToolPreviewLine[];
  hiddenLineCount: number;
  truncated: boolean;
};

const DEFAULT_PREVIEW_MAX_LINES = 3;
const DEFAULT_PREVIEW_MAX_CODE_POINTS = 360;
const REFERENCE_PREFIX_PATTERN = /^t-/iu;

/**
 * Stable, display-safe short reference for a provider tool id. Provider ids
 * are opaque and often share a visible prefix (Anthropic-style ids all begin
 * `call_00_`), so a hint must not be derived from the id's first characters.
 * The reference is `T-` plus the first 10 lowercase hex characters of the
 * SHA-256 digest of the full id; identical ids always produce the same
 * reference and distinct ids virtually never collide.
 */
export function toolReference(id: string): string {
  const digest = createHash("sha256").update(id).digest("hex");
  return `T-${digest.slice(0, 10)}`;
}

/**
 * Finds a tool call/result pair in a session transcript. Accepts either (a) a
 * provider-id prefix — matched case-sensitively as before — or (b) a `T-`
 * reference prefix, which is matched case-insensitively against
 * {@link toolReference}. A full provider id that matches exactly always wins
 * first. Pure: reads messages only, never mutates anything.
 */
export function findToolActivity(
  messages: readonly Message[],
  prefix: string,
): ToolActivityMatch {
  const resultsByCallId = new Map<string, ToolResultBlock>();
  const calls: ToolCallBlock[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "tool_call") {
          calls.push(block);
        }
      }
    } else if (message.role === "user") {
      for (const block of message.content) {
        if (block.type === "tool_result") {
          resultsByCallId.set(block.toolCallId, block);
        }
      }
    }
  }

  const exact = calls.filter((call) => call.id === prefix);
  if (exact.length === 1) {
    return foundActivity(exact[0]!, resultsByCallId);
  }

  const isReference = REFERENCE_PREFIX_PATTERN.test(prefix);
  const normalizedPrefix = prefix.toLowerCase();
  const matches = calls
    .filter((call) => {
      if (call.id.startsWith(prefix)) {
        return true;
      }
      if (isReference) {
        return toolReference(call.id)
          .toLowerCase()
          .startsWith(normalizedPrefix);
      }
      return false;
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  if (matches.length === 0) {
    return { kind: "none" };
  }
  if (matches.length > 1) {
    return {
      kind: "ambiguous",
      matches: matches.map((call) => ({ id: call.id, name: call.name })),
    };
  }
  return foundActivity(matches[0]!, resultsByCallId);
}

function foundActivity(
  call: ToolCallBlock,
  resultsByCallId: Map<string, ToolResultBlock>,
): ToolActivityMatch {
  const result = resultsByCallId.get(call.id);
  return {
    kind: "found",
    activity: {
      id: call.id,
      name: call.name,
      input: call.input,
      ...(result === undefined
        ? {}
        : {
            result: {
              content: result.content,
              ...(result.isError ? { isError: true } : {}),
            },
          }),
    },
  };
}

function nonEmptyLines(text: string): string[] {
  return text.split(/\r?\n/u).filter((line) => line.trim() !== "");
}

/**
 * Builds a bounded preview of captured command output. Never throws:
 * malformed text simply becomes preview lines. Blank lines are discarded and
 * at most `maxLines` non-empty lines are kept across both streams, stdout
 * first. A line longer than `maxCodePoints` is cut with one ellipsis.
 */
export function makeToolPreview(input: {
  stdout: string;
  stderr: string;
  maxLines?: number;
  maxCodePoints?: number;
}): ToolPreview {
  const maxLines = input.maxLines ?? DEFAULT_PREVIEW_MAX_LINES;
  const maxCodePoints = input.maxCodePoints ?? DEFAULT_PREVIEW_MAX_CODE_POINTS;
  const all: ToolPreviewLine[] = [
    ...nonEmptyLines(input.stdout).map((text) => ({ text, stream: "stdout" as const })),
    ...nonEmptyLines(input.stderr).map((text) => ({ text, stream: "stderr" as const })),
  ];
  const shown = all.slice(0, maxLines).map((line) => {
    const codePoints = [...line.text];
    if (codePoints.length <= maxCodePoints) {
      return line;
    }
    return {
      ...line,
      text: `${codePoints.slice(0, Math.max(0, maxCodePoints - 1)).join("")}…`,
    };
  });
  return {
    lines: shown,
    hiddenLineCount: Math.max(0, all.length - maxLines),
    truncated: all.length > maxLines,
  };
}
