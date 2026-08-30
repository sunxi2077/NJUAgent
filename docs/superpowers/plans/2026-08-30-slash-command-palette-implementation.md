# Slash Command Palette Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不重写 readline、不破坏中文输入与现有 Slash Command 语义的前提下，为真实增强 TTY 增加 `/` 自动弹出、前缀过滤、方向键选择和 Tab/Enter 补全的命令面板。

**Architecture:** 在真实 stdin 与 `node:readline` 之间增加一个可消费特定 keypress 的 `TerminalInputRouter`；用纯状态机 `SlashCompletionModel` 维护候选，用独立 `SlashMenuPresenter` 管理输入行下方的临时区域，由 `ReadlinePrompt` 负责协调三者。命令元数据只从 `SlashCommandRouter.descriptors()` 获取，最终命令仍由现有 Router 执行。

**Tech Stack:** TypeScript、Node.js `readline` / `PassThrough` / ANSI 控制序列、Vitest、现有 `picocolors` 与终端宽度工具；不增加运行时依赖。

**Spec:** [`docs/superpowers/specs/2026-08-30-slash-command-palette-design.md`](../specs/2026-08-30-slash-command-palette-design.md)

## Global Constraints

- 严格按测试驱动顺序实施：先写会失败的测试，运行并确认失败原因，再写最小实现，再运行测试。
- 每完成一个 Task 就运行该 Task 指定的测试并提交；不要把全部改动堆到最后一个提交。
- 不改 Agent Loop、Session 持久化格式、权限策略、Slash Command 执行语义或模型历史。
- 不实现参数补全、模糊搜索、文件补全、鼠标、多列菜单或完整自定义编辑器。
- 不新增 Ink、Blessed、Inquirer、Enquirer 等 TUI/Prompt 依赖。
- 命令元数据只有一个来源：`SlashCommandRouter`。禁止在 Prompt 中硬编码命令列表。
- 只消费 Palette 明确拥有的按键。未知序列、中文、粘贴和普通编辑必须 fail-open 到 readline。
- 不记录 raw key sequence 或用户粘贴内容。
- 生产代码不得直接改写 readline 的私有 `line` / `cursor` 字段；补全必须使用公开 `Interface.write()`。
- 非 TTY、`NO_COLOR`、`TERM=dumb` 必须保持当前行为，不能输出菜单 ANSI。
- DSH 每完成一个 Task，应先自查本 Task 的 diff，确认无越界功能，再提交。

---

## Task 1: 暴露安全的命令描述并实现纯补全状态机

**Files:**

- Modify: `src/cli/command.ts`
- Modify: `src/cli/command-router.ts`
- Create: `src/cli/slash-completion.ts`
- Modify: `tests/unit/cli/command-router.test.ts`
- Create: `tests/unit/cli/slash-completion.test.ts`

### Step 1: 为 Router descriptor 写失败测试

- [ ] 在 `tests/unit/cli/command-router.test.ts` 增加测试，注册三个命令后断言：
  - `descriptors()` 保持注册顺序；
  - name 是 Router 规范化后的小写；
  - 返回对象只含 `name`、`usage`、`description`，不含 `execute`；
  - 两次调用返回不同数组和不同对象；
  - 修改调用方持有的数据不会改变 Router 的命令。

推荐断言形态：

```ts
const first = router.descriptors();
const second = router.descriptors();

expect(first).toEqual([
  { name: "help", usage: "/help", description: "Show help" },
  { name: "goal", usage: "/goal [text]", description: "Manage goal" },
]);
expect(first).not.toBe(second);
expect(first[0]).not.toBe(second[0]);
expect("execute" in first[0]!).toBe(false);
```

- [ ] 运行并确认测试因为 `descriptors` 不存在而失败：

```bash
npx vitest run tests/unit/cli/command-router.test.ts
```

### Step 2: 实现 descriptor 类型和 Router API

- [ ] 在 `src/cli/command.ts` 的 `SlashCommand` 后增加：

```ts
export type SlashCommandDescriptor = Readonly<
  Pick<SlashCommand, "name" | "usage" | "description">
>;
```

- [ ] 在 `src/cli/command-router.ts` 导入该类型并实现：

```ts
descriptors(): readonly SlashCommandDescriptor[] {
  return [...this.#commands.entries()].map(([name, command]) => ({
    name,
    usage: command.usage,
    description: command.description,
  }));
}
```

