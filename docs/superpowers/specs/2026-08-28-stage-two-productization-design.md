# NJUAgent 第二阶段产品化设计规范

日期：2026-08-28  
状态：已确认，等待实施  
前置基线：`main` at `97b4d1e`，第一阶段 20 个测试文件、143 项测试通过  
对应第一阶段设计：`docs/superpowers/specs/2026-08-27-njuagent-design.md`

## 1. 文档目的与优先级

本文冻结 NJUAgent 第二阶段的产品边界、模块接口、持久化契约、上下文策略、Skills 语义、错误模型、CLI 体验与验收标准。实施 Agent 不应自行扩大范围或替换本文已经确定的技术选择。

发生冲突时按以下优先级判断：

1. 题目 PDF 的硬性约束；
2. `docs/PROJECT_REQUIREMENTS.md` 中的 P0 合规与安全约束；
3. 本文的第二阶段设计；
4. 第一阶段设计中与第二阶段范围冲突的“非目标”描述。

第二阶段有意把会话持久化、主动压缩和 Skills 从第一阶段非目标提升为当前目标。第一阶段的 Agent Loop、Provider、Tools、安全边界和“普通 Anthropic SDK 只作为 API 客户端”的约束继续有效。

## 2. 阶段目标

第一阶段已经证明“模型—工具—模型”的编程闭环可用。第二阶段不追求更多工具数量，而是把它提升为适合持续使用和录制演示的命令行产品：

1. 具有稳定、雅观、可降级的纯 CLI 交互；
2. 具有本地 Slash Command 控制层；
3. 能保存、列出、恢复和新建多个会话；
4. 能解释上下文占用并执行可靠的自动或主动压缩；
5. 能显式发现和启用一个本地 Skill；
6. 对配置、模型、持久化、压缩和 Skill 错误提供一致且可恢复的反馈；
7. 保持第一阶段的测试、构建、真实 API 冒烟和安全保证。

## 3. 明确非目标

第二阶段不实现：

- Web UI、Electron、桌面应用或任何图形化运行界面；
- Ink/React 等全屏 TUI、alternate screen、鼠标交互或终端侧栏；
- 多智能体、子任务委派、后台任务和任务 DAG；
- MCP、插件市场、Hook 系统或 Skill 自动安装；
- Skill 脚本自动执行、Skill 依赖安装或 Skill 自动选择；
- 跨会话全文搜索、云同步、跨设备同步和长期知识库；
- API Key 文件存储、系统钥匙串集成或账号登录；
- 新模型协议和新的模型 SDK；
- 重写第一阶段已稳定的文件工具、命令工具或权限系统。

## 4. 总体架构

```text
Terminal
  │
  ▼
CliSession ───────────────► TerminalRenderer
  │                            ▲
  ├─ ordinary text             │ AppEvent / AgentEvent
  │      ▼                     │
  │  SessionManager.runTurn ───┘
  │      ├─ ContextManager.prepare
  │      ├─ AgentRunner.run
  │      └─ SessionStore.saveCheckpoint
  │
  └─ /command
         ▼
     SlashCommandRouter
         ├─ SessionManager
         ├─ ContextManager
         ├─ SkillRegistry
         └─ ConfigStore
```

架构约束：

- `src/index.ts` 只解析最外层启动条件并组装依赖，不承载命令语义。
- `AgentRunner` 继续只依赖项目内部消息、Provider 和 Tool 接口，不依赖 CLI、文件存储或 Skills 目录。
- Slash 命令是本地控制面，不注册为模型工具，不写入模型对话历史。
- Renderer 只消费事件和视图模型，不读取 Session 文件或改变 Agent 决策。
- SessionManager 是当前会话的唯一切换入口；`/resume` 不允许直接替换某个全局 history 引用。
- ContextPolicy 保持纯粹、确定性和同步；需要模型的语义摘要由异步 ContextManager/Compactor 编排。
- 完整历史与“实际发给模型的上下文视图”必须分离，压缩不等于删除用户记录。

