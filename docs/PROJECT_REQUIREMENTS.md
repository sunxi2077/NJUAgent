# NJUAgent 项目要求与实施清单（v0.2）

> 本文是项目的需求基线、设计思路和验收清单。题目原文与本文冲突时，以题目 PDF 为准。
>
> 状态标记：`[ ]` 未完成，`[x]` 已完成。优先级：P0 必须完成，P1 应当完成，P2 时间允许再做。
>
> 详细架构与行为设计见 [`docs/superpowers/specs/2026-08-27-njuagent-design.md`](docs/superpowers/specs/2026-08-27-njuagent-design.md)。

## 1. 项目目标

独立设计并实现一个命令行编程智能体。用户给出编程任务后，智能体通过大语言模型自主决定下一步操作，调用本地工具读取或修改代码、执行命令、观察结果并继续行动，直至给出最终答复或触发明确的终止条件。

计划采用：

- TypeScript + Node.js 实现命令行程序；
- `@anthropic-ai/sdk` 仅作为普通模型 API 客户端库；
- DeepSeek 的 Anthropic 兼容 API；
- 借鉴 `learn-claude-code` 的学习思路，但自行设计和实现核心代码；
- 第一版只做单智能体，不做 GUI、多智能体、MCP 和复杂工作流。

## 2. 题目硬性约束（P0）

### 2.1 实现约束

- [x] 项目是个人独立设计和实现的编程智能体。
- [x] 不在 Claude Code、Codex、OpenCode 等现成 agent 产品上封装界面。
- [x] 不使用 LangChain、LlamaIndex、OpenAI Agents SDK、Claude Agent SDK、AutoGen、CrewAI 等 agent 框架或 SDK。
- [x] 只把 `@anthropic-ai/sdk` 用作普通模型 API 客户端，不使用 `@anthropic-ai/claude-agent-sdk`，也不依赖任何现成 agent/harness 实现。
- [x] 不依赖服务端托管的 Code Interpreter、Files API 或类似文件、代码执行工具。
- [x] 自行实现对话历史和上下文管理。
- [x] 自行定义工具协议并在本地执行工具。
- [x] 自行解析模型输出及工具调用结果。
- [x] 自行实现 agent 循环和循环终止条件。
- [x] 自行实现 API、工具和协议错误处理。
- [x] 能解释并为项目中的每项重要设计决策辩护。

### 2.2 凭据与仓库

- [x] API Key 只通过环境变量或未入库配置提供。
- [x] `.env`、本地配置、运行日志等敏感内容加入 `.gitignore`。
- [x] 仓库和 README、示例、测试、终端录屏中不出现真实凭据。
- [ ] 使用题目发布后新建的公开 GitHub 或 Gitee 仓库。
- [x] 保留完整、真实、逐步演进的提交历史。
- [ ] 不压缩或改写已经推送到远端的提交历史。
- [ ] 2026 年 9 月 2 日 24:00 后不再推送提交。

### 2.3 最终提交物

- [ ] 公开 Git 仓库可访问，且包含可运行的完整源码和开发历史。
- [x] 编写 `README.txt`，控制在 1000 汉字以内。
- [x] `README.txt` 包含仓库地址、运行方法、特色功能和必要说明。
- [ ] 录制不超过 2 分钟的 MP4 演示视频。
- [ ] 视频展示 agent 完成一个真实编程任务，并简要讲解实现。
- [ ] 视频文件不超过 200 MB，且不出现 API Key 等凭据。
- [ ] 最终 ZIP 仅包含 `README.txt` 和视频，以本人姓名命名。
- [ ] 在截止时间前完成表单提交，并核对最后一次提交内容。

## 3. MVP 功能要求（P0）

### 3.1 命令行交互

- [x] 用户可以指定一个工作区并启动 agent。
- [x] 用户可以在终端输入自然语言编程任务。
- [x] 终端清楚显示模型回复、工具名称、关键参数、执行结果和最终状态。
- [x] 采用混合流式交互：正文保留为可滚动记录，当前状态、spinner 和流式增量在瞬时区域更新。
- [x] 在非 TTY 环境自动退化为无颜色、无动态刷新的普通文本输出。
- [x] 支持用户正常退出以及 `Ctrl-C` 中断。
- [x] 启动时检查必要配置，缺失时给出可操作的错误提示。

