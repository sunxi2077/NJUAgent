import { describe, expect, test } from "vitest";

import { SlashCompletionModel } from "../../../src/cli/slash-completion.js";
import type { SlashCommandDescriptor } from "../../../src/cli/command.js";

function descriptor(name: string, description = `${name} command`): SlashCommandDescriptor {
  return { name, usage: `/${name}`, description };
}

const FOURTEEN_COMMANDS = [
  "help", "status", "sessions", "resume", "new", "history", "context",
  "compact", "plan", "goal", "skills", "skill", "setup", "exit",
].map((name) => descriptor(name));

describe("SlashCompletionModel", () => {
  test("open keeps every match and exposes a six-row window", () => {
    const model = new SlashCompletionModel({ pageSize: 6 });
    const state = model.open(FOURTEEN_COMMANDS);
    expect(state.matches).toHaveLength(14);
    expect(state.totalMatches).toBe(14);
    expect(state.windowStart).toBe(0);
    expect(state.visibleMatches.map(({ name }) => name)).toEqual([
      "help", "status", "sessions", "resume", "new", "history",
    ]);
  });

  test("moving beyond the window scrolls it and wraps at the ends", () => {
    const model = new SlashCompletionModel({ pageSize: 6 });
    model.open(FOURTEEN_COMMANDS);
    for (let index = 0; index < 6; index += 1) {
      model.move(1);
    }
    expect(model.snapshot().selectedIndex).toBe(6);
    expect(model.snapshot().windowStart).toBe(1);
    expect(model.snapshot().visibleMatches.at(-1)?.name).toBe("context");

    for (let index = 6; index < 13; index += 1) {
      model.move(1);
    }
    expect(model.selected()?.name).toBe("exit");
    expect(model.snapshot().windowStart).toBe(8);

    model.move(1);
    expect(model.selected()?.name).toBe("help");
    expect(model.snapshot().windowStart).toBe(0);

    model.move(-1);
    expect(model.selected()?.name).toBe("exit");
    expect(model.snapshot().windowStart).toBe(8);
  });

  test("every one of the fourteen commands is reachable by selection", () => {
    const model = new SlashCompletionModel({ pageSize: 6 });
    model.open(FOURTEEN_COMMANDS);
    const reached: string[] = [];
    for (let index = 0; index < 14; index += 1) {
      reached.push(model.selected()?.name ?? "");
      model.move(1);
    }
    expect(reached).toEqual(FOURTEEN_COMMANDS.map((command) => command.name));
  });

  test("updatePrefix filters case-insensitively over all matches", () => {
    const model = new SlashCompletionModel({ pageSize: 6 });
    model.open(FOURTEEN_COMMANDS);
    const state = model.updatePrefix("g");
    expect(state.matches.map(({ name }) => name)).toEqual(["goal"]);
    expect(state.totalMatches).toBe(1);
    expect(state.visibleMatches.map(({ name }) => name)).toEqual(["goal"]);
    expect(state.selectedIndex).toBe(0);
    expect(state.windowStart).toBe(0);
  });

  test("filtering preserves the selected command by name when it still matches", () => {
    const model = new SlashCompletionModel({ pageSize: 6 });
    model.open(FOURTEEN_COMMANDS);
    // Move down to /status (index 1).
    model.move(1);
    const filtered = model.updatePrefix("s");
    expect(filtered.matches.map(({ name }) => name)).toEqual([
      "status",
      "sessions",
      "skills",
      "skill",
      "setup",
    ]);
    // /status is now the first match and stays selected.
    expect(filtered.selectedIndex).toBe(0);
    expect(model.selected()?.name).toBe("status");
  });

  test("a disappearing selection resets to the first item and the window top", () => {
    const model = new SlashCompletionModel({ pageSize: 6 });
    model.open(FOURTEEN_COMMANDS);
    model.move(1);
    model.move(1);
    model.move(1); // /resume
    const filtered = model.updatePrefix("go");
    expect(filtered.matches.map(({ name }) => name)).toEqual(["goal"]);
    expect(filtered.selectedIndex).toBe(0);
    expect(filtered.windowStart).toBe(0);
    expect(model.selected()?.name).toBe("goal");
  });

  test("no matches yields selectedIndex -1 and an empty window", () => {
    const model = new SlashCompletionModel({ pageSize: 6 });
    model.open(FOURTEEN_COMMANDS);
    const state = model.updatePrefix("zzz");
    expect(state.matches).toEqual([]);
    expect(state.totalMatches).toBe(0);
    expect(state.selectedIndex).toBe(-1);
    expect(state.windowStart).toBe(0);
    expect(state.visibleMatches).toEqual([]);
    expect(model.selected()).toBeUndefined();
  });

  test("close and reopen reset both match sets and the selection", () => {
    const model = new SlashCompletionModel({ pageSize: 6 });
    model.open(FOURTEEN_COMMANDS);
    model.move(1);
    model.move(1);
    const closed = model.close();
    expect(closed.active).toBe(false);
    expect(closed.matches).toEqual([]);
    expect(closed.visibleMatches).toEqual([]);
    expect(closed.windowStart).toBe(0);
    const reopened = model.open(FOURTEEN_COMMANDS);
    expect(reopened.selectedIndex).toBe(0);
    expect(reopened.windowStart).toBe(0);
  });

  test("snapshots, both match arrays, and inputs never share mutable state", () => {
    const model = new SlashCompletionModel({ pageSize: 6 });
    const first = model.open(FOURTEEN_COMMANDS);
    const snapshot = model.snapshot();
    expect(first.matches).not.toBe(snapshot.matches);
    expect(first.visibleMatches).not.toBe(snapshot.visibleMatches);
    expect(first.matches[0]).not.toBe(snapshot.matches[0]);
    (snapshot.matches[0] as unknown as { name: string }).name = "mutated";
    expect(model.selected()?.name).toBe("help");
    // Mutating the caller's descriptor array must not affect the model.
    const injected = [descriptor("injected")] as Array<{
      name: string;
      usage: string;
      description: string;
    }>;
    model.open(injected);
    injected[0]!.name = "changed";
    expect(model.snapshot().matches[0]!.name).toBe("injected");
  });

  test.each([
    [0, "zero"],
    [-1, "negative"],
    [1.5, "non-integer"],
  ])("rejects pageSize %s", (pageSize, _label) => {
    expect(() => new SlashCompletionModel({ pageSize })).toThrow(RangeError);
  });

  test.each([
    ["", "empty string is legal"],
    ["go", "legal prefix"],
    ["GO", "case preserved but legal"],
    ["goal-1", "dash legal"],
  ])("accepts prefix %s", (prefix) => {
    const model = new SlashCompletionModel({ pageSize: 6 });
    model.open(FOURTEEN_COMMANDS);
    expect(() => model.updatePrefix(prefix)).not.toThrow();
  });

  test.each([
    ["go ", "space"],
    ["/go", "slash"],
    ["完成", "CJK"],
    ["go!", "symbol"],
  ])("rejects illegal prefix %s", (prefix) => {
    const model = new SlashCompletionModel({ pageSize: 6 });
    model.open(FOURTEEN_COMMANDS);
    expect(() => model.updatePrefix(prefix)).toThrow(TypeError);
  });

  test("move is a no-op when inactive or with no matches", () => {
    const model = new SlashCompletionModel({ pageSize: 6 });
    expect(model.move(1)).toMatchObject({ active: false });
    model.open(FOURTEEN_COMMANDS);
    model.updatePrefix("zzz");
    const before = model.snapshot();
    model.move(1);
    expect(model.snapshot()).toEqual(before);
  });
});
