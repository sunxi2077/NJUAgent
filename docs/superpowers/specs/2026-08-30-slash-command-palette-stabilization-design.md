# NJUAgent Slash Command Palette 稳定性修复规格

日期：2026-08-30

状态：已确认，等待实施

修复基线：`feat/slash-command-palette` 分支，提交 `61da68e`

关联原规格：`docs/superpowers/specs/2026-08-30-slash-command-palette-design.md`

## 1. 文档目的

本文修复已经实现但在真实终端中不可可靠交互的 Slash Command Palette。它不是新一轮 UI 扩展，也不重写 readline；目标是让现有 `/` 菜单在真实 TTY 中具备正确、可测试、可降级的输入与重绘行为。

本文优先级高于原规格中与“最多 6 个匹配项”和“forward 后通过 microtask 同步 readline”有关的描述。原规格的其他边界继续有效。

## 2. 已复现的问题与证据

### 2.1 真实 TTY 复现

使用构建后的真实 `ReadlinePrompt`、`TerminalInputRouter` 和 `SlashMenuPresenter`，在伪终端中注册当前 14 个核心命令并执行：

1. 输入 `/`；
2. 等待菜单出现；
3. 输入 `g`；
4. 等待 1.5 秒；
5. 按 Enter。

实际结果：

```text
/  -> 显示 help/status/sessions/resume/new/history
g  -> 菜单不更新
Enter -> 输入被错误补全为 /help
```

InputRouter 记录表明 `g` 已经收到并返回 `forward`，但 Presenter 只收到空前缀 snapshot，没有收到 prefix=`g` 的 snapshot。问题不在终端缺少交互能力，而在 Palette 与 readline 的状态同步方式。

### 2.2 命令数据被截断

当前核心 Router 注册 14 个命令，但 `SlashCompletionModel.#matches()` 在过滤后直接 `slice(0, 6)`。结果是：

- 菜单只显示前 6 个；
- 后 8 个不在 snapshot 中；
- Up/Down 无法选中第 7 个及之后的命令；
- “最多显示 6 行”被错误实现成“系统只知道 6 条匹配”。

### 2.3 readline 同步存在竞争

当前 controller 在决定 forward 后调用：

```ts
queueMicrotask(() => this.#syncSlashState());
```

但真实链路是：

```text
keypress handler
  -> 返回 forward
  -> PassThrough.write(sequence)
  -> readline 异步/流式消费
```

microtask 执行时 readline 的 `line` / `cursor` 不保证已经包含刚刚转发的字符。FakeInputRouter 测试同步修改 FakeReadline，错误地制造了这个顺序保证。

### 2.4 菜单清除方向错误

菜单从输入行向下绘制，但当前 `#clearRows()` 从输入光标连续发出 cursor-up。它会清除输入行上方的历史内容，不能可靠清除下方菜单，并可能制造残影或视觉上的“卡住”。

### 2.5 测试存在未处理异常

当前全量测试报告：

```text
68 test files passed
716 tests passed
1 unhandled error
```

异常来自 Presenter render 抛错场景。render 位于 `queueMicrotask` 内，已经逃离按键 handler 的 `try/catch`，所以现有 fail-open 测试是假通过。

## 3. 修复目标

本轮完成后必须满足：

1. `/` 后显示当前全部匹配命令中的一个最多 6 行的视窗；
2. Up/Down 能遍历全部 14 个核心命令，视窗随选中项滚动；
3. footer 显示当前位置，例如 `1–6 / 14`、`7–12 / 14`；
4. 输入 `g` 后在同一次 keypress 处理内把候选过滤为 `/goal`，不依赖 timer、microtask 或 readline 更新时机；
5. Enter/Tab 总是基于当前 Palette prefix 和 selected command 补全，不使用过期 snapshot；
6. 菜单更新只修改输入行下方的临时区域，不清除输入行上方内容；
7. Presenter/Model 内部异常关闭 Palette 并把当前输入交还 readline，不产生 uncaught exception；
8. 中文参数、IME、粘贴、`//`、Ctrl-C、Ctrl-D、Esc、Backspace、Left/Right 保持原契约；
9. non-TTY、`NO_COLOR`、`TERM=dumb` 保持普通 readline；
10. 全量测试必须以零 unhandled error 退出；
11. 增加至少一个使用真实 Node stream、真实 `TerminalInputRouter` 和真实 readline 的集成测试；
12. 不增加运行时依赖。

