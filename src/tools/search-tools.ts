import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import fg from "fast-glob";

import type { Workspace } from "../security/workspace.js";
import { truncateUtf8 } from "./output-budget.js";
import type { Tool, ToolContext } from "./tool.js";

type SearchToolOptions = {
  workspace: Workspace;
  maxOutputBytes: number;
  maxResults: number;
};

type TextSearchToolOptions = SearchToolOptions & {
  maxFileBytes: number;
};

type ListFilesInput = {
  path?: string;
  pattern?: string;
};

type SearchTextInput = {
  query: string;
  path?: string;
  pattern?: string;
};

const ignoredPaths = [
  "**/.git/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
];

function assertSafePattern(pattern: string): void {
  const normalized = pattern.replaceAll("\\", "/");
  if (
    path.isAbsolute(pattern) ||
    normalized.split("/").some((segment) => segment === "..")
  ) {
    throw new Error(`Glob pattern must stay inside the workspace: ${pattern}`);
  }
}

async function candidateFiles(
  workspace: Workspace,
  basePath: string,
  pattern: string,
): Promise<string[]> {
  assertSafePattern(pattern);
  const base = await workspace.resolveExisting(basePath);
  if (!(await stat(base)).isDirectory()) {
    throw new Error(`Search path is not a directory: ${basePath}`);
  }

  const candidates = await fg(pattern, {
    cwd: base,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false,
    ignore: ignoredPaths,
  });

  const relativePaths: string[] = [];
  for (const candidate of candidates) {
    const lexicalAbsolute = path.join(base, candidate);
    const workspaceRelative = workspace.toRelative(lexicalAbsolute);
    const canonical = await workspace.resolveExisting(workspaceRelative);
    relativePaths.push(workspace.toRelative(canonical));
  }
  return [...new Set(relativePaths)].sort((left, right) => left.localeCompare(right));
}

function omittedLine(count: number, noun: string): string {
  return `[... ${count} more ${noun}${count === 1 ? "" : "s"} omitted]`;
}

function throwIfAborted(context: ToolContext): void {
  if (context.signal.aborted) {
    throw new DOMException("Tool execution was cancelled", "AbortError");
  }
}

export function createListFilesTool(options: SearchToolOptions): Tool<ListFilesInput> {
  return {
    name: "list_files",
    description: "List sorted files inside the workspace, optionally filtered by a glob pattern.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, default: "." },
        pattern: { type: "string", minLength: 1, default: "**/*" },
      },
      additionalProperties: false,
    },
    async execute(input, context) {
      throwIfAborted(context);
      const files = await candidateFiles(
        options.workspace,
        input.path ?? ".",
        input.pattern ?? "**/*",
      );
      const returned = files.slice(0, options.maxResults);
      const omitted = files.length - returned.length;
      const raw = [
        ...returned,
        ...(omitted > 0 ? [omittedLine(omitted, "file")] : []),
      ].join("\n");
      const limited = truncateUtf8(raw, options.maxOutputBytes);
      return {
        content: limited.text,
        metadata: {
          matched: files.length,
          returned: returned.length,
          truncated: omitted > 0 || limited.truncated,
        },
      };
    },
  };
}

export function createSearchTextTool(options: TextSearchToolOptions): Tool<SearchTextInput> {
  return {
    name: "search_text",
    description: "Search literal UTF-8 text in workspace files and return path:line matches.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        path: { type: "string", minLength: 1, default: "." },
        pattern: { type: "string", minLength: 1, default: "**/*" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const files = await candidateFiles(
        options.workspace,
        input.path ?? ".",
        input.pattern ?? "**/*",
      );
      const matches: string[] = [];

      for (const relativePath of files) {
        throwIfAborted(context);
        const absolutePath = await options.workspace.resolveExisting(relativePath);
        const fileStats = await stat(absolutePath);
        if (fileStats.size > options.maxFileBytes) {
          continue;
        }
        const bytes = await readFile(absolutePath);
        if (bytes.includes(0)) {
          continue;
        }
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          continue;
        }
        const lines = text.split(/\r?\n/u);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? "";
          if (line.includes(input.query)) {
            matches.push(`${relativePath}:${index + 1}: ${line}`);
          }
        }
      }

      const returned = matches.slice(0, options.maxResults);
      const omitted = matches.length - returned.length;
      const raw = [
        ...returned,
        ...(omitted > 0 ? [omittedLine(omitted, "match")] : []),
      ].join("\n");
      const limited = truncateUtf8(raw, options.maxOutputBytes);
      return {
        content: limited.text,
        metadata: {
          matched: matches.length,
          returned: returned.length,
          truncated: omitted > 0 || limited.truncated,
        },
      };
    },
  };
}
