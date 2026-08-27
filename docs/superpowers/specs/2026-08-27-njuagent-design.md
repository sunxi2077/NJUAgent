# NJUAgent 命令行编程智能体设计稿

日期：2026-08-27  
状态：待评审  
对应需求基线：`docs/PROJECT_REQUIREMENTS.md` v0.2

## 1. 文档目的

本文确定 NJUAgent 第一版的产品边界、技术选型、模块划分、核心数据结构、运行流程、安全策略、错误处理和测试方法。后续实施计划与代码应以本文和题目 PDF 为依据；如果二者冲突，以题目 PDF 为准。

本文只描述设计，不代表功能已经实现。

## 2. 项目目标与非目标

### 2.1 目标

实现一个单智能体、命令行运行的编程 agent。用户在指定工作区输入自然语言任务后，agent 能够：

1. 调用大语言模型决定下一步；
2. 读取、搜索、创建和修改工作区内文件；
3. 在工作区执行构建、测试和普通开发命令；
4. 把工具结果反馈给模型并继续循环；
5. 流式展示过程，允许确认风险操作和随时中断；
6. 在正常结束、达到限制、模型失败或用户取消时给出明确状态。

第一版的评价重点是：闭环完整、边界清楚、错误可解释、实现可测试、演示稳定。

### 2.2 非目标

第一版不实现：

- GUI 或全屏 TUI；
- 多智能体和子任务委派；
- MCP、Skills、插件市场和通用 hook 系统；
- 后台任务、任务 DAG、Git worktree 并发；
- 云端代码执行、服务端文件工具或 Code Interpreter；
- 长期记忆和跨项目知识库；
- 对任意 shell 命令提供操作系统级强隔离。

这些能力不会进入 MVP，避免把有限时间消耗在题目没有要求的基础设施上。

## 3. 合规边界

项目自行实现 agent harness，包括：

- 对话历史和上下文控制；
- 内部消息类型和模型协议适配；
- 工具定义、注册、参数校验与本地执行；
- tool call 与 tool result 的配对；
- 模型—工具循环、最大轮数和终止状态；
- 权限判断、路径边界、超时与输出限制；
- API、流式响应、工具和协议错误处理。

允许使用 `@anthropic-ai/sdk`，但它只承担普通 Anthropic Messages API 客户端的职责。项目不使用 `@anthropic-ai/claude-agent-sdk`，也不使用 LangChain、LlamaIndex、OpenAI Agents SDK、AutoGen、CrewAI 等 agent 框架。

判断标准不是依赖名称，而是依赖是否替我们完成了 agent 循环、工具执行或上下文管理。普通模型客户端、参数校验库、终端着色库和测试框架不代替上述核心实现，因此可使用。

## 4. 已确定的技术选择

| 事项 | 选择 | 理由 |
| --- | --- | --- |
| 语言与运行时 | TypeScript + Node.js | 事件与消息类型清晰，适合流式 I/O、子进程和跨平台 CLI；也便于长期扩展 |
| 模型协议 | Anthropic Messages API | 用户熟悉，原生支持结构化 tool use |
| 模型服务 | DeepSeek 的 Anthropic 兼容端点 | 满足成本与兼容性需求，配置可替换 |
| API 客户端 | `@anthropic-ai/sdk` | 只处理 HTTP、流式协议和供应商类型，避免重复造网络客户端 |
| CLI 形态 | 混合流式 CLI | 保留可滚动记录，同时用瞬时状态行提供顺滑反馈；比全屏 TUI 更稳、更适合录屏 |
| agent 数量 | 单智能体 | 足以覆盖题目闭环，易于解释和测试 |
| 工具执行顺序 | 同一 assistant 消息中的工具调用按原顺序串行执行 | 输出确定、权限交互简单、历史容易复现 |
| 完成判断 | 模型不再发起工具调用时正常结束，但不宣称任务已经被证明成功 | 区分“循环停止”和“验证通过” |

模型连接全部通过环境变量配置：