## 5. 目标目录与职责

在尊重现有文件的前提下采用以下目标结构。不要为了移动而移动；`src/config.ts` 和 `src/cli/renderer.ts` 可以原位演进。

```text
src/
  index.ts                         # composition root
  config.ts                        # CLI/env/persisted config 合并与运行配置
  errors/
    app-error.ts                   # 稳定错误码与安全用户信息
    error-presenter.ts             # CLI 展示与 debug 规则
  cli/
    session.ts                     # 输入循环、busy 状态、取消、退出
    prompt.ts                      # readline 与输入行恢复
    renderer.ts                    # Agent/App 事件渲染
    theme.ts                       # 南大紫与语义色 token
    welcome.ts                     # 启动页视图模型和格式化
    command-router.ts              # Slash 解析、转义与分发
    command.ts                     # CommandContext/CommandResult
    setup.ts                       # 首次及 /setup 向导
    commands/                      # 一组小型命令 handler
  storage/
    paths.ts                       # NJU_AGENT_HOME 与目录布局
    atomic-json.ts                 # 同目录临时文件 + rename
    config-store.ts                # 非敏感配置
  sessions/
    session-schema.ts              # PersistedSessionV1 与 Ajv 校验
    session-store.ts               # list/load/save
    session-manager.ts             # active runtime 与生命周期
    session-format.ts              # /sessions、/history、/status 视图
  agent/
    runner.ts                      # 保留核心循环
    history.ts                     # 增加 load/replace，继续保证合法性
    context-policy.ts              # token 估算、工具结果确定性收缩
    context-manager.ts             # 自动/主动 compact 编排
    compactor.ts                   # 无工具的语义摘要请求
    context-types.ts               # checkpoint/status/prepared context
  skills/
    skill.ts                       # Skill 类型与名称规则
    skill-loader.ts                # 单目录安全加载
    skill-registry.ts              # 用户级 + 项目级合并
    skill-prompt.ts                # 安全的提示词分层
```

## 6. CLI 视觉与输入行为

### 6.1 产品形态

最终产品仍是普通 Node.js CLI。浏览器视觉稿只用于设计确认，不属于运行产物。CLI 不进入全屏模式，所有模型回复和工具记录保留在终端 scrollback 中。

视觉方向采用已确认的“A：克制编辑风”：

```text
╭─ NJUAgent v0.2 ─────────────────────────╮
│ workspace  ~/projects/demo              │
│ model      deepseek-v4-flash            │
│ session    8e6a2f · new · balanced      │
╰─────────────────────────────────────────╯
Type /help for commands · Ctrl-C cancels

● Inspecting workspace
✓ read_file src/index.ts
✓ run_command npm test · 143 passed

› Ask NJUAgent to build something…
```

启动框只打印一次。每轮不得重复打印 Logo 或大段 banner。

### 6.2 颜色

南京大学官方标准紫色为 `C50 M100 Y0 K40`。屏幕主题定义为集中 token：

- `brandBase`：`#4D0099` 的 ANSI 近似，用于边框或品牌块；
- `brandText`：`#C8A8F4` 的 ANSI 近似，用于深色背景上的品牌文字、焦点和进行中状态；
- `success`：绿色；
- `warning`：黄色；
- `error`：红色；
- `muted`：灰色。

不得把成功、警告和错误全部改为紫色。`NO_COLOR` 非空、stdout 非 TTY 或显式 plain 模式时，不输出任何 ANSI 字节。使用项目已有 `picocolors` 和少量集中封装，不增加 UI 框架。

### 6.3 提示符稳定性

现有提示符通过 `output.write("nju-agent> ")` 手工输出，readline 不知道提示符内容，因此光标移动或行重绘时可能丢失。修复要求：

