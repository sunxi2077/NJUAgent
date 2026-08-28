import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConfigStore, type PersistedConfigV1 } from "../../../src/storage/config-store.js";
import { writeJsonAtomic } from "../../../src/storage/atomic-json.js";
import { AppError } from "../../../src/errors/app-error.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function tempConfigFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "nju-config-store-"));
  temporaryDirectories.push(dir);
  return path.join(dir, "config.json");
}

const valid: PersistedConfigV1 = {
  schemaVersion: 1,
  baseURL: "https://api.example.com/anthropic",
  model: "deepseek-v4-flash",
  permissionMode: "balanced",
};

describe("ConfigStore", () => {
  test("missing file returns undefined", async () => {
    const store = new ConfigStore(await tempConfigFile());
    expect(await store.load()).toBeUndefined();
  });

  test("save then load round-trips only allowed fields", async () => {
    const file = await tempConfigFile();
    const store = new ConfigStore(file);
    await store.save(valid);

    const loaded = await store.load();
    expect(loaded).toEqual(valid);
  });

  test("rejects an invalid schemaVersion with CONFIG_INVALID", async () => {
    const file = await tempConfigFile();
    await writeJsonAtomic(file, { ...valid, schemaVersion: 2 });
    const store = new ConfigStore(file);

    await expect(store.load()).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  test("rejects a blank Base URL, invalid model, or bad permission mode", async () => {
    const blank = await tempConfigFile();
    await writeJsonAtomic(blank, { ...valid, baseURL: "   " });
    await expect(new ConfigStore(blank).load()).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });

    const badModel = await tempConfigFile();
    await writeJsonAtomic(badModel, { ...valid, model: "" });
    await expect(new ConfigStore(badModel).load()).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });

    const badMode = await tempConfigFile();
    await writeJsonAtomic(badMode, { ...valid, permissionMode: "paranoid" });
    await expect(new ConfigStore(badMode).load()).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });

  test("never persists an apiKey field and rejects documents containing one", async () => {
    const file = await tempConfigFile();
    const store = new ConfigStore(file);
    await store.save(valid);

    const saved = await (await import("node:fs/promises")).readFile(file, "utf8");
    expect(saved).not.toContain("apiKey");

    await writeJsonAtomic(file, { ...valid, apiKey: "should-be-rejected" });
    await expect(store.load()).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  test("a pre-existing valid file remains valid when an injected atomic writer fails", async () => {
    const file = await tempConfigFile();
    const store = new ConfigStore(file);
    await store.save(valid);

    const failingWriter = async () => {
      throw new Error("disk full");
    };
    await expect(new ConfigStore(file, failingWriter).save(valid)).rejects.toThrow(
      "disk full",
    );

    const loaded = await store.load();
    expect(loaded).toEqual(valid);
    expect(loaded).toBeInstanceOf(Object);
  });

  test("wraps filesystem failures as AppError with CONFIG_INVALID", async () => {
    const file = await tempConfigFile();
    // Occupy the path with a file so the nested path is structurally invalid.
    await writeJsonAtomic(file, { placeholder: true });
    const store = new ConfigStore(path.join(file, "missing", "x.json"));
    await expect(store.load()).rejects.toBeInstanceOf(AppError);
  });
});
