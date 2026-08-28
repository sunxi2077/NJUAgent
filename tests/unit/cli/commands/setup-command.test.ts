import { describe, expect, test } from "vitest";

import type { CommandContext } from "../../../../src/cli/command.js";
import { createSetupCommand } from "../../../../src/cli/commands/setup-command.js";
import type { Renderer } from "../../../../src/cli/renderer.js";
import { createTheme } from "../../../../src/cli/theme.js";
import { AppError } from "../../../../src/errors/app-error.js";

class MemoryRenderer implements Renderer {
  readonly printed: string[] = [];
  readonly errors: string[] = [];
  handle(): void {}
  toolOutput(): void {}
  print(text: string): void { this.printed.push(text); }
  error(message: string): void { this.errors.push(message); }
}

function context(runSetup: () => Promise<boolean>): CommandContext {
  const renderer = new MemoryRenderer();
  return {
    renderer,
    theme: createTheme({ enabled: false }),
    signal: new AbortController().signal,
    runSetup,
    sessionManager: {} as CommandContext["sessionManager"],
    store: {} as CommandContext["store"],
    skillRegistry: {} as CommandContext["skillRegistry"],
  };
}

describe("/setup", () => {
  test("reports a successful in-process reconfiguration", async () => {
    const command = createSetupCommand();
    const ctx = context(async () => true);

    const result = await command.execute("", ctx);

    expect(result).toEqual({ kind: "continue", stateChanged: true });
    expect((ctx.renderer as MemoryRenderer).printed[0]).toContain("Configuration updated");
  });

  test("treats cancellation as an unchanged session", async () => {
    const command = createSetupCommand();
    const ctx = context(async () => false);

    const result = await command.execute("", ctx);

    expect(result).toEqual({ kind: "continue", stateChanged: false });
    expect((ctx.renderer as MemoryRenderer).printed[0]).toContain("cancelled");
  });

  test("formats setup failures without terminating the CLI", async () => {
    const command = createSetupCommand();
    const ctx = context(async () => {
      throw new AppError({ code: "CONFIG_INVALID", userMessage: "bad model" });
    });

    const result = await command.execute("", ctx);

    expect(result).toEqual({ kind: "continue", stateChanged: false });
    expect((ctx.renderer as MemoryRenderer).errors[0]).toContain("[CONFIG_INVALID]");
  });
});
