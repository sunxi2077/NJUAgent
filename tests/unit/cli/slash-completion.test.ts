import { describe, expect, test } from "vitest";

import { SlashCompletionModel } from "../../../src/cli/slash-completion.js";
import type { SlashCommandDescriptor } from "../../../src/cli/command.js";

function descriptor(name: string, description = `the ${name} command`): SlashCommandDescriptor {
  return { name, usage: `/${name}`, description };
}

const COMMANDS = [
  descriptor("help"),
  descriptor("status"),
  descriptor("sessions"),
  descriptor("resume"),
  descriptor("new"),
  descriptor("history"),
  descriptor("goal"),
  descriptor("plan"),
] as const;

describe("SlashCompletionModel", () => {
  test("open shows empty-prefix candidates in registration order, capped at 6", () => {
    const model = new SlashCompletionModel();
    const snapshot = model.open(COMMANDS);
    expect(snapshot.active).toBe(true);
    expect(snapshot.prefix).toBe("");
    expect(snapshot.selectedIndex).toBe(0);
    expect(snapshot.matches.map((match) => match.name)).toEqual([
      "help",
      "status",
      "sessions",
      "resume",
      "new",
      "history",
    ]);
    expect(snapshot.matches).toHaveLength(6);
  });

  test("updatePrefix filters case-insensitively", () => {
    const model = new SlashCompletionModel();
    model.open(COMMANDS);
    const go = model.updatePrefix("GO");
    expect(go.matches.map((match) => match.name)).toEqual(["goal"]);
    const g = model.updatePrefix("g");
    expect(g.matches.map((match) => match.name)).toEqual(["goal"]);
  });

  test("no matches yields selectedIndex -1 and selected undefined", () => {
    const model = new SlashCompletionModel();
    model.open(COMMANDS);
    const snapshot = model.updatePrefix("zzz");
    expect(snapshot.matches).toEqual([]);
    expect(snapshot.selectedIndex).toBe(-1);
    expect(model.selected()).toBeUndefined();
  });

  test("move wraps around the ends", () => {
    const model = new SlashCompletionModel();
    model.open([COMMANDS[0], COMMANDS[1], COMMANDS[2]] as readonly SlashCommandDescriptor[]);
    expect(model.move(1).selectedIndex).toBe(1);
    expect(model.move(1).selectedIndex).toBe(2);
    expect(model.move(1).selectedIndex).toBe(0);
    expect(model.move(-1).selectedIndex).toBe(2);
  });

  test("filtering preserves the selected command by name, not index", () => {
    const model = new SlashCompletionModel();
    model.open(COMMANDS);
    // Move down to /status (index 1).
    model.move(1);
    const filtered = model.updatePrefix("s");
    // /status is now the first match (index 0 in the new set) and stays selected.
    expect(filtered.matches.map((match) => match.name)).toEqual(["status", "sessions"]);
    expect(filtered.selectedIndex).toBe(0);
    expect(model.selected()?.name).toBe("status");
  });

  test("a disappearing selection resets to the first item", () => {
    const model = new SlashCompletionModel();
    model.open(COMMANDS);
    model.move(1);
    model.move(1);
    model.move(1); // /resume
    const filtered = model.updatePrefix("go");
    expect(filtered.matches.map((match) => match.name)).toEqual(["goal"]);
    expect(filtered.selectedIndex).toBe(0);
    expect(model.selected()?.name).toBe("goal");
  });

  test("close and reopen reset the selection", () => {
    const model = new SlashCompletionModel();
    model.open(COMMANDS);
    model.move(1);
    model.move(1);
    const closed = model.close();
    expect(closed.active).toBe(false);
    expect(closed.matches).toEqual([]);
    const reopened = model.open(COMMANDS);
    expect(reopened.selectedIndex).toBe(0);
  });

  test("snapshots, matches, and inputs never share mutable state", () => {
    const model = new SlashCompletionModel();
    const first = model.open(COMMANDS);
    const snapshot = model.snapshot();
    expect(first.matches).not.toBe(snapshot.matches);
    expect(first.matches[0]).not.toBe(snapshot.matches[0]);
    (snapshot.matches[0] as unknown as { name: string }).name = "mutated";
    expect(model.selected()?.name).toBe("help");
    // Mutating the caller's descriptor array must not affect the model.
    const injected = [descriptor("injected")] as Array<{ name: string; usage: string; description: string }>;
    model.open(injected);
    injected[0]!.name = "changed";
    expect(model.snapshot().matches[0]!.name).toBe("injected");
  });

  test.each([
    [0, "zero"],
    [-1, "negative"],
    [1.5, "non-integer"],
  ])("rejects maxVisible %s", (maxVisible, _label) => {
    expect(() => new SlashCompletionModel({ maxVisible })).toThrow(RangeError);
  });

  test.each([
    ["", "empty string is legal"],
    ["go", "legal prefix"],
    ["GO", "case preserved but legal"],
    ["goal-1", "dash legal"],
  ])("accepts prefix %s", (prefix) => {
    const model = new SlashCompletionModel();
    model.open(COMMANDS);
    expect(() => model.updatePrefix(prefix)).not.toThrow();
  });

  test.each([
    ["go ", "space"],
    ["/go", "slash"],
    ["完成", "CJK"],
    ["go!", "symbol"],
  ])("rejects illegal prefix %s", (prefix) => {
    const model = new SlashCompletionModel();
    model.open(COMMANDS);
    expect(() => model.updatePrefix(prefix)).toThrow(TypeError);
  });

  test("move is a no-op when inactive or with no matches", () => {
    const model = new SlashCompletionModel();
    expect(model.move(1)).toMatchObject({ active: false });
    model.open(COMMANDS);
    model.updatePrefix("zzz");
    const before = model.snapshot();
    model.move(1);
    expect(model.snapshot()).toEqual(before);
  });

  test("open and close reset the selection", () => {
    const model = new SlashCompletionModel();
    model.open(COMMANDS);
    model.move(1);
    model.move(1);
    model.move(1);
    const afterOpen = model.open(COMMANDS);
    expect(afterOpen.selectedIndex).toBe(0);
  });
});