## 4. 明确非目标

本轮不实现：

- Slash 参数补全；
- 模糊搜索或拼音搜索；
- 命令排序和使用频率学习；
- 鼠标操作；
- 多列菜单；
- 替换 readline；
- 重构 Agent Loop、Session、权限系统或 Renderer 的其他 UI；
- 改变命令执行语义；
- 一次性展示 14 行而不使用视窗；
- 通过增加 sleep 延迟掩盖状态竞争。

## 5. 方案选择

### 方案 A：继续延迟读取 readline 状态

可把 `queueMicrotask` 改成 `setImmediate` 或几十毫秒 timer。优点是改动小；缺点是仍依赖事件循环时序，快速输入、粘贴和不同 Node/终端环境下可能再次失效。拒绝。

### 方案 B：给 InputRouter 增加 after-forward 回调

Router 在写入 proxy 后回调 Prompt，再读取 readline 状态。它比 timer 更集中，但 Node Writable 的 write callback只保证 chunk 由 Writable 接受，不保证 readline 已完成行编辑；接口也会因一个 Palette 用例而复杂化。暂不采用。

### 方案 C：Palette 同步维护受限命令前缀

推荐并采用。Palette 只拥有“行首 `/` 后、首个空格前”的 ASCII 命令名，本来就已有 `prefix` 状态。收到合法命令字符时先同步更新 Model 和菜单，再把同一 sequence forward 给 readline；收到空格、中文或普通编辑键时立即关闭 Palette，把控制权完整交回 readline。

该方案不维护完整输入行，不接管中文、IME、历史或光标编辑，因此没有演变成第二个文本编辑器。

## 6. 修复后的状态模型

### 6.1 Snapshot

