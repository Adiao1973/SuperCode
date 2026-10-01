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
| P1-7 | opencode 安装探测与引导 + 严格模式引导（检测/建议收紧 opencode `permission` 配置，补客户端管辖边界外的白名单缺口，ADR-0006；含默认模型检查） | 未安装时给出可复制安装指引；严格模式引导可见可复制 | ✅ 已验收 2026-09-27 |
| P1-8 | 工作空间模型（ADR-0007）：项目空间=项目根路径 + 默认空间（不绑项目，普通聊天/电脑操作类任务）；会话按空间分组（迁移 0003，历史按 distinct cwd 回填归类） | 重启后历史会话按项目自动归类；新会话选空间后 cwd 预填（默认空间 cwd 自由）；删除空间不删会话（移入默认空间） | ✅ 已验收 2026-09-27 |
| P1-9 | 简版任务看板（任务=标题+空间+绑定会话+状态，按空间组织） | 任务创建→指派会话→状态流转闭环 | ✅ 已验收 2026-09-27 |
| P1-10 | Phase 1 整体验收 + tag v0.2.0 合入 main | 验收剧本（P1-10 前预写进 docs/acceptance/phase1.md）+ 打包出 .app 可运行 | ✅ 已验收 2026-09-28 |

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
- **P1-10 验收**：剧本①-⑤全过（verify 50 测试全绿；.app/.dmg 打包产出；端到端真实任务与重启恢复用户实机确认；GUI PATH 与图标两项偏差见上下两条记录）。发布顺序按用户指定：文档（README v0.2.0 + 验收记录）→ dev 打 tag v0.2.0 → 合回 main。Phase 1 至此完结。
- **P1-10 图标（用户要求替换 Tauri 默认图标）**：「指挥官终端」——发光 `>_` 提示符（青→靛→紫渐变，总控/运行的符号）+ 深空靛紫渐变 squircle + 右上互联节点（多 agent 编排隐喻）。`tools/gen_icon.py` 脚本生成（numpy/PIL 2x 超采样，可复现可调参）→ `pnpm tauri icon` 产全尺寸（PNG/ICO/ICNS）。踩坑：PIL `Image.composite(stroke, out, mask)` 参数序——mask=255 区域取第一参数，误用把整层内容换成描边致 alpha 归零（全黑假象）；另 CDN 按路径缓存旧图造成两轮评审误报，换新文件名复核通过。
- **P1-10 偏差（打包验收发现）**：GUI 启动的 .app 不继承 shell PATH（launchctl getenv PATH 为空，仅 /usr/bin:/bin:/usr/sbin:/sbin）——/opt/homebrew/bin 下的 opencode 对打包应用不可见，探测与 driver spawn（PATH 查找）双失效；just dev 自终端启动继承 shell PATH 故此前未暴露。修复：envcheck 增 augment_gui_path()（常见安装目录 /opt/homebrew/bin、/usr/local/bin、/opt/local/bin、~/.opencode/bin、~/.local/bin 并入进程 PATH，幂等只增不改序；Rust 2024 set_var unsafe——约定宿主 run() 首行、线程 spawn 前调用），桌面宿主已接入 + merge 纯函数单测。与 P0-4/P1-6 环境偏差同类：环境层问题由产品侧兜底。
- **P1-9 验收**：看板按空间分节四列（backlog/in_progress/review/done）；任务创建→绑定会话（点击短 id 跳转回会话视图）→‹›按钮状态流转→删除闭环；绑定是引用不是从属——删除会话级联解绑（任务保留，事务内完成，单测锁定）；重启任务与状态保留（SQLite）。dnd-kit 拖拽按规划留待 Phase 2 完整看板。IPC：list/create/update/delete_task（update_task 空串 session_id=解绑约定，IPC 无法传 SQL NULL）。
- **P1-8 设计前置（2026-09-27）**：会话组织调研定案——ZCode（任务按 workspace 组织）/ Codex（resume 按当前目录列历史）/ Claude Code（历史按项目目录落盘）/ DeepSeek Harness 生态（工作区=一等实体）四家一致按项目分组，采纳工作空间模型（ADR-0007）；原 P1-8 看板顺延为 P1-9、整体验收顺延为 P1-10。
- **P1-8 验收**：迁移 0003 + distinct-cwd 回填（历史会话按项目自动归类、重启保留）；侧栏空间分节（项目空间 cwd 预填 + 同路径去重 + 默认空间恒最后）；删除项目空间会话迁入默认空间不级联删；落库归属随 run_prompt workspace_id 传递。剧本 A/B/C 实机通过；期间发现并修复两个续聊潜伏缺陷（见下条）。
- **P1-8 修复（验收中发现，与工作空间无关的历史潜伏缺陷）**：① tap 捕获 `(session_tx.take(), &event)` 先 take 后匹配——续聊时重放事件先于 session/load 响应到达，oneshot sender 被丢在重放事件上，RunInfo 永远等不到：轮末误报"agent 未返回会话信息"、超 30s 还会误触建立超时自动取消（"已取消"表象）。修复为仅匹配时 take。② recorder 把重放历史 chunk 累积进本轮 pending，TurnCompleted 时误写为新一轮 agent 消息（DB 实证：暗号会话每轮续聊都多出一条重放的"你好！我是 opencode"，P1-6 期间"重复内容"的 DB 侧根源）。修复：SessionStarted 之前的事件只渲染不落库 + 回归单测；存量 11 条污染行已清理。
- **P1-7 验收**：设置页「opencode 环境」面板（安装徽标+路径 / 默认模型检查 / 全局严格判定，三引导片段始终可见可复制）+ 运行框 cwd 联检（防抖 400ms：宽松→琥珀警告+可复制收紧片段+重新检测，收紧→绿色 ✓；未安装→红色安装指引）。剧本 A/B 实机通过；未安装路径由单测覆盖（不卸载本机 opencode）。
- **P1-7 实现**：core 新增 `envcheck` 模块（PATH 扫描 + `opencode --version` 5s 超时；全局 `~/.config/opencode` 尊重 XDG_CONFIG_HOME——macOS 上 opencode 也用 XDG 风格路径，不可用 dirs::config_dir()；JSONC 解析用 **json5**（新依赖：注释/尾逗号且字符串内 `//`——`$schema` URL——必须存活）；严格判定=有效 edit∧bash（项目覆盖全局）均 ∈ {ask, deny, custom}）。全程只读，不代改用户配置；"经 OPENCODE_CONFIG 注入托管配置"仍留待后续评估。IPC：`check_opencode_env`（§5.1）。
- **P1-7 偏差**：真机联测确认全局配置仅有 model、无 permission → 判定宽松（与 P1-5 实证一致：本机一直靠项目级 opencode.jsonc 收紧）。

