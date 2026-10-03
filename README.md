# SuperCode

**多 Agent 桌面总控客户端** —— 不重新发明 coding agent，而是站在各家成熟 agent CLI 的肩膀上，做它们的"最高指挥中心"。

```
┌─────────────────────────────────────────────┐
│  SuperCode（总控）                            │
│  工作空间 · 多会话 · 审批中心 · 任务看板 · Diff 审查 │
├─────────────────────────────────────────────┤
│  Agent 适配层（ACP 优先，headless 兜底）         │
└──────────────┬──────────────────────────────┘
               ↓ stdio JSON-RPC（ACP v1）
   opencode ─ claude-code ─ codex ─ MiMo ─ …
```

- **协议优先**：以 [Agent Client Protocol](https://agentclientprotocol.com)（Zed 发起，v1 稳定）为通用接入底座——新增 agent ≈ 注册表加一条命令
- **审批是第一公民**：所有 agent 的权限请求汇入统一审批中心（会话级权限模式 + 预授权规则 + 人工裁决 + fail-closed）
- **Mac 优先**，后续兼容 Windows；桌面端 Tauri v2 + Rust 核心 + React 19

## 当前状态：v0.3.0（多 Agent · worktree · 看板 · 终端）

[下载 v0.3.0（macOS Apple Silicon / Intel）](https://github.com/Adiao1973/SuperCode/releases/tag/v0.3.0)

✅ **桌面端全功能已在真实 opencode + GLM 上验收通过**（[Phase 1 验收记录](docs/acceptance/phase1.md)）：

| 能力 | 说明 |
|---|---|
| 多会话并行 | 多会话同时运行互不串台；⌘N/⌘1-8/⌘R/⌘. 快捷键；协议级取消 |
| 会话视图 | 流式消息 + 思考 + 工具时间线（虚拟列表，200+ 条目流畅）；edit 结构化 diff / write 磁盘懒读 |
| 权限模式 | 会话级四档一键切换（计划 / 确认 / 自动编辑 / 完全访问，ADR-0006）+ 规则库（SQLite 持久，deny>ask>allow）；待决卡片内联会话流，审批中心跨会话聚合 |
| 持久化与恢复 | 事件流落库；重启后历史会话恢复；续聊经 session/load 恢复上下文；会话删除级联 |
| 工作空间 | 项目空间=项目根路径（同项目会话自动归组，历史按 cwd 回填）；默认空间承载聊天/电脑操作类任务（ADR-0007） |
| 任务看板 | 任务=标题+空间+绑定会话+状态（待办→进行→评审→完成）；点击绑定会话跳转；会话删除自动解绑 |
| 环境探测 | opencode 安装/版本/默认模型检测；严格模式引导（检测并给出可复制的收紧配置，补客户端管辖边界外的白名单缺口） |

v0.1.0（Phase 0 · CLI 原型）的 ACP 全链路验收见 [docs/acceptance/phase0.md](docs/acceptance/phase0.md)。

v0.3.0 包含 Claude Code、Codex、MiMo ACP 接入、Agent 管理、任务 worktree 隔离、看板拖拽与会话内嵌终端。用户授权本版跳过 ZCode：其 StreamJson 实现保留独立分支，当前 Start Plan 未能通过 headless CLI 验收，发布版不能运行 ZCode。详见 [Phase 2 验收](docs/acceptance/phase2.md) 和 [路线图](docs/roadmap.md)。

开发版可在设置页管理 Agent，在会话中选择已安装并完成认证的 ACP agent。任务看板可跨列/空间拖拽，已有会话及 worktree 保持原执行归属；「隔离会话」建立独立任务目录；会话底部「打开终端」使用实际 cwd，关闭或切换会话/页面会结束 shell。

## 环境要求

- macOS（Phase 3 起支持 Windows）
- Rust ≥ 1.88（edition 2024）、Node + pnpm
- [opencode](https://opencode.ai) ≥ 1.18 已安装并完成认证；也可选择 Claude Code/Codex/MiMo，按设置页指引安装相应 CLI/ACP adapter 并完成各自认证
  - 注意：需在 `~/.config/opencode/opencode.jsonc` 显式固定默认模型（ACP 会话不继承登录态默认模型，会回退到 zen 免费模型并限流），例如：
    ```jsonc
    { "model": "zhipuai-coding-plan/glm-5.3-flash" }
    ```
  - Homebrew / 官方脚本安装均可——打包 .app 已内置常见安装目录的 PATH 修正（launchd 环境不继承 shell PATH）
- [just](https://github.com/casey/just)（一键命令，可选）

## 快速开始

```bash
git clone <repo> && cd SuperCode
just verify          # 前端构建 + fmt/clippy/全部测试
just dev             # 桌面端开发模式（Tauri dev）
just build           # 打包 .app 与 .dmg（target/release/bundle/）
```

桌面端速览：

- **新建空间**：侧栏 ➕文件夹 → 输入项目根目录（如 `/Users/you/Code/myapp`），同项目会话自动归组；不绑项目的会话放「默认空间」
- **跑任务**：空间内新建会话（cwd 自动预填）→ 输入提示词 ⌘R 运行；确认模式下每个 bash/edit 都会弹内联审批卡
- **权限模式**：表单右侧选择器（计划=只读全拒 / 确认=逐次询问 / 自动编辑=edit 类放行 / 完全访问=全放行），运行中可热切换
- **续聊**：跑过的会话直接输入新提示词再运行（自动 session/load 恢复上下文）；重启后历史仍在
- **严格模式**（推荐）：会话运行框检测到"宽松"时，展开「收紧引导」复制 `opencode.jsonc` 片段写入项目目录——之后 bash/edit 全部进 SuperCode 审批（否则 opencode 自带白名单会静默放行部分操作，见 ADR-0006 管辖边界）

CLI 支持 `./target/debug/supercode run|resume|sessions|detect`。

Phase 3 开发中的计划校验（dev，尚未包含在 v0.3.0）：

```bash
cargo run -p supercode-cli -- plan validate docs/examples/commander-plan.json
```

该命令只验证计划并输出依赖批次，不执行任务。

### 预授权规则语法

```
*                全匹配
bash             裸工具名（任意参数）
bash(git status) 精确命令
bash(git diff *) 通配（* 跨空格；尾通配宽容：也匹配无参的 git diff）
```

求值优先级 `deny > ask > allow`；模式兜底在其后（plan 拒绝 / full 放行 / autoedit 放行 edit 类）。**面向 agent 的规则建议用通配**——agent 常自行拼接命令，精确规则容易漏配。

### 数据位置

- 会话库：`~/Library/Application Support/SuperCode/supercode.db`（`SUPERCODE_DB` 覆盖）
- opencode stderr 日志：`~/.local/share/opencode/log/`

dev 已集成的 P3-2 提供“设置 → 指挥官模型”，连接参数和 key 可在 App 内分开保存到本机 SQLite，数据库不上传 GitHub。密钥保存后无需终端环境变量，重启 App 仍可直接使用；环境变量保留为备用来源。点击“验证模型并生成示例计划”可直接验证，计划不会自动执行。CLI 默认同样读取本机配置与密钥；显式 --config 只读取指定配置及其环境变量。配置后可运行：

```bash
cargo run -p supercode-cli -- plan generate '为待办应用提出开发计划，不执行任务'
# 或显式使用本机配置文件（不要提交真实连接信息）：
cargo run -p supercode-cli -- plan generate '设计任务计划' --config /tmp/commander.json
```

`docs/examples/commander-config.json` 只包含占位值。P3-1～P3-6 已验收并合入 dev，真实 MiMo App/CLI 计划生成通过；尚未包含在 v0.3.0 安装包。计划持久化、状态机与核心 ACP 批次调度已实现并完成真实双 agent 验收。CLI 预览、显式确认执行及结果报告已实现；桌面「指挥官」入口已在 macOS 验收：填写目标、已存在的绝对工作目录和参与规划的 Agent → 生成草稿 → 展开审阅完整提示词/依赖 →「审阅并执行」→ 确认后查看进度、审批和结果。可取消本应用的操作；重启恢复历史，不自动重跑。Windows 实机专项留待 P3-8/9。

指挥官 CLI 闭环（dev）：

```bash
# 使用已保存的模型和密钥，仅生成并保存 draft；目录须已存在且为绝对路径
supercode plan run '任务目标' --cwd /absolute/project --agents opencode,codex
# 先审阅返回的 plan/prompts，再复制 summary.run_id 确认执行
supercode plan execute <run-id> --yes --jobs 2
supercode plan report <run-id>
```

`execute` 没有 `--yes` 不运行；未预授权操作默认拒绝，可用 `--allow`/`--deny` 指定规则。stdout 为 JSON，进度写 stderr；失败非零，Ctrl-C 等待取消后退出 130。报告包含各状态数量、会话引用和最后回复（最多 8 KiB），读取不重跑任务。

## 架构与文档

从 [文档导航](docs/README.md) 进入；当前进度看 roadmap，执行步骤看 development-process，历史过程不作为现行规则。

- [docs/architecture.md](docs/architecture.md) —— 设计单一事实源：分层架构、核心接口（AgentEvent / ApprovalBroker / envcheck / EventAggregator）、事件管道（Rust 合帧 → Tauri Channel）、IPC 契约、数据模型
- [docs/roadmap.md](docs/roadmap.md) —— 分期任务清单（当前进度、下一任务及验收入口）
- [docs/development-process.md](docs/development-process.md) —— 闭环开发流程：文档先行 → 实现 → 验证 → 归档；分支模型 `feat/fix → dev → tag → main`
- [docs/adr/](docs/adr/) —— 架构决策记录（ACP 选型 / Tauri+Rust / React+shadcn / opencode 先行 / 分支模型 / 权限模式 / 工作空间模型）
- [docs/acceptance/](docs/acceptance/) —— 分期与任务验收记录（各 Phase 与任务，顶部结论优先）

```
crates/core    # supercode-core：driver 适配层、审批、事件、进程、注册表、envcheck、SQLite
crates/cli     # supercode CLI（Phase 0 宿主）
apps/desktop   # Tauri v2 + React 19 桌面端（Phase 1 起）
tools/         # 辅助脚本（图标生成等）
```

## 开发

```bash
just verify    # 前端构建 + fmt --check + clippy(-D warnings) + cargo test —— DoD 硬标准
just fix       # 自动修复
just dev       # 桌面开发模式
just build     # 打包 .app/.dmg
just smoke     # 真实 opencode 冒烟（CLI，需本机认证）
```

从 `dev` 切短分支开发，验收后 `--no-ff` 合回；版本稳定打 tag 后合入 `main`（详见开发流程文档）。

## License

[MIT](LICENSE)
