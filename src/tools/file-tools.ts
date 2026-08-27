import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Workspace } from "../security/workspace.js";
import { truncateUtf8 } from "./output-budget.js";
import type { Tool } from "./tool.js";

type FileToolOptions = {
  workspace: Workspace;
};

type ReadFileOptions = FileToolOptions & {
  maxOutputBytes: number;
};

type ReadFileInput = {
  path: string;
  offset?: number;
  limit?: number;
};

type WriteFileInput = {
  path: string;
  content: string;
};

type EditFileInput = {
  path: string;
  oldText: string;
  newText: string;
  replaceAll?: boolean;
};

const pathProperty = {
  type: "string",
  minLength: 1,
  description: "A path relative to the workspace root.",
} as const;

async function readUtf8File(absolutePath: string): Promise<string> {
  const bytes = await readFile(absolutePath);
  if (bytes.includes(0)) {
    throw new Error("Cannot read binary file containing NUL bytes");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("File is not valid UTF-8 text");
  }
}

function textLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function countLiteralMatches(text: string, needle: string): number {
  let count = 0;
  let position = 0;
  while (position <= text.length - needle.length) {
    const found = text.indexOf(needle, position);
    if (found < 0) {
      break;
    }
    count += 1;
    position = found + needle.length;
  }
  return count;
}

export function createReadFileTool(options: ReadFileOptions): Tool<ReadFileInput> {
  return {
    name: "read_file",
    description: "Read UTF-8 text from a workspace-relative file with one-based line pagination.",
    inputSchema: {
      type: "object",
      properties: {
        path: pathProperty,
        offset: { type: "integer", minimum: 1, default: 1 },
        limit: { type: "integer", minimum: 1, maximum: 2000, default: 200 },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(input) {
      const absolutePath = await options.workspace.resolveExisting(input.path);
      const text = await readUtf8File(absolutePath);
      const lines = textLines(text);
      const startLine = input.offset ?? 1;
      const limit = input.limit ?? 200;
      const selected = lines.slice(startLine - 1, startLine - 1 + limit);
      const numbered = selected
        .map((line, index) => `${startLine + index}: ${line}`)
        .join("\n");
      const limited = truncateUtf8(numbered, options.maxOutputBytes);
      const endLine = selected.length === 0 ? 0 : startLine + selected.length - 1;
      return {
        content: limited.text,
        metadata: {
          path: input.path,
          startLine,
          endLine,
          totalLines: lines.length,
          truncated: limited.truncated,
        },
      };
    },
  };
}

export function createWriteFileTool(options: FileToolOptions): Tool<WriteFileInput> {
  return {
    name: "write_file",
    description: "Create or completely overwrite a UTF-8 text file inside the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: pathProperty,
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    async execute(input) {
      if (input.content.includes("\0")) {
        throw new Error("Cannot write binary content containing NUL bytes");
      }
      let absolutePath = await options.workspace.resolveForWrite(input.path);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      absolutePath = await options.workspace.resolveForWrite(input.path);
      await writeFile(absolutePath, input.content, "utf8");
      const bytes = Buffer.byteLength(input.content, "utf8");
      return {
        content: `Wrote ${bytes} bytes to ${input.path}`,
        metadata: { path: input.path, bytes, truncated: false },
      };
    },
  };
}

export function createEditFileTool(options: FileToolOptions): Tool<EditFileInput> {
  return {
    name: "edit_file",
    description: "Replace an exact literal string in an existing UTF-8 workspace file.",
    inputSchema: {
      type: "object",
      properties: {
        path: pathProperty,
        oldText: { type: "string", minLength: 1 },
        newText: { type: "string" },
        replaceAll: { type: "boolean", default: false },
      },
      required: ["path", "oldText", "newText"],
      additionalProperties: false,
    },
    async execute(input) {
      if (input.oldText.length === 0) {
        throw new Error("oldText must not be empty");
      }
      if (input.newText.includes("\0")) {
        throw new Error("Cannot write binary content containing NUL bytes");
      }
      const absolutePath = await options.workspace.resolveExisting(input.path);
      const original = await readUtf8File(absolutePath);
      const matches = countLiteralMatches(original, input.oldText);
      if (matches === 0) {
        throw new Error(`Exact text not found in ${input.path}`);
      }
      if (matches > 1 && input.replaceAll !== true) {
        throw new Error(
          `Exact text has ${matches} matches in ${input.path}; set replaceAll to replace every match`,
        );
      }

      const updated = input.replaceAll === true
        ? original.split(input.oldText).join(input.newText)
        : original.replace(input.oldText, input.newText);
      await writeFile(absolutePath, updated, "utf8");
      const replacements = input.replaceAll === true ? matches : 1;
      return {
        content: `Replaced ${replacements} match${replacements === 1 ? "" : "es"} in ${input.path}`,
        metadata: {
          path: input.path,
          replacements,
          bytes: Buffer.byteLength(updated, "utf8"),
          truncated: false,
        },
      };
    },
  };
}
