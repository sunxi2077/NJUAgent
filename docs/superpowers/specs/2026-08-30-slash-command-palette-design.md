# NJUAgent Slash Command Palette 设计规格

日期：2026-08-30

状态：已确认，等待实施

前置基线：Stage Four Reliable Agent 与权限确认卡片已完成

## 1. 文档目的

本文定义 NJUAgent 的交互式 Slash Command Palette。用户在真实终端的空输入行键入 `/` 后，应立即看到可过滤的命令列表，并能通过键盘选择和补全，而不需要记忆或完整手敲命令。

本功能只增强本地 CLI 输入体验，不改变 Slash Command 的路由语义、权限边界、模型历史、Session 数据格式或 Agent Loop。

## 2. 用户问题

当前 Slash Command 已具备注册、帮助、解析和执行能力，但发现性较差：

- 用户必须记住完整命令名；
- 输入 `/` 时没有任何反馈；
- 拼写错误只在回车后发现；
- `/goal`、`/compact`、`/resume` 等能力不容易被新用户发现；
- 命令列表只存在于 `/help`，没有与输入过程结合。

现有 `SlashCommandRouter.commands()` 已经拥有命令名、usage 和 description，应作为 Palette 的唯一数据源，不能维护第二份硬编码列表。

## 3. 目标

第一版必须做到：

1. 在增强 TTY 模式下，空输入行键入 `/` 后立即显示命令列表；
2. 继续输入 ASCII 命令前缀时实时做大小写不敏感的前缀过滤；
3. `↑` / `↓` 在 Palette 打开时移动候选项并首尾循环；
4. `Tab` 或 `Enter` 可以把当前候选补全到 readline 输入行；
5. 完整手敲的合法命令仍可直接回车执行，不增加一次额外确认；
6. `Esc` 关闭 Palette，但保留当前输入；
7. 在 `/` 处按 Backspace 删除 Slash 并关闭 Palette；
8. 输入空格后退出命令名模式，参数继续由原生 readline 处理；
9. `/goal 完成测试` 等中文参数、IME 输入和粘贴仍由 readline 负责；
10. `//literal` 转义语义保持不变；
11. Renderer 输出、权限卡片或 spinner 插入时，Palette 能暂时清除并正确恢复；
12. Ctrl-C、Ctrl-D、EOF、`interrupt()`、`close()` 和终端 resize 不留下残影、监听器或错误 raw mode；
13. 非 TTY、`NO_COLOR` 或 `TERM=dumb` 完全保留当前行输入行为，不输出动态菜单；
14. 不引入 TUI 框架或新的运行时依赖。

## 4. 明确非目标

第一版不实现：

- 命令参数补全；
- Session ID、Skill 名称、文件路径或 Goal 文本补全；
- 模糊搜索、拼音搜索或语义搜索；
- 鼠标交互；
- 多列候选布局；
- 自定义快捷键配置；
- 对普通自然语言输入的自定义编辑器；
- 替换 readline 的历史、光标移动、选择、粘贴或中文 IME；
- 在非 TTY 中输出候选菜单；
- 命令使用频率排序；
- 修改 Slash Command 执行结果或权限策略；
- 引入 Ink、Blessed、Inquirer、Enquirer 或其他 TUI/Prompt 框架。

## 5. 交互契约

### 5.1 打开与过滤

初始：

```text
❯ You  /

╭─ Commands ─────────────────────────────────────────────╮
│ › /help       Show available commands                  │
│   /status     Show current session status              │
│   /sessions   List saved sessions                      │
│   /resume     Resume a saved session                   │
│   /new        Start a new session                      │
│   /history    Show recent messages                     │
╰─ ↑↓ select · Tab/Enter complete · Esc close ───────────╯
```

输入 `/go`：

```text
❯ You  /go

╭─ Commands ─────────────────────────────────────────────╮
│ › /goal       Show, set, or clear the explicit goal    │
╰─ ↑↓ select · Tab/Enter complete · Esc close ───────────╯
```

过滤规则：

