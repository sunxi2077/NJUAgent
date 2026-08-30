# Slash Command Palette Stabilization Implementation Plan

> **Implementation correction:** Task 2 原定的 cursor-down Presenter 在真实终端底部会触发滚屏，已被后续实现纠正为“菜单位于输入行上方的 live region”。最终行为以对应设计规格第 8 节和当前代码为准；不要重新执行 Task 2 中的 cursor-down 步骤。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 Slash Command Palette 在真实 TTY 中命令被截断、输入后不刷新、错误补全、菜单清除错位和异步异常逃逸的问题。

**Architecture:** `SlashCompletionModel` 保存全部匹配并输出 6 行滚动视窗；`ReadlinePrompt` 在 keypress handler 内同步维护受限 ASCII 命令前缀，不再通过 microtask 读取 readline；`SlashMenuPresenter` 始终从输入行向下绘制和清除。真实 Node stream/readline 集成测试覆盖 FakeReadline 未发现的时序边界。

**Tech Stack:** TypeScript、Node.js `readline` / streams / ANSI、Vitest、现有 terminal-width 和 theme 工具；不增加运行时依赖。

**Spec:** [`docs/superpowers/specs/2026-08-30-slash-command-palette-stabilization-design.md`](../specs/2026-08-30-slash-command-palette-stabilization-design.md)

## Global Constraints

- 修复基线为 `feat/slash-command-palette` 的 `61da68e`；开始前确认没有覆盖用户未提交改动。
- 每个 Task 严格先写失败测试、确认失败原因、实现最小修复、运行测试、提交。
- 不使用 sleep、timer、`setImmediate` 或 `queueMicrotask` 修复生产逐键状态同步。
- Palette 只维护行首 `/` 后、首个空格前的 ASCII 命令名；完整输入仍由 readline 维护。
- `pageSize=6` 只限制可见候选，不能截断全部 matches。
- 不修改 Agent Loop、Session schema、权限、命令执行语义或模型历史。
- 不新增运行时依赖，不引入 TUI 框架，不重写 readline。
- 未识别输入 fail-open 到 readline；不得记录 raw key、中文参数或粘贴内容。
- non-TTY、`NO_COLOR`、`TERM=dumb` 保持普通 readline。
- Vitest 出现 unhandled error 即失败，即使 assertion 全部通过。
- 每个 Task 完成后检查 diff、运行指定测试并独立提交。

---

## Task 1: 将截断匹配改成全量匹配和滚动视窗

**Files:**

- Modify: `src/cli/slash-completion.ts`
- Modify: `tests/unit/cli/slash-completion.test.ts`

**Interfaces:**

- Consumes: `SlashCommandDescriptor`
- Produces:

```ts
export type SlashCompletionSnapshot = {
  active: boolean;
  prefix: string;
  selectedIndex: number;
  windowStart: number;
  totalMatches: number;
  matches: readonly SlashCommandDescriptor[];
  visibleMatches: readonly SlashCommandDescriptor[];
};

export class SlashCompletionModel {
  constructor(options?: { pageSize?: number });
  open(commands: readonly SlashCommandDescriptor[]): SlashCompletionSnapshot;
  updatePrefix(prefix: string): SlashCompletionSnapshot;
  move(delta: -1 | 1): SlashCompletionSnapshot;
  selected(): SlashCommandDescriptor | undefined;
  close(): SlashCompletionSnapshot;
  snapshot(): SlashCompletionSnapshot;
}
```

- [ ] **Step 1: 建立 14 个核心命令的测试数据**

```ts
const FOURTEEN_COMMANDS = [
  "help", "status", "sessions", "resume", "new", "history", "context",
  "compact", "plan", "goal", "skills", "skill", "setup", "exit",
].map((name) => ({
  name,
  usage: `/${name}`,
  description: `${name} command`,
}));
```

- [ ] **Step 2: 写首次 open 的失败测试**

```ts
const model = new SlashCompletionModel({ pageSize: 6 });
const state = model.open(FOURTEEN_COMMANDS);
expect(state.matches).toHaveLength(14);
expect(state.totalMatches).toBe(14);
expect(state.windowStart).toBe(0);
expect(state.visibleMatches.map(({ name }) => name)).toEqual([
  "help", "status", "sessions", "resume", "new", "history",
]);
```