验收：在一个独立示例项目中启动 agent，输入任务后无需手工拼接 API 请求即可完成整轮交互。

### 3.2 模型客户端

- [x] 通过 Anthropic Messages API 形式调用 DeepSeek Anthropic 兼容端点。
- [x] API Key、Base URL、模型名均可通过环境变量配置。
- [x] agent 主循环不直接依赖 `@anthropic-ai/sdk` 的响应对象，模型适配逻辑与核心循环之间有清晰边界。
- [x] 将文本块、工具调用块和停止原因转换为项目内部数据结构。

验收：可以用 mock 客户端离线测试 agent loop；更换兼容模型不需要修改工具和循环逻辑。

### 3.3 Agent 主循环

- [x] 将用户消息加入对话历史。
- [x] 向模型发送 system prompt、历史消息和工具定义。
- [x] 保存模型返回的完整 assistant 消息。
- [x] 识别一轮中的一个或多个工具调用。
- [x] 调用本地工具，并将每个结果与正确的 `tool_use_id` 配对。
- [x] 将工具结果加入历史，再次请求模型。
- [x] 没有工具调用时结束本轮并输出模型文本。
- [x] 设置最大模型轮数，防止无限循环。
- [x] 区分正常完成、达到限制、API 失败、工具失败和用户中断。

验收：使用 mock 响应覆盖“纯文本结束”“单次工具调用”“多轮工具调用”“达到轮数上限”和“异常退出”。

### 3.4 本地工具

第一版工具集：

- [x] `read_file`：按行或按范围读取 UTF-8 文本文件。
- [x] `write_file`：创建或完整写入文件。
- [x] `edit_file`：用精确匹配完成局部修改，并能识别未找到或多处匹配。
- [x] `list_files`：查看目录或按 glob 模式查找文件。
- [x] `search_text`：在工作区搜索代码和文本。
- [x] `run_command`：在工作区执行构建、测试和普通命令。

所有工具统一满足：

- [x] 使用明确的 JSON Schema 描述输入。
- [x] 在工具注册表中将名称、描述、Schema 和执行函数关联起来。
- [x] 参数无效、工具不存在、文件不存在等情况返回结构化错误，不让进程崩溃。
- [x] 限制返回模型的输出大小，并明确告知是否被截断。
- [x] 保留足够的日志用于调试和视频讲解。

验收：每个工具都有独立单元测试，并至少覆盖成功、无效输入和执行失败三类情况。

### 3.5 工作区与安全边界

- [x] 文件工具默认只允许访问启动时指定的工作区。
- [x] 使用规范化后的真实路径判断边界，防止 `..`、绝对路径和符号链接逃逸。
- [x] 命令固定以工作区为当前目录执行。
- [x] 命令执行设置超时并同时捕获 stdout、stderr 和退出码。
- [x] 明确阻止极高风险命令。
- [x] 对删除、覆盖工作区外内容等潜在破坏性操作进行人工确认或拒绝。
- [x] 工具被拒绝时仍生成对应的工具结果，使消息历史保持合法。

验收：测试普通路径、`../`、绝对路径、指向外部的符号链接、命令超时和危险命令。

### 3.6 错误与终止机制

- [x] API 超时、限流、连接失败和非法响应不会导致未说明的崩溃。
- [x] 对可恢复 API 错误进行有上限的退避重试。
- [x] 工具执行失败时把清晰错误反馈给模型，使其可以自主修复。
- [x] 最大轮数、命令超时和输出上限可配置且有合理默认值。
- [x] 最终状态中包含停止原因和本轮工具调用数量。

验收：用 mock 或故障注入稳定复现并验证上述错误路径。

## 4. 可靠性与展示要求（P1）

### 4.1 可观察性

- [x] 每次运行具有 session ID。
- [x] 记录每轮模型请求、停止原因、工具调用、耗时和结果摘要。
- [x] 默认日志不记录 API Key；对可能的敏感环境变量进行脱敏。
- [x] 提供简洁输出和调试输出两种模式。

### 4.2 上下文控制

- [x] 估算或记录每轮 token 使用量。
- [x] 大型工具输出先截断或压缩，避免直接塞满上下文。
- [x] 上下文接近阈值时有明确策略：停止并说明，或摘要较早历史。
- [x] 摘要策略启用时保留当前任务、关键决定、已修改文件和未完成事项。

### 4.3 可验证完成

