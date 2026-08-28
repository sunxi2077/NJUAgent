# NJUAgent 两分钟演示脚本（第二阶段）

> 目标：在 2 分钟内展示完整的第二阶段产品能力。录制前先完整排练一次；出现任何密钥、个人 home 路径、系统通知或无关终端标签页，立即重录。

## 准备（录制前）

- 终端窗口：**120 列 × 30 行**，等宽字体（如 Menlo 14pt），无背景图。
- 工作区：`tests/fixtures/demo-project` 的副本（`cp -R tests/fixtures/demo-project/. /tmp/nju-demo`）。
- 环境：在一个**未录屏的 shell** 中先导出（画面中只显示变量名，不显示值）：

  ```bash
  export ANTHROPIC_API_KEY=...            # 只在录制前设置，画面不出现值
  export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
  export MODEL_ID=deepseek-v4-flash
  export NJU_AGENT_HOME=/tmp/nju-agent-home   # 临时 home，避免出现个人路径
  ```

- 可选项目技能（用于 /skills 演示）：

  ```bash
  mkdir -p /tmp/nju-demo/.nju-agent/skills/test-first
  printf -- '---\nname: test-first\ndescription: Write a failing test first.\n---\n\nWrite one focused failing test, observe it fail, then implement.\n' \
    > /tmp/nju-demo/.nju-agent/skills/test-first/SKILL.md
  ```

- 禁用系统通知；关闭无关终端标签页；录音从启动命令前一秒开始。

## 时间线（2:00 总时长）

| 时间 | 画面 | 讲解要点 |
|---|---|---|
| 00:00–00:12 | `npm start -- --workspace /tmp/nju-demo`：NJU 紫欢迎面板 + `› ` 提示 | 一句架构：模型决策，宿主负责工作区、权限与上下文边界 |
| 00:12–01:12 | 输入编码任务；agent 列文件→读源码→编辑→`npm test` 失败→读错误→再编辑→测试通过 | 完整"失败-修复-通过"闭环；强调真实命令记录 |
| 01:12–01:32 | `/context`（估算/阈值/硬限/覆盖）+ `/compact wrap up` + `/context`（覆盖数增加） | 上下文预算是估算；压缩只摘要、不删完整历史 |
| 01:32–01:48 | `/new` → 输入一句 → `/sessions`（两行）→ `/resume <前 8 位>` | 会话按 UUID 存储、保存即切换、resume 恢复完整历史 |
| 01:48–01:58 | `/skills`（项目技能可见）→ `/skill test-first` → 再输任务观察技能层 | Skill 是提示文本、显式激活、项目覆盖用户 |
| 01:58–02:00 | `/exit`；滚动回顶部展示"无凭据出现在任何输出" | 结束语：受信任本地 CLI，凭据只来自环境变量 |

## 备用任务（主任务意外失败时）

- 用 `tests/fixtures/demo-project` 的另一个缺陷（如 `parsePort` 未拒绝负数），演示相同闭环；或跳过 /compact 只展示 /context。
- 若模型未按预期调用工具：降低任务复杂度为"列出文件并总结项目结构"，再手动演示命令部分。

## 验收清单（录制后）

- [ ] 2:00 以内、≤200 MB、无 API Key/个人 home 路径/系统通知
- [ ] 出现一次"测试失败 → 阅读错误 → 修复 → 通过"
- [ ] `/context`、`/compact`、`/new`、`/sessions`、`/resume`、`/skills`、`/skill` 各至少一次
- [ ] 重放一遍确认每段画面与讲解一致
