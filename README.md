# SuperCode

**多 Agent 桌面总控客户端** —— 不重新发明 coding agent，而是站在各家成熟 agent CLI 的肩膀上，做它们的"最高指挥中心"。

```
┌─────────────────────────────────────────────┐
│  SuperCode（总控）                            │
│  统一会话管理 · 审批中心 · 任务看板 · Diff 审查   │
├─────────────────────────────────────────────┤
│  Agent 适配层（ACP 优先，headless 兜底）         │
└──────────────┬──────────────────────────────┘
               ↓ stdio JSON-RPC（ACP v1）
   opencode ─ claude-code ─ codex ─ MiMo ─ …
```

- **协议优先**：以 [Agent Client Protocol](https://agentclientprotocol.com)（Zed 发起，v1 稳定）为通用接入底座——新增 agent ≈ 注册表加一条命令
- **审批是第一公民**：所有 agent 的权限请求汇入统一审批中心（预授权规则 + 人工裁决 + fail-closed）
- **Mac 优先**，后续兼容 Windows；桌面端 Tauri v2 + Rust 核心 + React 19

## 当前状态：v0.1.0（Phase 0 · CLI 原型）

✅ **ACP 全链路已在真实 opencode + GLM 上验收通过**（[验收记录](docs/acceptance/phase0.md)）：

| 能力 | 说明 |
|---|---|
| Agent 驱动 | `initialize → session/new \| session/load → session/prompt`，事件流（消息/思考/工具调用/用量）实时转换 |
| 审批中心 | 三条路径：预授权规则（`allow`/`deny`/`ask` + glob）/ 终端交互（y/a/n）/ fail-closed（链路异常一律不放行） |
| 取消 | 协议层 `session/cancel` 优先，10s 宽限后进程组兜底回收，无残留 |
| 持久化 | SQLite 六表（会话/消息/工具调用/审批留痕），`SUPERCODE_DB` 可覆盖路径 |
| 会话恢复 | `sessions list` + `resume <id>`：新进程经 session/load 重放历史、续接上下文 |

🚧 规划中：Phase 1 桌面 MVP（Tauri + React）→ Phase 2 多 agent（claude-code/codex/MiMo 官方 ACP adapter、worktree 隔离）→ Phase 3 AI 指挥官 + Windows。完整路线见 [docs/roadmap.md](docs/roadmap.md)。

## 环境要求

- macOS（Phase 3 起支持 Windows）
- Rust ≥ 1.88（edition 2024）
- [opencode](https://opencode.ai) ≥ 1.18 已安装并完成认证（当前唯一内置 agent）
  - 注意：需在 `~/.config/opencode/opencode.jsonc` 显式固定默认模型（ACP 会话不继承登录态默认模型，会回退到 zen 免费模型并限流），例如：
    ```jsonc
    { "model": "zhipuai-coding-plan/glm-5.3-flash" }
    ```
- [just](https://github.com/casey/just)（一键命令，可选）

## 快速开始

```bash
git clone <repo> && cd SuperCode
just verify          # 或 cargo build；fmt/clippy/28 测试全绿

./target/debug/supercode detect
# OpenCode 1.18.30 ✓

# 跑一个真实任务（事件流式打印，权限请求终端 y/n 应答）
./target/debug/supercode run '在当前目录创建 hello.txt，内容为 hi，然后读出来' --cwd /tmp/demo

# 预授权：命中的请求不再打扰你
./target/debug/supercode run '运行 git status 告诉我仓库状态' --cwd /my/repo \
    --allow 'bash(git status)' --deny 'bash(git push *)'

# 会话历史与恢复
./target/debug/supercode sessions list
./target/debug/supercode resume <session-id> '刚才说的暗号是什么？'

# Ctrl-C 优雅取消当前任务（再按一次强制退出）
```

### 预授权规则语法

```
*                全匹配
bash             裸工具名（任意参数）
bash(git status) 精确命令
bash(git diff *) 通配（* 跨空格；尾通配宽容：也匹配无参的 git diff）
```

求值优先级 `deny > allow > ask`；匹配目标推断：`raw_input.command` → bash 命令，否则取请求标题首词。**面向 agent 的规则建议用通配**——agent 常自行拼接命令（如 `sleep 120 && echo ...`），精确规则容易漏配。

### 数据位置

- 会话库：`~/Library/Application Support/SuperCode/supercode.db`（`SUPERCODE_DB` 覆盖）
- opencode stderr 日志：`<库目录同级>/log/`（Phase 1 起纳入设置页）

## 架构与文档

- [docs/architecture.md](docs/architecture.md) —— 设计单一事实源：分层架构、核心接口（AgentEvent / ApprovalBroker / ProcessManager / EventAggregator）、事件管道（Rust 合帧 → Tauri Channel）、数据模型
- [docs/roadmap.md](docs/roadmap.md) —— 分期任务清单（每任务带验收命令）
- [docs/development-process.md](docs/development-process.md) —— 闭环开发流程：文档先行 → 实现 → 验证 → 归档；分支模型 `feat/fix → dev → tag → main`
- [docs/adr/](docs/adr/) —— 架构决策记录（ACP 选型 / Tauri+Rust / React+shadcn / opencode 先行 / 分支模型）

```
crates/core    # supercode-core：driver 适配层、审批、事件、进程、注册表、SQLite
crates/cli     # supercode CLI（Phase 0 宿主）
apps/desktop   # Tauri v2 + React 19（Phase 1）
```

## 开发

```bash
just verify    # fmt --check + clippy(-D warnings) + cargo test —— DoD 硬标准
just fix       # 自动修复
just smoke     # 真实 opencode 冒烟（需本机认证）
```

从 `dev` 切短分支开发，验收后 `--no-ff` 合回；版本稳定打 tag 后合入 `main`（详见开发流程文档）。

## License

[MIT](LICENSE)