- 使用 `command.name.toLowerCase().startsWith(prefix.toLowerCase())`；
- 空前缀保持注册顺序；
- 全部匹配项保留在 `matches`，菜单一次最多显示 6 行（滚动视窗），footer 显示窗口范围（如 `1–6 / 14`）；
- 选择项移动后，只要它仍在新匹配集合中就保持选择；否则回到第一项；
- 上下移动首尾循环；
- 没有匹配时显示一行 `No matching commands`，不伪造候选。

### 5.2 补全与执行

Palette 打开时：

- `Tab`：把当前候选写入输入行，格式为 `/<name> `，关闭 Palette，不提交；
- `Enter` 且当前输入已经精确等于某个注册命令（如 `/help`）：关闭 Palette并正常提交该行；
- `Enter` 且当前输入只是前缀（如 `/go`）：补全为 `/goal `，关闭 Palette，不提交；用户可继续输入参数或再次 Enter；
- `Enter` 且没有匹配项：关闭 Palette并正常提交原始输入，由现有 Router 输出 Unknown Command；
- 输入空格：关闭 Palette，原样把空格交给 readline；若命令是完整的，后续参数完全由 readline 编辑；
- `Esc`：仅关闭 Palette，保留例如 `/go` 的输入；
- Backspace：正常删除；删除到空行时关闭 Palette；
- `//`：第二个 `/` 出现时关闭 Palette，后续全部按普通 readline 输入，最终仍由 Router 转义为字面 `/`。

“选择”在本阶段等同于补全，不自动执行具有潜在副作用的 Slash Command。只有用户已经完整输入命令并按 Enter 时才直接执行。

### 5.3 其他编辑键

当 Palette 打开时收到以下操作，应先关闭 Palette，再把按键原样交给 readline：

- Left / Right；
- Home / End；
- Delete；
- PageUp / PageDown；
- Ctrl-A / Ctrl-E 等 readline 编辑快捷键；
- 未识别控制序列；
- 非 ASCII 可打印字符。

这样 Palette 不尝试维护第二套光标、选择区和 Unicode 编辑状态。用户若移动光标或进入复杂编辑，就回退到可靠的 readline 行编辑。

### 5.4 中文输入与粘贴

设计边界：Palette 只拥有开头 `/` 后、首个空格前的 ASCII 命令名。

以下输入必须工作：

```text
/goal 完成输入校验并通过测试
/compact 只保留当前 bug 的信息
//这不是命令
```

输入路由必须支持两种终端行为：

1. 每个字符独立产生 keypress；
2. 粘贴内容一次产生多个字符的 sequence。

若一次 sequence 是 `/goal 完成测试`：

- 可以短暂识别 `/goal`；
- 遇到第一个空格立即退出 Palette；
- 整个 sequence 必须原样进入 readline；
- 不得丢字符、重复字符或把中文写进 Palette 的 prefix。

未知的 bracketed-paste 控制序列应触发 fail-open：关闭 Palette并原样交给 readline。

## 6. 总体架构

```text
real stdin (TTY/raw bytes)
        │
        ▼
TerminalInputRouter
  ├─ normal mode ─────────────► RoutedReadStream ─► node:readline
  └─ slash mode ─► ReadlinePrompt key handler
                         │
                         ├─ SlashCompletionModel
                         ├─ replaceLine() / forward key
                         └─ SlashMenuPresenter ─► stdout overlay

SlashCommandRouter
  └─ descriptors() ─► CliSession ─► Prompt.read(options)
```

核心约束：

- `TerminalInputRouter` 是真实 stdin 与 readline 之间的唯一字节通道；真实 stdin 不再同时直接传给 readline；
- normal mode 的所有 sequence 原样转发，不解释普通文本；
- slash mode 仅消费明确属于 Palette 的 `↑`、`↓`、`Tab`、`Esc` 和“前缀 Enter”；
- 所有未识别输入都 fail-open 到 readline；
- `SlashCompletionModel` 是纯状态机，不访问 stream、readline、Renderer 或 Session；
- `SlashMenuPresenter` 只负责临时区域，不把候选写入滚动历史；
- `SlashCommandRouter` 仍是命令执行的唯一入口；Palette 不能直接调用 `SlashCommand.execute()`；
- Palette 补全后的文本仍走现有 `CliSession → SlashCommandRouter.route()`。

