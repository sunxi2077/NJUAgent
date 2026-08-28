import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import type { Prompt } from "../../src/cli/prompt.js";
import { main, type BootstrapDeps } from "../../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

class MemoryWriter {
  readonly chunks: string[] = [];
  isTTY = false;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  text(): string {
    return this.chunks.join("");
  }
}

class FakePrompt implements Prompt {
  reads: Array<string | null> = [];
  confirmResult = true;
  readCalls = 0;

  read(_promptText: string): Promise<string | null> {
    this.readCalls += 1;
    return Promise.resolve(this.reads.shift() ?? null);
  }

  confirm(_question: string): Promise<boolean> {
    return Promise.resolve(this.confirmResult);
  }

  onSigint(_handler: () => void): void {}
  interrupt(): void {}
  suspendForOutput(): void {}
  resumeAfterOutput(): void {}
  close(): void {}
}

type Overrides = Partial<Omit<BootstrapDeps, "env" | "argv" | "stdout" | "stderr">> & {
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
};

async function makeDeps(overrides: Overrides = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "nju-bootstrap-"));
  temporaryDirectories.push(home);
  const workspaceDir = await mkdtemp(path.join(tmpdir(), "nju-bootstrap-work-"));
  temporaryDirectories.push(workspaceDir);
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  const prompt = new FakePrompt();
  const deps: BootstrapDeps = {
    env: {
      ANTHROPIC_API_KEY: "key",
      ANTHROPIC_BASE_URL: "https://api.example.com/anthropic",
      MODEL_ID: "deepseek-v4-flash",
    },
    argv: [],
    cwd: workspaceDir,
    homeDirectory: home,
    stdin: new Readable({ read() {} }),
    stdout: stdout as unknown as NodeJS.WritableStream,
    stderr: stderr as unknown as NodeJS.WritableStream,
    isTTY: false,
    promptFactory: () => prompt,
    ...overrides,
  };
  return { deps, stdout, stderr, prompt, home, workspaceDir };
}

describe("bootstrap", () => {
  test("--help returns 0 without loading configuration or API Key", async () => {
    const { deps, stdout } = await makeDeps({ env: {}, argv: ["--help"] });
    const exitCode = await main(deps);
    expect(exitCode).toBe(0);
    expect(stdout.text()).toContain("Usage:");
  });

  test("missing Base URL/Model in TTY invokes setup, saves config, then validates API Key", async () => {
    const { deps, stderr, prompt, home } = await makeDeps({
      env: {},
      isTTY: true,
    });
    prompt.reads = ["https://api.example", "deepseek-v4-flash", "balanced"];

    const exitCode = await main(deps);

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("CONFIG_MISSING_API_KEY");
    expect(stderr.text()).toContain("ANTHROPIC_API_KEY");

    const saved = JSON.parse(
      await readFile(path.join(home, ".nju-agent", "config.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(saved).toEqual({
      schemaVersion: 1,
      baseURL: "https://api.example",
      model: "deepseek-v4-flash",
      permissionMode: "balanced",
    });
    expect(saved).not.toHaveProperty("apiKey");
  });

  test("missing API Key prints CONFIG_MISSING_API_KEY and returns 1 without saving a key", async () => {
    const { deps, stderr, home } = await makeDeps({
      env: {
        ANTHROPIC_BASE_URL: "https://api.example.com/anthropic",
        MODEL_ID: "deepseek-v4-flash",
      },
    });

    const exitCode = await main(deps);

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("CONFIG_MISSING_API_KEY");
    expect(stderr.text()).toContain("ANTHROPIC_API_KEY");
    await expect(readFile(path.join(home, "config.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("non-TTY incomplete config returns 1 without prompting", async () => {
    const { deps, stderr, prompt } = await makeDeps({
      env: { ANTHROPIC_API_KEY: "key" },
    });

    const exitCode = await main(deps);

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("ANTHROPIC_BASE_URL");
    expect(prompt.readCalls).toBe(0);
  });

  test("valid config prints the welcome panel exactly once before the session ends", async () => {
    const { deps, stdout, prompt } = await makeDeps({});
    prompt.reads = [null];

    const exitCode = await main(deps);

    expect(exitCode).toBe(0);
    const text = stdout.text();
    expect(text).toContain("NJUAgent");
    expect(text).toContain("workspace");
    expect(text).toContain("model");
    expect(text).toContain("[session]");
    expect(text.match(/NJUAgent/gu)).toHaveLength(1);
    expect(text).not.toContain("\x1b[");
    expect(prompt.readCalls).toBeGreaterThan(0);
  });
});
