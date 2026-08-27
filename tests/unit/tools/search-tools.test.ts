import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Workspace } from "../../../src/security/workspace.js";
import {
  createListFilesTool,
  createSearchTextTool,
} from "../../../src/tools/search-tools.js";
import type { ToolContext } from "../../../src/tools/tool.js";

const temporaryDirectories: string[] = [];
const context: ToolContext = {
  signal: new AbortController().signal,
  emitOutput: () => undefined,
};

async function fixture(): Promise<{ root: string; workspace: Workspace }> {
  const root = await mkdtemp(path.join(tmpdir(), "nju-search-tools-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "hidden"), { recursive: true });
  await mkdir(path.join(root, ".git"), { recursive: true });
  await writeFile(path.join(root, "src", "z.ts"), "const z = 'needle';\n");
  await writeFile(path.join(root, "src", "a.ts"), "const a = 'needle';\nneedle();\n");
  await writeFile(path.join(root, "src", "notes.txt"), "nothing here\n");
  await writeFile(path.join(root, "node_modules", "hidden", "package.ts"), "needle\n");
  await writeFile(path.join(root, ".git", "config"), "needle\n");
  await writeFile(path.join(root, "binary.dat"), Buffer.from([110, 0, 101]));
  return { root, workspace: await Workspace.open(root) };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("list_files", () => {
  test("returns sorted workspace-relative paths matching the glob and excludes dependency metadata", async () => {
    const { workspace } = await fixture();
    const tool = createListFilesTool({
      workspace,
      maxOutputBytes: 4096,
      maxResults: 100,
    });

    const result = await tool.execute({ path: ".", pattern: "**/*.ts" }, context);

    expect(result.content).toBe("src/a.ts\nsrc/z.ts");
    expect(result.metadata).toEqual({ matched: 2, returned: 2, truncated: false });
  });

  test("marks output truncated when the result-count limit is reached", async () => {
    const { workspace } = await fixture();
    const tool = createListFilesTool({
      workspace,
      maxOutputBytes: 4096,
      maxResults: 1,
    });

    const result = await tool.execute({ pattern: "**/*.ts" }, context);

    expect(result.content).toContain("src/a.ts");
    expect(result.content).toContain("1 more file omitted");
    expect(result.metadata).toMatchObject({ matched: 2, returned: 1, truncated: true });
  });
});

describe("search_text", () => {
  test("returns sorted line-numbered matches and skips ignored and binary files", async () => {
    const { workspace } = await fixture();
    const tool = createSearchTextTool({
      workspace,
      maxOutputBytes: 4096,
      maxResults: 100,
      maxFileBytes: 1024,
    });

    const result = await tool.execute(
      { query: "needle", path: ".", pattern: "**/*" },
      context,
    );

    expect(result.content).toBe(
      "src/a.ts:1: const a = 'needle';\n" +
      "src/a.ts:2: needle();\n" +
      "src/z.ts:1: const z = 'needle';",
    );
    expect(result.metadata).toEqual({ matched: 3, returned: 3, truncated: false });
  });

  test("applies the UTF-8 output budget independently of the match-count limit", async () => {
    const { root, workspace } = await fixture();
    await writeFile(path.join(root, "src", "long.ts"), `needle ${"x".repeat(400)}\n`);
    const tool = createSearchTextTool({
      workspace,
      maxOutputBytes: 100,
      maxResults: 100,
      maxFileBytes: 1024,
    });

    const result = await tool.execute({ query: "needle", pattern: "src/long.ts" }, context);

    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(100);
    expect(result.content).toContain("bytes omitted");
    expect(result.metadata).toMatchObject({ matched: 1, returned: 1, truncated: true });
  });
});