- [ ] **Step 3: 写移动视窗和首尾循环的失败测试**

```ts
for (let index = 0; index < 6; index += 1) model.move(1);
expect(model.snapshot().selectedIndex).toBe(6);
expect(model.snapshot().windowStart).toBe(1);
expect(model.snapshot().visibleMatches.at(-1)?.name).toBe("context");

for (let index = 6; index < 13; index += 1) model.move(1);
expect(model.selected()?.name).toBe("exit");
expect(model.snapshot().windowStart).toBe(8);
model.move(1);
expect(model.selected()?.name).toBe("help");
expect(model.snapshot().windowStart).toBe(0);
model.move(-1);
expect(model.selected()?.name).toBe("exit");
expect(model.snapshot().windowStart).toBe(8);
```

- [ ] **Step 4: 写过滤和不变量测试**

覆盖：`updatePrefix("g")` 只匹配 goal；清空 prefix 后按 command name 保留选择；选中项消失时回到第一项；无匹配时 selectedIndex=-1/windowStart=0；close 清空两类 matches；两类数组和 descriptor 都是防御性副本；非法 pageSize 抛 RangeError。

- [ ] **Step 5: 运行并确认当前实现 Red**

```bash
npx vitest run tests/unit/cli/slash-completion.test.ts
```

Expected：缺少新字段/constructor 参数，或 matches 仍只有 6 条。

- [ ] **Step 6: 实现全量过滤和视窗字段**

```ts
readonly #pageSize: number;
#windowStart = 0;

#matches(): readonly SlashCommandDescriptor[] {
  if (!this.#active) return [];
  const prefix = this.#prefix.toLowerCase();
  return this.#commands.filter((command) =>
    command.name.toLowerCase().startsWith(prefix)
  );
}
```

删除旧 `maxVisible` 和 `slice(0, maxVisible)`。

- [ ] **Step 7: 实现选中项可见性校正**

```ts
#fitWindow(total: number): void {
  if (total === 0 || this.#selectedIndex < 0) {
    this.#windowStart = 0;
    return;
  }
  if (this.#selectedIndex < this.#windowStart) {
    this.#windowStart = this.#selectedIndex;
  } else if (this.#selectedIndex >= this.#windowStart + this.#pageSize) {
    this.#windowStart = this.#selectedIndex - this.#pageSize + 1;
  }
  this.#windowStart = Math.min(
    this.#windowStart,
    Math.max(0, total - this.#pageSize),
  );
}
```

`move()`、`updatePrefix()`、`open()` 重建选择后都调用它。

- [ ] **Step 8: 实现 snapshot**

```ts
snapshot(): SlashCompletionSnapshot {
  const matches = this.#matches().map((item) => this.#copy(item));
  const visibleMatches = matches
    .slice(this.#windowStart, this.#windowStart + this.#pageSize)
    .map((item) => this.#copy(item));
  return {
    active: this.#active,
    prefix: this.#prefix,
    selectedIndex: this.#selectedIndex,
    windowStart: this.#windowStart,
    totalMatches: matches.length,
    matches,
    visibleMatches,
  };
}
```

`selected()` 使用全部 matches 的绝对 selectedIndex。

- [ ] **Step 9: 验证并提交**

```bash
npx vitest run tests/unit/cli/slash-completion.test.ts
npm run typecheck
rg -n "maxVisible" src/cli/slash-completion.ts tests/unit/cli/slash-completion.test.ts
git diff --check
git add src/cli/slash-completion.ts tests/unit/cli/slash-completion.test.ts
git commit -m "fix: keep all slash command matches"
```

`rg` 应无命中。

---

## Task 2: 修复菜单视窗、范围提示和清除坐标

**Files:**

- Modify: `src/cli/slash-menu.ts`
- Modify: `tests/unit/cli/slash-menu.test.ts`

**Interfaces:**

- Consumes: Task 1 的 `visibleMatches/windowStart/totalMatches`
- Produces: 保持 `formatSlashMenu()`、`SlashMenuPresenterPort` 和 constructor 公共签名不变

- [ ] **Step 1: 更新测试 snapshot builder**

