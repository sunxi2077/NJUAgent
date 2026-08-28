import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { SessionStore } from "../../../src/sessions/session-store.js";
import { createEmptySession, type PersistedSessionV1 } from "../../../src/sessions/session-schema.js";
import { writeJsonAtomic } from "../../../src/storage/atomic-json.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function tempDirectory(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "nju-session-store-"));
  temporaryDirectories.push(dir);
  return dir;
}

function session(overrides: Partial<PersistedSessionV1> = {}): PersistedSessionV1 {
  return createEmptySession({
    id: "3f2c9d5a-6b1e-4f80-9a2c-7d8e1f0a3b4c",
    now: "2026-08-28T08:00:00.000Z",
    workspaceRoot: "/tmp/workspace",
    modelId: "deepseek-v4-flash",
    permissionMode: "balanced",
  });
}

describe("SessionStore", () => {
  test("save/load round-trips a session", async () => {
    const dir = await tempDirectory();
    const store = new SessionStore(dir);
    const s = { ...session(), title: "fix parser" };
    await store.save(s);
    const loaded = await store.load(s.id);
    expect(loaded).toEqual(s);
  });

  test("file name is exactly <uuid>.json and contains no key-like value", async () => {
    const dir = await tempDirectory();
    const store = new SessionStore(dir);
    const s = session();
    await store.save(s);
    const files = await (await import("node:fs/promises")).readdir(dir);
    expect(files).toEqual(["3f2c9d5a-6b1e-4f80-9a2c-7d8e1f0a3b4c.json"]);
    const text = await readFile(path.join(dir, files[0]!), "utf8");
    expect(text).not.toContain("apiKey");
    expect(text).not.toContain("ANTHROPIC_API_KEY");
  });

  test("list sorts by descending updatedAt", async () => {
    const dir = await tempDirectory();
    const store = new SessionStore(dir);
    const older = { ...session(), id: "11111111-1111-4111-8111-111111111111", updatedAt: "2026-08-28T08:00:00.000Z" };
    const newer = { ...session(), id: "22222222-2222-4222-8222-222222222222", updatedAt: "2026-08-28T09:00:00.000Z" };
    await store.save(older);
    await store.save(newer);

    const { sessions, diagnostics } = await store.list();
    expect(sessions.map((s) => s.id)).toEqual([newer.id, older.id]);
    expect(diagnostics).toEqual([]);
  });

  test("malformed and schema-invalid files appear in diagnostics while valid entries remain", async () => {
    const dir = await tempDirectory();
    const store = new SessionStore(dir);
    const good = session();
    await store.save(good);
    await writeFile(path.join(dir, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json"), "{not json", "utf8");
    await writeFile(path.join(dir, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.json"), "{}", "utf8");

    const { sessions, diagnostics } = await store.list();
    expect(sessions.map((s) => s.id)).toEqual([good.id]);
    expect(diagnostics).toHaveLength(2);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.message).not.toContain("bbbbbbbb");
    }
  });

  test("resolveId accepts a full ID and a unique case-insensitive prefix", async () => {
    const dir = await tempDirectory();
    const store = new SessionStore(dir);
    const s = session();
    await store.save(s);

    expect(await store.resolveId(s.id)).toBe(s.id);
    expect(await store.resolveId("3F2C9D5A")).toBe(s.id);
  });

  test("zero matches throws SESSION_CORRUPT with a safe message", async () => {
    const dir = await tempDirectory();
    const store = new SessionStore(dir);
    await expect(store.resolveId("zzzzzzzz")).rejects.toMatchObject({
      code: "SESSION_CORRUPT",
    });
    await expect(store.resolveId("zzzzzzzz")).rejects.toThrow(/No session matches/);
  });

  test("multiple matches throws with only matching short IDs", async () => {
    const dir = await tempDirectory();
    const store = new SessionStore(dir);
    await store.save({ ...session(), id: "aaaaaaaa-1111-4111-8111-111111111111" });
    await store.save({ ...session(), id: "aaaaaaaa-2222-4222-8222-222222222222" });

    await expect(store.resolveId("aaaaaaaa")).rejects.toThrow(/aaaaaaaa-1111/);
    await expect(store.resolveId("aaaaaaaa")).rejects.toThrow(/aaaaaaaa-2222/);
  });

  test("injected atomic writer failure preserves an existing valid file", async () => {
    const dir = await tempDirectory();
    const store = new SessionStore(dir);
    const s = session();
    await store.save(s);

    const failing = async () => {
      throw new Error("disk full");
    };
    const broken = new SessionStore(dir, failing);
    await expect(broken.save({ ...s, title: "updated" })).rejects.toMatchObject({
      code: "SESSION_IO",
    });

    const reloaded = await store.load(s.id);
    expect(reloaded.title).toBe("New session");
    expect((await import("node:fs/promises")).access).toBeDefined();
  });

  test("load of a missing id throws SESSION_CORRUPT", async () => {
    const dir = await tempDirectory();
    const store = new SessionStore(dir);
    await expect(store.load("ffffffff-ffff-4fff-8fff-ffffffffffff")).rejects.toMatchObject({
      code: "SESSION_CORRUPT",
    });
  });
});