- `ANTHROPIC_API_KEY`：API Key；
- `ANTHROPIC_BASE_URL`：例如 DeepSeek Anthropic 兼容地址；
- `MODEL_ID`：实际可用模型名；
- `AGENT_MAX_STEPS`：单轮最大模型请求次数；
- `COMMAND_TIMEOUT_MS`：命令默认超时；
- `TOOL_OUTPUT_MAX_BYTES`：送回模型的工具输出上限。

仓库只提供 `.env.example` 占位值，不提交真实密钥。程序不强依赖 `.env` 文件；环境变量是唯一配置来源，是否使用外部 dotenv 工具由使用者决定。

## 5. 总体架构

```text
Terminal
   │ input / Ctrl-C / confirmation
   ▼
CLI Session ───────────────► Renderer
   │                           ▲
   │ user request              │ AgentEvent
   ▼                           │
AgentRunner ───────────────────┘
   ├── ConversationHistory
   ├── ContextPolicy
   ├── ModelProvider ──► AnthropicProvider ──► DeepSeek endpoint
   └── ToolExecutor
         ├── ToolRegistry
         ├── PermissionPolicy
         ├── WorkspaceBoundary
         └── File / Search / Command tools
```

核心原则：

1. `AgentRunner` 只认识项目内部类型，不认识 SDK 类型。
2. provider 负责协议转换，不负责决定是否调用工具。
3. tool 自己描述能力，executor 统一处理校验、权限、异常、计时和事件。
4. renderer 只消费事件，不参与 agent 决策。
5. 安全限制由宿主程序强制执行，不能只写在 system prompt 中。

## 6. 目录与模块职责

```text
src/
  index.ts
  config.ts
  cli/
    session.ts
    prompt.ts
    renderer.ts
  agent/
    runner.ts
    events.ts
    messages.ts
    history.ts
    result.ts
    context-policy.ts
    system-prompt.ts
  providers/
    provider.ts
    anthropic-provider.ts
  tools/
    tool.ts
    registry.ts
    executor.ts
    file-tools.ts
    search-tools.ts
    command-tool.ts
  security/
    workspace.ts
    permission-policy.ts
tests/
  unit/
  integration/
  fixtures/
```

- `cli/session.ts`：启动会话、读取多轮用户输入、协调中断与退出。
- `cli/prompt.ts`：普通输入和权限确认，不包含 agent 业务逻辑。
- `cli/renderer.ts`：把领域事件转换为终端输出，处理 TTY 降级。
- `agent/runner.ts`：唯一的模型—工具循环控制器。
- `agent/history.ts`：保存合法消息序列并执行确定性的历史压缩。
- `agent/context-policy.ts`：估算上下文、限制旧工具输出、决定能否继续请求。
- `providers/provider.ts`：项目自己的模型接口。
- `providers/anthropic-provider.ts`：SDK 类型与内部类型之间的唯一适配层。
- `tools/registry.ts`：按名称保存工具定义并导出模型所需 schema。
- `tools/executor.ts`：参数校验、权限检查、执行、异常转换与事件发射。
- `security/workspace.ts`：工作区路径解析和越界阻止。
- `security/permission-policy.ts`：对工具操作做 allow、ask 或 deny 决策。

测试目录镜像核心模块，但不为了“一文件一测试”而拆出无意义的小文件。

## 7. 内部类型设计

内部类型使用 TypeScript 判别联合，确保新增消息、事件或停止原因时，编译器能检查遗漏分支。示意如下：

```ts
type Message =
  | { role: "user"; content: UserBlock[] }
  | { role: "assistant"; content: AssistantBlock[] };

type UserBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_result";
      toolCallId: string;
      content: string;
      isError: boolean;
    };

type AssistantBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_call";
      id: string;
      name: string;
      input: unknown;
    };

type RunStats = { steps: number; toolCalls: number; durationMs: number };

type RunResult = RunStats &
  (
    | { status: "completed" }
    | { status: "limit_reached" }
    | { status: "context_limit" }
    | { status: "cancelled" }
    | { status: "model_failed"; message: string }
    | { status: "internal_failed"; message: string }
  );

type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_input_delta"; id: string; partialJson: string }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | {
      type: "message_completed";
      message: Extract<Message, { role: "assistant" }>;
      stopReason: string;
    };
```

