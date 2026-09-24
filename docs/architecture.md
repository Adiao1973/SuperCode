# SuperCode 架构设计文档

> 本文档是 SuperCode 接口设计的**单一事实源**：任何接口 / 数据模型变更，先改本文档再改代码。
> 版本：0.1（Step 0 产出）· 变更记录见文末。

## 1. 项目概述

SuperCode 是一个**多 Agent 桌面总控客户端**（Mac 优先，后续兼容 Windows）。它不重新实现 coding agent，而是站在各家成熟 agent CLI 的肩膀上：

- 通过 **ACP（Agent Client Protocol）** 等协议驱动本机已安装的 agent CLI（opencode → claude-code / codex / MiMo-Code → ZCode）；
- 提供统一的多会话管理、**权限审批中心**、任务看板与 diff 审查——所有 agent 的权限请求汇到一处裁决，SuperCode 是"最高指挥中心"。

**首发目标（Phase 0）**：用纯 Rust CLI 原型打穿 `opencode acp` 一条链路（消息流 / 工具调用 / 权限应答 / 取消 / 会话恢复）。

## 2. 总体架构

```
┌──────────────────────────────────────────────────────────┐
│  渲染层  apps/desktop（Tauri v2 + React 19 + shadcn/ui）      │
│  会话面板 │ 审批中心 │ 任务看板 │ Diff 审查 │ agent 管理         │
├──────────────────────────────────────────────────────────┤
│  Rust 核心（workspace crates，与 UI 完全解耦，可独立成 CLI）     │
│                                                           │
│  supercode-core                                           │
│  ├─ orchestrator   编排核心：会话生命周期、任务调度            │
│  ├─ approval       ApprovalBroker：统一审批队列 + 规则引擎     │
│  ├─ driver         Agent 适配层：AgentDriver trait + 实现     │
│  │   ├─ AcpDriver        （ACP 通用：opencode 原生，后续      │
│  │   │                    claude/codex 经官方 adapter）       │
│  │   ├─ StreamJsonDriver （headless 兜底：zcode 等，Phase 2） │
│  │   └─ NativeDriver     （codex app-server 等，Phase 3）    │
│  ├─ proc           进程管理器：spawn/进程组杀树/心跳/退出清理   │
│  ├─ events         事件模型 + 帧级合帧聚合器                   │
│  ├─ registry       AgentRegistry：agent 定义与探测            │
│  └─ db             sqlx + SQLite 持久化                     │
├──────────────────────────────────────────────────────────┤
│  supercode-cli（Phase 0 原型）   apps/desktop 的 Tauri 壳（Phase 1）│
└──────────────────────────────────────────────────────────┘
        ↓ spawn 子进程 · stdio JSON-RPC（ACP）
   opencode acp   （后续：npx @agentclientprotocol/claude-agent-acp
                   npx @agentclientprotocol/codex-acp · mimo acp）
```

**依赖方向（只允许自上而下）**：

```
apps/desktop ──► supercode-cli ──► supercode-core
                                   ├─► driver ──► (agent-client-protocol crate)
                                   ├─► approval / events / proc / registry / db
                                   └─ 各模块之间通过 trait + channel 解耦
```

- `supercode-core` 不依赖 Tauri / CLI 任何类型——它是纯库，CLI 和桌面壳都是它的宿主。
- driver 层对外只暴露 `AgentDriver` trait 与 `AgentEvent`；orchestrator 不知道底层是 ACP 还是 stream-json。

## 3. Workspace 结构

```
SuperCode/
├── Cargo.toml              # [workspace]
├── crates/
│   ├── core/               # supercode-core：全部核心逻辑（纯库）
│   │   └── src/{lib.rs, error.rs, driver/, approval/, events/, proc/, registry/, db/, orchestrator.rs}
│   └── cli/                # supercode-cli：Phase 0 验证原型（bin）
│       └── src/main.rs
├── apps/
│   └── desktop/            # Phase 1：Tauri v2 + React 19（Step 0 仅占位 README）
├── docs/                   # 本文档、roadmap、流程、ADR
└── justfile                # just verify 等一键命令
```

## 4. 核心接口定义

> 以下 Rust 签名是**设计稿**：命名以文档为准，实现时可微调（如加 `Arc`/生命周期），但**语义不得偏离**。变更需走文档先行。

### 4.1 统一事件模型 `AgentEvent`

内部事件枚举**直接对齐 ACP v1 `session/update` 变体**，使 AcpDriver 近乎零转换，其他 driver 向它归一：

