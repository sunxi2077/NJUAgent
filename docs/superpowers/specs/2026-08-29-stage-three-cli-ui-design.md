# NJUAgent 第三阶段 CLI UI 优化设计规范

日期：2026-08-29

状态：设计已确认，等待实施计划与开发

前置基线：`main` at `d32afe3`，第二阶段验收修复已合并

关联规范：`docs/superpowers/specs/2026-08-28-stage-two-productization-design.md`

## 1. 文档目的

本文冻结 NJUAgent 本轮 CLI 视觉优化的范围、交互契约、模块边界、流式 Markdown 语义、异常降级和验收标准。实施 Agent 应逐项满足本文，不应自行引入全屏 TUI、Slash 候选菜单、语法高亮或其他产品功能。

本轮只改终端表现层，不改变 Agent Loop、Provider、工具协议、权限模型、会话存储、上下文压缩或 Skills 行为。若本文与第二阶段规范中的旧视觉示例冲突，以本文为准；其余第二阶段约束继续有效。

## 2. 背景与现状问题

当前 `main` 已经具备可用的普通 CLI、一次性欢迎框、南大紫主题、readline 输入、流式模型输出和本地 Slash 命令。不过真实 TTY 使用暴露出以下问题：

1. `NJUAgent v0.2.0` 的亮紫色合适，但边框使用 ANSI 256 色 `54`，在深色终端上过暗；
2. 欢迎页缺少醒目的产品标志，开场辨识度不足；
3. 输入区只有 `› `，在长对话中难以定位用户问题；
4. 用户输入与模型正文缺少固定角色锚点，向上滚动时不易划分轮次；
5. 模型输出中的 `**`、反引号、标题和列表仍以原始 Markdown 符号显示；
6. 正文、工具记录和完成状态的颜色与留白层级不足，整体显得平；
7. 当前 `TerminalRenderer` 直接写入模型 delta，如果继续在同一文件内加入 Markdown 解析，会造成职责膨胀。

## 3. 阶段目标

本轮完成以下目标：

1. 启动时展示带边框的大型 ASCII `NJU` 欢迎卡片；
2. 保留明亮南大紫品牌色，同时提高边框可见度；
3. 将 readline 提示符升级为明显的彩色 `❯ You  `；
4. 在每个实际产生正文的模型片段前显示彩色 `◆ NJUAgent`；
5. 在保持流式输出的前提下渲染常用 Markdown 子集；
6. 用稳定的颜色、图标、缩进和留白区分用户、模型、工具、成功、警告和错误；
7. 保持普通 CLI 和永久 scrollback，不进入 alternate screen；
8. 保持非 TTY、`NO_COLOR`、窄终端和异常 Markdown 的可靠降级；
9. 通过单元测试、完整回归和真实终端人工验收固定行为。

## 4. 明确非目标

本轮不实现：

- 输入 `/` 后自动弹出的 Slash Command 候选菜单；
- Slash 命令的方向键选择、实时过滤或自动补全；
- TypeScript、Python、Shell 等代码语法高亮；
- GFM 表格、任务列表、脚注、图片和 HTML；
- Ink、React、Blessed 或其他全屏 TUI；
- alternate screen、鼠标交互、固定侧栏或底部状态栏；
- 用户自定义主题、主题配置文件或自动检测终端明暗主题；
- OSC 8 可点击链接；
- 修改 Slash Command 路由、命令语义或现有命令集合；
- 修改会话历史格式、上下文管理、模型协议或 Agent 行为。

现有 `/help`、`/status`、`/sessions`、`/history`、`/context`、`/compact`、`/skills`、`/skill`、`/setup`、`/new`、`/resume` 和 `/exit` 继续通过当前路由工作。Slash 候选菜单可作为后续独立阶段重新评估，不能由本轮实施者顺手加入。

## 5. 产品形态与目标转录