`completed` 只表示模型正常返回了不含工具调用的 assistant 消息。它不等价于测试通过，也不等价于所有用户目标已经客观完成。

provider 以 `AsyncIterable<ProviderEvent>` 返回流式事件。最后一个正常事件必须是 `message_completed`，其中包含已经组装、验证过的完整 assistant 消息；流抛错或缺少该事件都视为本次模型调用失败。SDK 的 content block、stop reason 和 usage 类型不得越过 provider 边界。

## 8. Agent 主循环

一次用户回合按以下顺序运行：

1. CLI 将用户文本作为一条 user 消息加入历史。
2. `ContextPolicy` 在模型调用前估算上下文；必要时压缩较旧的工具输出。
3. `AgentRunner` 把 system prompt、历史和工具 schema 交给 `ModelProvider`。
4. provider 流式发出文本、usage 和状态事件；renderer 立即显示文本增量。
5. 流结束后，provider 返回完整且结构合法的 assistant 消息。
6. runner 只在完整消息成功组装后把它加入历史；半截流不会进入历史。
7. 如果消息不含 tool call，本轮以 `completed` 结束。
8. 如果包含一个或多个 tool call，executor 按出现顺序逐个执行。
9. 每个 tool call 都必须产生一个同 ID 的 tool result；失败、拒绝和取消也必须产生结果。
10. 所有结果按原顺序组成一条 user 消息加入历史，然后回到步骤 2。
11. 模型请求次数达到上限时停止，返回 `limit_reached`，不再偷偷追加一次请求。

同一轮中串行执行工具是有意选择。并发虽可能更快，但多个写操作、权限提示和实时输出会产生难以解释的竞态；第一版优先确定性。

系统提示词只提供稳定的行为原则：先理解再修改、尽量小改、重要变更后运行验证、如实说明结果。工具 schema 提供具体能力，安全策略不依赖模型自觉遵守。

## 9. 模型适配层

`ModelProvider` 暴露项目自有接口：

```ts
interface ModelProvider {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}
```

`AnthropicProvider` 的职责仅包括：

- 将内部 system prompt、消息和工具 schema 转为 Anthropic Messages API 请求；
- 使用 `@anthropic-ai/sdk` 发起普通流式 API 调用；
- 将 text delta、tool input delta、usage 和 stop reason 转为内部事件；
- 组装并校验完整 assistant 消息；
- 把供应商异常分类为可重试或不可重试错误。

它不执行工具、不修改历史、不判断任务完成，也不直接输出终端内容。这样可以用 mock provider 离线测试核心循环，也可在不动 agent 与工具代码的情况下增加其他模型协议。

启动时必须验证三个模型配置项非空。Base URL 和模型名不写死，以避免兼容服务升级后修改源代码。

## 10. 工具系统

### 10.1 统一接口

每个工具包含名称、说明、JSON Schema 和执行函数：

```ts
interface Tool<TInput> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  execute(input: TInput, context: ToolContext): Promise<ToolOutput>;
}
```

`ToolRegistry` 保证名称唯一，并向 provider 提供 schema 列表。`ToolExecutor` 在调用具体工具前完成：工具查找、运行时参数校验、权限决策、AbortSignal 传递和计时；之后统一把返回值或异常转换成结构化 `ToolResult`。

工具实现不得直接打印终端。实时进度通过 `AgentEvent` 发给 renderer。

### 10.2 MVP 工具

1. `read_file(path, offset?, limit?)`
   - `path` 必须是工作区相对路径；
   - 默认读取 UTF-8 文本；
   - 支持按行分页，并返回实际范围与总行数；
   - 二进制、非法编码和超大单行返回可解释错误。