- [ ] 不删除或改变 `commands()`，因为 `/help` 仍依赖它。
- [ ] 运行 Router 测试，确认通过。

### Step 3: 先写 SlashCompletionModel 的完整状态测试

- [ ] 新建 `tests/unit/cli/slash-completion.test.ts`，覆盖：
  - `open()` 以注册顺序显示空前缀候选，最多 6 条；
  - `updatePrefix()` 做大小写不敏感的 `startsWith`；
  - `move(1)` 与 `move(-1)` 首尾循环；
  - 过滤后若选中 command 仍存在则保留它，而不是保留下标；
  - 选中 command 消失时回到第一项；
  - 无匹配时 `selectedIndex === -1` 且 `selected()` 为 `undefined`；
  - `close()` 与再次 `open()` 重置选择；
  - snapshot、matches 和输入 descriptors 不共享可变对象；
  - `maxVisible` 的 0、负数、非整数抛 `RangeError`；
  - 非法 prefix（空串合法，`go` 合法，`GO` 合法；空格、斜杠、中文非法）抛 `TypeError`。

- [ ] 运行并确认测试因模块不存在而失败：

```bash
npx vitest run tests/unit/cli/slash-completion.test.ts
```

### Step 4: 实现纯状态机

- [ ] 新建 `src/cli/slash-completion.ts`，导出精确接口：

```ts
export type SlashCompletionSnapshot = {
  active: boolean;
  prefix: string;
  selectedIndex: number;
  matches: readonly SlashCommandDescriptor[];
};

export class SlashCompletionModel {
  constructor(options?: { maxVisible?: number });
  open(commands: readonly SlashCommandDescriptor[]): SlashCompletionSnapshot;
  updatePrefix(prefix: string): SlashCompletionSnapshot;
  move(delta: -1 | 1): SlashCompletionSnapshot;
  selected(): SlashCommandDescriptor | undefined;
  close(): SlashCompletionSnapshot;
  snapshot(): SlashCompletionSnapshot;
}
```

- [ ] 内部保存全部 commands 的副本，过滤后再 `slice(0, maxVisible)`。
- [ ] `updatePrefix()` 前先按 name 保存当前选中项；生成新 matches 后按 name 恢复选中，否则选择第一项。
- [ ] 所有公开返回值都通过一个私有 snapshot builder 新建数组和 descriptor 对象。
- [ ] Model 不导入 readline、streams、Renderer、Session 或 Router。

### Step 5: 验证并提交

- [ ] 运行：

```bash
npx vitest run tests/unit/cli/command-router.test.ts tests/unit/cli/slash-completion.test.ts
npm run typecheck
```

- [ ] 检查 `git diff --check`，然后提交：

```bash
git add src/cli/command.ts src/cli/command-router.ts src/cli/slash-completion.ts tests/unit/cli/command-router.test.ts tests/unit/cli/slash-completion.test.ts
git commit -m "feat: add slash command completion model"
```

---

## Task 2: 实现自适应菜单格式化和临时区域 Presenter

**Files:**

- Create: `src/cli/slash-menu.ts`
- Modify: `src/cli/terminal-text.ts`
- Create: `tests/unit/cli/slash-menu.test.ts`
- Modify: `tests/unit/cli/terminal-text.test.ts`

### Step 1: 为终端文本清理补测试

- [ ] 检查 `src/cli/terminal-text.ts` 现有导出。若没有“清除 ANSI 并把换行折叠成单空格”的公共函数，先在 `tests/unit/cli/terminal-text.test.ts` 为下列输入写失败测试：

```ts
sanitizeTerminalText("line 1\nline 2\r\nline 3") === "line 1 line 2 line 3"
sanitizeTerminalText("\x1b[31mred\x1b[0m") === "red"
sanitizeTerminalText("a\t\tb") === "a b"
```

- [ ] 使用 Node `stripVTControlCharacters` 实现并导出 `sanitizeTerminalText(text: string): string`。连续 whitespace 折叠为一个空格并 trim。
- [ ] 如果已有等价函数，复用并补齐测试，不创建重复 API。

### Step 2: 先写纯格式化测试

- [ ] 新建 `tests/unit/cli/slash-menu.test.ts`，为 `formatSlashMenu()` 覆盖：
  - inactive 返回 `[]`；
  - 80 columns 输出完整单列边框、`Commands` 标题、6 条以内候选和 footer；
  - 当前选中项有 `›`，其他项为空格；
  - name、usage 或 description 过长时不超过边框可见宽度；
  - 中文和 emoji 按 terminal cell width 截断，不打破对齐；
  - description 的 ANSI、CR/LF、tab 被清理；
  - 无匹配显示 `No matching commands`；
  - 40 columns 仍为完整边框；39 columns 进入最多 3 条的紧凑无边框模式；
  - theme enabled/disabled 都不改变可见宽度。