最终产品仍是普通 Node.js CLI。所有完成的输入、回答、工具活动和状态都永久保留在终端 scrollback 中。

目标欢迎页：

```text
╭────────────────────────────────────────────────────────╮
│                                                        │
│  ███╗   ██╗     ██╗██╗   ██╗                          │
│  ████╗  ██║     ██║██║   ██║                          │
│  ██╔██╗ ██║     ██║██║   ██║                          │
│  ██║╚██╗██║██   ██║██║   ██║                          │
│  ██║ ╚████║╚█████╔╝╚██████╔╝                          │
│  ╚═╝  ╚═══╝ ╚════╝  ╚═════╝                           │
│                                                        │
│  NJUAgent v0.2.0                                       │
│  workspace  /tmp/demo                                  │
│  model      deepseek-v4-flash                          │
│  session    5027fd35 · new · balanced                  │
│                                                        │
╰────────────────────────────────────────────────────────╯
  Type /help for commands · Ctrl-C cancels
```

目标对话转录：

```text
❯ You  帮我分析一下这个项目

◆ NJUAgent

我先检查项目结构，然后给出修改建议。

  主要问题
  ────────
  • 输入区缺少明显的视觉锚点
  • 模型输出没有渲染 Markdown
  • 状态信息与正文层级接近

我会先读取 `src/cli`，再运行测试。

⚙ read_file · src/cli/renderer.ts
  ✓ read_file · 12ms

◆ NJUAgent

已经找到问题，主要集中在 TerminalRenderer。

✓ Completed · 2 steps · 1 tool call · 2.8s

❯ You
```

以上代码块表达结构而非逐字快照。实际终端中角色标签、边框、标题、代码和状态使用第 6 节定义的颜色。

## 6. 主题与视觉层级

### 6.1 语义化主题接口

扩展 `src/cli/theme.ts`，由 `TerminalTheme` 集中提供语义样式。建议接口至少覆盖：

```ts
type TerminalTheme = {
  enabled: boolean;
  brandStrong(text: string): string;
  brandBorder(text: string): string;
  userLabel(text: string): string;
  assistantLabel(text: string): string;
  heading(text: string): string;
  code(text: string): string;
  quote(text: string): string;
  success(text: string): string;
  warning(text: string): string;
  error(text: string): string;
  muted(text: string): string;
  bold(text: string): string;
  italic(text: string): string;
  underline(text: string): string;
};
```

最终命名可以根据现有代码小幅调整，但必须保持“调用方使用语义，不直接写 ANSI 色号”的边界。

### 6.2 固定颜色策略

- `brandStrong` / `assistantLabel`：ANSI 256 色 `141`，并对角色标签加粗；
- `brandBorder`：ANSI 256 色 `99`，替换当前过暗的 `54`；
- `userLabel`：高对比青色，建议 ANSI 256 色 `45`，并加粗；
- `code`：比正文更亮的浅青色，建议 ANSI 256 色 `81`；
- `heading`：`brandStrong + bold`；
- `quote` / `muted`：终端 dim 灰色或灰紫色；
- `success`：标准绿色；
- `warning`：标准黄色；
- `error`：标准红色。

品牌紫不能替代所有语义色。成功、警告、失败继续使用绿、黄、红，工具活动可以使用品牌色或浅蓝色。正文使用终端默认前景色，避免大面积着色导致疲劳。

### 6.3 颜色关闭

以下任一条件成立时，主题必须完全禁用：

- stdout 不是 TTY；
- `NO_COLOR` 环境变量存在且非空；
- 调用方显式传入 plain/no-color 选项；
- `TERM=dumb`。

禁用主题时所有 formatter 都是恒等函数，输出不得含 `\x1b[`。不得在各组件内重复读取环境变量；由 composition root 或统一的 theme factory 决定。

## 7. 欢迎卡片

### 7.1 内容与颜色

欢迎卡片继续由 `src/cli/welcome.ts` 生成，并保持“一次启动只打印一次”。

