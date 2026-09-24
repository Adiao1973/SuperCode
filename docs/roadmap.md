# SuperCode Roadmap

> 每个任务：≤2 天工作量、独立可验证、**预写验收命令与预期输出**。
> 状态：`待办` | `进行中` | `已验收` | `有偏差`（偏差须写明原因与处理）。
> 细化原则：**只细化当前 Phase + 下一个 Phase**；更远的 Phase 保持概要，临近时再拆（避免计划腐化）。

## Step 0 — 文档先行（当前批次）

| ID | 任务 | 验收标准 | 状态 |
|---|---|---|---|
| S0-1 | 建立 dev / feat 分支结构 | `git branch` 可见 `main`、`dev`、`feat/step0-docs` | 已验收 |
| S0-2 | `docs/architecture.md` 基础设计框架文档 | 覆盖：分层架构、crate 结构、AgentDriver/AgentEvent/ApprovalBroker/Registry 接口、事件管道、SQLite 模型、进程/错误/安全约定、WebKit 规范 | 已验收 |
| S0-3 | `docs/roadmap.md`（本文档） | Phase 0/1 任务级拆解 + 验收命令；Phase 2/3 概要 | 已验收 |
| S0-4 | `docs/development-process.md` 闭环流程文档 | 覆盖：闭环五步、DoD、分支模型、提交/测试/发布规范 | 已验收 |
| S0-5 | `docs/adr/0001~0005` 架构决策记录 | 五条 ADR 各含：背景/决策/理由/被否方案/影响 | 已验收 |
| S0-6 | 验收归档 | 文档齐备且互相引用一致；`git log` 约定式提交；合回 dev（--no-ff） | 已验收 |

## Phase 0 — opencode 链路打穿（纯 Rust CLI 原型）

**目标**：`supercode run "任务"` 驱动本机 opencode 完成真实任务，验证 ACP 全链路。这是全项目最大风险点。

| ID | 任务 | 验收命令与预期 | 状态 |
|---|---|---|---|
| P0-1 | cargo workspace 脚手架 | `cargo build` 成功；workspace 含 `crates/core`、`crates/cli`；`apps/desktop/README.md` 占位 | 已验收 |
| P0-2 | 进程管理器 `proc`：command_group spawn + 进程组杀树 + stderr 落日志 | 单测：spawn `sleep 1000` 的子进程派生孙进程后 kill，断言孙进程一并退出（`pgrep` 无残留）；日志文件存在且非空 | 已验收 |
| P0-3 | 事件模型 `AgentEvent` + 合帧聚合器 | 单测：灌入 100 条同 id MessageChunk + 混合事件，断言合帧输出条数与顺序；`cargo test` 绿 | 待办 |
| P0-4 | AcpDriver：spawn `opencode acp`，完成 initialize / session/new / session/prompt，事件转 `AgentEvent` | `supercode detect` → 打印 `opencode <版本>`；`supercode run "用一句话介绍你自己" --cwd /tmp` → 终端流式打印 agent 消息，`TurnCompleted{EndTurn}` 收尾 | 待办 |
| P0-5 | ApprovalBroker + CLI 交互审批（y/n/a） | 配置 `bash(*)` 为 ask 后 `supercode run "运行 git status"` → 出现权限请求提示（完整命令可见），选 y 后工具执行、事件流继续；选 n 后 agent 收到拒绝 | 待办 |
| P0-6 | 预授权规则引擎（allow/deny/ask + pattern） | 规则 `allow: ["bash(git status)"]` 时同一任务**不再**弹审批；`deny` 规则直接拒绝且 approvals 留痕 | 待办 |
| P0-7 | 取消：`session/cancel` + 超时兜底杀进程组 | 长任务运行中按 Ctrl-C / `supercode cancel` → 收到 `TurnCompleted{Cancelled}`；agent 进程组无残留 | 待办 |
| P0-8 | 会话恢复：session/load + SQLite 存档 | `supercode sessions list` 列出历史；`supercode resume <id> "继续"` 基于原上下文回答（可被人工核验） | 待办 |
| P0-9 | justfile：`just verify` 一键 fmt+clippy+test | `just verify` 全绿，耗时 < 2min | 待办 |
| P0-10 | Phase 0 整体验收 + tag v0.1.0 合入 main | 验收剧本逐条执行留痕（见下）；`git tag v0.1.0`；dev 合回 main | 待办 |