- [ ] 每一条完整模式输出行都用 `terminalWidth(stripVTControlCharacters(line))` 检查宽度一致。
- [ ] 运行并确认模块不存在而失败：

```bash
npx vitest run tests/unit/cli/terminal-text.test.ts tests/unit/cli/slash-menu.test.ts
```

### Step 3: 实现 formatSlashMenu

- [ ] 新建 `src/cli/slash-menu.ts`，先实现纯函数：

```ts
export function formatSlashMenu(
  snapshot: SlashCompletionSnapshot,
  options: { columns: number; theme: TerminalTheme },
): readonly string[];
```

- [ ] 完整模式宽度为 `Math.min(Math.max(Math.floor(columns), 40) - 2, 88)`；紧凑模式在 `< 40` 时启用。
- [ ] 内部先生成无 ANSI 的 cell 内容与 padding，再套 theme；不得用含 ANSI 的 `string.length` 对齐。
- [ ] 描述文本先 `sanitizeTerminalText`，再按剩余 cell width 截断。
- [ ] 使用现有 `terminalWidth()` / `truncateToTerminalWidth()`，不要另写 Unicode 宽度算法。
- [ ] Menu 只渲染 descriptor，不修改 snapshot。

### Step 4: 为 Presenter 写失败测试

- [ ] 在同一测试文件建立可记录 `write()`、`columns`、`on/off("resize")` 的 FakeOutput。
- [ ] 覆盖：
  - 第一次 render 写入 save cursor、菜单和 restore cursor；
  - 第二次候选变少会清除旧区域的全部行；
  - `clear()` 幂等且光标回到输入位置；
  - `suspend()` 清除但 `resume(snapshot)` 能恢复；
  - inactive snapshot 的 resume 不输出菜单；
  - 修改 columns 后触发 resize 会按新宽度重绘；
  - `close()` 清理区域并只移除一次 resize listener；
  - close 后 render/resize 不再输出。

### Step 5: 实现 Presenter

- [ ] 在 `src/cli/slash-menu.ts` 导出：

```ts
export interface SlashMenuPresenterPort {
  render(snapshot: SlashCompletionSnapshot): void;
  clear(): void;
  suspend(): void;
  resume(snapshot: SlashCompletionSnapshot): void;
  close(): void;
}

export type SlashMenuPresenterOptions = {
  output: NodeJS.WritableStream & { columns?: number };
  theme: TerminalTheme;
  fallbackColumns?: number;
};

export class SlashMenuPresenter implements SlashMenuPresenterPort {
  constructor(options: SlashMenuPresenterOptions);
}
```

- [ ] 将 ANSI 控制序列定义为模块内常量，至少包含 save cursor、restore cursor、cursor down、cursor up、clear entire line。
- [ ] Presenter 保存 `#lastRows`、`#lastSnapshot`、`#suspended`、`#closed`。resize 只重绘 `#lastSnapshot`。
- [ ] `#columns()` 每次读取 output 当前 columns；非法或缺失时使用 `fallbackColumns ?? 80`。
- [ ] descriptor 只能进入可见文本函数，不能拼进 ANSI 控制序列。

### Step 6: 验证并提交

- [ ] 运行：

```bash
npx vitest run tests/unit/cli/terminal-text.test.ts tests/unit/cli/slash-menu.test.ts
npm run typecheck
```

- [ ] 提交：

```bash
git add src/cli/terminal-text.ts src/cli/slash-menu.ts tests/unit/cli/terminal-text.test.ts tests/unit/cli/slash-menu.test.ts
git commit -m "feat: render slash command palette"
```

---

## Task 3: 在 stdin 与 readline 之间增加可消费按键的输入 Router

**Files:**

- Create: `src/cli/terminal-input-router.ts`
- Create: `tests/unit/cli/terminal-input-router.test.ts`

### Step 1: 写 Router 的行为测试

