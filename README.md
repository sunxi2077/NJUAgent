# NJUAgent

NJUAgent 是一个使用 TypeScript 与 Node.js 独立实现的命令行编程智能体。用户给出任务后，它会规划步骤，在本地读取、搜索和修改代码，运行测试与构建，并根据结果继续行动。项目不封装现成 Agent；循环、工具协议、上下文与权限控制均由本仓库实现。模型通过 Anthropic Messages API 接入 DeepSeek 兼容端点。

仓库：[GitHub](https://github.com/sunxi2077/NJUAgent)

## 主要能力

- 文件读写、精确编辑、代码搜索和命令执行；
- `web_search` 联网搜索，`fetch_url` 获取指定网页（GitHub blob/tree 链接自动走 Contents API，只读、不写文件）；
- Goal 定义完成条件，Plan 展示执行进度；输出被 token 上限截断时会自动续写重试（≤2 次），不再直接失败；
- 从项目或用户目录加载 Skills（frontmatter 接受 `name`、`description` 与可选的 `license`），显式 `/skill <name>` 激活；
- 每个工具完成渲染一张紧凑结果卡，省略行给出 `… N more lines hidden · /tool T-…`，`/tool` 按 T- 引用或 id 前缀查看保留的完整输出；
- 保存与恢复会话，主动或自动压缩上下文；
- 流式 Markdown、Slash 菜单、Token 面板与 Terminal Cards。

## 快速开始

需要 Node.js 20+。复制 `.env.example` 为 `.env`，填写 API 配置。密钥只从环境变量读取，不会保存到会话中。

```bash
npm install
npm run build
npm link
set -a; source .env; set +a
njuagent .
```

`.` 表示当前目录。权限模式通过 `--permission-mode cautious|balanced|trusted` 选择：`cautious` 写入/命令都要确认；`balanced`（默认）自动放行安全的工作区命令；`trusted` 进一步自动放行过 guard 的工作区命令与 `fetch_url`——hard guard（sudo、`~`、绝对路径逃逸、`git push`、管道到 shell 等）在任何模式下都不可绕过。模型永远不能自行修改权限模式。

## 常用命令

输入 `/` 浏览全部命令，例如：

```text
/help     命令分组帮助（TTY 下为卡片）
/status   会话状态面板（含上下文压力、token 用量与费用估算）
/tool <T-… | id 前缀>   查看某次工具调用的保留输出
/goal [clear|<条件>]    设置/查看/清除完成目标
/plan [clear]           查看/清除执行计划
/skills · /skill <name>|off   列出 / 激活 / 停用 Skill
/context · /compact [focus]   上下文状态与压缩
/sessions · /resume <id> · /new   会话管理
/setup · /exit   配置 / 退出
```

## 配置

环境变量说明见 `.env.example`，常用项：

- `AGENT_MAX_TOKENS`：单次回复 token 上限，默认 `8192`（大文件单次写入场景可调到 ~12000）；
- `REMOTE_FETCH_TIMEOUT_MS` / `REMOTE_FETCH_MAX_BYTES`：`fetch_url` 超时（默认 15000ms）与单资源字节上限（默认 32768，1024–65536）；
- `WEB_SEARCH_TIMEOUT_MS` / `WEB_SEARCH_MAX_CONTENT_CHARS`：`web_search` 相关；
- `NJU_AGENT_HOME`：应用目录（配置、会话、Skills，默认 `~/.nju-agent`）；`NO_COLOR`：禁用颜色与控制字符。

## 安全与验证

模型决定下一步操作，宿主程序负责安全边界：

- 文件工具只能访问当前工作区（realpath 后再校验）；命令先经过工作区 guard 再进入权限模式判断，并具有超时、取消与输出上限；
- 子进程运行在清理后的白名单环境里，**不**继承模型凭据或代理变量；`fetch_url` 只读拉取文本，保存仍需工作区相对路径的 `write_file`；
- 联网内容（搜索与拉取）统一视为不可信数据，不授权任何操作；不存在 “unrestricted” 权限模式；
- 修改代码后，Agent 会通过测试或构建验证结果；Goal 场景下编辑后必须有全新的成功验证命令才算满足。

```bash
npm test
npm run typecheck
npm run build
```

当前版本为单 Agent、单工作区 CLI。