2. `write_file(path, content)`
   - 创建或完整覆盖文本文件；
   - 自动创建父目录；
   - 返回写入字节数及相对路径。

3. `edit_file(path, oldText, newText, replaceAll?)`
   - 默认要求 `oldText` 恰好出现一次；
   - 未找到或多处匹配时失败，不猜测修改位置；
   - 只有显式 `replaceAll: true` 时才替换所有匹配。

4. `list_files(path?, pattern?)`
   - 默认从工作区根目录列举；
   - 支持 glob 过滤；
   - 默认忽略 `.git`、依赖目录和常见构建产物；
   - 对数量和总字符数设置上限。

5. `search_text(query, path?, pattern?)`
   - 递归搜索 UTF-8 文本；
   - 返回相对路径、行号和匹配片段；
   - 对文件大小、结果条数和输出字节设置上限。

6. `run_command(command, timeoutMs?)`
   - 使用明确的系统 shell 执行，以支持管道和常用项目脚本；
   - 当前目录固定为工作区；
   - 分别捕获 stdout、stderr 和退出码；
   - 支持超时、用户中断和对子进程树的终止；
   - 输出实时显示，但送回模型的内容另行截断。

工具结果使用稳定文本格式，包含成功状态、关键信息以及 `truncated` 标记。模型不应依赖终端颜色或 renderer 文案理解结果。

## 11. 工作区与权限安全

### 11.1 文件边界

启动时将工作区解析为绝对真实路径。所有文件工具只接受相对路径并执行以下检查：

1. 拒绝绝对路径和含 NUL 的路径；
2. 将输入规范化并与工作区拼接；
3. 对已存在目标使用 `realpath` 后再次检查其仍位于工作区；
4. 对待创建目标，从最近的已存在父目录开始解析真实路径，防止通过符号链接写到外部；
5. 逐级检查路径链中的符号链接；
6. 最终路径必须等于工作区或以“工作区路径 + 分隔符”开头，不能只用字符串前缀判断。

这能覆盖常见的 `..`、绝对路径和符号链接逃逸。用户在 agent 运行期间并发替换文件仍可能形成 TOCTOU 风险，因此第一版定位为受信任本地开发工具，而不是敌对多租户沙箱。

### 11.2 权限决策

权限策略返回三种结果：

- `allow`：直接执行；
- `ask`：向用户展示工具名、关键参数和风险说明，确认后执行；
- `deny`：不执行，并把拒绝原因作为 tool result 返回模型。

默认平衡模式：

- 工作区内读取、列举和搜索自动允许；
- 工作区内普通写入和精确编辑自动允许；
- 常见只读检查、测试、构建和 lint 命令允许；
- 删除、覆盖大量文件、安装依赖、网络访问和破坏性 Git 操作要求确认；
- 提权、系统关机、磁盘格式化、修改工作区外路径等高风险意图直接拒绝。

另提供谨慎模式，使所有写操作和命令都需要确认。命令分类只是减少误操作的保护层，不宣称能够可靠理解任意 shell 语法，也不等价于操作系统沙箱。终端会在命令执行前清楚展示原始命令。

## 12. 混合流式 CLI

CLI 分为永久记录和瞬时状态两部分：

- 永久记录：用户输入、模型正文、工具卡片、命令输出、错误和最终状态；
- 瞬时状态：spinner、当前阶段、已用时间和等待确认提示。

`AgentRunner` 和 `ToolExecutor` 只发出事件，例如：

```ts
type AgentEvent =
  | { type: "model_started"; step: number }
  | { type: "text_delta"; text: string }
  | { type: "model_completed"; stopReason: string }
  | { type: "tool_started"; id: string; name: string; summary: string }
  | { type: "tool_output"; id: string; stream: "stdout" | "stderr"; text: string }
  | { type: "tool_completed"; id: string; ok: boolean; durationMs: number }
  | { type: "permission_required"; id: string; reason: string }
  | { type: "retrying"; attempt: number; delayMs: number; reason: string }
  | { type: "run_finished"; result: RunResult };
```