- 由 readline 的 `setPrompt()` 与 `prompt(true)` 管理提示符；
- 空闲提示符固定为 `› `，欢迎页已经表明产品名称，不重复写长前缀；
- Renderer 写永久输出前清除活动输入行，写完后恢复提示符和 readline 已有的 `line` 缓冲；
- Agent 正在运行时不显示可输入提示符，也不并发接受下一条任务；
- 权限确认使用独立问题提示，完成后恢复运行状态；
- Ctrl-C 在运行中只取消当前回合；空闲提示符上的 Ctrl-C 退出；
- EOF 保存后退出。

### 6.4 TTY 降级

非 TTY 输出采用稳定、可测试、适合重定向的记录：

```text
[session] 8e6a2f model=deepseek-v4-flash workspace=/abs/path
[model] text...
[tool] read_file ok in 12ms
[error:PROVIDER_UNAVAILABLE] Service temporarily unavailable
```

不输出 Spinner、清行控制符、框线动画或颜色。

## 7. 配置与初始化

### 7.1 存储布局

```text
${NJU_AGENT_HOME:-~/.nju-agent}/
  config.json
  sessions/
  skills/
```

项目级 Skill 位于 `<workspace>/.nju-agent/skills/`。`NJU_AGENT_HOME` 既便于测试，也便于用户覆盖默认位置。

### 7.2 配置优先级

运行配置按以下优先级合并：

1. CLI 参数；
2. 环境变量；
3. `config.json` 中的非敏感配置；
4. 稳定默认值。

`ANTHROPIC_API_KEY` 始终只从当前进程环境读取。不得写入 `config.json`、Session、日志、错误详情或测试快照。

`config.json` 只允许：

```ts
interface PersistedConfigV1 {
  schemaVersion: 1;
  baseURL: string;
  model: string;
  permissionMode: "balanced" | "cautious";
}
```

### 7.3 首次启动与 `/setup`

- `--help` 永远先于配置加载，并且不需要凭据。
- 缺少 Base URL 或 Model 且 stdin/stdout 都是 TTY 时，运行三步以内的初始化向导。
- 向导配置 Base URL、Model 和默认权限模式，先展示摘要，再原子保存。
- 缺少 API Key 时不询问也不保存 Key；展示 `ANTHROPIC_API_KEY` 环境变量配置说明并退出码 1。
- 非 TTY 缺少配置时不进入交互向导，返回可操作的错误。
- `/setup` 只允许空闲时运行。保存后重建 Provider/运行配置，但保留当前历史；如果 API Key 仍缺失，则要求用户设置环境变量并重启。

## 8. Slash Command 控制层

### 8.1 路由契约

```ts
type RouteResult =
  | { kind: "not_command"; text: string }
  | { kind: "handled"; stateChanged: boolean }
  | { kind: "exit" };

interface SlashCommand {
  readonly name: string;
  readonly usage: string;
  readonly description: string;
  execute(args: string, context: CommandContext): Promise<CommandResult>;
}
```

规则：

- 普通输入返回 `not_command` 并进入 Agent；
- `/name args` 由本地处理，命令名规范化为小写；
- `//text` 作为普通用户文本 `/text` 发送给 Agent；
- 未知命令不发送给模型，显示 `Unknown command "/x". Type /help.`；
- Slash 命令不写入对话历史；
- 参数只做“命令名 + 剩余原始字符串”解析，不实现 shell quoting 语言；
- 运行中不读取新命令，因此 handler 不需要处理并发切换。

### 8.2 命令语义

