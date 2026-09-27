# SuperCode Roadmap

> 每个任务：≤2 天工作量、独立可验证、**预写验收命令与预期输出**。
> 状态：`待办` | `进行中` | `已验收` | `有偏差`（偏差须写明原因与处理）。
> 细化原则：**只细化当前 Phase + 下一个 Phase**；更远的 Phase 保持概要，临近时再拆（避免计划腐化）。
> 记录规范：任务表只保留简洁行；验收记录、偏差记录、修复记录统一放各 Phase 末尾的
> 「验收与偏差记录」小节（按任务 ID 分条），**不插入表格行间**（避免断表）。

## Step 0 — 文档先行（已完成）

| ID | 任务 | 验收标准 | 状态 |
|---|---|---|---|
| S0-1 | 建立 dev / feat 分支结构 | `git branch` 可见 `main`、`dev`、`feat/step0-docs` | 已验收 |
| S0-2 | `docs/architecture.md` 基础设计框架文档 | 覆盖：分层架构、crate 结构、AgentDriver/AgentEvent/ApprovalBroker/Registry 接口、事件管道、SQLite 模型、进程/错误/安全约定、WebKit 规范 | 已验收 |
| S0-3 | `docs/roadmap.md`（本文档） | Phase 0/1 任务级拆解 + 验收命令；Phase 2/3 概要 | 已验收 |
| S0-4 | `docs/development-process.md` 闭环流程文档 | 覆盖：闭环五步、DoD、分支模型、提交/测试/发布规范 | 已验收 |
| S0-5 | `docs/adr/0001~0005` 架构决策记录 | 五条 ADR 各含：背景/决策/理由/被否方案/影响 | 已验收 |
| S0-6 | 验收归档 | 文档齐备且互相引用一致；`git log` 约定式提交；合回 dev（--no-ff） | 已验收 |

## Phase 0 — opencode 链路打穿（纯 Rust CLI 原型，已完成）

**目标**：`supercode run "任务"` 驱动本机 opencode 完成真实任务，验证 ACP 全链路。这是全项目最大风险点。

| ID | 任务 | 验收命令与预期 | 状态 |
|---|---|---|---|
| P0-1 | cargo workspace 脚手架 | `cargo build` 成功；workspace 含 `crates/core`、`crates/cli`；`apps/desktop/README.md` 占位 | 已验收 |
| P0-2 | 进程管理器 `proc`：command_group spawn + 进程组杀树 + stderr 落日志 | 单测：spawn `sleep 1000` 的子进程派生孙进程后 kill，断言孙进程一并退出（`pgrep` 无残留）；日志文件存在且非空 | 已验收 |
| P0-3 | 事件模型 `AgentEvent` + 合帧聚合器 | 单测：灌入 100 条同 id MessageChunk + 混合事件，断言合帧输出条数与顺序；`cargo test` 绿 | 已验收 |
| P0-4 | AcpDriver：spawn `opencode acp`，完成 initialize / session/new / session/prompt，事件转 `AgentEvent` | `supercode detect` → 打印 `opencode <版本>`；`supercode run "用一句话介绍你自己" --cwd /tmp` → 终端流式打印 agent 消息，`TurnCompleted{EndTurn}` 收尾 | 已验收 |
| P0-5 | ApprovalBroker + CLI 交互审批（y/n/a） | 配置 `bash(*)` 为 ask 后 `supercode run "运行 git status"` → 出现权限请求提示（完整命令可见），选 y 后工具执行、事件流继续；选 n 后 agent 收到拒绝 | 已验收 |
| P0-6 | 预授权规则引擎（allow/deny + pattern） | 规则 `allow: ["bash(git status)"]` 时同一任务**不再**弹审批；`deny` 规则直接拒绝且 approvals 留痕 | 已验收 |
| P0-7 | 取消：`session/cancel` + 超时兜底杀进程组 | 长任务运行中按 Ctrl-C → 收到 `TurnCompleted{Cancelled}`；agent 进程组无残留 | 已验收 |
| P0-8 | 会话恢复：session/load + SQLite 存档 | `supercode sessions list` 列出历史；`supercode resume <id> "继续"` 基于原上下文回答（可被人工核验） | 已验收 |
| P0-9 | justfile：`just verify` 一键 fmt+clippy+test | `just verify` 全绿，耗时 < 2min | 已验收 |
| P0-10 | Phase 0 整体验收 + tag v0.1.0 合入 main | 验收剧本逐条执行留痕（见下）；`git tag v0.1.0`；dev 合回 main | 已验收 |