renderer 根据事件控制 ANSI 颜色和状态行。非 TTY、输出重定向或 `NO_COLOR` 环境下，自动关闭 spinner、光标控制和颜色，每个事件退化为普通文本行，保证 CI 和日志可读。

命令输出可实时滚动，但设置终端展示预算；超过预算后只显示一次抑制提示，继续在后台消费子进程输出以避免阻塞。送回模型的输出采用头尾保留策略，并标明省略字节数。

中断语义：

- 模型或工具运行中第一次 `Ctrl-C`：通过同一个 `AbortController` 取消当前用户回合并返回输入提示；
- 权限确认时 `Ctrl-C`：视为取消整个用户回合；
- 空闲输入提示时 `Ctrl-C` 或输入 `/exit`：退出程序；
- assistant 已完整发出多个 tool call 后发生取消：未执行的调用也补充 `cancelled` tool result，保持历史配对合法；
- 模型流在完整消息形成前被取消：丢弃该半截 assistant 消息。

## 13. 错误处理

错误分为四层：

### 13.1 配置错误

缺少 API Key、Base URL、模型名，或数值配置越界时，启动失败并列出变量名和修复方法。错误信息不回显密钥内容。

### 13.2 模型错误

- 网络中断、超时、429 和 5xx：最多重试三次，采用带抖动的指数退避，并优先尊重服务端 `Retry-After`；
- 认证、权限、无效参数和不兼容协议：不重试，返回 `model_failed`；
- 流在中途失败：半截内容不进入历史，终端标记该段已丢弃后再按策略重试；
- 工具输入块无法组装或响应结构非法：作为协议错误终止，不能带着损坏历史继续。

### 13.3 工具错误

参数非法、文件不存在、精确编辑歧义、命令非零退出、超时和权限拒绝都转换为对应 tool result，让模型有机会调整方案。命令非零退出属于工具执行结果，不导致宿主进程崩溃。

### 13.4 内部错误

违反消息配对不变量、未知事件或其他程序缺陷返回 `internal_failed`，保留经过脱敏的调试信息。此类错误不伪装成模型可自行修复的问题。

日志默认只记录必要元数据。调试模式可以增加请求轮次、事件和耗时，但必须脱敏已知凭据和敏感环境变量，也不默认持久化完整文件内容。

## 14. 上下文控制

第一版采用可解释的确定性策略，不调用另一个“摘要 agent”：

1. 每个工具在产生结果时先执行字节上限，保留头尾并附省略统计；
2. provider 返回实际 token usage 时记录实际值，否则使用保守字符估算；
3. 请求前若接近配置阈值，将较早的 tool result 内容替换为包含工具名、成功状态、原始长度和摘要标记的短占位；
4. 替换只改变 tool result 内容，不删除 tool call 或其 ID，保持协议配对；
5. 保留最近若干轮、全部用户任务文本以及尚未完成的当前工具批次；
6. 压缩后仍超过阈值则返回 `context_limit`，说明停止原因，不继续发送必然失败的请求。

这种策略不如语义摘要节省空间，但行为确定、容易测试、不会产生“摘要模型篡改事实”的新风险。自动语义摘要只作为后续增强。

## 15. 完成与验证语义

程序不设计专用 `finish` 工具。模型返回不含 tool call 的完整消息时，当前用户回合正常结束；renderer 展示：

- 终止状态；
- 模型请求次数；
- 工具调用次数；
- 本轮运行过的命令、退出码和耗时摘要。

系统提示要求模型在修改代码后运行合适的测试或构建，并在最终回复中如实说明验证结果。但程序不会仅凭模型文字把状态标为“测试已证明通过”。终端只展示真实执行记录，由用户判断它是否足以验证任务。

“最后一个命令退出码为 0”也不自动等价于任务正确：它可能只是 `pwd`。因此不增加带误导性的绿色“任务成功”徽章，而是把正常结束和验证证据分别显示。