- [ ] 新建 FakeSource：Readable/EventEmitter，带 `isTTY = true`、`setRawMode()` 调用记录和 `emitKey(text, key)` helper。
- [ ] 测试以下精确行为：
  - 未设置 handler 时，`sequence` 向 `readlineInput` 转发一次；
  - handler 返回 `forward` 时转发一次；
  - handler 返回 `consume` 时不转发；
  - sequence 为空时转发 text；text 与 sequence 都为空时不写；
  - handler 抛错时，本次输入被转发，handler 被禁用，后续输入继续转发；
  - `readlineInput.isTTY` 与 source 一致；
  - `readlineInput.setRawMode(true/false)` 代理到 source 并返回 readlineInput；
  - `close()` 移除 keypress listener、结束 proxy，但不 destroy/close source；
  - 重复 close 幂等；
  - Ctrl-C、方向键和一次包含中文的粘贴 sequence 不被拆分或改写。

- [ ] 运行并确认失败：

```bash
npx vitest run tests/unit/cli/terminal-input-router.test.ts
```

### Step 2: 实现公开类型和 RoutedReadStream

- [ ] 新建 `src/cli/terminal-input-router.ts`，导出：

```ts
export type TerminalKey = {
  sequence: string;
  name?: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
};

export type TerminalKeyDecision = "forward" | "consume";

export type TerminalKeyHandler = (
  text: string,
  key: TerminalKey,
) => TerminalKeyDecision;

export interface TerminalInputRouterPort {
  readonly readlineInput: NodeJS.ReadableStream;
  setHandler(handler: TerminalKeyHandler | undefined): void;
  close(): void;
}
```

- [ ] 内部 `RoutedReadStream extends PassThrough`：
  - constructor 接收 source；
  - getter `isTTY` 返回 `source.isTTY === true`；
  - `setRawMode(mode)` 若 source 有该函数则以 source 为 this 调用，然后返回 proxy 自身。

### Step 3: 实现 TerminalInputRouter

- [ ] 生产 constructor 签名保持：

```ts
export class TerminalInputRouter implements TerminalInputRouterPort {
  constructor(source: NodeJS.ReadableStream);
}
```

- [ ] constructor 调用 `emitKeypressEvents(source)` 并监听 source 的 `keypress`。
- [ ] 把 Node readline key 转换成完整 `TerminalKey`，所有 boolean 缺失值规范化为 `false`。
- [ ] 转发内容严格为 `key.sequence !== "" ? key.sequence : text`。
- [ ] handler 抛错时不输出错误正文或原始输入，只执行：禁用 handler、转发本次 sequence。
- [ ] readline 只能连接 `readlineInput`，绝不能同时连接 source；这一约束在 Task 4 集成。

### Step 4: 验证并提交

- [ ] 运行：

```bash
npx vitest run tests/unit/cli/terminal-input-router.test.ts
npm run typecheck
```

- [ ] 提交：

```bash
git add src/cli/terminal-input-router.ts tests/unit/cli/terminal-input-router.test.ts
git commit -m "feat: route terminal keypress input"
```

---

## Task 4: 在 ReadlinePrompt 中接入 Palette Controller

**Files:**

- Modify: `src/cli/prompt.ts`
- Modify: `tests/unit/cli/prompt.test.ts`

### Step 1: 扩展测试 seam，不先写生产实现

- [ ] 扩展 `FakeReadline`，至少支持：
  - `line: string`，初始 `""`；
  - `cursor: number`；
  - `write(data?, key?)`，能够模拟 Ctrl-U、普通文本、Backspace 和 Enter；
  - 原有 `setPrompt()`、`prompt()`、`on()`、`close()`；
  - helper `submitLine()`。
- [ ] 新建 `FakeInputRouter implements TerminalInputRouterPort`，保存 handler，并提供 `press(text, key)`；若返回 `forward`，测试 helper 再调用 FakeReadline 对应输入。
- [ ] 新建 `FakeSlashMenuPresenter implements SlashMenuPresenterPort`，记录 render snapshot、clear、suspend、resume、close。
- [ ] Prompt 需要可注入 Presenter，故将计划中的生产 options 最终定义为：

```ts
export type PromptReadOptions = {
  slashCommands?: readonly SlashCommandDescriptor[];
};

export type ReadlinePromptOptions = {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  terminal: boolean;
  enhanced?: boolean;
  theme?: TerminalTheme;
  columns?: number;
  interfaceFactory?: typeof createInterface;
  inputRouterFactory?: (
    source: NodeJS.ReadableStream,
  ) => TerminalInputRouterPort;
  menuPresenterFactory?: (
    options: SlashMenuPresenterOptions,
  ) => SlashMenuPresenterPort;
};
```