```rust
/// 一个 agent 会话产生的统一事件流。所有 driver 的输出都归一到该模型。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    /// 会话已创建（含 sessionId）
    SessionStarted { session_id: String },
    /// agent 消息增量块（同一 message_id 的 chunk 按序拼接）
    MessageChunk { message_id: String, text: String },
    /// 工具调用（首次出现，status=pending）
    ToolCall {
        tool_call_id: String,
        name: String,
        title: Option<String>,
        kind: ToolKind,          // Read | Edit | Execute | Other
        raw_input: serde_json::Value,
    },
    /// 工具调用状态更新（in_progress / completed / failed，可含 content/locations/diff）
    ToolCallUpdate {
        tool_call_id: String,
        status: ToolStatus,
        content: Vec<ContentBlock>,   // 对齐 ACP ContentBlock（text/image/resource）
        locations: Vec<FileLocation>, // 可选：涉及文件与行区间
        diff: Option<String>,         // 统一 diff 文本（若有）
    },
    /// agent 生成的计划（plan 模式）
    Plan { entries: Vec<PlanEntry> },
    /// token/费用用量更新
    UsageUpdate { used: Option<u64>, size: Option<u64>, cost: Option<f64> },
    /// 一轮对话结束
    TurnCompleted { stop_reason: StopReason },  // EndTurn | Cancelled | MaxTokens | MaxTurnRequests | Refusal
    /// driver 层错误（进程崩溃、协议异常等）
    DriverError { message: String },
}
```

### 4.2 `AgentDriver` trait

```rust
/// 一个 agent 接入实现的全部能力。
/// 实现方：AcpDriver（Phase 0）、StreamJsonDriver（Phase 2）、NativeDriver（Phase 3）。
#[async_trait]
pub trait AgentDriver: Send {
    /// 本 driver 绑定的 agent 定义（命令、名称、能力）
    fn definition(&self) -> &AgentDefinition;

    /// 探测本机是否安装该 agent，返回版本号（注册表/安装引导用）
    async fn detect(&self) -> Result<Option<String>>;

    /// 创建新会话
    async fn create_session(&mut self, cwd: PathBuf) -> Result<SessionHandle>;

    /// 恢复既有会话（映射 ACP session/load；headless 映射各家 --resume）
    async fn load_session(&mut self, session_ref: SessionRef) -> Result<SessionHandle>;

    /// 发送一轮 prompt，事件经 channel 流出，返回该轮的 stop_reason
    async fn prompt(
        &mut self,
        session: &SessionHandle,
        prompt: String,
        events: mpsc::Sender<AgentEvent>,
    ) -> Result<StopReason>;

    /// 取消当前进行中的一轮（语义：尽力中止，agent 应回 TurnCompleted{Cancelled})
    async fn cancel(&mut self, session: &SessionHandle) -> Result<()>;

    /// 注册权限回调：driver 收到 agent 权限请求时调用，阻塞等待裁决结果
    fn set_permission_handler(&mut self, handler: PermissionHandler);
}

/// 权限请求（来自任何 driver，汇入 ApprovalBroker）
pub struct PermissionRequest {
    pub session_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub raw_input: serde_json::Value,
    /// 请求方提供的可选项（对齐 ACP：allow_once/allow_always/reject_once/reject_always）
    pub options: Vec<PermissionOption>,
}

pub type PermissionHandler =
    Arc<dyn Fn(PermissionRequest) -> BoxFuture<'static, Result<PermissionDecision>> + Send + Sync>;

pub struct PermissionDecision {
    pub option_id: PermissionOptionId, // AllowOnce | AllowAlways | RejectOnce | RejectAlways
    pub updated_input: Option<serde_json::Value>,
}
```

### 4.3 `ApprovalBroker`（审批代理）

```rust
/// 所有 driver 的权限请求汇入统一队列；UI（或 CLI）应答后回写对应协议。
pub struct ApprovalBroker { /* 预授权规则 + 待决队列 */ }

impl ApprovalBroker {
    /// 规则引擎先行裁决：命中 allow/deny 规则直接返回，不打扰用户
    /// 未命中规则的请求进入待决队列，等待 UI/CLI 应答
    pub async fn resolve(&self, req: PermissionRequest) -> Result<PermissionDecision>;

    /// 待决队列订阅（UI 审批中心 / CLI 交互都从这里拿请求）
    pub fn subscribe(&self) -> mpsc::Receiver<PermissionRequest>;

    /// 用户应答（allow once/always、reject），驱动等待中的 resolve 返回
    pub async fn respond(&self, request_id: Uuid, decision: PermissionDecision) -> Result<()>;
}
```

