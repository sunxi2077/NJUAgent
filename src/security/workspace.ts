import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

export class WorkspaceViolationError extends Error {
  override readonly name = "WorkspaceViolationError";
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

export class Workspace {
  private constructor(readonly root: string) {}

  static async open(root: string): Promise<Workspace> {
    const canonicalRoot = await realpath(path.resolve(root));
    const rootStats = await stat(canonicalRoot);
    if (!rootStats.isDirectory()) {
      throw new WorkspaceViolationError(`Workspace is not a directory: ${root}`);
    }
    return new Workspace(canonicalRoot);
  }

  async resolveExisting(relativePath: string): Promise<string> {
    const lexicalPath = this.lexicalPath(relativePath);
    const canonicalPath = await realpath(lexicalPath);
    this.assertInside(canonicalPath);
    return canonicalPath;
  }

  async resolveForWrite(relativePath: string): Promise<string> {
    const lexicalPath = this.lexicalPath(relativePath);
    const relative = path.relative(this.root, lexicalPath);
    if (relative === "") {
      return this.root;
    }

    const segments = relative.split(path.sep);
    let canonicalCursor = this.root;

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (segment === undefined) {
        continue;
      }
      const candidate = path.join(canonicalCursor, segment);
      let candidateStats;
      try {
        candidateStats = await lstat(candidate);
      } catch (error) {
        if (!isMissing(error)) {
          throw error;
        }
        const unresolved = segments.slice(index);
        const target = path.join(canonicalCursor, ...unresolved);
        this.assertInside(target);
        return target;
      }

      if (candidateStats.isSymbolicLink()) {
        try {
          canonicalCursor = await realpath(candidate);
        } catch (error) {
          if (isMissing(error)) {
            throw new WorkspaceViolationError(
              `Broken symbolic link is not writable: ${candidate}`,
            );
          }
          throw error;
        }
        this.assertInside(canonicalCursor);
      } else {
        canonicalCursor = candidate;
        this.assertInside(canonicalCursor);
      }
    }

    return canonicalCursor;
  }

  toRelative(absolutePath: string): string {
    const resolved = path.resolve(absolutePath);
    this.assertInside(resolved);
    return path.relative(this.root, resolved) || ".";
  }

  private lexicalPath(relativePath: string): string {
    if (relativePath.includes("\0")) {
      throw new WorkspaceViolationError("Workspace paths cannot contain NUL bytes");
    }
    if (path.isAbsolute(relativePath)) {
      throw new WorkspaceViolationError(`Absolute paths are not allowed: ${relativePath}`);
    }

    const candidate = path.resolve(this.root, relativePath || ".");
    this.assertInside(candidate);
    return candidate;
  }

  private assertInside(candidate: string): void {
    const relative = path.relative(this.root, candidate);
    if (
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`)
    ) {
      throw new WorkspaceViolationError(
        `Path escapes workspace: ${candidate}`,
      );
    }
  }
}