`enhanced` 和 `theme` 设为 optional 是为了保持现有测试与第三方 composition seam 兼容；默认 `enhanced = false`、theme 为 disabled theme。生产 bootstrap 会显式传真实值。

### Step 2: 为启用条件和读取生命周期写失败测试

- [ ] 在 `tests/unit/cli/prompt.test.ts` 增加：
  - `enhanced: true` 且 terminal true 时，readline interface 的 input 是 Router 的 proxy，而非真实 input；
  - terminal false、enhanced false 各不创建 Router/Presenter；
  - queued line 被下一次 `read()` 直接返回时不安装 Palette handler；
  - `read(prompt, { slashCommands })` resolve 后清除本次 options；
  - `confirm()` 不传 slashCommands，键入 `/` 不打开 Palette；
  - 无 descriptors 时不打开 Palette。

### Step 3: 为按键决策表写失败测试

- [ ] 使用 3 个 descriptor 覆盖：
  - fresh line `/`：sequence forward 后 microtask 打开并 render；
  - `/go`：每次字符 forward 后更新 prefix 和 matches；
  - Up/Down：返回 consume、移动选择、readline line 不变；
  - Tab：返回 consume、将输入替换为 `/<name> `、关闭、不 resolve pending read；
  - Enter + `/goal` 精确匹配：清除并 forward，pending resolve `/goal`；
  - Enter + `/go`：consume、补全 `/goal `、pending 仍未 resolve；
  - Enter + `/zzz`：清除并 forward，pending resolve `/zzz`；
  - Esc：consume、关闭、保留 `/go`；
  - Backspace：forward 后更新；删到空行关闭；
  - 第二个 `/`：先关闭再 forward，最终 `//literal` 保留；
  - 空格：关闭并 forward，中文参数随后全部原样进入 readline；
  - Left/Right/Home/End/Delete、Ctrl-A/Ctrl-E、非 ASCII、未知 key：关闭并 forward；
  - Ctrl-C/Ctrl-D：先 clear，再 forward；
  - 光标不在行尾或 line 不满足 `^/[a-z0-9-]*$`：关闭并 forward。

- [ ] 粘贴至少测两种形态：逐字符输入和单次 sequence `/goal 完成测试`。两者最终 line 必须完全相同，无重复或丢失。
- [ ] `queueMicrotask` 测试必须 `await Promise.resolve()` 后再断言 snapshot，证明 controller 读取的是 readline 更新后的 line。

### Step 4: 实现 Prompt 接口和构造逻辑

- [ ] 修改 `Prompt.read`：

```ts
read(
  promptText: string,
  options?: PromptReadOptions,
): Promise<string | null>;
```

- [ ] `ReadlinePrompt` 只有在 `terminal && enhanced` 时创建 Router、Model 和 Presenter；否则保持现有 direct input。
- [ ] 增强组件初始化必须在创建 readline interface 前完成，并包在 fail-open 边界内：Router factory、Presenter factory 或构造过程抛错时，关闭已创建的部分组件，退回真实 input 创建普通 readline；不得让可选 Palette 导致 CLI 无法启动。
- [ ] 创建 readline interface 时使用：

```ts
const readlineInput = this.#inputRouter?.readlineInput ?? options.input;
this.#rl = factory({
  input: readlineInput,
  output: options.output,
  terminal: options.terminal,
});
```

- [ ] 默认 Presenter 使用 `new SlashMenuPresenter({ output, theme, fallbackColumns: columns })`。
- [ ] `read()` 只有确认不存在 pending read 后才设置本次 options 与 handler；queued line 路径不启用 handler。
- [ ] line/close/interrupt resolve 时统一调用一个私有 `#finishRead()`，负责：clear menu、close model、清空 options、卸载 handler、清空 pending。

### Step 5: 实现单一按键 controller

- [ ] 增加一个私有 handler，返回 `TerminalKeyDecision`，所有分支必须显式返回。
- [ ] active 判定只依据：当前有 pending read、descriptors 非空、model active、`rl.cursor === rl.line.length`、line 匹配 `^/[a-z0-9-]*$`。
- [ ] fresh `/` 与 active 可打印命令字符走 `forward`，并用 `queueMicrotask(() => this.#syncSlashState())` 在 readline 更新后同步。
- [ ] 对单次多字符粘贴：若 sequence 含空格、非命令字符或第二个 `/`，先关闭 Palette，再整段 `forward`。不得逐字重放 sequence。
- [ ] 键名判断优先于 text；识别 `up`、`down`、`tab`、`escape`、`return`、`enter`、`backspace`。
- [ ] Ctrl-C/Ctrl-D 在任何模式都 clear 后 forward，保持现有 SIGINT/EOF 语义。
- [ ] controller 内部异常必须捕获：禁用本次 Palette、clear、返回 `forward`。