## Phase 2 — 多 Agent 扩展

**目标**：把单 agent（opencode）扩展为注册表驱动的多 agent 总控——新增 agent ≈ 加一条配置；
接入 claude-code / codex / mimo；StreamJson 兜底 zcode；补 worktree 隔离与看板/终端体验。全部任务已细化。

| ID | 任务 | 验收命令与预期 | 状态 |
|---|---|---|---|
| P2-1 | Agent 注册表机制（core）：`AgentDefinition` 扩展 driver_kind/capabilities/spawn；内置条目含 opencode/claude-code/codex/mimo/zcode；用户自定义 `~/.supercode/agents.json` 合并；`probe_installed` 批量探测 | `cargo test` 注册表单测绿（内置查找/自定义合并覆盖同 id/探测解析）；`supercode detect` 列出全部注册 agent 及安装状态（未安装显示 —） | ✅ 已验收 2026-09-28 |
| P2-2 | 设置 UI：agent 管理页（列表 + 安装徽标/版本 + 自定义 agent CRUD + 安装引导可复制） | `pnpm tauri dev` 设置页可见全部注册 agent；未安装项给出可复制安装命令；新增自定义 agent 后出现在列表且重启保留 | ✅ 已验收 2026-09-28 |
| P2-3 | claude-code 接入：`npx -y @agentclientprotocol/claude-agent-acp` 走 AcpDriver；Node/npx 依赖探测引导 | 真实任务跑通（流式消息 + 工具时间线 + 审批应答）；npx/Node 未装时给出可复制安装指引；续聊 session/load 生效；自动/手动步骤见 `docs/acceptance/p2-3.md` | ✅ 已验收 2026-09-28 |
| P2-4 | codex 接入：`npx -y @agentclientprotocol/codex-acp` 走 AcpDriver | 同 P2-3 剧本在 codex 上通过（两 agent 并行会话互不串台）；具体命令与预期见 `docs/acceptance/p2-4.md` | ✅ 已验收 2026-09-28 |
| P2-5 | mimo 接入：`mimo acp` 走 AcpDriver | 同 P2-3 剧本在 mimo 上通过；具体命令与预期见 `docs/acceptance/p2-5.md` | ✅ 已验收 2026-09-30 |
| P2-6 | StreamJsonDriver + zcode 受限支持：headless `--mode yolo` 预授权流解析；UI 标注"该 agent 无法外部审批" | zcode 任务跑通消息/工具事件；UI 可见受限标注；权限模式选择器对 zcode 置灰 | 延期验收（Start Plan CLI 不兼容；用户授权排除本版） |
| P2-7 | git worktree 任务隔离：每任务独立 worktree + 分支、`.worktreeinclude` 复制、孤儿清扫（worktree 会话归属原项目空间，ADR-0007） | 从项目空间任务一键建 worktree 会话；改动不影响主工作区；孤儿 worktree 可清扫；会话仍归原项目空间；完整步骤与结果见 `docs/acceptance/p2-7.md` | ✅ 已验收 2026-10-01 |
| P2-8 | 完整看板：dnd-kit 拖拽跨列/跨空间移动任务 | 拖拽改变状态即时落库；重启保留；拖拽不破坏绑定会话引用；完整剧本见 `docs/acceptance/p2-8.md` | ✅ 已验收 2026-10-01 |
| P2-9 | xterm 终端嵌入（≥5.3.0，禁透明 canvas）：会话内嵌终端（cwd=会话 cwd） | 会话视图可开终端；输入输出正常；WebKit 无绿伪影；关终端不残留进程；详见 `docs/acceptance/p2-9.md` | ✅ 已验收 2026-10-01 |
| P2-10 | Phase 2 整体验收 + tag v0.3.0 合入 main | 验收剧本（P2-10 前预写进 docs/acceptance/phase2.md）逐条留痕；`just verify` 全绿；`git tag v0.3.0` | ✅ 已验收 2026-10-01（按用户授权排除 P2-6 发布） |