- 整个 ASCII `NJU` 使用 `brandStrong`；
- `NJUAgent v0.2.0` 使用 `brandStrong`；
- 圆角边框使用 `brandBorder`；
- `workspace`、`model`、`session` 标签使用 muted 或默认灰色；
- 值使用终端默认前景色；
- `/help`、Ctrl-C 和 `/resume` 提示位于边框外，使用 muted；
- recent session 提示继续保留，不能因重做欢迎页而删除。

### 7.2 响应式规则

`formatWelcome()` 继续接收终端列数。采用确定性的三档布局：

1. `columns >= 64`：显示完整 ASCII `NJU` 和带边框信息卡；
2. `36 <= columns < 64`：隐藏 ASCII `NJU`，显示紧凑的带边框标题和信息；
3. `columns < 36`：使用无边框的纯文本布局，逐行截断长值。

带边框卡片宽度不得直接占满终端：

- 最大宽度为 72 列；
- 右侧至少预留 2 列，避免边框贴住终端边缘或触发自动换行；
- 最终宽度为内容期望宽度、最大宽度和 `columns - 2` 的安全组合；
- workspace/model 过长时按 Unicode code point 截断并添加 `…`；
- 每一行去除 ANSI 后的显示宽度必须一致；
- 任何宽度下都不得出现单独悬空的 `│`、`╮` 或 `╯`。

### 7.3 Plain 模式

Plain 模式不输出彩色边框或大段 ASCII Logo，只输出稳定记录：

```text
NJUAgent v0.2.0
[session] 5027fd35
workspace: /tmp/demo
model: deepseek-v4-flash
permission mode: balanced
Type /help for usage, or enter a task.
```

现有非 TTY 契约和 recent session 提示保持兼容。

## 8. 输入提示与用户消息锚点

### 8.1 提示符

普通交互提示符改为：

```text
❯ You
```

- `❯ You` 使用 `userLabel`；
- 角色标签后恰好保留两个空格；
- readline 继续通过 `setPrompt()` 和 `prompt(true)` 持有完整提示符；
- 不通过手工 `stdout.write()` 伪造提示符；
- 用户按 Enter 后，终端自然保留彩色角色标签和用户原文，形成永久 scrollback 锚点；
- Slash 命令也使用同一提示符，不额外区分角色。

`CliSession` 不应直接构造 ANSI。可以在 `CliSessionOptions` 中注入已格式化的 `inputPrompt`，并为测试和 plain 模式保留无颜色默认值。具体依赖注入由实施计划冻结。

### 8.2 保留 readline 能力

本轮不能用自定义 raw-mode 行编辑器替换 Node readline。必须保留现有：

- 中文输入法；
- 左右/Home/End 光标移动；
- Backspace/Delete；
- 历史记录；
- 单行与多行粘贴队列；
- 当前 Ctrl-C、EOF、确认问题和 suspend/resume 行为。

彩色 ANSI 提示符必须通过真实 TTY 验证光标位置和重绘宽度。不得使用 Bash 专用的 `\001`/`\002` 包裹方案污染 Node readline；优先依赖 Node 对 VT 控制序列的显示宽度处理，并通过测试与人工验收确认。

## 9. 模型角色锚点与对话分段

### 9.1 延迟输出标签

`TerminalRenderer` 在 `model_started` 时仍可以显示瞬态 spinner，但不能立即打印永久的 `◆ NJUAgent`。只有该模型 step 的第一个非空 `text_delta` 到达时才打印：

```text
◆ NJUAgent

```

原因是部分模型 step 会直接产生 tool use 而没有正文；这些 step 不应留下空角色标签。

### 9.2 分段状态

Renderer 至少维护：

- 当前模型 step 是否已经开始；
- 当前 step 是否已经输出 assistant 标签；
- 当前 Markdown renderer 是否存在未刷新状态；
- 当前是否有未结束的流式文本行。

