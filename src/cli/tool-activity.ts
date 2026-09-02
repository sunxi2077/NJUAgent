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

/**
 * Finds a tool call/result pair in a session transcript by id prefix. Pure:
 * reads messages only, never mutates anything. Provider ids are opaque, so
 * prefix matching is case-sensitive.
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

  const matches = calls
    .filter((call) => call.id.startsWith(prefix))
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
  const call = matches[0]!;
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