| 命令 | 语义 |
| --- | --- |
| `/help` | 分类展示全部命令、参数和 `//` 转义示例。 |
| `/status` | 当前 Session、Model、Workspace、权限模式、Skill、上下文占用、dirty 状态。 |
| `/sessions` | 按 `updatedAt` 倒序列出短 ID、标题、工作区、更新时间、当前标记。 |
| `/resume <id>` | 接受完整 UUID 或唯一前缀；冲突时列候选；目标完全加载成功后才切换。 |
| `/new` | 先保存当前会话，再创建空白会话；不继承当前 Skill。 |
| `/history [count]` | 默认最近 20 条；工具输出只显示名称、状态和有界摘要。 |
| `/context` | 显示估算 token、预算、阈值、checkpoint 覆盖范围和压缩次数。 |
| `/compact [focus]` | 主动生成累计语义摘要；剩余字符串全部作为关注点。 |
| `/skills` | 刷新并列出可用 Skill、来源、描述和当前启用状态。 |
| `/skill <name>` | 显式启用一个 Skill；同一时间最多一个。 |
| `/skill off` | 停用当前 Skill。 |
| `/setup` | 重新运行非敏感配置向导。 |
| `/exit` | 刷新当前会话后退出；保存失败不得静默退出。 |

`/history count` 仅接受 `1..100` 的整数。空 `/resume`、`/skill` 或非法 count 显示 usage，不抛出内部异常。

## 9. Session 持久化

### 9.1 Schema

```ts
interface PersistedSessionV1 {
  schemaVersion: 1;
  id: string;                    // UUID
  title: string;                 // 首条用户文本确定性截断
  createdAt: string;             // ISO-8601
  updatedAt: string;
  workspaceRoot: string;         // canonical absolute path
  modelId: string;
  permissionMode: "balanced" | "cautious";
  activeSkill: string | null;
  messages: Message[];           // 完整合法历史
  context: {
    checkpoint?: ContextCheckpoint;
    lastInputTokens?: number;
    compactionCount: number;
  };
  stats: {
    turns: number;
    toolCalls: number;
    lastRunStatus?: RunResult["status"];
  };
}

interface ContextCheckpoint {
  summary: string;
  coveredMessageCount: number;
  createdAt: string;
  sourceEstimatedTokens: number;
}
```

Session 不保存 API Key、Base URL、工具实时输出、Spinner 状态或当前未完成的半截 Provider 流。

### 9.2 标题与列表

- 新 Session 初始标题为 `New session`；
- 完成首条非空用户输入后，以折叠空白后的前 48 个 Unicode code points 作为标题；
- `/sessions` 使用 UUID 前 8 位显示，但 `/resume` 必须通过唯一前缀解析；
- 列表跳过并标记损坏文件，不因为一个坏文件导致所有会话不可用。

### 9.3 保存与故障语义

保存步骤为：在同目录生成唯一临时文件，写入并关闭，随后 `rename` 到目标文件。正式文件权限尽量设置为 `0o600`，目录为 `0o700`。

保存时机：

- 新 Session 创建后；
- 每个 Agent 回合以 completed/failed/cancelled/limit 状态结束后；
- compact 成功后；
- Skill 状态变化后；
- `/new`、`/resume`、`/exit` 前。

本阶段的崩溃恢复边界：强制杀死进程可以丢失尚未结束的当前回合，但不能损坏此前检查点。

保存失败时保留内存状态和旧文件，标记 dirty，显示 `SESSION_IO`。dirty 未成功刷新的情况下拒绝 `/new`、`/resume` 和普通 `/exit`，避免无意丢失；EOF 或第二次明确退出可以由实现显示丢失警告后终止，但不得声称已保存。

### 9.4 生命周期

每次进程启动默认创建一个新 Session，不自动恢复旧上下文。欢迎页可以显示最近会话及 `/resume <short-id>` 提示。

`/resume` 的切换顺序：

1. 解析唯一 ID；
2. 读取并双重校验 Schema 与消息关系；
3. 验证工作区仍可打开；
4. 刷新当前 dirty Session；
5. 为目标 Session 创建新的 Workspace、ContextManager、Skill 状态和 AgentRunner；
6. 所有步骤成功后原子替换 active runtime。

任何步骤失败，原 active runtime 保持不变。

## 10. 上下文管理

### 10.1 完整历史与请求视图分离

`PersistedSession.messages` 永远保存完整记录。ContextManager 每次请求前构造一个临时 `PreparedContext`：

