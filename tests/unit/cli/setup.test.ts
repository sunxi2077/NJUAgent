import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runSetup } from "../../../src/cli/setup.js";
import { ConfigStore } from "../../../src/storage/config-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function tempConfigFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "nju-setup-"));
  temporaryDirectories.push(dir);
  return path.join(dir, "config.json");
}

class FakePrompt {
  reads: Array<string | null> = [];
  questions: string[] = [];
  confirmResults: boolean[] = [true];
  confirmQuestions: string[] = [];

  async read(_question: string): Promise<string | null> {
    this.questions.push(_question);
    return this.reads.shift() ?? null;
  }

  async confirm(question: string): Promise<boolean> {
    this.confirmQuestions.push(question);
    return this.confirmResults.shift() ?? false;
  }
}

describe("runSetup", () => {
  test("saves exactly Base URL, Model, and permission mode", async () => {
    const file = await tempConfigFile();
    const prompt = new FakePrompt();
    prompt.reads = ["https://api.example", "deepseek-v4-flash", "cautious"];

    const config = await runSetup({ prompt, store: new ConfigStore(file) });

    expect(config).toEqual({
      schemaVersion: 1,
      baseURL: "https://api.example",
      model: "deepseek-v4-flash",
      permissionMode: "cautious",
    });
    const saved = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(saved).toEqual({
      schemaVersion: 1,
      baseURL: "https://api.example",
      model: "deepseek-v4-flash",
      permissionMode: "cautious",
    });
    expect(saved).not.toHaveProperty("apiKey");
  });

  test("offers balanced, cautious, and trusted in the prompt", async () => {
    const file = await tempConfigFile();
    const prompt = new FakePrompt();
    prompt.reads = ["https://api.example", "deepseek-v4-flash", "trusted"];

    const config = await runSetup({ prompt, store: new ConfigStore(file) });

    expect(config?.permissionMode).toBe("trusted");
    expect(prompt.questions[2]).toContain("balanced");
    expect(prompt.questions[2]).toContain("cautious");
    expect(prompt.questions[2]).toContain("trusted");
    const saved = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(saved.permissionMode).toBe("trusted");
  });

  test("reprompts when the permission mode is invalid", async () => {
    const file = await tempConfigFile();
    const prompt = new FakePrompt();
    prompt.reads = [
      "https://api.example",
      "deepseek-v4-flash",
      "paranoid",
      "trusted",
    ];

    const config = await runSetup({ prompt, store: new ConfigStore(file) });

    expect(config?.permissionMode).toBe("trusted");
    // The invalid answer produced an extra read for the same question.
    expect(prompt.questions.filter((q) => q.includes("Permission mode"))).toHaveLength(2);
  });

  test("returns null and saves nothing when cancelled", async () => {
    const file = await tempConfigFile();
    const prompt = new FakePrompt();
    prompt.reads = [null];

    const config = await runSetup({ prompt, store: new ConfigStore(file) });

    expect(config).toBeNull();
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("returns null when the final confirmation is declined", async () => {
    const file = await tempConfigFile();
    const prompt = new FakePrompt();
    prompt.reads = ["https://api.example", "deepseek-v4-flash", "balanced"];
    prompt.confirmResults = [false];

    const config = await runSetup({ prompt, store: new ConfigStore(file) });

    expect(config).toBeNull();
    expect(prompt.confirmQuestions[0]).toContain("Save this configuration");
  });

  test("reprompts on blank input and on an invalid URL", async () => {
    const file = await tempConfigFile();
    const prompt = new FakePrompt();
    prompt.reads = [
      "",                       // blank URL -> reprompt
      "not-a-url",              // invalid URL -> reprompt
      "https://api.example",    // valid
      "   ",                    // blank model -> reprompt
      "deepseek-v4-flash",
      "balanced",
    ];

    const config = await runSetup({ prompt, store: new ConfigStore(file) });

    expect(config?.baseURL).toBe("https://api.example");
    expect(config?.model).toBe("deepseek-v4-flash");
  });

  test("never asks for or saves an API Key", async () => {
    const file = await tempConfigFile();
    const prompt = new FakePrompt();
    prompt.reads = ["https://api.example", "deepseek-v4-flash", "cautious"];

    await runSetup({ prompt, store: new ConfigStore(file) });

    expect(prompt.questions.join("\n")).not.toMatch(/api[_-]?key/iu);
    const saved = await readFile(file, "utf8");
    expect(saved).not.toMatch(/api[_-]?key/iu);
  });
});
