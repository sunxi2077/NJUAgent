import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Workspace } from "../../../src/security/workspace.js";
import {
  createEditFileTool,
  createReadFileTool,
  createWriteFileTool,
} from "../../../src/tools/file-tools.js";
import type { ToolContext } from "../../../src/tools/tool.js";

const temporaryDirectories: string[] = [];
const context: ToolContext = {
  signal: new AbortController().signal,
  emitOutput: () => undefined,
};

async function fixture(): Promise<{ root: string; workspace: Workspace }> {
  const root = await mkdtemp(path.join(tmpdir(), "nju-file-tools-"));
  temporaryDirectories.push(root);
  return { root, workspace: await Workspace.open(root) };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("read_file", () => {
  test("reads a one-based line range and reports pagination metadata", async () => {
    const { root, workspace } = await fixture();
    await writeFile(path.join(root, "sample.txt"), "alpha\nbeta\ngamma\ndelta\n");
    const tool = createReadFileTool({ workspace, maxOutputBytes: 4096 });

    const result = await tool.execute({ path: "sample.txt", offset: 2, limit: 2 }, context);

    expect(result.content).toBe("2: beta\n3: gamma");
    expect(result.metadata).toEqual({
      path: "sample.txt",
      startLine: 2,
      endLine: 3,
      totalLines: 4,
      truncated: false,
    });
  });

  test("truncates oversized content within the configured UTF-8 byte budget", async () => {
    const { root, workspace } = await fixture();
    await writeFile(path.join(root, "large.txt"), "x".repeat(500));
    const tool = createReadFileTool({ workspace, maxOutputBytes: 96 });

    const result = await tool.execute({ path: "large.txt" }, context);

    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(96);
    expect(result.content).toContain("bytes omitted");
    expect(result.metadata).toMatchObject({ truncated: true });
  });

  test("rejects binary content", async () => {
    const { root, workspace } = await fixture();
    await writeFile(path.join(root, "binary.dat"), Buffer.from([65, 0, 66]));
    const tool = createReadFileTool({ workspace, maxOutputBytes: 4096 });

    await expect(tool.execute({ path: "binary.dat" }, context)).rejects.toThrow(/binary/i);
  });
});

describe("write_file", () => {
  test("creates parent directories and writes UTF-8 content", async () => {
    const { root, workspace } = await fixture();
    const tool = createWriteFileTool({ workspace });

    const result = await tool.execute(
      { path: "src/nested/new.ts", content: "export const value = 1;\n" },
      context,
    );

    await expect(readFile(path.join(root, "src/nested/new.ts"), "utf8")).resolves.toBe(
      "export const value = 1;\n",
    );
    expect(result.metadata).toMatchObject({ path: "src/nested/new.ts", bytes: 24 });
  });

  test("rejects traversal outside the workspace", async () => {
    const { workspace } = await fixture();
    const tool = createWriteFileTool({ workspace });

    await expect(
      tool.execute({ path: "../outside.txt", content: "no" }, context),
    ).rejects.toThrow(/workspace/i);
  });
});

describe("edit_file", () => {
  test("replaces one unique literal match", async () => {
    const { root, workspace } = await fixture();
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src/value.ts"), "const value = 1;\n");
    const tool = createEditFileTool({ workspace });

    await tool.execute(
      { path: "src/value.ts", oldText: "value = 1", newText: "value = 2" },
      context,
    );

    await expect(readFile(path.join(root, "src/value.ts"), "utf8")).resolves.toBe(
      "const value = 2;\n",
    );
  });

  test("rejects a missing or ambiguous match without changing the file", async () => {
    const { root, workspace } = await fixture();
    const original = "same\nsame\n";
    await writeFile(path.join(root, "value.txt"), original);
    const tool = createEditFileTool({ workspace });

    await expect(
      tool.execute({ path: "value.txt", oldText: "missing", newText: "new" }, context),
    ).rejects.toThrow(/not found/i);
    await expect(
      tool.execute({ path: "value.txt", oldText: "same", newText: "new" }, context),
    ).rejects.toThrow(/2 matches/i);
    await expect(readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe(original);
  });

  test("replaces every literal match only when replaceAll is explicit", async () => {
    const { root, workspace } = await fixture();
    await writeFile(path.join(root, "value.txt"), "same\nsame\n");
    const tool = createEditFileTool({ workspace });

    const result = await tool.execute(
      {
        path: "value.txt",
        oldText: "same",
        newText: "changed",
        replaceAll: true,
      },
      context,
    );

    await expect(readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe(
      "changed\nchanged\n",
    );
    expect(result.metadata).toMatchObject({ replacements: 2 });
  });
});