## 7. 命令描述接口

在 `src/cli/command.ts` 增加：

```ts
export type SlashCommandDescriptor = Readonly<
  Pick<SlashCommand, "name" | "usage" | "description">
>;
```

在 `SlashCommandRouter` 增加：

```ts
descriptors(): readonly SlashCommandDescriptor[];
```

返回要求：

- 注册顺序；
- 新数组、新对象，调用方不能改变 Router 内部命令；
- `name` 保持 Router 注册时的规范化小写形式；
- 不暴露 `execute`；
- `/help` 继续使用原来的 `commands()`，现有行为不变。

## 8. Prompt 读取接口

在 `src/cli/prompt.ts` 增加：

```ts
export type PromptReadOptions = {
  slashCommands?: readonly SlashCommandDescriptor[];
};

export interface Prompt {
  read(
    promptText: string,
    options?: PromptReadOptions,
  ): Promise<string | null>;
  // existing methods unchanged
}
```

规则：

- `CliSession` 仅在主输入循环调用 `read()` 时传入 descriptors；
- setup、permission confirm 和其他问答继续调用不带 options 的 `read()`；
- Palette 只能在 `options.slashCommands` 非空且增强 TTY 启用时打开；
- queued line 被直接返回时不显示 Palette；
- 一次 read resolve、interrupt 或 close 后立即清除该次 options。

现有测试 FakePrompt 可以忽略第二参数；TypeScript 允许实现方法接受更少参数，但需要显式记录 options 的测试 Fake 应使用完整签名。

## 9. SlashCompletionModel

新文件 `src/cli/slash-completion.ts`：

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

不变量：

- `maxVisible` 默认 6，必须是正整数；
- prefix 不包含 `/`；
- 只接受匹配 `^[a-z0-9-]*$` 的 prefix；非法 prefix 关闭或由 controller fail-open，Model 不静默修正；
- snapshot 和 matches 都是防御性副本；
- 无匹配时 `selectedIndex` 固定为 `-1`；
- 有匹配时 selectedIndex 始终在范围内；
- `move()` 在未激活或无匹配时不改变状态；
- `open()`、`close()` 将选择重置；
- 不执行命令，不解析 args。

## 10. TerminalInputRouter

新文件 `src/cli/terminal-input-router.ts`。

### 10.1 接口

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

生产实现：

```ts
export class TerminalInputRouter implements TerminalInputRouterPort {
  constructor(source: NodeJS.ReadableStream);
}
```

### 10.2 RoutedReadStream

Router 内部创建一个 `PassThrough` 子类作为 `readlineInput`。它必须：

- 把 `isTTY` 暴露为真实 source 的值；
- 若 source 存在 `setRawMode(boolean)`，代理该方法并返回自身；
- normal/forward 决策时写入原始 `key.sequence`；
- consume 时不写；
- handler 抛错时不得吞掉输入：捕获错误、禁用 handler，并把当前 sequence 转发；
- close 时移除 `keypress` 监听器并结束内部 PassThrough，不关闭真实 stdin。

Router 对真实 source 调用 Node 的 `emitKeypressEvents(source)`。因为 readline 只连接到 RoutedReadStream，Palette 消费方向键时不会再被 readline 同时处理，从根本上解决双消费问题。

若 sequence 为空，则使用 `text`；二者都为空时安全忽略。Router 不记录输入文本，避免把用户可能粘贴的敏感内容写入日志。

### 10.3 非 TTY

非 TTY 不创建 TerminalInputRouter，`createInterface` 继续直接使用原 input。这样管道、测试和 CI 不承担 raw-mode 或 ANSI 行为。

## 11. ReadlinePrompt Controller

`ReadlinePrompt` 在增强 TTY 下持有：

- `TerminalInputRouterPort`；
- `SlashCompletionModel`；
- `SlashMenuPresenter`；
- 当前 `PromptReadOptions`；
- `#slashSuspended` 与现有 `#suspended` 状态。

### 11.1 输入状态

```ts
type SlashInputMode = "inactive" | "active";
```