```ts
function snapshot(overrides: Partial<SlashCompletionSnapshot> = {}) {
  const matches = FOURTEEN_COMMANDS;
  return {
    active: true,
    prefix: "",
    selectedIndex: 0,
    windowStart: 0,
    totalMatches: matches.length,
    matches,
    visibleMatches: matches.slice(0, 6),
    ...overrides,
  } satisfies SlashCompletionSnapshot;
}
```

- [ ] **Step 2: 写视窗和 footer 失败测试**

```ts
const text = formatSlashMenu(snapshot(), { columns: 80, theme })
  .map(stripVTControlCharacters).join("\n");
expect(text).toContain("/help");
expect(text).toContain("/history");
expect(text).not.toContain("/context");
expect(text).toContain("1–6 / 14");
```

再测 windowStart=6、selectedIndex=7、visibleMatches=matches.slice(6,12) 时 footer=`7–12 / 14`，选中标记位于可见第二行。

- [ ] **Step 3: 写向下清除的失败测试**

```ts
presenter.render(snapshot());
const before = output.text().length;
presenter.clear();
const delta = output.text().slice(before);
expect(delta).toContain("\x1b[s");
expect(delta).toContain("\x1b[1B\r\x1b[2K");
expect(delta).toContain("\x1b[u");
expect(delta).not.toContain("\x1b[A");
```

- [ ] **Step 4: 运行并确认 Red**

```bash
npx vitest run tests/unit/cli/slash-menu.test.ts
```

- [ ] **Step 5: formatter 改用 visibleMatches 和绝对下标**

```ts
const absoluteIndex = snapshot.windowStart + visibleIndex;
const selected = absoluteIndex === snapshot.selectedIndex;
```

增加：

```ts
function formatRange(snapshot: SlashCompletionSnapshot): string {
  if (snapshot.totalMatches === 0) return "0 commands";
  if (snapshot.totalMatches <= snapshot.visibleMatches.length) {
    return `${snapshot.totalMatches} commands`;
  }
  const start = snapshot.windowStart + 1;
  const end = snapshot.windowStart + snapshot.visibleMatches.length;
  return `${start}–${end} / ${snapshot.totalMatches}`;
}
```

完整 footer 添加该范围；compact footer 使用无空格范围。

- [ ] **Step 6: 重写 draw 和 clear**

```ts
const ANSI_CURSOR_DOWN_ONE = "\x1b[1B";
const ANSI_CLEAR_ENTIRE_LINE = "\x1b[2K";

#draw(lines: readonly string[]): void {
  this.#clearRows();
  if (lines.length === 0) return;
  this.#output.write(ANSI_SAVE_CURSOR);
  for (const line of lines) {
    this.#output.write(
      `${ANSI_CURSOR_DOWN_ONE}\r${ANSI_CLEAR_ENTIRE_LINE}${line}`,
    );
  }
  this.#output.write(ANSI_RESTORE_CURSOR);
  this.#lastRows = lines.length;
}

#clearRows(): void {
  if (this.#lastRows === 0) return;
  this.#output.write(ANSI_SAVE_CURSOR);
  for (let index = 0; index < this.#lastRows; index += 1) {
    this.#output.write(
      `${ANSI_CURSOR_DOWN_ONE}\r${ANSI_CLEAR_ENTIRE_LINE}`,
    );
  }
  this.#output.write(ANSI_RESTORE_CURSOR);
  this.#lastRows = 0;
}
```

生产 Presenter 删除 cursor-up 和 `\r\n` 定位。

- [ ] **Step 7: 隔离 resize 异常**

增加 `#disabled`。resize listener 内同步捕获 format/write 错误，清空内存状态、移除 listener、禁用后续 render；禁用过程不能再次调用可能失败的 output.write。

- [ ] **Step 8: 写异常测试**

FakeOutput 在 `throwOnWrite=true` 时抛错。触发 resize 后断言：resize 不抛、listener 被移除、后续 render/clear 不再 write、无 unhandled error。

- [ ] **Step 9: 验证并提交**

```bash
npx vitest run tests/unit/cli/slash-menu.test.ts
npm run typecheck
rg -n "CURSOR_UP|\\\\x1b\\[A" src/cli/slash-menu.ts
git diff --check
git add src/cli/slash-menu.ts tests/unit/cli/slash-menu.test.ts
git commit -m "fix: scroll and clear slash menu safely"
```