### Step 6: 实现补全和行替换

- [ ] 精确命令用大小写不敏感 name 比较，但补全文本使用 descriptor 的规范化 name。
- [ ] 私有方法：

```ts
#replaceCurrentLine(text: string): void {
  this.#rl.write(undefined, { ctrl: true, name: "u" });
  this.#rl.write(text);
}
```

- [ ] Tab 总是补全 selected 并尾随一个空格；若无 selected，consume Tab 但保持输入和菜单（避免 readline 插入 tab）。
- [ ] 前缀 Enter 有 selected 时补全并关闭但不提交；精确命令 Enter 和无匹配 Enter 都 forward 给 readline。

### Step 7: 把 Palette 纳入输出暂停/恢复和关闭

- [ ] `suspendForOutput()` 顺序：Presenter.suspend → clear readline line → 标记 suspended。
- [ ] `resumeAfterOutput()` 顺序：`rl.prompt(true)` → active 时 Presenter.resume(snapshot) → 清 suspended。
- [ ] `interrupt()`：clear Presenter、close Model、清 read options、resolve pending null，但不 close Router。
- [ ] `close()` 幂等：先 Presenter.close、Router.close，再关闭 readline 和 process listener。
- [ ] line/EOF 后不得留下 active snapshot。

### Step 8: 验证并提交

- [ ] 运行：

```bash
npx vitest run tests/unit/cli/prompt.test.ts tests/unit/cli/slash-completion.test.ts tests/unit/cli/slash-menu.test.ts tests/unit/cli/terminal-input-router.test.ts
npm run typecheck
```

- [ ] 提交：

```bash
git add src/cli/prompt.ts tests/unit/cli/prompt.test.ts
git commit -m "feat: integrate slash palette with readline"
```

---

## Task 5: 从 CliSession 传入 descriptors，并在 Bootstrap 统一增强模式和主题

**Files:**

- Modify: `src/cli/session.ts`
- Modify: `src/index.ts`
- Modify: `src/cli/renderer.ts`
- Modify: `tests/unit/cli/session.test.ts`
- Modify: `tests/integration/bootstrap.test.ts`
- Modify: affected renderer/bootstrap test fakes found by `rg "promptFactory|rendererFactory|ReadlinePromptOptions|TerminalRendererOptions" tests src`

### Step 1: 为 CliSession 元数据传递写失败测试

- [ ] 更新 session 测试 FakePrompt，使其记录 `{ promptText, options }`。
- [ ] 增加测试：配置 Router 时，每一轮主 `read()` 收到该时刻 `router.descriptors()`；无 Router 时 options 为 `undefined`。
- [ ] 断言 `/help`、unknown command、`//literal`、普通模型输入的路由行为均不变。
- [ ] 运行：

```bash
npx vitest run tests/unit/cli/session.test.ts
```

### Step 2: 修改 CliSession 主循环

- [ ] 用下面的明确调用替换现有主 read：

```ts
const readOptions = this.#router === undefined
  ? undefined
  : { slashCommands: this.#router.descriptors() };
const text = await this.#prompt.read(this.#inputPrompt, readOptions);
```

- [ ] 不缓存 descriptors；每轮 read 都读取一次，确保后续动态注册也能出现。
- [ ] setup 和 permission prompt 不经过 CliSession 主 read，因此不会收到 descriptors。

### Step 3: 为 Bootstrap 写统一模式测试

- [ ] 在 `tests/integration/bootstrap.test.ts` 通过 promptFactory / rendererFactory 捕获 options，覆盖：
  - `isTTY: true`、无 `NO_COLOR`、TERM 非 dumb：Prompt `enhanced === true`，theme enabled；Renderer theme 与 Prompt theme 是同一对象；
  - `NO_COLOR=1`：Prompt `enhanced === false`，theme disabled；
  - `TERM=dumb`：同上；
  - non-TTY：同上；
  - stdout columns 被传给 Prompt；缺失 columns 不传或使用 undefined；
  - 欢迎区、Renderer、CommandContext 使用同一 theme。

### Step 4: 重排 composition root

- [ ] 在创建 Prompt 之前计算一次：