行为要求：

1. 每个实际产生正文的模型 step 恰好打印一个 `◆ NJUAgent`；
2. 同一 step 的多个 delta 不重复标签；
3. 工具调用后新的模型 step 若产生正文，再打印一个标签；
4. 无正文、直接工具调用的 step 不打印标签；
5. retry、usage 和 transient status 不触发标签；
6. `model_completed`、`tool_started`、`run_finished` 和错误边界都要先刷新 Markdown 状态；
7. 一轮完成状态与下一次 `❯ You` 之间保留一个空行；
8. 不能因插入标签而重复或吞掉模型文本。

### 9.3 工具与状态层级

保留第二阶段已有的简洁工具转录：

```text
⚙ read_file · src/index.ts
  ✓ read_file · 12ms
```

- 工具开始符号使用品牌色或浅蓝色；
- 工具成功使用绿色，失败使用红色；
- stdout/stderr 继续缩进在 `│` 后；
- 完成摘要保持 `✓ Completed · 2 steps · 1 tool call · 2.8s`；
- 不恢复内部 call id、原始 JSON 或 `duration_ms=` 等调试格式；
- 不把大段工具输出整体染成品牌紫。

## 10. 流式 Markdown 渲染

### 10.1 组件边界

新增 `src/cli/streaming-markdown.ts`。该组件：

- 只接收模型原始文本增量和 `TerminalTheme`；
- 不接收 AgentEvent、会话、工具或 Provider；
- 不修改或保存对话历史；
- 只产生用于当前终端显示的字符串；
- 能在任意 chunk 边界正确工作；
- 提供明确的 `push(text)`、`flush()`、`reset()` 契约。

可采用返回字符串或注入 writer 的方式，但不得让 Markdown 组件直接控制 readline、spinner 或工具记录。

建议接口：

```ts
interface StreamingMarkdownRenderer {
  push(text: string): string;
  flush(): string;
  reset(): void;
}
```

`push()` 返回当前已经可以安全展示的内容；`flush()` 在模型/工具/运行边界输出剩余可读文本并关闭所有 ANSI 样式；`reset()` 清除内部状态且不产生内容。

### 10.2 支持语法

只支持以下子集：

| Markdown | TTY 表现 |
|---|---|
| `#` 至 `######` 标题 | 隐藏井号，使用 heading/bold；一级、二级标题在换行后生成最长 24 列的 muted `─` 分隔线，三级至六级不生成分隔线 |
| `**bold**` | 隐藏星号，输出真正粗体 |
| `*italic*` | 隐藏星号，输出斜体；终端不支持时退化为普通文本 |
| `` `code` `` | 隐藏反引号，使用 code 色 |
| `- item` / `* item` | 转换为 `• item` 并保持缩进 |
| `1. item` | 保留序号并突出序号部分 |
| `> quote` | 转换为 muted `│ ` 前缀 |
| 围栏代码块 | 隐藏 fence；每行输出 `  │ ` 和统一 code 色 |
| `[label](url)` | label 使用 underline，URL 以 muted `(url)` 显示 |

不识别嵌套列表的完整 CommonMark 语义。最多尊重模型已经给出的前导空格，并在其后转换项目符号。代码块内部所有 Markdown 均视为普通代码文本。

### 10.3 增量解析策略

实现小型确定性状态机，不引入完整 Markdown/UI 框架。状态至少覆盖：

- 是否位于行首；
- 当前 block 类型：普通、标题、引用、列表、代码围栏；
- inline 状态：普通、bold、italic、inline code；
- 尚未判断完整的 delimiter 缓冲；
- 链接候选缓冲；
- 是否已经输出 ANSI style，需要在边界 reset。

行首解析允许短暂缓存前缀，以识别 `### `、`- `、`1. `、`> ` 或三反引号。前缀一旦不能构成已支持语法，立即按原文释放，不能缓存整行。