生产文件的 `rg` 应无命中。

---

## Task 3: 用同步受限前缀替代 microtask 状态同步

**Files:**

- Modify: `src/cli/prompt.ts`
- Modify: `tests/unit/cli/prompt.test.ts`
- Modify: `tests/integration/slash-palette.test.ts`

**Interfaces:**

- Consumes: Tasks 1–2 的 Model/Presenter
- Produces: `Prompt` 和 `ReadlinePromptOptions` 公共签名不变；删除私有 `#syncSlashState()`

- [ ] **Step 1: 让 `/go` 测试即时断言**

```ts
pressText(router, "/");
expect(presenter.renders.at(-1)?.prefix).toBe("");
pressText(router, "g");
expect(presenter.renders.at(-1)?.prefix).toBe("g");
expect(presenter.renders.at(-1)?.visibleMatches.map(({ name }) => name))
  .toEqual(["goal"]);
pressText(router, "o");
expect(presenter.renders.at(-1)?.prefix).toBe("go");
```

这些断言前不能 `await Promise.resolve()`。

- [ ] **Step 2: 写 stale readline 失败测试**

FakeReadline 在 handler 返回 forward 之前保持旧 line。依次 press `/`、`g`、Enter，断言补全 `/goal `，不能是 `/help `。当前实现应失败。

- [ ] **Step 3: 写 Backspace/chunk/paste 失败测试**

覆盖：`/go` Backspace 立即变 prefix=g；`/` Backspace 关闭；单次 `/go` 在空行打开 goal；单次 `/goal 完成测试` 不打开且完整 forward；active 时单次 `al` 从 go 变 goal；中文、空格、第二个 `/`、Left、Ctrl-A 关闭并 forward。

- [ ] **Step 4: 运行并确认 Red**

```bash
npx vitest run tests/unit/cli/prompt.test.ts tests/integration/slash-palette.test.ts
```

- [ ] **Step 5: 删除异步同步实现**

删除三处 Palette `queueMicrotask`、私有 `#syncSlashState()` 和 active 状态逐键读取 readline line/cursor 的逻辑。`#currentLine/#currentCursor` 只用于 inactive 时确认从空行开始。

- [ ] **Step 6: 同步打开 Palette**

```ts
const COMMAND_CHUNK = /^[a-zA-Z0-9-]+$/u;
const COMPLETE_COMMAND_SEQUENCE = /^\/([a-zA-Z0-9-]*)$/u;

#openPalette(prefix: string): void {
  const commands = this.#readOptions?.slashCommands;
  if (commands === undefined || commands.length === 0) return;
  this.#completion.open(commands);
  this.#slashMode = "active";
  this.#completion.updatePrefix(prefix);
  this.#renderMenu();
}
```

inactive 时仅当 currentLine 空、cursor=0 且完整 sequence 匹配 `COMPLETE_COMMAND_SEQUENCE` 才调用它，然后返回 forward。

- [ ] **Step 7: active 时同步更新**