```ts
interface PreparedContext {
  action: "continue" | "compacted" | "stop";
  messages: readonly Message[];
  summary?: string;
  estimatedTokens: number;
  compactedToolResults: number;
  checkpoint?: ContextCheckpoint;
  reason?: string;
}
```

Provider 收到：稳定 System Prompt + 当前 Skill 层 + checkpoint summary 层 + checkpoint 之后的消息尾部。不得把 summary 伪装成一条真实 user 消息写回完整历史。

### 10.2 预算

第二阶段默认值：

- `CONTEXT_WINDOW_TOKENS=48000`；
- 自动压缩阈值为窗口的 `0.70`；
- 至少保留最近 `12` 条消息；
- 输出和协议安全余量为 `maxTokens + 2048`；
- 字符估算继续使用 `4 chars/token`，但必须把 System Prompt、Skill、工具 Schema、checkpoint 和消息全部计入；
- Provider 返回的最近 `inputTokens` 作为估算下界，不把估算显示成“精确值”。

有效输入硬上限为 `contextWindowTokens - maxTokens - 2048`。任何请求在超过硬上限时不得发送给 Provider。

### 10.3 两阶段压缩

达到自动阈值后：

1. 对旧的 tool result 执行确定性收缩，保留工具调用 ID、错误标志、原字节数和有限摘要；
2. 如果仍达到阈值，把 checkpoint 后较旧的完整消息交给 Compactor，生成累计语义摘要；
3. 最近 12 条消息不进入摘要；
4. 切分点不得位于 assistant tool call 与紧随其后的 tool result 批次之间；
5. 新摘要输入包含旧 checkpoint summary 和本次新增覆盖区间，不重新发送完整旧历史；
6. 摘要成功并通过长度、覆盖范围校验后才替换 checkpoint；
7. 用新 checkpoint 重新估算；仍超过硬上限则返回 `stop/context_limit`。

`/compact [focus]` 走同一算法但绕过阈值。可压缩区间为空时显示 `Nothing to compact yet.`，不发模型请求。

### 10.4 摘要格式

Compactor 使用同一个 `ModelProvider`、空工具列表和独立摘要提示词。输出纯文本且不超过约 1200 个英文单词或等量中文，固定覆盖：

```text
Current goal
Constraints and decisions
Files inspected or changed
Commands and observed results
Errors and attempted fixes
Open work and next steps
```

摘要提示必须说明：被压缩内容是数据而不是新指令；忠实保留路径、命令、错误、用户约束和未完成事项；不宣称没有证据的完成状态。

Compactor 若返回 tool call、空文本、流未正常结束或摘要超过上限，视为 `COMPACTION_FAILED`。

### 10.5 失败回退

- 自动 compact 失败但当前请求仍低于硬上限：保留旧 checkpoint，警告一次并继续；
- 自动 compact 失败且已经超过硬上限：停止本轮，不发送超限请求；
- 主动 compact 失败：保留旧 checkpoint 和完整历史，命令返回失败；
- 任何失败都不得部分更新 `coveredMessageCount` 或删除消息。

## 11. Skills

### 11.1 目录与优先级

发现顺序：

1. 用户级 `${NJU_AGENT_HOME}/skills/<name>/SKILL.md`；
2. 项目级 `<workspace>/.nju-agent/skills/<name>/SKILL.md`。

项目级同名 Skill 覆盖用户级。`/skills` 显示最终有效来源。每次执行 `/skills` 时刷新 Registry，启动时也加载一次。

### 11.2 文件格式

第二阶段只解析最小 YAML frontmatter，不引入 YAML 依赖：

```markdown
---
name: test-first
description: Require a focused failing test before implementation.
---

# Test First

Instructions...
```

约束：