Inline 解析只缓存尚未闭合判断的最短内容：

- `*` 最多等待下一字符，以区分 italic 与 bold；
- 反引号在行首需要区分单个 inline code 与三个 code fence；
- 链接从 `[` 开始保守缓存，遇到换行、明显不匹配或达到 2048 字符时按原文释放；
- 不得为了正确渲染 Markdown 而缓存整段模型回答；
- 普通长段落必须持续出现在终端，不能等 `model_completed` 后一次性跳出。

chunk 边界不得影响结果。例如以下三种输入应得到相同的可见文本与样式：

```ts
push("**important**")

push("*")
push("*important*")
push("*")

push("**impor")
push("tant")
push("**")
```

### 10.4 Flush 与异常 Markdown

`flush()` 必须：

1. 输出仍在缓冲中的普通字符或未识别标记；
2. 关闭 bold、italic、code、heading 等 ANSI 样式；
3. 对未闭合 inline 标记保证正文可读，不要求补造模型未输出的内容；
4. 对未闭合代码围栏结束 code block 显示状态；
5. 以可预测方式处理尾部换行，不制造多余空白行；
6. 让下一模型片段从干净的 plain 状态开始。

任何解析失败都必须回退为原始可读文本，不能抛出导致 Agent 主循环退出的异常。即使输入包含控制字符，也必须保证本组件自己生成的 ANSI 序列最终 reset。安全清洗模型提供的任意终端控制序列沿用项目现有策略；如果现有项目没有该策略，本轮不顺手扩张成完整终端安全项目，但实施计划应加入一条回归测试，确保普通 Markdown 不产生额外控制序列。

### 10.5 Plain 模式

非 TTY/no-color 模式继续使用现有 newline-safe `[model] ...` 记录，并保留模型原始 Markdown 文本。Plain 模式不调用彩色 Markdown renderer，原因是：

- 管道使用者可能需要原始 Markdown；
- `[model]` 前缀契约已经稳定；
- 去除 Markdown 标记会造成机器可读输出的信息损失。

## 11. 总体架构与数据流

```text
CliSession
 ├─ ReadlinePrompt
 │    └─ themed `❯ You  ` prompt
 └─ TerminalRenderer
      ├─ TerminalTheme
      ├─ assistant-segment state
      ├─ StreamingMarkdownRenderer
      ├─ tool/status rendering
      └─ Prompt suspend/resume coordination

WelcomeView ──► formatWelcome(theme, columns) ──► stdout

AgentEvent.text_delta
  ──► TerminalRenderer lazily prints `◆ NJUAgent`
  ──► StreamingMarkdownRenderer.push(raw delta)
  ──► styled terminal bytes
  ──► stdout
```

架构约束：

- `src/index.ts` 仍是 composition root，只创建主题、提示符、Renderer 和 Session；
- `CliSession` 不解释 Markdown，不决定模型标签；
- `ReadlinePrompt` 不解析 Slash 命令，不渲染模型文本；
- `StreamingMarkdownRenderer` 不知道 AgentEvent；
- `TerminalRenderer` 不读取会话文件，也不修改 history；
- 所有 ANSI 只存在于显示层，绝不能写入 Session 或模型上下文；
- 不为了本轮 UI 重构 Agent 事件类型，除非测试证明现有事件无法表达已确认行为；按当前代码，现有事件已足够。

## 12. 建议文件范围

预计实施文件：

```text
src/cli/theme.ts
src/cli/welcome.ts
src/cli/prompt.ts
src/cli/session.ts
src/cli/renderer.ts
src/cli/streaming-markdown.ts        # new
src/index.ts                          # composition only

tests/unit/cli/theme.test.ts
tests/unit/cli/welcome.test.ts
tests/unit/cli/prompt.test.ts
tests/unit/cli/session.test.ts
tests/unit/cli/renderer.test.ts
tests/unit/cli/streaming-markdown.test.ts  # new
```