## 16. 测试策略

测试使用 Vitest，默认不访问真实网络。

### 16.1 单元测试

- `AgentRunner`：纯文本结束、一次工具调用、多轮调用、同轮多工具、工具失败恢复、达到步数上限、取消；
- 消息历史：tool call/result 一一配对、顺序稳定、半截流不入库；
- provider：使用固定事件 fixture 验证 SDK 类型到内部类型的转换；
- registry/executor：重复名称、未知工具、非法参数、异常转换和 AbortSignal；
- 文件工具：读写、分页、精确替换零次/一次/多次、输出截断；
- workspace：普通相对路径、`../`、绝对路径、外部符号链接、新文件父目录符号链接；
- command：stdout/stderr、非零退出、超时、中断、输出预算；
- permission policy：allow/ask/deny 的代表性命令；
- context policy：旧结果压缩后仍保持合法配对；
- renderer：关闭 ANSI 后的稳定文本快照。

### 16.2 集成测试

在临时工作区使用脚本化 mock provider 完成“读文件—编辑—运行测试—最终回复”闭环，检查真实文件变化、命令结果和事件顺序。另覆盖取消命令与拒绝权限。

### 16.3 真实 API 冒烟测试

提供显式命令单独运行，只有环境变量齐全时才访问 DeepSeek。它只验证一次文本响应和一次无副作用工具调用，不进入默认测试套件，也不把响应或凭据写入仓库。

## 17. 演示验收设计

演示使用一个很小、具有确定性失败测试的示例项目。推荐任务：为已有函数补充输入校验并修复测试。

两分钟内应看到：

1. 在示例工作区启动 NJUAgent；
2. 输入一次完整自然语言任务；
3. agent 列举和读取相关文件；
4. agent 精确编辑代码；
5. agent 运行测试并看到失败；
6. agent 根据错误再次修改；
7. agent 再次运行测试并获得退出码 0；
8. 最终回复概括修改和真实命令记录。

录制前固定示例仓库初始状态、模型配置和备用视频。终端尺寸与字体提前调整，敏感环境变量不出现在命令和画面中。

## 18. 实施顺序

### 阶段 A：可测试的最小循环

建立 TypeScript 工程，定义内部类型、事件、mock provider、history 和 runner；先用测试证明纯文本、工具调用、上限和取消状态正确。

### 阶段 B：模型与 CLI

接入 `@anthropic-ai/sdk` 的普通 Messages API 流，完成混合流式 renderer、配置校验和多轮输入。

### 阶段 C：本地编程工具

完成 registry、executor、六个基础工具、路径边界、权限判断、命令实时输出和中断。

### 阶段 D：可靠性与交付

补齐重试、上下文压缩、集成测试、真实 API 冒烟测试、README、演示样例和视频脚本。

每个阶段都应形成小而真实的 Git 提交，不在最后一次性导入完整代码。

## 19. 参考项目的使用方式

`learn-claude-code` 只作为机制参考：

- 从早期步骤借鉴最小 agent loop 和工具分发的教学顺序；
- 从新版借鉴权限检查、统一执行管线、上下文控制以及“停止不等于验证完成”的思想；
- 不复制其后期单文件大实现；
- 不把多智能体、Skills、MCP、后台任务等超出本项目范围的能力带入第一版；
- 代码、类型、测试和错误语义都按本文重新设计。

这样既利用用户已经熟悉的心智模型，也能在答辩时清楚说明哪些是通用思想，哪些是本项目的独立实现和取舍。

## 20. 设计验收结论

本文已经为第一版确定以下关键问题：语言、CLI 形态、模型客户端边界、模块职责、消息协议、循环终止、工具集合、串行执行、路径限制、权限分级、中断语义、重试策略、上下文控制、完成语义和测试范围。

设计经评审确认后，下一步是把阶段 A～D 拆成可以逐项执行和提交的实施计划；在设计确认前不开始编写业务代码。