```ts
const interactive = shouldEnableTerminalTheme({ isTTY, env });
const theme = createTheme({ enabled: interactive });
const columns = (stdout as NodeJS.WritableStream & { columns?: number }).columns;
```

- [ ] 创建 Prompt 时显式传：

```ts
const prompt = promptFactory({
  input: stdin,
  output: stdout,
  terminal: isTTY,
  enhanced: interactive,
  theme,
  ...(columns === undefined ? {} : { columns }),
});
```

- [ ] 创建 Renderer 时传同一 `theme`。若 `TerminalRendererOptions` 已支持 theme，只补 composition；若未支持，增加 optional theme 并保留现有默认行为。
- [ ] 删除 welcome 前重复声明的 interactive/theme，清屏逻辑仍使用提前计算的 interactive。
- [ ] 不把 `NO_COLOR` 或 env 传入 Prompt 让其二次判断。

### Step 5: 验证并提交

- [ ] 用 `rg` 找齐所有 Prompt interface 实现和 factory，更新 TypeScript 签名；测试 Fake 可以忽略 options，但记录型 Fake 必须使用完整签名。
- [ ] 运行：

```bash
npx vitest run tests/unit/cli/session.test.ts tests/integration/bootstrap.test.ts tests/unit/cli/renderer.test.ts
npm run typecheck
```

- [ ] 提交：

```bash
git add src/cli/session.ts src/index.ts src/cli/renderer.ts tests/unit/cli/session.test.ts tests/integration/bootstrap.test.ts tests/unit/cli/renderer.test.ts
git commit -m "feat: enable slash palette in interactive sessions"
```

如果 `renderer.ts` 或 renderer test 实际没有变化，不要为了匹配命令制造无意义改动，也不要把未修改路径传给 `git add`。

---

## Task 6: 增加跨组件回归测试和异常/生命周期测试

**Files:**

- Modify: `tests/unit/cli/prompt.test.ts`
- Modify: `tests/unit/cli/session.test.ts`
- Modify: `tests/integration/bootstrap.test.ts`
- Create: `tests/integration/slash-palette.test.ts`

### Step 1: 建立不依赖真实终端的集成 harness

- [ ] 新建 `tests/integration/slash-palette.test.ts`，组合真实：
  - `SlashCommandRouter`；
  - `SlashCompletionModel`；
  - `ReadlinePrompt` controller；
  - 测试 InputRouter、FakeReadline、记录型输出。
- [ ] 不访问网络、不加载 API key、不启动模型。注册只记录 execute 参数的测试命令。

### Step 2: 覆盖完整用户路径

- [ ] 场景一：输入 `/` → `g` → `o` → Enter，确认 line 变 `/goal ` 且命令未执行；输入中文 args 再 Enter，Router 执行一次且 args 完整。
- [ ] 场景二：输入 `/` → Down 若干次 → Tab → Enter，确认选中命令执行一次，菜单已 clear。
- [ ] 场景三：完整手敲 `/help` 后 Enter，直接执行，不需要第二次 Enter。
- [ ] 场景四：`//literal slash text` 最终 Router 返回 `{ kind: "not_command", text: "/literal slash text" }`。
- [ ] 场景五：未知 `/zzz` Enter 仍由 Router 产生 Unknown Command，不进入模型。
- [ ] 场景六：Palette 打开时 suspend/resume，输出顺序为 menu clear → 永久输出 → readline redraw → menu redraw。

### Step 3: 覆盖失败开放和清理

- [ ] Presenter factory 抛错、Presenter.render 抛错、Model sync 非法输入、Router handler 抛错，各自测试普通字符仍能进入 readline。
- [ ] `interrupt()` 后再次 `read()` 可以正常输入。
- [ ] `close()` 两次不抛；keypress、resize、process SIGINT listener 数量恢复到创建前。
- [ ] EOF 时 pending resolve null；Palette clear；Session flush 仍执行。
- [ ] non-TTY、NO_COLOR、TERM=dumb 的输出不包含 `\x1b[` 菜单序列。

### Step 4: 运行回归并提交

- [ ] 运行：

```bash
npx vitest run tests/integration/slash-palette.test.ts tests/unit/cli/prompt.test.ts tests/unit/cli/session.test.ts tests/integration/bootstrap.test.ts
npm test
npm run typecheck
npm run build
```

- [ ] 若旧测试因精确输出快照变化而失败，只更新与新增 Palette/共享 theme 直接相关的断言；不得批量重录无关快照。
- [ ] 提交：