若实际实现不需要修改其中某个文件，可以省略。不得以 UI 优化为由移动无关文件或改写 Session/Context/Skill 子系统。

## 13. 错误处理与终端完整性

### 13.1 输出边界

在以下事件前必须先 flush 当前 Markdown 并补齐必要换行：

- `model_completed`；
- `tool_started`；
- `run_finished`；
- retry 永久消息；
- Renderer error；
- CLI 退出或取消。

工具输出和永久状态写入时继续调用 `inputSurface.suspendForOutput()` / `resumeAfterOutput()`。不得退回手工重复打印用户 prompt 的方案。

### 13.2 ANSI 完整性

- 每个永久输出边界都应处于 reset 状态；
- 主题 formatter 必须闭合自己产生的序列；
- Markdown 的跨 delta style 可以保持打开，但 flush 必须 reset；
- error path 和 `finally` path 也必须 reset；
- plain 模式断言不得发现任何 ESC 字节。

### 13.3 写入失败

本轮不重新设计 stdout backpressure 或 EPIPE 策略。Renderer 应保持当前同步 writer 契约。Markdown parser 自身不得主动退出进程；如果 parser 内部出现意外状态，应 reset 并输出当前可恢复文本。真正的 stdout 写入异常继续由现有顶层错误处理负责。

## 14. 测试要求

所有行为变更遵循 RED → GREEN。测试断言优先检查“去除 ANSI 后的稳定结构”和关键 ANSI 语义，避免对每一个 escape byte 建立脆弱大快照。

### 14.1 Theme 测试

- enabled theme 的 `brandStrong`、`brandBorder` 和 `userLabel` 产生不同 ANSI 样式；
- `brandBorder` 不再使用色号 `54`；
- disabled theme 的所有 formatter 都返回原文；
- `TERM=dumb`/NO_COLOR 的启用判断由负责该判断的单元覆盖。

### 14.2 Welcome 测试

- 80 或 100 列显示完整 ASCII `NJU`；
- 60 列隐藏 ASCII Logo，但保留完整边框；
- 40 列显示紧凑边框；
- 小于 36 列退化为无边框文本；
- 去除 ANSI 后每个边框行宽一致且不超过安全终端宽度；
- 长 workspace/model 截断后不破坏右边框；
- recent session `/resume` 提示仍然存在；
- plain 模式无 ANSI、无大 Logo、字段完整。

### 14.3 Prompt 与 Session 测试

- readline 收到完整的 `❯ You  ` 提示字符串；
- no-color/default seam 能使用纯文本提示符；
- suspend/resume 后仍调用 `prompt(true)` 且不丢 `rl.line`；
- 快速多行粘贴队列行为保持不变；
- Ctrl-C、EOF、`/exit` 与命令路由测试全部继续通过；
- ANSI prompt 不被 Renderer 当作用户正文写入 history。

### 14.4 Streaming Markdown 测试

每种语法至少包含完整 chunk 和碎片 chunk 两类测试：

- 标题 1–6 级；
- bold delimiter 在 2–4 个 delta 中拆分；
- italic 与列表 `* ` 的歧义；
- inline code delimiter 拆分；
- fenced code 的 opening/closing fence 拆分；
- 代码块内的 `**`、`#` 和反引号不被二次解析；
- 无序列表、有序列表、引用与缩进；
- Markdown link 完整、跨 chunk、在换行前未闭合和超过缓冲上限；
- 中文、中文标点、Emoji 和空行；
- 未闭合 bold、inline code 和 code fence 的 flush；
- flush 后下一段从 clean state 开始；
- 任意分块方式得到相同的 ANSI-stripped 可见文本；
- plain 路径保留原始 Markdown。

### 14.5 TerminalRenderer 测试