**Phase 0 验收剧本**（P0-10 执行，输出存 `docs/acceptance/phase0.md`）：
1. `supercode detect` 正确报告本机 opencode 版本；
2. 真实任务：`supercode run "在当前目录创建 hello.txt 内容为 hi，然后读出来" --cwd /tmp/sc-test` —— 能看到 write/read 工具调用事件、权限请求被 y 应答、最终消息复述文件内容；
3. 权限拒绝路径：同任务选 n —— agent 得到拒绝并改述；
4. Ctrl-C 取消路径无残留进程（`pgrep -f "opencode acp"` 为空）；
5. `supercode sessions list` / `supercode resume` 恢复上下文成功。

### Phase 0 验收与偏差记录

- **P0-4 偏差**：`opencode acp` 不继承 auth 默认模型，回退 zen 免费模型 `big-pickle`（限流严格，provider 429）。处理：`~/.config/opencode/opencode.jsonc` 显式固定 `"model": "zhipuai-coding-plan/glm-5.3-flash"`。环境配置问题非代码缺陷；"默认模型检查"已记入 P1-7。
- **P0-6 留痕说明**：裁决留痕以 `DecisionRecord` 广播流落地；SQLite approvals 表持久化按计划在 P0-8 落地。
- **P0-7 范围说明**：Ctrl-C 路径已验收；`supercode cancel` 跨进程子命令需会话注册表，随桌面端多会话管理落地（CLI 子命令不再单列）。
- **P0-8 修复**：driver 补发 `TurnCompleted` 事件（原只作为 run() 返回值，接入持久层后导致消息与状态不落库）；修正默认库路径为 `<data>/SuperCode/supercode.db`。

## Phase 1 — Tauri 桌面 MVP（仍只支持 opencode）

**目标**：把 Phase 0 的核心装进桌面壳，形成可用产品骨架。全部任务已细化。

| ID | 任务 | 验收要点 | 状态 |
|---|---|---|---|
| P1-1 | Tauri v2 + React 19 + Tailwind + shadcn/ui 脚手架 | `pnpm tauri dev` 起窗；窗口渲染基础布局 | ✅ 已验收 2026-09-25 |
| P1-2 | 事件管道接通：Rust 合帧 → Tauri Channel → 前端 | UI 跑通 P0-4 同款任务，流式渲染无明显卡顿（活动 chunk 重渲染纪律） | ✅ 已验收 2026-09-25 |
| P1-3 | 多会话管理 UI（列表/新建/切换/取消） | 并行 2 会话互不串台；取消生效 | ✅ 已验收 2026-09-25 |
| P1-4 | 会话视图：虚拟列表消息流 + 工具时间线 + diff 展示 | 长会话（200+ 消息）滚动流畅；edit 类工具显示 diff | ✅ 已验收 2026-09-25（依赖替换见记录） |
| P1-5 | 审批中心：会话级权限模式（plan/ask/autoedit/full，ADR-0006）+ 待决队列 + 规则库管理（SQLite） | 四模式行为与管线位次逐一验收；审批/预授权/拒绝路径与 Phase 0 一致 | ✅ 已验收 2026-09-25 |
| P1-6 | SQLite 持久化 + 会话恢复 UI + 会话删除 | 重启后历史仍在；续聊上下文有效；删除级联且运行中保护 | ✅ 已验收 2026-09-27 |
| P1-7 | opencode 安装探测与引导 + 严格模式引导（检测/建议收紧 opencode `permission` 配置，补客户端管辖边界外的白名单缺口，ADR-0006；含默认模型检查） | 未安装时给出可复制安装指引；严格模式引导可见可复制 | 待办 |
| P1-8 | 简版任务看板（任务=标题+目录+绑定会话+状态） | 任务创建→指派会话→状态流转闭环 | 待办 |
| P1-9 | Phase 1 整体验收 + tag v0.2.0 合入 main | 验收剧本（P1-9 前预写进 docs/acceptance/phase1.md）+ 打包出 .app 可运行 | 待办 |

### Phase 1 验收与偏差记录