```bash
git add tests/integration/slash-palette.test.ts tests/unit/cli/prompt.test.ts tests/unit/cli/session.test.ts tests/integration/bootstrap.test.ts
git commit -m "test: cover slash palette interaction lifecycle"
```

---

## Task 7: 更新用户文档和项目验收状态

**Files:**

- Modify: `README.md`
- Modify: `docs/PROJECT_REQUIREMENTS.md`
- Modify: `docs/superpowers/specs/2026-08-30-slash-command-palette-design.md` only if implementation found and resolved a genuine spec contradiction

### Step 1: 更新 README

- [ ] 在 CLI 使用说明中增加一小节，准确说明：
  - 真实增强 TTY 输入 `/` 自动显示命令；
  - 输入前缀过滤；
  - Up/Down 选择；
  - Tab 或前缀 Enter 补全；
  - 完整命令 Enter 直接执行；
  - Esc 关闭并保留输入；
  - 参数补全不在本阶段范围；
  - non-TTY、NO_COLOR、TERM=dumb 会降级为普通输入。
- [ ] 文档示例使用当前真实命令，不写不存在的 command。

### Step 2: 更新 requirements

- [ ] 在 `docs/PROJECT_REQUIREMENTS.md` 对应 UI/Slash Command 条目标记已实现，并引用设计规格。
- [ ] 不把参数补全、模糊搜索或完整 TUI 标为已完成。

### Step 3: 最终验收

- [ ] 运行静态检查：

```bash
rg -n "T[D]O|T[B]D|待.*定|place[h]older" src tests README.md docs/PROJECT_REQUIREMENTS.md docs/superpowers/specs/2026-08-30-slash-command-palette-design.md
git diff --check
```

任何命中都必须逐条判断；原项目已有合法待办注释可以保留，但本功能新增文件不得留占位内容。

- [ ] 运行全部验证：

```bash
npm test
npm run typecheck
npm run build
```

- [ ] 在 macOS 或 Linux 的真实 TTY 手工完成以下最小验收，并把结果写入最终交付说明，不把录屏文件提交进仓库：
  1. `/` 自动弹出；
  2. `/go` 只剩 goal；
  3. Up/Down 循环；
  4. Tab 补全但不执行；
  5. `/help` Enter 直接执行；
  6. `/goal 完成中文测试` 无丢字；
  7. `//literal` 保留；
  8. Palette 打开时触发一次 Renderer 输出，无残影；
  9. Esc、Ctrl-C、Ctrl-D 行为符合规格；
  10. 窄终端 resize 后无错位。

### Step 4: 提交文档

- [ ] 提交：

```bash
git add README.md docs/PROJECT_REQUIREMENTS.md docs/superpowers/specs/2026-08-30-slash-command-palette-design.md
git commit -m "docs: document slash command palette"
```

若设计规格没有改变，不要重复 add 它。

---

## Final Review Checklist

DSH 在汇报完成前必须逐项确认：

- [ ] `/` 菜单的数据来自 `SlashCommandRouter.descriptors()`，没有第二份硬编码列表。
- [ ] readline 只读取 Router proxy，没有同时读取真实 stdin。
- [ ] Palette 仅消费 Up/Down/Tab/Esc/前缀 Enter；其他输入 fail-open。
- [ ] 普通中文输入、中文参数、逐字符输入和一次性粘贴均无丢失/重复。
- [ ] `//`、unknown command、直接手敲完整命令均未回归。
- [ ] setup 与 permission confirm 没有命令 Palette。
- [ ] Renderer 输出前后菜单能 clear/resume，无滚动历史污染和残影。
- [ ] non-TTY、NO_COLOR、TERM=dumb 不创建动态菜单。
- [ ] interrupt、EOF、close、resize 不泄漏监听器。
- [ ] 没有新增运行时依赖，没有实现非目标。
- [ ] 全量 test、typecheck、build 都以当次最新输出通过。
- [ ] `git status --short` 只包含预期变更，提交历史按 Task 可审查。

## Expected Commit Sequence

完成后的提交历史应大致为：

```text
feat: add slash command completion model
feat: render slash command palette
feat: route terminal keypress input
feat: integrate slash palette with readline
feat: enable slash palette in interactive sessions
test: cover slash palette interaction lifecycle
docs: document slash command palette
```

允许因为实际依赖关系合并相邻测试提交，但不得把全部功能压成一个无法审查的大提交。