Palette 不保存完整行；完整行仍以 `Interface.line` 为准。Controller 只从“行首 `/` 到当前光标且无空格”的片段推导 prefix。

第一版只有当 cursor 位于行尾、行形如 `^/[a-z0-9-]*$` 时保持 Palette。否则立即关闭并 forward。

### 11.2 按键决策表

| 条件/按键 | 行为 | 是否 forward |
|---|---|---|
| fresh line 输入 `/` | 打开，forward 后按 `rl.line` 同步 | 是 |
| active 输入 `[a-z0-9-]` | forward，随后更新 prefix | 是 |
| active `↑` / `↓` | move、重绘 | 否 |
| active Tab | 用 selected 替换为 `/<name> `，关闭 | 否 |
| active Enter，当前是精确命令 | 清除菜单并提交 | 是 |
| active Enter，当前只是前缀且有 selected | 补全为 `/<name> `，关闭，不提交 | 否 |
| active Enter，无 selected | 清除并提交原文 | 是 |
| active Esc | 关闭并保留输入 | 否 |
| active Backspace | 同步收缩 prefix；prefix 为空则关闭并 forward | 是 |
| active 第二个 `/` | 关闭，保持 `//` 转义 | 是 |
| active 空格 | 关闭，进入参数编辑 | 是 |
| active 非 ASCII/编辑键/未知序列 | 关闭并交回 readline | 是 |
| Ctrl-C/Ctrl-D | 先清除菜单，再交给 readline | 是 |
| inactive 其他输入 | 不解释 | 是 |

Palette 同步维护自身受限 ASCII command prefix（不读取 readline line 判断逐键状态）；readline 仍是完整输入行的权威。清行替换只依赖可靠的可打印字符串插入，不依赖 programmatic 控制键写入。详细稳定化行为见
[`docs/superpowers/specs/2026-08-30-slash-command-palette-stabilization-design.md`](./2026-08-30-slash-command-palette-stabilization-design.md)。

### 11.3 替换当前行

新增私有操作：

```ts
#replaceCurrentLine(text: string): void;
```

使用 readline 的公开 `Interface.write()` 模拟 `Ctrl-U` 清行，再写入补全文本：

```ts
this.#rl.write(undefined, { ctrl: true, name: "u" });
this.#rl.write(text);
```

不得直接修改 `Interface.line` 私有状态，不得自行打印一份与 readline 不一致的输入行。

## 12. SlashMenuPresenter

新文件 `src/cli/slash-menu.ts`。

### 12.1 纯格式化

```ts
export function formatSlashMenu(
  snapshot: SlashCompletionSnapshot,
  options: {
    columns: number;
    theme: TerminalTheme;
  },
): readonly string[];
```

规则：

- `columns >= 40`：完整单列边框；
- 宽度为 `min(columns - 2, 88)`；
- 使用 `terminalWidth()` 和 `truncateToTerminalWidth()`，不能用 JS string length 对齐；
- 标题和边框使用 `brandBorder`；
- 选中符号 `›` 与命令名使用 `brandStrong` / bold；
- description 使用 muted；
- footer 为 `↑↓ select · Tab/Enter complete · Esc close`；
- 每行渲染后的可见宽度与上下边框一致；
- `columns < 40`：最多 3 条紧凑无边框记录，只显示 `› /name`，最后显示缩短的 `↑↓ · Tab · Esc`；
- 无匹配时显示 `No matching commands`；
- inactive 返回空数组。

### 12.2 临时区域 Presenter

```ts
export interface SlashMenuPresenterPort {
  render(snapshot: SlashCompletionSnapshot): void;
  clear(): void;
  suspend(): void;
  resume(snapshot: SlashCompletionSnapshot): void;
  close(): void;
}
```

生产 `SlashMenuPresenter`：