**预授权规则**（参考 opencode permission 配置语义）：

```jsonc
// ~/Library/Application Support/<bundle-id>/rules.json（Phase 0 先支持内置默认 + CLI 参数）
{
  "allow": ["read", "edit", "bash(git status)", "bash(git diff *)"],
  "deny":  ["bash(rm -rf *)", "bash(sudo *)"],
  "ask":   ["*"]        // 其余一律询问（默认）
}
```

### 4.4 `AgentDefinition` 与 `AgentRegistry`

```rust
/// 一个 agent 的接入声明。Phase 2 起，新增 agent = 在注册表加一条配置，AcpDriver 零改动。
pub struct AgentDefinition {
    pub id: String,               // "opencode" | "claude-code" | "codex" | ...
    pub display_name: String,
    pub driver_kind: DriverKind,  // Acp | StreamJson | Native
    pub spawn: SpawnSpec,         // command + args + env（如 ["opencode","acp"]）
    pub capabilities: Capabilities, // supports_load_session / supports_diff / ...
}

pub struct AgentRegistry { /* 内置定义 + 用户自定义 (~/.supercode/agents.json) */ }
impl AgentRegistry {
    pub fn builtin() -> Self;                        // Phase 0：仅 opencode
    pub async fn probe_installed(&self) -> Vec<(AgentDefinition, Option<String>)>; // 探测安装与版本
}
```

内置注册表（随 Phase 演进）：

| id | spawn | driver | 接入阶段 |
|---|---|---|---|
| opencode | `opencode acp` | Acp | Phase 0 |
| claude-code | `npx -y @agentclientprotocol/claude-agent-acp` | Acp | Phase 2 |
| codex | `npx -y @agentclientprotocol/codex-acp` | Acp | Phase 2 |
| mimo | `mimo acp` | Acp | Phase 2 |
| zcode | `zcode -p --output-format stream-json --mode yolo` | StreamJson | Phase 2（**受限支持**：无外部权限审批） |

### 4.5 进程管理器 `ProcessManager`（`proc` 模块）

```rust
/// 进程管理器分配的句柄 id（区别于 OS pid，避免 pid 复用歧义）。
pub struct ProcessId(u64);

/// spawn 一个子进程所需的最小描述（AgentRegistry 的 SpawnSpec 转换为它）。
pub struct ProcessSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub envs: Vec<(String, String)>,
}

/// spawn 成功后交给调用方的句柄：stdin/stdout 由调用方持有（协议通道），
/// stderr 已由管理器接管写入日志文件。
pub struct SpawnedProcess {
    pub id: ProcessId,
    pub pid: u32,
    pub log_path: PathBuf,     // <log_dir>/proc-<id>.log
    pub stdin: ChildStdin,
    pub stdout: ChildStdout,
}

impl ProcessManager {
    pub fn new(log_dir: impl Into<PathBuf>) -> Self;
    /// 以独立进程组 spawn（command_group）；stderr 后台泵入日志文件
    pub async fn spawn(&self, spec: ProcessSpec) -> Result<SpawnedProcess>;
    /// 杀掉整个进程组（孙进程一并终止）；进程已退出视为成功
    pub async fn kill(&self, id: ProcessId) -> Result<()>;
    /// 等待退出并移除登记（返回 ExitStatus）
    pub async fn wait(&self, id: ProcessId) -> Result<ExitStatus>;
    /// 宿主退出清理：对所有存活进程组发终止，返回处理数量
    pub async fn shutdown_all(&self) -> Result<usize>;
}
```

约定：`kill_on_drop(true)` 作为兜底（child 被 drop 时至少杀 leader）；显式 `kill` 才保证杀整组。

## 5. 事件管道（性能架构约束，非优化项）

Tauri 的 `tauri://` 页面**不支持 SSE/EventSource**；且 agent 事件可达每秒几十条。因此：

```
driver ──AgentEvent──► events::Aggregator（Rust 侧）
                          │  帧级合帧：相邻 MessageChunk 合并、按 ~16ms/tick flush
                          ▼
                    ┌─ CLI 宿主：直接逐条打印（Phase 0）
                    └─ Tauri 宿主：Channel 批量推送 ──► 前端只重渲染"活动 chunk"
```

- **合帧规则**：同一 `message_id` 的连续 `MessageChunk` 可合并为一个累积文本；`ToolCall*`/`Plan`/`Usage` 等低频事件直通。
- 前端纪律：已完成的 message/chunk 必须 memo 化，只有活动中的 chunk 触发重渲染。
- 该层为**硬性架构约束**，任何"先直连后面再优化"的 shortcuts 都不允许。