**Phase 0 验收剧本**（P0-10 执行，输出存 `docs/acceptance/phase0.md`）：
1. `supercode detect` 正确报告本机 opencode 版本；
2. 真实任务：`supercode run "在当前目录创建 hello.txt 内容为 hi，然后读出来" --cwd /tmp/sc-test` —— 能看到 write/read 工具调用事件、权限请求被 y 应答、最终消息复述文件内容；
3. 权限拒绝路径：同任务选 n —— agent 得到拒绝并改述；
4. Ctrl-C 取消路径无残留进程（`pgrep -f "opencode acp"` 为空）；
5. `supercode sessions list` / `supercode resume` 恢复上下文成功。

## Phase 1 — Tauri 桌面 MVP（仍只支持 opencode）

**目标**：把 Phase 0 的核心装进桌面壳，形成可用产品骨架。临近开工时再细拆，方向性任务：

| ID | 任务 | 验收要点（细化时补命令） | 状态 |
|---|---|---|---|
| P1-1 | Tauri v2 + React 19 + Tailwind + shadcn/ui 脚手架 | `pnpm tauri dev` 起窗；窗口渲染基础布局 | 待办 |
| P1-2 | 事件管道接通：Rust 合帧 → Tauri Channel → 前端 | UI 中跑通 P0-4 同款任务，消息流式渲染无明显卡顿（活动 chunk 重渲染纪律） | 待办 |
| P1-3 | 多会话管理 UI（会话列表/新建/切换/取消） | 并行 2 个会话互不串台；取消生效 | 待办 |
| P1-4 | 会话视图：消息流（@virtuoso.dev/message-list）+ 工具调用时间线 + diff 展示（@git-diff-view/react） | 长会话（200+ 消息）滚动流畅；edit 类工具显示 diff | 待办 |
| P1-5 | 审批中心 UI：待决队列 + once/always/reject + 预授权规则管理 | 审批/预授权/拒绝三条路径与 Phase 0 行为一致 | 待办 |
| P1-6 | SQLite 持久化 + 会话恢复 UI | 重启 app 后会话历史仍在，可恢复上下文 | 待办 |
| P1-7 | opencode 安装探测与引导 | 未安装时给出安装指引（命令可复制） | 待办 |
| P1-8 | 简版任务看板（任务=标题+目录+绑定会话+状态） | 任务创建→指派会话→状态流转闭环 | 待办 |
| P1-9 | Phase 1 整体验收 + tag v0.2.0 合入 main | 验收剧本（细化时预写）+ 打包出 .app 可运行 | 待办 |

## Phase 2 — 多 Agent 扩展（概要）

- agent 注册表机制 + 设置 UI（新增 agent = 加配置）；接入 claude-code / codex 官方 ACP adapter（`npx -y @agentclientprotocol/*`）、`mimo acp`；Node 依赖探测引导。
- StreamJsonDriver：接入 zcode（**受限支持**：`--mode yolo` 预授权，UI 明确标注"该 agent 无法外部审批"）。
- git worktree 任务隔离：每任务独立 worktree + 分支、`.worktreeinclude` 复制、孤儿清扫。
- 完整看板（dnd-kit 拖拽）+ xterm 终端嵌入（≥5.3.0）。
- 里程碑：v0.3.0。

## Phase 3 — AI 指挥官与 Windows（概要）

- 总控 LLM：任务拆解 → 按 agent 强项派单 → 结果汇总（复用 AcpDriver，指挥官自身走直连 LLM API）。
- NativeDriver：codex app-server（拿 ACP 外的原生能力，如运行时审批策略切换）。
- Windows 构建与适配（taskkill /T、WebView2 CSS 双测、安装包）。
- 里程碑：v1.0.0。

## 里程碑总览

| 里程碑 | 内容 | 出口条件 |
|---|---|---|
| v0.1.0 | Phase 0：opencode 链路 CLI 原型 | Phase 0 验收剧本全过 |
| v0.2.0 | Phase 1：桌面 MVP | 可打包运行的 .app，验收剧本全过 |
| v0.3.0 | Phase 2：多 agent + worktree | 三家以上 agent 并行可用 |
| v1.0.0 | Phase 3：AI 指挥官 + Windows | 双平台安装包 + 指挥官闭环 |