```ts
if (COMMAND_CHUNK.test(text)) {
  const next = `${this.#completion.snapshot().prefix}${text}`;
  this.#completion.updatePrefix(next);
  this.#renderMenu();
  return "forward";
}
```

Backspace 在 prefix 非空时 `slice(0,-1)` 后同步 render；prefix 空时关闭；两者都 forward。其他普通输入关闭并 forward。

- [ ] **Step 8: Enter 使用 Model prefix**

```ts
#handleEnter(): TerminalKeyDecision {
  const prefix = this.#completion.snapshot().prefix;
  const commands = this.#readOptions?.slashCommands ?? [];
  const exact = prefix !== "" && commands.some(
    (item) => item.name.toLowerCase() === prefix.toLowerCase(),
  );
  if (exact) {
    this.#closePalette();
    return "forward";
  }
  const selected = this.#completion.selected();
  if (selected !== undefined && prefix !== "") {
    this.#replaceCurrentLine(`/${selected.name} `);
    this.#closePalette();
    return "consume";
  }
  this.#closePalette();
  return "forward";
}
```

- [ ] **Step 9: 让 fail-open 自身不抛**

```ts
#disablePalette(): void {
  try { this.#presenter?.clear(); } catch {}
  try { this.#completion.close(); } catch {}
  this.#slashMode = "inactive";
  this.#inputRouter?.setHandler(undefined);
}
```

Presenter render 必须发生在 `#onKey()` 同步 try/catch 内。修复现有 throwing presenter 测试：press `/` 不抛、`/` 被 forward、handler 被卸载、后续输入继续进入 readline、Vitest 无 unhandled error。

- [ ] **Step 10: 验证并提交**

```bash
npx vitest run tests/unit/cli/prompt.test.ts tests/integration/slash-palette.test.ts
npm run typecheck
rg -n "queueMicrotask|syncSlashState" src/cli/prompt.ts
git diff --check
git add src/cli/prompt.ts tests/unit/cli/prompt.test.ts tests/integration/slash-palette.test.ts
git commit -m "fix: synchronize slash prefix during key handling"
```

`rg` 应无命中。

---

## Task 4: 用真实 stream/readline 覆盖本次故障

**Files:**

- Modify: `tests/integration/slash-palette.test.ts`
- Modify only if evidence requires: `src/cli/terminal-input-router.ts`
- Modify only if production changes: `tests/unit/cli/terminal-input-router.test.ts`

**Interfaces:**

- Consumes: real `ReadlinePrompt`、real `TerminalInputRouter`、real `node:readline`
- Produces: 不注入 FakeReadline/FakeInputRouter 的 portable integration harness

- [ ] **Step 1: 建立 TTY-like source**

```ts
class TtyInput extends PassThrough {
  isTTY = true;
  readonly rawModeCalls: boolean[] = [];
  setRawMode(value: boolean): this {
    this.rawModeCalls.push(value);
    return this;
  }
}

class TtyOutput extends Writable {
  isTTY = true;
  columns = 80;
  readonly chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString());
    callback();
  }
}
```

从 `node:stream` 导入 `PassThrough` 和 `Writable`。真实 readline 使用
`TtyOutput`，避免把只有 `write()` 的普通对象误当成完整 Writable stream。

- [ ] **Step 2: 增加有上限的条件等待 helper**

```ts
async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(message);
}
```

它只等待测试 stream 消费，不参与生产同步。

- [ ] **Step 3: 写真实 `/` → `g` 回归测试**

```ts
const input = new TtyInput();
const output = new TtyOutput();
const presenter = new RecordingPresenter();
const prompt = new ReadlinePrompt({
  input,
  output,
  terminal: true,
  enhanced: true,
  theme: createTheme({ enabled: false }),
  menuPresenterFactory: () => presenter,
});
```

不得注入 interfaceFactory/inputRouterFactory。执行：写 `/`，等 prefix=""；写 `g`，等 prefix="g" 且 visibleMatches=[goal]；写 Enter 补全；再写 Enter；pending 必须 resolve `/goal `，不能是 `/help `。

- [ ] **Step 4: 写全部命令可达测试**

对 14 个命令打开 `/`，连续 Down 13 次后 selected=exit，Tab+Enter 读取 `/exit `；从 exit 再 Down 一次 selected=help。

- [ ] **Step 5: 写清理断言**

记录 source 创建前后的 keypress listener count。`prompt.close()` 后恢复基线；rawModeCalls 若非空，最后一次必须为 false。不要断言 Node 版本相关的精确 data listener 数。

- [ ] **Step 6: 连续运行三次**

```bash
for run in 1 2 3; do
  npx vitest run tests/integration/slash-palette.test.ts || exit 1
done
```

Expected：三次均 PASS，零 unhandled error、无随机超时。

- [ ] **Step 7: 仅在证据要求时修 InputRouter**

允许范围：重复 forward、close listener、raw mode proxy、空 sequence fallback。不得通过延迟读取 readline 修复。

- [ ] **Step 8: 提交**

```bash
git diff --check
git add tests/integration/slash-palette.test.ts
git commit -m "test: cover slash palette on real readline streams"
```

若修改 InputRouter，把生产文件及对应单测加入该提交。

---

## Task 5: 全量回归、真实 TTY 验收和文档校正

**Files:**

- Modify: `README.md`
- Modify: `docs/PROJECT_REQUIREMENTS.md`
- Modify: `docs/superpowers/specs/2026-08-30-slash-command-palette-design.md`

**Interfaces:**

- Consumes: Tasks 1–4 的最终行为
- Produces: 与实际滚动视窗和同步输入一致的文档

- [ ] **Step 1: 校正原设计**

把原设计中的“最多显示前 6 个匹配”改成“全部匹配、6 行滚动视窗”；把“forward 后 microtask 读取 readline”改成“Palette 同步维护受限 ASCII prefix”；链接本稳定性规格；保留历史背景。

- [ ] **Step 2: 更新 README/requirements**

README 说明 Up/Down 能遍历全部命令、一次最多 6 条、footer 显示范围、前缀即时过滤。只有真实 TTY 验收完成后，requirements 才能保持已完成状态。

- [ ] **Step 3: 运行目标回归**

```bash
npx vitest run \
  tests/unit/cli/slash-completion.test.ts \
  tests/unit/cli/slash-menu.test.ts \
  tests/unit/cli/prompt.test.ts \
  tests/unit/cli/terminal-input-router.test.ts \
  tests/unit/cli/session.test.ts \
  tests/integration/slash-palette.test.ts \
  tests/integration/bootstrap.test.ts
```

- [ ] **Step 4: 运行全量验证**

```bash
npm test
npm run typecheck
npm run build
```

分别确认 exit code 0；`npm test` 摘要必须为 0 errors，不能只报告 passed 数。

- [ ] **Step 5: 完成 11 项真实 TTY 验收**

1. 输入行上方放一行哨兵文本，打开/关闭菜单后仍存在；
2. `/` 显示 `1–6 / 14`；
3. Down 到第 7 项，视窗滚动；
4. 选中 exit 再 Down 循环到 help；
5. Esc 后菜单全部消失；
6. `/` 后输入 `g`，立即只剩 goal；
7. Enter 得到 `/goal ` 而不是 `/help `；
8. 中文参数正常提交；
9. `//literal` 仍作为普通消息；
10. resize 变窄/变宽无残影；
11. Ctrl-C/Ctrl-D 行为与 Session 既有语义一致。

- [ ] **Step 6: 扫描旧实现和占位**

```bash
rg -n "queueMicrotask|syncSlashState|maxVisible|CURSOR_UP" \
  src/cli tests/unit/cli tests/integration/slash-palette.test.ts
rg -n "T[D]O|T[B]D|待.*定|place[h]older" \
  docs/superpowers/specs/2026-08-30-slash-command-palette-stabilization-design.md \
  docs/superpowers/plans/2026-08-30-slash-command-palette-stabilization.md
git diff --check
```

不得留下本功能旧实现或文档占位。

- [ ] **Step 7: 提交文档**

```bash
git add README.md docs/PROJECT_REQUIREMENTS.md \
  docs/superpowers/specs/2026-08-30-slash-command-palette-design.md
git commit -m "docs: finalize stable slash palette behavior"
```

---

## Final Review Checklist

- [ ] 14 个命令在 matches 中全部存在，视窗最多 6 条。
- [ ] Up/Down 可访问 context 至 exit 并首尾循环。
- [ ] footer 与 windowStart/visibleMatches 一致。
- [ ] `/` → `g` 在同一按键处理周期同步过滤为 goal。
- [ ] Prompt 不再使用 microtask 同步 Palette。
- [ ] Enter/Tab 使用 Model prefix 和绝对 selectedIndex。
- [ ] Presenter draw/clear 不含 cursor-up，使用 cursor-down + clear-entire-line。
- [ ] 菜单不擦除输入行上方历史。
- [ ] Presenter 异常不逃逸为 Vitest unhandled error。
- [ ] 真实 Node stream/readline 集成测试连续通过三次。
- [ ] 中文、粘贴、`//`、unknown、完整命令没有回归。
- [ ] non-TTY、NO_COLOR、TERM=dumb 没有动态菜单。
- [ ] `npm test`、typecheck、build 最新运行均 exit code 0。
- [ ] 真实 TTY 11 项验收完成。
- [ ] 没有新增运行时依赖或实现非目标。
- [ ] `git status --short` 只含预期变更或为空。

## Expected Commit Sequence

```text
fix: keep all slash command matches
fix: scroll and clear slash menu safely
fix: synchronize slash prefix during key handling
test: cover slash palette on real readline streams
docs: finalize stable slash palette behavior
```

不要 squash 成一个无法定位回归来源的大提交。