## 6. 数据模型（SQLite，sqlx）

库文件：`~/Library/Application Support/<bundle-id>/supercode.db`（`dirs` crate 定位；开发期可用 `SUPERCODE_DB` 覆盖）。

```sql
agents(id TEXT PK, display_name TEXT, driver_kind TEXT, spawn_json TEXT,
       capabilities_json TEXT, installed_version TEXT NULL, updated_at TEXT);

sessions(id TEXT PK,            -- SuperCode 侧 UUID
         agent_id TEXT REFERENCES agents(id),
         agent_session_id TEXT, -- agent 侧会话标识（ACP sessionId 等），恢复用
         cwd TEXT, title TEXT, status TEXT,   -- active|completed|failed|cancelled
         created_at TEXT, updated_at TEXT);

messages(id TEXT PK, session_id TEXT REFERENCES sessions(id),
         role TEXT,              -- user | agent
         content_json TEXT,      -- ContentBlock[]
         created_at TEXT);

tool_calls(id TEXT PK, session_id TEXT, name TEXT, kind TEXT,
           status TEXT, input_json TEXT, output_json TEXT, started_at TEXT, ended_at TEXT);

approvals(id TEXT PK, session_id TEXT, tool_call_id TEXT, tool_name TEXT,
          request_json TEXT, decision TEXT, decided_by TEXT,  -- rule:<id> | user
          created_at TEXT, decided_at TEXT);

tasks(id TEXT PK, title TEXT, cwd TEXT, status TEXT, -- backlog|in_progress|review|done
      created_at TEXT, updated_at TEXT);             -- Phase 1 简版看板；session 关联经 sessions.task_id
```

迁移管理：`sqlx migrate`（`crates/core/migrations/`），迁移文件只增不改。

## 7. 进程生命周期管理

- **spawn**：`command_group::AsyncGroupChild`（进程组），避免 agent 派生孙进程后杀不干净；子进程 stdout/stderr 分流，stderr 全量落日志文件。
- **心跳**：driver 层监测 JSON-RPC 活性；进程意外退出 → 发 `AgentEvent::DriverError` 并标记会话 `failed`。
- **取消**：优先协议层取消（ACP `session/cancel`）；超时（默认 10s）未响应则进程组 SIGKILL。
- **app 退出清理**：宿主（CLI/Tauri）退出时对所有存活 agent 进程组发终止信号，登记到的 worktree/临时资源统一回收（Phase 2）。

## 8. 错误处理约定

- `supercode-core` 统一 `thiserror` 定义 `CoreError`：`Spawn / Protocol / Timeout / PermissionDenied / ProcessNotFound / Db / Io / AgentExited { code, stderr_tail }`（随模块落地逐步增补，`error.rs`）。
- 可恢复错误（单轮失败）不冒泡为进程错误：转为 `AgentEvent::DriverError` + 会话状态流转，宿主决定 UI 呈现。
- 任何跨模块边界返回 `Result<T, CoreError>`；panic 只允许表示程序自身 bug。

## 9. 安全模型

- 权限默认**最小放行**：未配置规则的工具调用一律 `ask`；审批是产品的第一公民功能。
- 预授权规则中的 `always` 生效时必须落库（approvals.decision_by = rule:<id>）留痕。
- API key 等敏感配置不进入 SuperCode：各 agent 自管自己的鉴权（`opencode auth login` 等），SuperCode 只管进程与协议。
- exec 类工具的命令内容在审批 UI 中**完整可见**（不截断命令、展示 cwd）。

## 10. 技术约束与开发规范（WebKit 相关）

1. xterm.js 锁 `>=5.3.0`（修复 Safari/WKWebView 输入问题）；避免透明 canvas（WebKit 绿色伪影）。
2. macOS 慎用 `backdrop-filter` + 窗口透明 / `position:fixed` 组合（WRY 已知 bug）；用 sticky 替代 fixed。
3. 事件流禁止使用 SSE/EventSource（`tauri://` 不支持），一律 Tauri Channel / WebSocket 插件。
4. 跨平台 CSS：每个涉及视觉的验收任务须在 macOS 实测，Phase 3 起增加 Windows 双测。

## 11. 变更记录

| 日期 | 版本 | 摘要 |
|---|---|---|
| 2026-09-24 | 0.1 | Step 0 初版：分层架构、AgentDriver/AgentEvent/ApprovalBroker/Registry 接口、事件管道、数据模型、进程与安全约定 |