- 菜单位于 readline 输入行上方，输入行是 live region 的最后一行；
- 更新前先清除当前输入行，再只向上移动 Presenter 自己拥有的旧菜单行；
- 菜单按普通终端行输出，随后通过回调执行 `readline.prompt(true)`；
- 不跨终端滚屏保存/恢复光标，也不向输入行下方执行 cursor-down；
- 保存上次菜单硬换行数，并计入 readline 输入的换行行数；重绘前恢复 readline 记录的逻辑光标位置；
- clear 后立即重绘输入行；
- suspend 清除但不关闭 Model；
- resume 仅在 active 时重绘；
- close 移除 stdout resize 监听；
- resize 时保守清除并关闭 Palette，不猜测不同终端对既有行的 reflow 行为；
- resize 写入失败时关闭 Palette 并把按键处理权交还普通 readline；
- 不向非增强模式构造 Presenter。

Presenter 的控制序列只存在于增强 TTY；测试必须验证可见文本、live-region
替换顺序和 readline 重绘回调。真实 PTY 验收必须覆盖输入提示位于终端底部的情况。

## 13. 与 CliSession 和 Bootstrap 集成

### 13.1 CliSession

主循环改为：

```ts
const text = await this.#prompt.read(this.#inputPrompt, {
  ...(this.#router === undefined
    ? {}
    : { slashCommands: this.#router.descriptors() }),
});
```

命令仍由 `route(trimmed, context)` 执行。Palette 不产生 RouteResult，不启动模型，也不修改 Session。

### 13.2 Bootstrap

`interactive` 与 `theme` 在创建 Prompt 前计算一次：

```ts
const interactive = shouldEnableTerminalTheme({ isTTY, env });
const theme = createTheme({ enabled: interactive });
```

同一个 theme 同时传给：

- `ReadlinePromptOptions`；
- `TerminalRendererOptions`；
- welcome；
- `CommandContext`。

不得让 Prompt 和 Renderer 分别推断出不同的增强模式。

`ReadlinePromptOptions` 增加：

```ts
enhanced?: boolean;
theme?: TerminalTheme;
columns?: number;
inputRouterFactory?: (source: NodeJS.ReadableStream) => TerminalInputRouterPort;
menuPresenterFactory?: (
  options: SlashMenuPresenterOptions,
) => SlashMenuPresenterPort;
```

`enhanced` 默认 false，`theme` 默认 disabled theme，以保持直接构造
`ReadlinePrompt` 的测试与 composition seam 向后兼容；生产 Bootstrap 必须显式传入二者。
生产 `columns` 从 stdout 获取；Presenter 在 resize 时读取最新 columns，初始值缺失时使用 80。

`promptFactory` 和 `rendererFactory` 测试 seam 保留。
`inputRouterFactory` 和 `menuPresenterFactory` 只用于隔离按键与 ANSI 生命周期测试；
任一增强组件在 readline 创建前初始化失败时，应关闭已创建的部分组件并回退到
真实 input 的普通 readline，而不是阻止 CLI 启动。

## 14. 与外部输出协调

现有 Renderer 通过 `inputSurface.suspendForOutput()` / `resumeAfterOutput()` 协调 readline。Palette 必须纳入同一协议：

### suspendForOutput

1. 如果没有 pending read，保持 no-op；
2. Presenter.suspend() 清除菜单；
3. 清除 readline 当前显示行；
4. 标记 suspended；
5. 不关闭 Model，不丢 prefix 和 selection。

### resumeAfterOutput

1. `rl.prompt(true)` 重绘输入文本；
2. 若 Palette active，Presenter.resume(snapshot)；
3. 清除 suspended 标记。

以下输出都必须通过该协议：

- Agent streamed text；
- spinner/status；
- tool started/completed；
- tool stdout/stderr；
- permission card；
- Plan/Goal event；
- slash command renderer.print/error。

## 15. 中断、关闭与异常

### Ctrl-C

- Palette active 时先 clear/close Palette，再把 Ctrl-C 转发给 readline；
- 继续沿用现有 `SIGINT → CliSession.#handleSigint()`；
- idle prompt 下仍退出 Session；
- Agent run 期间仍取消当前 run；
- 不增加“第一次 Ctrl-C 只关闭 Palette”的新语义，避免与现有行为冲突。

### Ctrl-D / EOF

- 清除 Palette；
- readline close 正常把 pending read resolve 为 null；
- Session flush 和 Prompt close 保持现有行为。

### interrupt

- Presenter.clear()；
- Model.close()；
- 清除 read options；
- resolve pending null；
- 不关闭整个 InputRouter，后续 prompt 仍可使用。

