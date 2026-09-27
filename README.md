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

## 当前状态：v0.2.0（Phase 1 · 桌面 MVP）

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

🚧 规划中：Phase 2 多 agent（claude-code/codex/MiMo 官方 ACP adapter、StreamJsonDriver 接 zcode、worktree 隔离、dnd-kit 看板）→ Phase 3 AI 指挥官 + Windows。完整路线见 [docs/roadmap.md](docs/roadmap.md)。

## 环境要求

- macOS（Phase 3 起支持 Windows）
- Rust ≥ 1.88（edition 2024）、Node + pnpm
- [opencode](https://opencode.ai) ≥ 1.18 已安装并完成认证（当前唯一内置 agent）
  - 注意：需在 `~/.config/opencode/opencode.jsonc` 显式固定默认模型（ACP 会话不继承登录态默认模型，会回退到 zen 免费模型并限流），例如：
    ```jsonc
    { "model": "zhipuai-coding-plan/glm-5.3-flash" }
    ```
  - Homebrew / 官方脚本安装均可——打包 .app 已内置常见安装目录的 PATH 修正（launchd 环境不继承 shell PATH）
- [just](https://github.com/casey/just)（一键命令，可选）

## 快速开始

```bash
git clone <repo> && cd SuperCode
just verify          # fmt/clippy/50 测试全绿
just dev             # 桌面端开发模式（Tauri dev）
just build           # 打包 .app 与 .dmg（target/release/bundle/）
```

桌面端速览：

- **新建空间**：侧栏 ➕文件夹 → 输入项目根目录（如 `/Users/you/Code/myapp`），同项目会话自动归组；不绑项目的会话放「默认空间」
- **跑任务**：空间内新建会话（cwd 自动预填）→ 输入提示词 ⌘R 运行；确认模式下每个 bash/edit 都会弹内联审批卡
- **权限模式**：表单右侧选择器（计划=只读全拒 / 确认=逐次询问 / 自动编辑=edit 类放行 / 完全访问=全放行），运行中可热切换
- **续聊**：跑过的会话直接输入新提示词再运行（自动 session/load 恢复上下文）；重启后历史仍在
- **严格模式**（推荐）：会话运行框检测到"宽松"时，展开「收紧引导」复制 `opencode.jsonc` 片段写入项目目录——之后 bash/edit 全部进 SuperCode 审批（否则 opencode 自带白名单会静默放行部分操作，见 ADR-0006 管辖边界）

CLI 原型（Phase 0 宿主）仍可用：`./target/debug/supercode run|resume|sessions|detect`。

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

## 架构与文档

- [docs/architecture.md](docs/architecture.md) —— 设计单一事实源：分层架构、核心接口（AgentEvent / ApprovalBroker / envcheck / EventAggregator）、事件管道（Rust 合帧 → Tauri Channel）、IPC 契约、数据模型
- [docs/roadmap.md](docs/roadmap.md) —— 分期任务清单（每任务带验收要点与偏差记录）
- [docs/development-process.md](docs/development-process.md) —— 闭环开发流程：文档先行 → 实现 → 验证 → 归档；分支模型 `feat/fix → dev → tag → main`
- [docs/adr/](docs/adr/) —— 架构决策记录（ACP 选型 / Tauri+Rust / React+shadcn / opencode 先行 / 分支模型 / 权限模式 / 工作空间模型）
- [docs/acceptance/](docs/acceptance/) —— 分期验收记录（phase0 / phase1）

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