**Phase 2 验收剧本**（P2-10 执行，输出存 `docs/acceptance/phase2.md`）：
1. 注册表：设置页五 agent（opencode/claude-code/codex/mimo/zcode）安装状态正确；自定义 agent 增删生效；
2. 三家具 ACP agent（至少 claude-code + 另一家）各自完成真实任务（写文件/读回），审批路径与 Phase 1 一致；
3. 双 agent 并行会话互不串台；各自续聊上下文有效；
4. zcode 受限标注可见，事件流正常；
5. worktree 隔离剧本（建/改/清扫）；
6. 看板拖拽与 xterm 终端人工核对；
7. 重启后历史会话按空间归类、agent 归属正确。

### Phase 2 验收与偏差记录

- **P2-5 验收**：MiMo Code 0.1.15 的 ACP 服务要求从会话 cwd 启动；内置 MiMo 支持官方安装器路径回退。真实模型在 CLI/桌面完成文件写读、流式工具事件、目录外审批、跨进程及桌面重启续聊；与 OpenCode 并行会话归属独立。桌面审批裁决现写入 SQLite；ACP 空 EndTurn 识别为失败。`just verify` 全绿，完整命令与输出见 `docs/acceptance/p2-5.md`。

- **P2-3 验收**：桌面/CLI 注册表驱动 agent 选择、真实归属落库与历史恢复；续聊校验 agent/cwd/能力，服务端 load 能力协商；Node/npx 探测与安装/登录/API Key 引导。`just verify` 68 测试全绿（1 既有 ignored），真实 Claude adapter 0.81.2 流式回复、Write 审批允许、Read、跨进程暗号续聊均通过。macOS WebKit 完成选择/依赖引导/内联审批/续聊/重启归属核对；完整输出与范围说明见 `docs/acceptance/p2-3.md`。无新增包依赖；CLI 新增 `run --agent` 支持验收，`resume` 使用存档 agent。Codex/MiMo 专项验收仍按后续任务推进。