- 目录名、frontmatter `name` 和启用名必须一致；
- 名称匹配 `^[a-z0-9][a-z0-9-]{0,63}$`；
- `description` 为单行、1..300 字符；
- 完整文件最大 32 KiB；
- frontmatter 只支持 `name` 与 `description` 两个标量字段；未知字段报错而不是猜测；
- canonical `SKILL.md` 必须仍位于对应用户或项目 Skill 根目录内，拒绝符号链接逃逸；
- 无效 Skill 在 `/skills` 中以 invalid 警告显示，不导致 CLI 启动失败。

### 11.3 激活语义

- 第二阶段同一 Session 同时最多启用一个 Skill；
- 只允许用户通过 `/skill <name>` 显式启用；模型不能自动启用；
- 激活状态保存在 Session；`/new` 不继承；
- `/resume` 时若 Skill 已删除或变为无效，自动停用并警告；
- `/skill off` 幂等；
- Skill 只影响下一次及后续模型请求，不修改历史消息。

### 11.4 Prompt 分层

最终 System Prompt 由纯函数构建：

```text
[base system prompt]

<active_skill name="..." source="user|project">
[SKILL.md body]
</active_skill>

<conversation_summary>
[checkpoint summary]
</conversation_summary>
```

层顺序固定，缺失层完全省略。Skill 和 summary 的内容都要明确标记边界。Skill 是用户显式选择的本地指令，但它不能扩大 Tool 权限、绕过 Workspace 和命令策略；这些边界仍由宿主强制。

本阶段不读取 Skill 目录中的脚本、assets、references 或其他文件，也不自动执行 Skill 描述的安装操作。

## 12. 错误、重试与取消

### 12.1 稳定错误模型

```ts
type AppErrorCode =
  | "CONFIG_INVALID"
  | "CONFIG_MISSING_API_KEY"
  | "PROVIDER_AUTH"
  | "PROVIDER_RATE_LIMIT"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_PROTOCOL"
  | "SESSION_IO"
  | "SESSION_CORRUPT"
  | "CONTEXT_LIMIT"
  | "COMPACTION_FAILED"
  | "SKILL_INVALID"
  | "USER_CANCELLED"
  | "INTERNAL";

class AppError extends Error {
  readonly code: AppErrorCode;
  readonly userMessage: string;
  readonly retryable: boolean;
  override readonly cause?: unknown;
}
```

Tool 的普通执行失败继续转成 `ToolResultBlock(isError=true)` 反馈给模型，不升级为 CLI AppError。只有协议不变量、存储故障或宿主内部故障才越过回合边界。

### 12.2 展示规则

- 默认：`✖ [SESSION_IO] Could not save session. Your in-memory session is still active.`；
- debug：追加经过控制的 cause 名称和 stack，但不得序列化 SDK 请求头、环境变量或完整配置对象；
- 用户可执行的补救动作必须包含在 `userMessage`；
- 同一个自动压缩失败在一回合内只展示一次；
- 非 TTY 使用稳定前缀 `[error:CODE]`。

### 12.3 Provider 重试

保留第一阶段有上限的指数退避和 jitter。只重试限流、连接中断、超时和明确的 5xx；认证、参数、协议解析和 Context Limit 不重试。取消信号立即终止退避。

### 12.4 Ctrl-C

- 运行中第一次 Ctrl-C：abort 当前 Provider/Tool/Compactor，保存 cancelled 回合检查点，然后回到输入；
- 权限或 setup 提示中 Ctrl-C：取消当前提示，不把空答案当作同意；
- 空闲输入时 Ctrl-C：尝试保存并退出；
- 不实现后台并发 turn，因此不需要第三种 Ctrl-C 状态。

## 13. 事件与渲染

不要让 CLI 通过分析错误字符串推断状态。除现有 `AgentEvent` 外，应用层提供有限事件或直接视图方法：

```ts
type AppEvent =
  | { type: "session_created"; id: string; title: string }
  | { type: "session_resumed"; id: string; title: string }
  | { type: "session_saved"; id: string }
  | { type: "compaction_started"; automatic: boolean }
  | { type: "compaction_completed"; coveredMessages: number; estimatedTokens: number }
  | { type: "skill_changed"; name: string | null }
  | { type: "app_warning"; code: AppErrorCode; message: string };
```