- **P1-2 验收**：`run_prompt`（Channel 批量推送 ≤16ms 帧）驱动真实 opencode 完成三剧本——A 真实任务流式渲染；B″ fail-closed 拒绝；C 协议级取消。用户实机截图留痕。新增 `ApprovalBroker::resolve_fail_closed`（2 单测）。
- **P1-2 偏差**：① **opencode 权限两层模型**——opencode 自带 permission 层（默认 bash/edit=allow 不发询问），客户端只裁决其主动询问的操作；项目级 `opencode.jsonc` 写 ask 可强制全转发（严格模式引导归 P1-7，详见 ADR-0006 实证记录）。② 规则输入框单行 Input 剥换行致规则全废 → 改 Textarea（教训：表单控件类型必须匹配数据形状）。
- **P1-3 验收**：sessions store 按客户端会话键路由事件批 + 列表（⌘N/⌘1-8）+ 详情（⌘R/⌘.）；双会话并行互不串台、取消生效。Rust 零改动。
- **P1-3 修复**：① 遗漏 `begin` 动作致 running 永不置位；② `begin` 未重置 acpSessionId 致 cancel 打到旧会话；③ ⌘R 无防重入。另：opencode 会话 id 前 8 位为时间桶前缀，短 id 展示改用尾部 6 位。
- **P1-4 验收**：react-virtuoso 虚拟列表 + DEV 压测按钮（320 条合成事件滚动流畅）+ diff 双路径（edit 结构化 diff / write 磁盘懒读）。core 修正：ACP `ToolCallContent::Diff` 此前被 driver 丢弃，现映射为结构化 `DiffPayload`（§4.1 契约更新 + 提取单测）。
- **P1-4 偏差**：① `@virtuoso.dev/message-list` 商业许可 → **react-virtuoso**（同作者 MIT）；② `@git-diff-view/react` 行号列缺陷 → **@pierre/diffs**（Apache-2.0，ZCode 同款）；③ write 新建文件内容不在事件流 → `read_text_file` 磁盘懒读；④ 方法论：事件留痕拿真实数据、数据缺失从源头取数。
- **P1-5 验收**：四模式管线逐一实测（确认弹卡应答/计划全拒/完全访问全放且 deny 仍最硬/自动编辑放行 edit 类）；规则库设置页增删 + SQLite 重启保留。修复：① opencode 权限请求不带 name（title 是路径/命令），PermissionRequest 增加 `kind` 字段修复 autoedit 分类；② 内联审批路由按 acpSessionId 匹配；③ 取消联动 reject_all_pending（权限挂起阻塞取消链）；④ 空闲会话切模式只存草稿不热切换。
- **P1-5 体验对齐**：待决卡片**内联**在会话事件流底部直接应答（ZCode 式），列表显示"N 待审批"徽标；审批中心保留为跨会话聚合视图。
- **P1-6 验收**：事件流接入 SessionRecorder 落库；重启后 hydrate 历史会话 + 懒加载落库消息；续聊 session/load 恢复上下文（暗号问答验证）；跑完一轮自动标记可续聊；会话删除（级联 + 二次确认 + 运行中保护，用户提议追加）。
- **P1-6 修复**：① resume 轮清空流（重放事件即历史渲染源，避免三源叠加重复）；② session_rx 关闭与 done_rx 就绪的 select 随机分支 → 确定性取 done 真实结果；③ 默认 cwd 不存在 → run_prompt 自动 create_dir_all；④ recorder 独立任务 + 文件库 WAL/4 连接（DB 写不再阻塞事件转发）；⑤ 运行晚失败静默死亡 → done watcher 转 DriverError + 45 秒慢响应提示。
- **P1-6 环境偏差（与 P0-4 同类）**：验收期间 GLM 编程计划触发 5 小时用量上限（opencode 无限重试、零事件），限额重置后恢复。

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

| 里程碑 | 内容 | 出口条件 | 状态 |
|---|---|---|---|
| v0.1.0 | Phase 0：opencode 链路 CLI 原型 | Phase 0 验收剧本全过 | ✅ 2026-09-24 达成（docs/acceptance/phase0.md） |
| v0.2.0 | Phase 1：桌面 MVP | 可打包运行的 .app，验收剧本全过 | 进行中 |
| v0.3.0 | Phase 2：多 agent + worktree | 三家以上 agent 并行可用 | — |
| v1.0.0 | Phase 3：AI 指挥官 + Windows | 双平台安装包 + 指挥官闭环 | — |
