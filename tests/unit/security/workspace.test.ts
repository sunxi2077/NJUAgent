import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  Workspace,
  WorkspaceViolationError,
} from "../../../src/security/workspace.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Workspace", () => {
  test("resolves existing files and new files inside the canonical root", async () => {
    const root = await temporaryDirectory("nju-workspace-");
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "index.ts"), "export {};\n");
    const workspace = await Workspace.open(root);

    await expect(workspace.resolveExisting("src/index.ts")).resolves.toBe(
      path.join(workspace.root, "src", "index.ts"),
    );
    await expect(workspace.resolveForWrite("src/new.ts")).resolves.toBe(
      path.join(workspace.root, "src", "new.ts"),
    );
    expect(workspace.toRelative(path.join(workspace.root, "src", "index.ts"))).toBe("src/index.ts");
  });

  test("rejects traversal and absolute input paths", async () => {
    const root = await temporaryDirectory("nju-workspace-");
    const workspace = await Workspace.open(root);

    await expect(workspace.resolveForWrite("../secret.txt")).rejects.toBeInstanceOf(
      WorkspaceViolationError,
    );
    await expect(workspace.resolveForWrite(path.join(root, "absolute.txt"))).rejects.toBeInstanceOf(
      WorkspaceViolationError,
    );
  });

  test("rejects an existing symlink that resolves outside the workspace", async () => {
    const root = await temporaryDirectory("nju-workspace-");
    const outside = await temporaryDirectory("nju-outside-");
    await writeFile(path.join(outside, "secret.txt"), "secret\n");
    await symlink(path.join(outside, "secret.txt"), path.join(root, "escape.txt"));
    const workspace = await Workspace.open(root);

    await expect(workspace.resolveExisting("escape.txt")).rejects.toBeInstanceOf(
      WorkspaceViolationError,
    );
  });

  test("rejects a new file below a directory symlink that resolves outside", async () => {
    const root = await temporaryDirectory("nju-workspace-");
    const outside = await temporaryDirectory("nju-outside-");
    await symlink(outside, path.join(root, "external"));
    const workspace = await Workspace.open(root);

    await expect(workspace.resolveForWrite("external/new.txt")).rejects.toBeInstanceOf(
      WorkspaceViolationError,
    );
  });

  test("rejects writing through a broken symlink whose target is outside", async () => {
    const root = await temporaryDirectory("nju-workspace-");
    const outside = await temporaryDirectory("nju-outside-");
    await symlink(path.join(outside, "new.txt"), path.join(root, "escape.txt"));
    const workspace = await Workspace.open(root);

    await expect(workspace.resolveForWrite("escape.txt")).rejects.toBeInstanceOf(
      WorkspaceViolationError,
    );
  });

  test("allows a symlink whose real target remains inside the workspace", async () => {
    const root = await temporaryDirectory("nju-workspace-");
    await mkdir(path.join(root, "real"));
    await writeFile(path.join(root, "real", "safe.txt"), "safe\n");
    await symlink(path.join(root, "real"), path.join(root, "linked"));
    const workspace = await Workspace.open(root);

    await expect(workspace.resolveExisting("linked/safe.txt")).resolves.toBe(
      path.join(workspace.root, "real", "safe.txt"),
    );
    await expect(workspace.resolveForWrite("linked/new.txt")).resolves.toBe(
      path.join(workspace.root, "real", "new.txt"),
    );
  });
});