Spinner 不需要定时器动画才能验收；事件到达时推进帧即可。这样测试确定、实现简单。若以后添加 timer，必须有 `dispose()` 且不得阻止进程退出。

## 14. 测试策略

所有新功能先写失败测试。测试不得依赖真实 HOME、用户真实 Session 或真实 API Key；每个存储测试设置临时 `NJU_AGENT_HOME` 或直接注入 root path。

### 14.1 单元测试重点

- Config 优先级、首次 setup、API Key 不落盘；
- Prompt 使用 readline prompt 而非手写前缀，清行后恢复；
- Theme 的 TTY/NO_COLOR/非 TTY 行为；
- Slash 普通输入、命令、未知命令和 `//` 转义；
- Session Schema、原子保存、损坏隔离、唯一前缀、dirty 防切换；
- Context 阈值、预算组成、tool-result 收缩、合法切分点、累计 checkpoint；
- Compactor 空文本/tool call/取消/失败回退；
- Skill frontmatter、覆盖规则、大小限制、路径逃逸、显式启停；
- ErrorPresenter 默认与 debug 脱敏。

### 14.2 集成测试重点

- 新建会话 → 完成一轮 → 退出 → 新进程恢复；
- `/new` 与 `/resume` 不串历史；
- 长历史触发自动 compact 后仍能完成下一轮；
- `/compact focus` 生成 checkpoint 且完整历史仍可 `/history`；
- 启用项目 Skill 后 Provider 收到分层 prompt，权限策略不受影响；
- TTY 演练中的欢迎页、工具输出、取消和提示符恢复；
- 非 TTY 快照不含 ANSI。

### 14.3 全局质量门

每个子计划完成时必须运行：

```bash
npm test
npm run typecheck
npm run build
```

最终阶段还必须运行 opt-in 真实 DeepSeek Anthropic-compatible smoke。日志只记录模型、状态、工具调用数和耗时，不打印内容或凭据。

## 15. 实施顺序

1. CLI、主题、输入协调、配置存储、setup 和错误基础；
2. Slash Router、Session Store、SessionManager 和会话命令；
3. ContextManager、Compactor、`/context` 与 `/compact`；
4. Skills、Prompt 分层、最终集成、文档和演示验收。

不得在一个提交中同时完成四个子系统。每个任务遵循 RED → GREEN → 全量测试 → 小提交。

## 16. 最终验收场景

在一个独立失败测试项目中：

1. 首次启动显示南大紫欢迎页且不暴露 Key；
2. 输入真实修复任务，观察读取、修改、测试失败、继续修复、测试通过；
3. `/status` 与 `/context` 显示当前状态；
4. `/compact 保留测试失败原因和修改文件` 主动压缩；
5. `/history` 仍能看到压缩前的完整对话摘要列表；
6. `/new` 创建独立会话；
7. `/sessions` 找到原会话并用短 ID `/resume`；
8. 创建或启用一个简单项目 Skill，下一轮行为受其指令影响；
9. Ctrl-C 能取消运行并返回稳定的 `›` 提示符；
10. 退出并重启后会话仍可恢复；
11. 全程没有 GUI、全屏 TUI、仓库外文件访问或凭据泄漏。

## 17. 完成定义

只有同时满足以下条件才可宣布第二阶段完成：

- 本文所有在范围内的行为已有实现和自动化测试；
- 全量测试、typecheck、build 与真实 API smoke 通过；
- README 与短版 README 对配置、Session、压缩、Skills 和安全边界描述真实；
- `docs/PROJECT_REQUIREMENTS.md` 的阶段状态与代码一致；
- 在干净临时 HOME 和临时工作区中完成一次手工 CLI 演练；
- `git status --short` 仅包含预期文件，仓库中不存在 API Key、Session 数据或本地 Skill 私有内容。