- [x] system prompt 明确要求修改后运行相关测试或构建命令。
- [x] 最终回复说明修改了什么、运行了什么验证、验证是否通过。
- [x] 不把“模型停止调用工具”在程序层面伪装成经过证明的成功。
- [ ] 视频演示至少包含一次“测试失败 - 阅读错误 - 修复 - 测试通过”的闭环。

### 4.4 工程质量

- [x] 使用 `package.json`、`tsconfig.json` 管理依赖、构建配置和命令入口。
- [x] 核心模块具有类型标注和必要文档。
- [x] 单元测试不需要真实 API Key。
- [x] 提供一个可选的真实 API 冒烟测试。
- [x] 提供 `.env.example`，只包含占位值。
- [x] 提供适合开发者阅读的仓库 `README.md`，与最终提交的短版 `README.txt` 分开。

## 5. 可选增强（P2）

仅在 P0、P1 稳定并完成演示脚本后考虑：

- [x] 会话保存与恢复。
- [ ] 更精确的 patch 工具。
- [ ] Git diff 摘要。
- [ ] 用户可配置的 allow/deny 权限规则。
- [ ] 简单 todo/planning 工具。
- [x] 自动上下文摘要。

第二阶段已经加入显式 Skills、Session 和上下文摘要。当前仍不计划：GUI、多智能体、后台任务、MCP、长期记忆、任务 DAG、工作树并发和远程代码执行。

## 6. 建议架构

```text
CLI
 ├─ Config
 └─ Agent
     ├─ ModelProvider (Anthropic protocol / DeepSeek endpoint)
     ├─ ConversationHistory
     ├─ ToolRegistry
     │   ├─ File tools
     │   ├─ Search tools
     │   └─ Command tool
     ├─ PermissionPolicy
     └─ RunResult / StopReason
```

设计原则：

1. 模型负责判断下一步行动，harness 负责提供能力和边界。
2. 核心循环保持简单，工具通过注册机制扩展。
3. SDK 数据类型只停留在 provider 层，内部类型由我们控制。
4. 文件安全、命令权限、超时和输出限制由宿主程序强制执行，不能只靠 prompt。
5. 每个异常路径都应有可解释、可测试的结果。

## 7. 分阶段实施与提交思路

### 阶段 A：最小闭环

- [x] 建立新 Git 仓库、TypeScript/Node.js 工程、配置和测试框架。
- [x] 定义内部消息、工具调用和运行结果类型。
- [x] 使用 mock 模型实现并测试最小 agent loop。
- [x] 接入 DeepSeek Anthropic 兼容 API，完成文本对话冒烟测试。

完成标准：一轮文本和一轮 mock 工具调用均可运行。

### 阶段 B：编程能力

- [x] 实现工具接口、注册表和六个基础工具。
- [x] 接入真实工具调用循环。
- [x] 添加工作区路径保护、命令超时和输出限制。

完成标准：agent 能在示例项目中读取代码、修改代码并运行测试。

### 阶段 C：可靠性

- [x] 完善权限确认、错误恢复、最大轮数和停止原因。
- [x] 完善日志、token/上下文控制和配置校验。
- [x] 补齐关键单元测试与集成测试。

完成标准：危险操作和主要故障路径可稳定复现，且程序不会无说明退出。

### 阶段 D：提交与面试

- [x] 选择稳定、时长可控的真实演示任务。
- [ ] 多次演练并准备异常情况下的备用录屏。
- [x] 完成仓库 `README.md` 和 1000 汉字以内的 `README.txt`。
- [ ] 准备两分钟视频脚本并录制、剪辑、压缩。
- [x] 准备架构、工具协议、安全边界、终止条件和错误处理的面试说明。
- [x] 清理仓库中的密钥、临时文件和无关产物。
- [ ] 按题目要求打包并提交。

## 8. 总体验收场景

准备一个带有现成失败测试的小型示例项目，对 agent 输入真实任务，例如：

> 为这个 Python 项目补充输入校验；先阅读代码和测试，完成修改后运行测试，若失败请继续修复。

验收过程应能观察到：

1. agent 查看项目结构和相关文件；
2. agent 定位需要修改的代码；
3. agent 编辑文件；
4. agent 运行测试；
5. 若测试失败，agent 读取错误并继续修复；
6. 测试通过后，agent 汇报变更、验证命令和结果；
7. 运行日志可以说明每一轮为何继续或停止；
8. 全程没有访问工作区外文件，也没有泄露凭据。