### close

- 幂等；
- Presenter.close()；
- InputRouter.close()；
- 移除 SIGINT/resize/keypress listener；
- 最后关闭 readline；
- raw mode 的恢复由 RoutedReadStream 对 readline 的 `setRawMode(false)` 代理完成。

### 内部异常

- completion/filter/Presenter 错误不能让用户无法输入；
- 关闭并禁用本次 Palette，当前 sequence 原样 forward；
- 不回显原始粘贴内容到错误日志；
- 普通 readline 继续可用。

## 16. 安全与隐私

1. Palette 数据只来自本地注册的命令元数据；
2. 不把用户输入发送给模型或网络；
3. 不把选择历史持久化；
4. 不记录 raw key sequence；
5. 补全不执行命令，最终文本仍经过 SlashCommandRouter；
6. Palette 不授予工具权限；
7. 未识别输入 fail-open 到 readline，不应丢弃用户内容；
8. ANSI 控制序列只由宿主常量生成，命令 description 必须经过换行折叠与宽度截断，不能注入控制序列；
9. 使用 `stripVTControlCharacters()` 清理 descriptor 的可见字段后再渲染。

## 17. 文件职责

新增：

```text
src/cli/slash-completion.ts       纯候选过滤与选中状态机
src/cli/slash-menu.ts             菜单格式化与临时区域 Presenter
src/cli/terminal-input-router.ts  真实 stdin → keypress → readline proxy
```

修改：

```text
src/cli/command.ts                SlashCommandDescriptor
src/cli/command-router.ts         descriptors()
src/cli/prompt.ts                 read options 与 Palette controller
src/cli/session.ts                主 read 传入 descriptors
src/index.ts                      提前建立统一 interactive/theme，传入 Prompt
README.md                         Slash Palette 使用说明
docs/PROJECT_REQUIREMENTS.md      验收状态
```

测试：

```text
tests/unit/cli/slash-completion.test.ts
tests/unit/cli/slash-menu.test.ts
tests/unit/cli/terminal-input-router.test.ts
tests/unit/cli/prompt.test.ts
tests/unit/cli/command-router.test.ts
tests/unit/cli/session.test.ts
tests/integration/bootstrap.test.ts
```

不把 Palette 逻辑放进 `renderer.ts`、`command-router.ts` 或 `session.ts`。Renderer 不应该理解按键，Router 不应该理解终端，Session 不应该维护候选选择。

## 18. 测试策略

### 18.1 Completion Model

- 注册顺序与空前缀；
- 大小写不敏感前缀；
- 0、1、6、超过 6 个匹配；
- 上下移动与首尾循环；
- 过滤后保持仍存在的选中项；
- 选中项消失时回到第一项；
- 无匹配 selectedIndex=-1；
- close/open/reset；
- 防御性副本；
- 非法 prefix 和非法 maxVisible。

### 18.2 Menu

- 完整边框；
- 选中样式；
- usage/description 文本；
- 无匹配；
- 超长 ASCII、中文和 emoji 截断；
- 40、80、120 columns；
- 小于 40 的紧凑模式；
- ANSI 不计入宽度；
- description 中的换行和 ANSI 被清理；
- 清除旧行、保存恢复光标、suspend/resume；
- resize 变窄与变宽；
- close 移除 listener。

### 18.3 Input Router

- normal sequence 原样转发一次；
- consumed sequence 不进入 readline；
- handler undefined 时转发；
- handler 抛错时当前和后续 sequence 转发；
- 空 sequence fallback 到 text；
- setRawMode 代理；
- close 移除 keypress listener且不关闭 source；
- 不重复 forward；
- Ctrl-C sequence 可转发。

### 18.4 Prompt Controller

- `/` 打开；
- `/go` 过滤；
- 上下选择；
- Tab 补全且不 resolve read；
- 前缀 Enter 补全且不 resolve；
- 精确命令 Enter resolve；
- 无匹配 Enter 原样 resolve；
- Esc 保留输入并关闭；
- Backspace 到空关闭；
- 空格进入参数；
- `//literal`；
- 粘贴 `/goal 完成测试`；
- 非 ASCII 退出 Palette且不丢字符；
- Left/Right/Home/End 退出并 forward；
- Ctrl-C/Ctrl-D；
- queued lines；
- confirm 不启用 Palette；
- suspend/resume；
- interrupt/close 幂等；
- 非 TTY、NO_COLOR、TERM=dumb 无 Palette/ANSI。

