import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

import type { Prompt, ReadlinePromptOptions } from "../../src/cli/prompt.js";
import { TerminalRenderer, type TerminalRendererOptions } from "../../src/cli/renderer.js";
import { isDirectRun, main, type BootstrapDeps } from "../../src/index.js";

const temporaryDirectories: string[] = [];

test("recognizes a symlinked executable as a direct run", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "nju-entry-"));
  temporaryDirectories.push(directory);
  const target = path.join(directory, "index.js");
  const link = path.join(directory, "njuagent");
  await writeFile(target, "#!/usr/bin/env node\n");
  await symlink(target, link);

  expect(isDirectRun(pathToFileURL(target).href, link)).toBe(true);
});

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
  closeCalls = 0;
  readonly promptTexts: string[] = [];

  read(promptText: string): Promise<string | null> {
    this.promptTexts.push(promptText);
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
  close(): void {
    this.closeCalls += 1;
  }
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
    const { deps, stderr, home, prompt } = await makeDeps({
      env: {
        ANTHROPIC_BASE_URL: "https://api.example.com/anthropic",
        MODEL_ID: "deepseek-v4-flash",
      },
    });

    const exitCode = await main(deps);

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("CONFIG_MISSING_API_KEY");
    expect(stderr.text()).toContain("ANTHROPIC_API_KEY");
    expect(prompt.closeCalls).toBe(1);
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
    expect(prompt.closeCalls).toBe(1);
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
    // Disabled theme is identity: the user anchor arrives without ANSI.
    expect(prompt.promptTexts[0]).toBe("❯ You  ");
  });

  test("--permission-mode trusted flows into the session welcome", async () => {
    const { deps, stdout, prompt } = await makeDeps({
      argv: ["--permission-mode", "trusted"],
    });
    prompt.reads = [null];

    const exitCode = await main(deps);

    expect(exitCode).toBe(0);
    const text = stdout.text();
    expect(text).toContain("permission mode: trusted");
    expect(text).toContain("fewer prompts for a workspace you trust");
    expect(text).toContain("outside-workspace and high");
  });

  test("a real TTY clears the screen once before the welcome panel", async () => {
    const { deps, stdout, prompt } = await makeDeps({ isTTY: true });
    prompt.reads = [null];

    const exitCode = await main(deps);

    expect(exitCode).toBe(0);
    const text = stdout.text();
    // Clear sequence (visible area only, cursor home) precedes the panel and
    // appears exactly once per process start.
    expect(text.match(/\x1b\[2J\x1b\[H/gu)).toHaveLength(1);
    expect(text.indexOf("\x1b[2J\x1b[H")).toBeLessThan(text.indexOf("NJUAgent"));
    // TTY theme styles the anchor; stripping ANSI still yields the same text.
    expect(prompt.promptTexts[0]).toContain("\x1b[");
    expect(prompt.promptTexts[0]!.replace(/\x1b\[[0-9;]*m/gu, "")).toBe("❯ You  ");
  });

  test("NO_COLOR disables the clear sequence even on a TTY", async () => {
    const { deps, stdout, prompt } = await makeDeps({
      isTTY: true,
      env: {
        ANTHROPIC_API_KEY: "key",
        ANTHROPIC_BASE_URL: "https://api.example.com/anthropic",
        MODEL_ID: "deepseek-v4-flash",
        NO_COLOR: "1",
      },
    });
    prompt.reads = [null];

    await main(deps);

    expect(stdout.text()).not.toContain("\x1b[2J");
  });

  test("TERM=dumb disables the clear sequence even on a TTY", async () => {
    const { deps, stdout, prompt } = await makeDeps({
      isTTY: true,
      env: {
        ANTHROPIC_API_KEY: "key",
        ANTHROPIC_BASE_URL: "https://api.example.com/anthropic",
        MODEL_ID: "deepseek-v4-flash",
        TERM: "dumb",
      },
    });
    prompt.reads = [null];

    await main(deps);

    expect(stdout.text()).not.toContain("\x1b[2J");
  });

  test.each([
    ["interactive TTY", { isTTY: true, env: { ANTHROPIC_API_KEY: "key", ANTHROPIC_BASE_URL: "https://api.example.com/anthropic", MODEL_ID: "deepseek-v4-flash" } }, true ],
    ["NO_COLOR", { isTTY: true, env: { ANTHROPIC_API_KEY: "key", ANTHROPIC_BASE_URL: "https://api.example.com/anthropic", MODEL_ID: "deepseek-v4-flash", NO_COLOR: "1" } }, false ],
    ["TERM=dumb", { isTTY: true, env: { ANTHROPIC_API_KEY: "key", ANTHROPIC_BASE_URL: "https://api.example.com/anthropic", MODEL_ID: "deepseek-v4-flash", TERM: "dumb" } }, false ],
    ["non-TTY", { isTTY: false, env: { ANTHROPIC_API_KEY: "key", ANTHROPIC_BASE_URL: "https://api.example.com/anthropic", MODEL_ID: "deepseek-v4-flash" } }, false ],
  ] as const)("bootstraps one %s mode shared by prompt and renderer", async (_label, opts, enhanced) => {
    const promptOptions: ReadlinePromptOptions[] = [];
    const rendererOptions: TerminalRendererOptions[] = [];
    const prompt = new FakePrompt();
    const { deps, stdout } = await makeDeps({
      isTTY: opts.isTTY,
      env: opts.env,
      promptFactory: (options) => {
        promptOptions.push(options);
        return prompt;
      },
      rendererFactory: (options) => {
        rendererOptions.push(options);
        return new TerminalRenderer(options);
      },
    });
    prompt.reads = [null];
    await main(deps);

    expect(promptOptions).toHaveLength(1);
    expect(rendererOptions).toHaveLength(1);
    expect(promptOptions[0]!.enhanced).toBe(enhanced);
    expect(promptOptions[0]!.theme?.enabled).toBe(enhanced);
    expect(rendererOptions[0]!.theme).toBe(promptOptions[0]!.theme);
    expect(promptOptions[0]!.theme?.enabled).toBe(promptOptions[0]!.enhanced);
    // Columns come from stdout; MemoryWriter has none, so it must stay unset.
    expect(promptOptions[0]!.columns).toBeUndefined();
  });
});