`src/cli/slash-completion.ts` 改为：

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
```

字段语义：

- `matches`：全部经过 prefix 过滤的命令，不截断；
- `selectedIndex`：相对于全部 matches 的绝对下标；
- `windowStart`：当前视窗第一项在 matches 中的下标；
- `visibleMatches`：`matches.slice(windowStart, windowStart + pageSize)`；
- `totalMatches === matches.length`；
- 无匹配时 selectedIndex 为 -1，windowStart 为 0；
- 默认 `pageSize = 6`，它只控制显示行数，不控制匹配数量。

### 6.2 视窗不变量

当存在匹配时：

```text
0 <= selectedIndex < totalMatches
0 <= windowStart < totalMatches
windowStart <= selectedIndex < windowStart + pageSize
visibleMatches.length <= pageSize
```

移动规则：

- Down 从最后一项循环到第一项；
- Up 从第一项循环到最后一项；
- selectedIndex 超过视窗底部时，windowStart 向下移动到能包含 selected；
- selectedIndex 移到视窗顶部之前时，windowStart 等于 selectedIndex；
- 循环到第一项时 windowStart=0；
- 循环到最后一项时 windowStart=`max(0, totalMatches-pageSize)`；
- prefix 变化后尽量按 command name 保留选择；选中项不再匹配时回到第一项。

## 7. 同步输入状态机

### 7.1 核心原则

删除 Palette 路径中的全部 `queueMicrotask(() => #syncSlashState())`。Palette 的 Model 是其 ASCII command prefix 的权威状态，readline 是完整输入行的权威状态；两者不再通过异步读取进行逐键同步。

### 7.2 打开

inactive 状态收到 `/` 时，只有同时满足以下条件才打开：

```ts
this.#currentLine() === "" && this.#currentCursor() === 0
```

处理顺序：

1. `completion.open(commands)`；
2. slashMode=active；
3. 同步 render 空 prefix 菜单；
4. 返回 forward，让 readline 接收 `/`。

一次 keypress 的 text/sequence 若完整匹配 `^/[a-zA-Z0-9-]*$`，也允许一次性打开并把 `/` 后内容设为 prefix；若包含空格、中文、第二个 `/` 或控制序列，则不打开菜单，整个 sequence 原样 forward。

### 7.3 active 状态输入命令字符

合法 command chunk 为：

```ts
const COMMAND_CHUNK = /^[a-zA-Z0-9-]+$/u;
```

收到合法 chunk：

1. `nextPrefix = snapshot.prefix + text`；
2. `completion.updatePrefix(nextPrefix)`；
3. 同步 render；
4. 返回 forward。

不再读取 `rl.line` 判断刚输入的字符是否出现。

### 7.4 Backspace

- prefix 非空：先删除 prefix 最后一个 ASCII code point、更新并 render，然后 forward Backspace；
- prefix 为空：关闭 Palette，然后 forward Backspace，使 readline 删除 `/`；
- 不使用 microtask。

### 7.5 Enter 与 Tab

- 精确命令判断使用 `completion.snapshot().prefix`；
- selected 使用相对于全部 matches 的 selectedIndex；
- 精确命令 Enter：关闭并 forward，readline 提交完整行；
- 非精确前缀且有 selected：替换为 `/<selected.name> `、关闭、consume；
- 无匹配 Enter：关闭并 forward，让现有 Router 报 Unknown Command；
- Tab：有 selected 时补全；无 selected 时 consume，不向 readline 插入 tab。

### 7.6 退出命令名模式

以下输入同步关闭 Palette并 forward：

- 空格；
- 第二个 `/`；
- 中文或其他非 ASCII 可打印内容；
- Left/Right/Home/End/Delete；
- Ctrl-A/Ctrl-E；
- bracketed paste 或未知控制序列。

关闭后不再尝试根据 readline line 自动重新打开。只有用户回到空行再次输入 `/` 才重新进入。

## 8. Menu Presenter 坐标修复

### 8.1 绘制锚点

每次 `render()` 调用时，真实光标位于 readline 输入行。Presenter 必须：

1. 保存输入光标；
2. 每行先向下移动一行；
3. 回到列 0；
4. 清除整行；
5. 写入菜单行；
6. 最后恢复输入光标。

禁止依赖 `\r\n` 作为菜单定位手段，避免在终端底部触发不受控滚屏。

### 8.2 清除

`#clearRows()` 必须从输入行向下清除：

```text
save cursor
repeat lastRows times:
  cursor down 1
  carriage return
  clear entire line
restore cursor
```

使用 clear-entire-line `ESC[2K`，而不是只清除光标右侧的 `ESC[K`。

清除过程中不得出现 cursor-up。测试必须明确断言 clear delta 不包含 `\x1b[A`。

### 8.3 视窗 footer

完整模式 footer 示例：

```text
╰─ ↑↓ select · Tab complete · Esc close · 1–6 / 14 ─────╯
```

当 totalMatches <= pageSize 时可省略范围，仅显示 `6 commands`；无匹配显示 `0 commands`。窄终端 compact 模式使用：

```text
↑↓ · Tab · Esc · 1–3/14
```

## 9. 错误边界

### 9.1 Prompt 同步错误

所有 Model update、selection、replaceLine 和 Presenter render 都发生在 `#onKey()` 的同步 `try/catch` 内。捕获后：

1. 尝试 `presenter.clear()`，clear 自身错误必须二次吞掉；
2. completion.close()；
3. slashMode=inactive；
4. 本次按键返回 forward；
5. 本次 read 禁用 Palette handler；
6. 不记录 raw text。

### 9.2 Presenter resize 错误

resize listener 内部不得抛出。格式化或 output.write 同步抛错时：

- 清除 lastRows/lastSnapshot；
- 标记 Presenter disabled；
- 移除 resize listener；
- 后续 render/clear/resume 成为 no-op；
- readline 继续可用。

### 9.3 测试进程

任何 `unhandledRejection`、`uncaughtException` 或 Vitest unhandled error 都视为失败。不能以“所有 assertion 已通过”宣称测试通过。

## 10. 测试架构修复

### 10.1 纯 Model 测试

至少使用 14 个 descriptors，验证：

- matches=14、visibleMatches=6；
- Down 到第 7 项后 windowStart 更新；
- Up/Down 可遍历所有 14 项；
- 首尾循环；
- prefix `/g` 只匹配 goal；
- 过滤后选择保持/重置；
- snapshot 防御性副本。

### 10.2 Presenter 控制序列测试

测试只看“包含某个 ANSI”不够。必须解析 render/clear delta，断言：

- save/restore 成对；
- 每个菜单行由 cursor-down 定位；
- clear 使用 `\r\x1b[2K`；
- clear 不包含 cursor-up；
- 从 8 行变 3 行后旧 8 行全部被清除；
- 输入行上方没有任何定位序列。

### 10.3 Prompt 单元测试

FakeInputRouter 不再负责制造“forward 后 readline 已同步”的假设。测试在调用 handler 后立即断言 completion render 已经更新；对 `/go` 不使用 `await Promise.resolve()` 驱动过滤。

### 10.4 真实 stream 集成测试

新增一个不注入 FakeInputRouter、不注入 FakeReadline 的测试：

```text
TTY-like PassThrough source
  -> real TerminalInputRouter
  -> real node:readline Interface
  -> RecordingPresenter
```

通过条件轮询而非固定 sleep 等待 snapshot，验证：

1. source 写 `/`，收到 prefix=""；
2. source 写 `g`，下一个 snapshot 必须 prefix="g" 且只含 goal；
3. Enter 补全 goal，而不是 help；
4. 再次 Enter resolve `/goal `；
5. close 后所有 listener 被清理。

该测试直接覆盖本次真实故障的数据边界。

### 10.5 PTY 手工验收

在 macOS/Linux 真实终端执行构建产物，至少完成：

- `/` 显示 6/14 视窗；
- 连续 Down 13 次能看到并选中 `/exit`；
- 再 Down 循环到 `/help`；
- 输入 `g` 立即只显示 `/goal`；
- Enter 补全 `/goal `；
- 输入中文参数正常；
- Esc 关闭无残影；
- 上方历史文本不被清除；
- resize 后菜单仍正确；
- Ctrl-C/Ctrl-D 无 listener 泄漏。

## 11. 文件范围

必须修改：

```text
src/cli/slash-completion.ts
src/cli/prompt.ts
src/cli/slash-menu.ts
tests/unit/cli/slash-completion.test.ts
tests/unit/cli/prompt.test.ts
tests/unit/cli/slash-menu.test.ts
tests/integration/slash-palette.test.ts
```

只有测试证明必要时才修改：

```text
src/cli/terminal-input-router.ts
tests/unit/cli/terminal-input-router.test.ts
README.md
docs/PROJECT_REQUIREMENTS.md
```

不修改：

```text
src/agent/**
src/sessions/**
src/permissions/**
Slash Command execute implementations
package runtime dependencies
```

## 12. 完成定义

以下条件必须同时成立：

- 14 个核心命令全部可通过方向键访问；
- 菜单最多只占 6 个候选行；
- footer 准确显示窗口范围/总数；
- `/` 后输入 `g` 立即过滤为 `/goal`；
- 不存在 Palette `queueMicrotask` 状态同步；
- Enter 不会基于过期候选补全错误命令；
- clear delta 不含 cursor-up；
- 菜单关闭后没有残影，不清除上方历史；
- Presenter 抛错测试没有 unhandled error；
- 真实 stream 集成测试覆盖 `/` → `g` → goal；
- 中文参数、`//`、直接命令、unknown command 全部回归通过；
- non-TTY/NO_COLOR/TERM=dumb 回归通过；
- `npm test` exit code 0，且输出没有 Unhandled Errors；
- `npm run typecheck` exit code 0；
- `npm run build` exit code 0；
- 不新增运行时依赖；
- 真实 TTY 手工验收完成。