## 9. 开发过程中的决策记录

重要设计决定应记录“问题、选择、理由、代价和备选方案”，至少覆盖：

- [x] 为什么选择命令行而不是 GUI；
- [x] 为什么选择 Anthropic 协议与 DeepSeek；
- [x] 为什么使用模型厂商 SDK 不违反题目限制；
- [x] 为什么采用当前工具粒度；
- [x] 如何判定并限制危险操作；
- [x] 为什么采用当前终止条件；
- [x] 如何处理模型上下文增长；
- [x] 如何定义和证明“任务完成”。

这些记录既服务于实现，也直接用于视频讲解和面试答辩。逐项说明见 `docs/superpowers/specs/2026-08-27-njuagent-design.md`（第 3、4、8、10、11、14、15、19 节）与仓库 `README.md` 的架构、安全模型和局限性章节。

## 10. 验收审计记录（2026-08-27；2026-08-28 阶段一收尾复核）

审计依据 `fix/stage-one-hardening` 分支 HEAD（含阶段一收尾的六个提交）逐项核对；未勾选项均为外部交付或明确未实现项。

### 已勾选项的支撑证据

- 实现约束、MVP 功能、阶段 A–C：源码与测试见 `src/`、`tests/`；`npm test` 全量离线单元与集成测试通过，`npm run typecheck`、`npm run build` 通过（数量以最新一次运行为准，避免文档过期）。
- 主循环、工具、消息配对、权限、路径边界、重试、上下文压缩：对应单元测试 `tests/unit/`。
- 端到端闭环（列目录 → 读文件 → 编辑 → 测试失败 → 修复 → 测试通过）：`tests/integration/agent.test.ts` + `tests/fixtures/demo-project`，全部离线、无需真实 API Key。
- 命令行交互、TTY/非 TTY 渲染、Ctrl-C 语义、session ID、工具调用参数展示、非 TTY 流式文本重组与实时输出限额：`src/cli/`、`src/index.ts` 与 `tests/unit/cli/`。
- 配置校验与可执行入口：`src/config.ts`、`src/index.ts`；无模型变量时输出可操作错误并退出码 1；`--help`/`-h` 无需凭据即可运行并退出 0；可执行文件首行为 Node shebang。
- 子进程环境隔离：`src/security/command-environment.ts` 以白名单方式构造命令环境，模型凭据与无关父进程变量（如 `DATABASE_URL`）不会进入子进程；回归测试见 `tests/unit/security/command-environment.test.ts` 与 `tests/unit/tools/command-tool.test.ts`。
- 命令权限保守化：`src/security/permission-policy.ts` 在放行白名单之前先检查 shell 语法与绝对路径；管道、重定向、home 展开、任意运行时、`find -delete`、`sed -i`、破坏性 `git branch` 均需确认；提权等仍直接拒绝；回归测试见 `tests/unit/security/permission-policy.test.ts`。
- 冒烟测试：`tests/smoke/anthropic-api.smoke.ts` + `tests/smoke/smoke-assertions.ts`，`npm run test:smoke`；缺少凭据时打印一条 SKIP 说明并以退出码 0 结束，不发网络请求。**真实运行记录（2026-08-28）**：`SMOKE model=deepseek-v4-flash text_turn=completed tool_turn=completed tool_calls=1 duration_ms=3378 PASS`；阶段 A 的“接入 DeepSeek Anthropic 兼容 API，完成文本对话冒烟测试”里程碑据此勾选。
- 凭据安全：`.gitignore` 排除 `.env`、日志与密钥类文件；全仓库与提交历史扫描未发现真实凭据；`.env.example` 仅为占位。

### 未勾选/待办项

- 公开仓库创建与推送（2.2/2.3）：需新建公开 GitHub/Gitee 仓库并推送分支；本次未推送、未改写历史。
- 演示视频（2.3/4.3/阶段 D）：录制 ≤2 分钟 MP4，展示“测试失败 - 阅读错误 - 修复 - 测试通过”闭环；≤200 MB、无凭据。
- 演练与备用录屏（阶段 D）：多次演练后准备异常情况备用素材。
- 打包与表单提交（2.3/阶段 D）：最终 ZIP 仅含 `README.txt` 与视频，以本人姓名命名，截止前提交。
- 语义上下文摘要（4.2 末项）：当前为确定性压缩（保留任务文本、工具结果配对与 ID），不保留早期内容的语义摘要；列为 P2 增强。
- 阶段一收尾已合并：`fix/stage-one-hardening` 通过真实冒烟 PASS 后快速前进合并到 `main`，历史未压缩、未改写。