- **P2-1 验收**：`just verify` 全绿（58 测试，registry 新增 7 项：五内置齐全/capabilities 标志/未知 id 报错/用户覆盖内置同 id/缺省 version_args 与 capabilities/坏文件静默忽略/探测缺失命令与首行解析）。`supercode detect` 实机输出：
  ```
  OpenCode 1.18.30 ✓
  Claude Code —（npx -y @agentclientprotocol/claude-agent-acp）
  Codex —（npx -y @agentclientprotocol/codex-acp）
  MiMo —（mimo acp）
  ZCode —（zcode -p --output-format stream-json --mode yolo）
  ```
- **P2-1 实现**：`AgentDefinition` serde 双向（内置常量 + `~/.supercode/agents.json`），`version_args`/`capabilities` 缺省友好；`AgentRegistry::load()` 合并用户条目（同 id 覆盖内置，坏文件静默不拖垮宿主）；`detect_version` 加 8s 超时（npx 冷启动可慢但不能卡死）。CLI `detect` 改走 `probe_installed` 全量列出；桌面端 `AgentDefinition::find` 便捷入口委托 `load()` 自动生效。
- **P2-2 验收**：设置页「Agent 管理」区块实机核对（用户截图）——五条注册 agent 列出；OpenCode ✓1.18.30 / Claude Code ✓0.81.2 / Codex ✓adapter 1.13.1；MiMo/ZCode 未安装项展示琥珀徽标 + 可复制安装指引；自定义 CRUD 写 `~/.supercode/agents.json` 重启保留。`just verify` 全绿（core 61 + desktop 2 = 63 测试）。
- **P2-2 审查修复（独立审查发现 critical）**：`AgentInput` 嵌套入参 casing 不匹配——Tauri 仅映射顶层命令形参，嵌套 struct 走 serde 原样匹配，前端 camelCase vs Rust snake_case 导致 add/update_agent 反序列化必失败。修复：`#[serde(rename_all = "camelCase")]` + 2 条 serde JSON 回归测锁定字段名；前端 id 校验收紧 `^[a-z0-9-]+$` 与后端一致。复审 PASS。**教训**：项目首个嵌套命令入参即踩坑——嵌套 IPC 入参必须显式 rename_all 并配 serde 级单测（`just verify` 不覆盖 IPC 反序列化层）。
- **P2-2 偏差（zcode 误报未安装，用户实机发现）**：本机装的是 **ZCode.app 桌面版**，CLI 嵌在 `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`（Node 脚本，0.16.9），**不注册 PATH 命令**——`zcode --version` 失败故判未安装（探测逻辑正确，安装形态特殊）。处理：安装引导改为可复制软链命令（`ln -sf …/zcode.cjs ~/.local/bin/zcode`）；实机验证软链后 `detect` → `ZCode 0.16.9 ✓`。与 P1-10 GUI PATH 问题同类：环境形态差异由产品引导兜底。
- **P2-6 实测更正（2026-09-30 历史）**：0.16.9 help 遗漏 output-format，参数校验实际支持 stream-json；help 不能作为唯一判断依据。实现保留在 P2-6 分支，用户无有效 key，授权延期真实验收。

## Phase 3 — AI 指挥官与 Windows（概要）

- 总控 LLM：任务拆解 → 按 agent 强项派单 → 结果汇总（复用 AcpDriver，指挥官自身走直连 LLM API）。
- NativeDriver：codex app-server（拿 ACP 外的原生能力，如运行时审批策略切换）。
- Windows 构建与适配（taskkill /T、WebView2 CSS 双测、安装包）。
- 里程碑：v1.0.0。