### 18.5 Integration/Regression

- CliSession 每次主 read 传入最新 descriptors；
- `/help` 仍列出同一命令集合；
- 完整手敲命令行为不变；
- 未知命令行为不变；
- `//` 行为不变；
- setup 与 permission confirm 不显示 Palette；
- TTY bootstrap 共享同一 theme；
- non-TTY 输出和测试稳定；
- Renderer prompt suspension 回归；
- 全部现有 625 项测试继续通过。

## 19. 验收场景

### 场景一：发现命令

1. 启动真实 TTY；
2. 输入 `/`；
3. 无需 Tab 即出现候选列表；
4. 输入 `go`；
5. 列表只剩 `/goal`；
6. Enter 补全为 `/goal `，未执行；
7. 输入中文完成条件并 Enter；
8. Goal 正常设置，命令文本不进入模型历史。

### 场景二：方向键与执行

1. 输入 `/`；
2. 使用 Down 选择 `/status`；
3. Tab 补全；
4. Enter；
5. `/status` 正常执行；
6. Palette 清除且终端无残影。

### 场景三：直接手敲

1. 输入 `/help`；
2. Palette 随前缀过滤；
3. 在精确命令状态按 Enter；
4. 命令立即执行，不要求第二次 Enter。

### 场景四：转义与粘贴

1. 粘贴 `//literal slash text`，发送给模型的文本为 `/literal slash text`；
2. 粘贴 `/goal 完成所有测试`，完整中文参数保留；
3. 不出现重复字符、丢字符或 raw escape 文本。

### 场景五：外部输出

1. Palette 打开；
2. 触发测试 seam 模拟 Renderer 永久输出；
3. Palette 临时清除；
4. 输入行和 Palette 按原 prefix/selection 恢复；
5. 光标仍位于输入末尾。

### 场景六：降级

1. 管道运行、`NO_COLOR=1` 和 `TERM=dumb` 各执行一次；
2. 不输出 Slash 菜单或 ANSI 控制序列；
3. 完整手敲 `/help` 仍可用。

## 20. 完成定义

只有同时满足以下条件才算完成：

- 本文所有验收场景通过；
- 不新增运行时依赖；
- TTY 输入 `/` 自动显示候选；
- 过滤、Up/Down、Tab、Enter、Esc、Backspace 符合契约；
- 中文参数和粘贴测试通过；
- `//` 转义不回归；
- setup/permission confirm 不触发 Palette；
- Renderer 输出期间无菜单残影；
- interrupt/close 后无 listener 泄漏；
- non-TTY/NO_COLOR/TERM=dumb 无动态控制序列；
- `npm test` 全部通过；
- `npm run typecheck` 通过；
- `npm run build` 通过；
- README 与项目要求更新；
- 未实现本文非目标。

## 21. 设计决策摘要

| 问题 | 选择 | 理由 |
|---|---|---|
| 是否重写完整输入框 | 否 | 保留 readline 的中文、历史、粘贴和光标能力 |
| 如何避免方向键双消费 | stdin 与 readline 间增加 Router | Palette consume 后 readline 根本收不到该 sequence |
| 匹配方式 | ASCII 前缀匹配 | 简单、确定、符合命令名规模 |
| 候选数据源 | Router descriptors | 不维护第二份命令清单 |
| 选择是否立即执行 | 前缀选择只补全 | 避免误执行；完整命令 Enter 仍直接执行 |
| 参数如何输入 | 交还 readline | 中文和 IME 不进入自定义状态机 |
| 是否加入 TUI 库 | 否 | 当前范围无需新增大型依赖 |
| 何时启用 | 增强 TTY | 保持 non-TTY、NO_COLOR、dumb terminal 稳定 |
| 异常策略 | fail-open 到 readline | 自动补全故障不能阻止用户输入 |