## 11. 第二阶段（Stage Two）开发清单

> 依据 `docs/superpowers/plans/2026-08-28-stage-two-*.md` 四份规划文档逐项核对；仅测试通过后勾选。

### CLI 基础（stage-two-cli-foundation）

- [x] 稳定错误契约（AppError 代码 + 安全消息格式化，不泄露密钥/环境）。
- [x] 应用路径（`NJU_AGENT_HOME`）、原子 JSON 写入、非密钥配置存储（`config.json` 只存 Base URL/Model/权限模式）。
- [x] 配置合并（环境 > 持久化；API Key 仅来自环境）与首次运行 setup 流程。
- [x] NJU 紫主题与一次性欢迎面板（TTY box 版 / 非 TTY 纯文本，长值按码点截断）。
- [x] readline 接管输入提示（`› ` 存活于输出重绘；suspend/resume 协调）。
- [x] 可测试 bootstrap（help 免凭据、setup 时机、欢迎面板只出现一次）。

### 会话与命令（stage-two-sessions-and-commands）

- [x] 完整历史可加载（防御性拷贝、校验失败不部分替换）与 `PersistedSessionV1` 双重校验。
- [x] 原子、抗损坏的 SessionStore（损坏文件隔离、唯一前缀解析）。
- [x] SessionManager（save-before-switch、回合检查点、dirty 语义、resume/createNew 原子替换）。
- [x] SlashCommandRouter（`//` 转义、未知命令不达模型）。
- [x] 会话/历史纯格式化（有界预览，不泄露完整工具输出）。
- [x] `/help` `/status` `/sessions` `/resume` `/new` `/history` `/setup` `/exit` 命令处理器。
- [x] 端到端接线（默认会话、动态 runtime 重建、欢迎页最近会话提示、生命周期集成测试）。

### 上下文管理（stage-two-context-management）

- [x] 上下文预算配置（`CONTEXT_WINDOW_TOKENS` 等四项，硬输入预算为正）。
- [x] 全请求估算与确定性工具结果收缩、安全切割（不拆分 tool-call/result 对）。
- [x] 无工具 ModelCompactor（固定摘要提示、有界 transcript、协议失败拒绝）。
- [x] 事务性 ContextManager（commit-after-validate、失败回滚、硬限检查）。
- [x] runner 接入 ContextManager 并持久化上下文状态（跨 resume 恢复）。
- [x] `/context`（诚实地标注 estimates）与 `/compact [focus]`（可 Ctrl-C 取消）。

### Skills 与发布（stage-two-skills-and-release）

- [x] 严格有界 SKILL.md 解析（最小 frontmatter、名称/大小/描述限制）。
- [x] 用户/项目 Skill 安全发现（符号链接防逃逸、读前大小检查、诊断隔离）与项目优先级。
- [x] 分层系统提示（base → skill → summary）与显式单 Skill 激活持久化（resume 恢复/停用修复）。
- [x] `/skills`（刷新后列出）与 `/skill <name>|off`（激活/停用，幂等）。
- [x] Provider 错误分类（auth/rate_limit/unavailable/protocol/invalid_request → 稳定 AppError 码）与取消审计。
- [x] 离线演示测试、文档与两分钟演示脚本（`docs/STAGE_TWO_DEMO.md`）。

### Stage 2.1 验收修复

- [x] 配置失败、EOF 和 Ctrl-C 路径正确关闭 Prompt 并刷新 dirty Session。
- [x] 同进程 `/resume` 恢复 Skill 注入；`/setup` 保存非敏感配置并重建当前 Runtime。
- [x] Provider usage 参与未压缩请求预算，`/context` 只估算 checkpoint 后的有效视图。
- [x] 项目 Skill 路径统一为 `<workspace>/.nju-agent/skills/`。
- [x] 欢迎页按终端宽度排版并使用南大紫层级；工具记录隐藏内部 ID 和原始 JSON。
- [x] readline 缓存连续粘贴的输入行，不再静默丢弃后续命令。

## 12. 第三阶段（Stage Three）CLI UI 打磨清单