## 里程碑总览

| 里程碑 | 内容 | 出口条件 | 状态 |
|---|---|---|---|
| v0.1.0 | Phase 0：opencode 链路 CLI 原型 | Phase 0 验收剧本全过 | ✅ 2026-09-24 达成（docs/acceptance/phase0.md） |
| v0.2.0 | Phase 1：桌面 MVP | 可打包运行的 .app，验收剧本全过 | ✅ 已发布 2026-09-28 |
| v0.3.0 | Phase 2：多 agent + worktree | 三家以上 agent 并行可用；ZCode 延期 | ✅ 已发布 2026-10-01 |
| v1.0.0 | Phase 3：AI 指挥官 + Windows | 双平台安装包 + 指挥官闭环 | — |

- **P2-6 延期授权（2026-09-30）**：用户无有效 key，允许跳过；实现和自动验收记录见 `docs/acceptance/p2-6.md`，保留独立分支待补验，继续 P2-7。

- **P2-7 验收（2026-10-01）**：任务托管 worktree/分支与原项目空间绑定、include 文件清单复制、孤儿保守清扫已完成。macOS 真实 OpenCode 写读完成，主目录不变，任务自动绑定会话并进入进行中；干净孤儿可清扫、脏目录及历史引用保留，重启历史归属正确。`just verify` 全绿（核心 69/协议 4/桌面 2，1 既有 ignored），无新增依赖或 schema 变更，详见 `docs/acceptance/p2-7.md`。

- **P2-8 验收（2026-10-01）**：看板鼠标/键盘跨列跨空间拖拽、原子保存与失败回滚、重启恢复通过；绑定会话及 worktree 原执行归属保持，移动后真实 OpenCode 运行成功。`just verify` 全绿（core 70/协议 4/desktop 3，1 既有 ignored）。新增 dnd-kit core 6.3.1，无 schema 变更；完整留痕见 `docs/acceptance/p2-8.md`。下一步 P2-9，P2-6 继续延期补验。

- **P2-9 验收（2026-10-01）**：会话内嵌 xterm 6.0 + portable-pty，实际 cwd/worktree、中文/ANSI、Ctrl-C、resize、自然退出、关闭/切换/应用退出进程回收、重启历史均通过 macOS WebKit 核对。`just verify` 全绿（core 70/协议 4/desktop 6，1 既有 ignored），修复 PTY 句柄释放顺序与 xterm 旧版销毁回调异常，无 schema 变更。详见 `docs/acceptance/p2-9.md`。下一步 P2-10 整体验收，P2-6 仍待有效 key 补验，Phase 2 发布出口尚未达成。

- **P2-10 预验收（2026-10-01，未发布）**：独立任务分支完成全部自动检查、三家 ACP 并行真实写读/续聊、OpenCode 模型冒烟与 macOS release 打包/组合核对；修复 CLI 协议失败历史仍 active 和 release 硬编码版本标识。结果见 `docs/acceptance/phase2.md`。P2-6 仍未通过真实补验，故保留 P2-10 分支，不标完整验收、不合 dev/main、不创建 v0.3.0 tag。

- **v0.3.0 范围调整（2026-10-01）**：用户明确授权跳过 P2-6 并提前发布。ZCode Start Plan 桌面可用但 standalone CLI 未接入该账号路径，默认模型临时试验无效；P2-6 不伪记通过、不合入本版。P2-10 以 P2-1～5、P2-7～9 及整体回归作为本版出口，版本统一 0.3.0，annotated tag 后 dev 合入 main。此前预验收的禁止发布结论被本次范围授权取代。

- **v0.3.0 发布落地**：tag 指向 `6d43e7b`，main 合并为 `045de1f`；本地安装包与校验和已归档，远程推送和 GitHub Release 已完成（双架构 DMG + SHA256SUMS.txt）。下一阶段为 Phase 3 细化，P2-6 独立延期补验。