- `model_started` 不立即打印 assistant 标签；
- 首个非空 `text_delta` 前打印一次 `◆ NJUAgent`；
- 同一 step 多个 delta 不重复标签；
- 空 delta 不触发标签；
- 直接 tool use 不产生空标签；
- tool 前后两个有正文的模型 step 分别产生标签；
- tool/status/run summary 保持现有简洁格式；
- completion、error 和 cancel 后没有未闭合 ANSI；
- 非 TTY 现有 `[model]`、`[tool]`、`[run]` 契约不回归。

### 14.6 完整验证

实施结束必须运行：

```bash
npm run typecheck
npm test
npm run build
```

不得只报告新增测试。若 smoke test 需要真实 API Key，可以明确标记 SKIP，但 typecheck、全量单测和 build 必须 PASS。

## 15. 人工验收脚本

在 macOS Terminal 或等价真实 TTY 中执行构建产物：

```bash
npm run build
node dist/index.js --workspace /tmp/demo
```

依次检查：

1. 首次进入后屏幕已清理，只出现一次欢迎卡片；
2. 宽终端显示完整 ASCII `NJU`，标题为亮紫，边框明显可见但比标题弱；
3. 将窗口缩窄后重新启动，Logo/边框按第 7.2 节降级；
4. `❯ You` 为高对比青色，输入中文、移动光标、退格和粘贴均正常；
5. 请求模型输出包含标题、粗体、斜体、列表、引用、inline code、代码围栏和链接的回答；
6. 确认 Markdown 标记被正确渲染，没有残留常见的 `**` 或 fence；
7. 触发至少一次读文件或命令工具，确认工具前后模型片段都容易区分；
8. 产生三轮以上中文对话并向上滚动，能依靠 `❯ You` 与 `◆ NJUAgent` 快速定位轮次；
9. 在模型输出时 Ctrl-C，确认颜色复位、提示符恢复且下一轮可输入；
10. 执行 `/help`、`/status`、`/history` 和 `/exit`，确认命令没有回归；
11. 通过管道或 `NO_COLOR=1` 运行，确认输出无 ANSI 且结构可读。

## 16. 验收标准

以下条件全部满足才算完成：

- 欢迎页包含响应式 ASCII `NJU` 和可见的浅紫边框；
- `NJUAgent v0.2.0` 保持明亮南大紫；
- 输入行使用明显的 `❯ You`，模型片段使用明显的 `◆ NJUAgent`；
- 向上滚动时用户与模型可以通过颜色和标签快速区分；
- 常用 Markdown 子集在 TTY 中正确显示，不再普遍暴露 `**` 和 fence；
- 流式输出仍然逐步出现，不等待整段完成；
- 工具、状态、成功、警告和错误拥有稳定视觉层级；
- readline 中文输入、粘贴、历史、光标和 Ctrl-C 行为无回归；
- Slash 命令继续工作，但没有新增 Slash 候选菜单；
- 非 TTY、NO_COLOR、TERM=dumb 和窄终端降级通过；
- 新增测试、现有全量测试、typecheck 和 build 全部通过；
- 人工 TTY 验收没有光标错位、重复标签、边框断裂或颜色泄漏。

## 17. 实施顺序建议

实施计划应按以下依赖顺序拆分，而不是并行修改同一 Renderer：

1. 扩展 Theme 语义 token，并固定 no-color 契约；
2. 重做响应式 Welcome 卡片；
3. 注入 `❯ You` readline 提示符并验证重绘；
4. 以独立测试驱动实现 Streaming Markdown；
5. 将 assistant 分段状态和 Markdown renderer 接入 TerminalRenderer；
6. 调整工具/完成状态周围的留白；
7. 执行全量自动验证和真实 TTY 人工验收；
8. 只在行为与本文不一致时修正文档，不扩张产品范围。

每一步都应先写失败测试，再实现最小代码，并在进入下一步前运行相关 focused tests。详细文件级任务与命令将在用户确认本文后，由单独的 implementation plan 给出。