> 依据 `docs/superpowers/plans/2026-08-29-stage-three-cli-ui-polish.md` 逐项核对。

- [x] 语义主题（brandStrong 141 / brandBorder 99 / userLabel 45）与单一启用决策（TTY && !NO_COLOR && TERM != dumb）。
- [x] 响应式欢迎卡：>=64 列完整 NJU Logo；36-63 紧凑边框；<36 或禁用时纯文本；Unicode 宽度截断。
- [x] readline 输入锚点 `❯ You`（cyan 45），中文/光标/Backspace/粘贴不回归。
- [x] 流式 Markdown 子集（heading/bold/italic/list/quote/inline code/fenced code/link）与分块不变量。
- [x] `◆ NJUAgent` 助手分段与工具行之间可见区分；无样式泄漏到运行摘要。
- [x] 全量回归 405 测试、真实 TTY 验收（80/60/40 列）、范围外功能未引入。

## 13. 第四阶段（Stage Four）可靠目标、计划与联网搜索清单

> 依据 `docs/superpowers/specs/2026-08-29-stage-four-reliable-agent-design.md` 与
> `docs/superpowers/plans/2026-08-29-stage-four-reliable-agent-implementation.md`。
> 范围：联网搜索、Plan 计划、显式 Goal 模式。非目标：长期记忆、Repo Map、Session Fork、
> 子 Agent、MCP、web_fetch、后台任务、自动 Git 回滚、自动为普通消息创建 Goal。
> 仅在最终套件全部通过后勾选。

- [x] 持久化 Plan/Goal/Evidence 状态（schemaVersion 1 兼容旧文档规范化）。
- [x] PlanManager 原子替换与 `plan_write` 模型工具。
- [x] `/plan` 命令、`plan_updated` 事件与 CLI 渲染。
- [x] Tavily Provider（注入 fetch、Bearer 协议、超时/取消组合、错误分类不泄露密钥）。
- [x] 权限门控 `web_search` 工具（域名校验、输出预算、`<untrusted_web_results>`）。
- [x] 确定性 Evidence Ledger 与验证命令分类（fresh verification 语义）。
- [x] `/goal` 会话控制（创建/查看/清除，替换重置计数）。
- [x] 无工具 GoalEvaluator 与宿主 GoalPolicy（未完成计划/陈旧验证强制 incomplete）。
- [x] StopGate + GoalController（最多 3 次自动继续；goal_verified / goal_incomplete / fail 映射）。
- [x] 普通模式零回归（无 Goal 时无评估请求；非 TTY 无 ANSI；无密钥泄漏）。

## 14. Slash Command Palette 验收状态

> 依据 `docs/superpowers/specs/2026-08-30-slash-command-palette-design.md` 与
> `docs/superpowers/plans/2026-08-30-slash-command-palette-implementation.md`。
> 范围：真实增强 TTY 下 `/` 自动弹出、前缀过滤、方向键选择、Tab/前缀 Enter 补全。
> 非目标：参数补全、模糊/拼音搜索、鼠标、多列布局、自定义编辑器、TUI 框架。

- [x] `SlashCommandRouter.descriptors()` 只暴露 name/usage/description（注册顺序、防御性副本）。
- [x] `SlashCompletionModel` 纯状态机（大小写不敏感前缀、≤6 候选、首尾循环、选中保持、防御性副本）。
- [x] `formatSlashMenu` 完整单列边框（<40 列紧凑降级）+ `sanitizeTerminalText` 清理描述。
- [x] `SlashMenuPresenter` 临时区域（save/restore cursor、suspend/resume、resize、close 清理）。
- [x] `TerminalInputRouter` 独占 stdin→readline 字节通道（consume/forward、handler 抛错 fail-open、close 不关 stdin）。
- [x] `ReadlinePrompt` Palette controller（决策表：Tab/Esc/方向键/前缀 Enter 消费，其余 fail-open；`//`、空格、中文、粘贴不丢字）。
- [x] CliSession 主 read 传入最新 descriptors；Bootstrap 统一 enhanced/theme（Prompt 与 Renderer 同一主题）。
- [x] 非 TTY / NO_COLOR / TERM=dumb 无动态菜单与 ANSI；普通输入与权限确认不触发 Palette。
- [x] 跨组件集成与生命周期测试（12 场景）覆盖完整用户路径、失败开放、interrupt/close/EOF/resize 清理。
