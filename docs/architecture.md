# SuperCode 架构设计文档

> 本文档是 SuperCode 接口设计的**单一事实源**：任何接口 / 数据模型变更，先改本文档再改代码。
> 版本：0.6（P1-4 会话视图落地）· 变更记录见文末。

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
│   └── desktop/            # Phase 1 起：Tauri 壳（src-tauri 为 workspace 成员；React 19 + Tailwind v4 + shadcn/ui）
├── docs/                   # 本文档、roadmap、流程、ADR
├── pnpm-workspace.yaml     # 前端 monorepo（apps/*）
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
    /// agent 消息增量块（同一 message_id 的 chunk 按序拼接；ACP 的 message_id
    /// 可选，缺失时由 driver 按轮合成 turn-N）
    MessageChunk { message_id: String, text: String },
    /// agent 思考过程增量块（ACP agent_thought_chunk）
    ThoughtChunk { message_id: String, text: String },
    /// 工具调用（首次出现，status=pending；ACP 的 name/raw_input 均可选）
    ToolCall {
        tool_call_id: String,
        name: Option<String>,
        title: Option<String>,
        kind: ToolKind,          // Read | Edit | Delete | Move | Search | Execute | Fetch | Other
        raw_input: Option<serde_json::Value>,
        diff: Option<DiffPayload>,   // ACP ToolCallContent::Diff 映射（opencode edit 类工具）
    },
    /// 工具调用状态更新（status 可选：update 可能只带 content/locations）
    ToolCallUpdate {
        tool_call_id: String,
        status: Option<ToolStatus>,  // Pending | InProgress | Completed | Failed
        content: Vec<ContentBlock>,
        locations: Vec<FileLocation>,
        diff: Option<DiffPayload>,   // 有值时覆盖同 id 工具此前的 diff
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

**支撑类型**（与 `AgentEvent` 同模块，语义对齐 ACP v1）：

```rust
pub enum ToolKind { Read, Edit, Delete, Move, Search, Execute, Fetch, Other } // 对齐 ACP v1
pub enum ToolStatus { Pending, InProgress, Completed, Failed }
pub enum ContentBlock { Text { text }, Image { data, mime_type }, ResourceLink { uri } } // tag="type"
/// 结构化文件修改（对齐 ACP ToolCallContent::Diff{path, oldText, newText}）：
/// driver 从工具事件的 content 块中提取；old_text=None 表示新建文件。
/// diff 算法与渲染是前端职责（@git-diff-view/react 接收原始新旧内容）。
pub struct DiffPayload { pub path: String, pub old_text: Option<String>, pub new_text: String }
pub struct FileLocation { pub path: PathBuf, pub line: Option<u32> } // 对齐 ACP ToolCallLocation
pub struct PlanEntry { pub content: String, pub status: PlanEntryStatus }
pub enum PlanEntryStatus { Pending, InProgress, Completed, Cancelled }
pub enum StopReason { EndTurn, Cancelled, MaxTokens, MaxTurnRequests, Refusal }
```

**权限模型**（对齐 ACP：option_id 是 agent 定义的**不透明字符串**，kind 才是语义）：

```rust
pub struct PermissionOption { pub option_id: String, pub name: String, pub kind: PermissionOptionKind }
pub enum PermissionOptionKind { AllowOnce, AllowAlways, RejectOnce, RejectAlways }
pub struct PermissionDecision { pub option_id: String, pub updated_input: Option<serde_json::Value> }
```

**落地节奏**：`AgentDriver` trait（§4.2）在多 driver 出现（Phase 2）前保持具体方法形态，
避免过早抽象。Phase 0 期间 AcpDriver 以 `run(cwd, mode: StartMode, prompt, events,
permissions, cancel)` 落地：`StartMode::New`（session/new）| `StartMode::Load(agent_session_id)`
（session/load——agent 重放历史通知后沿用原 session id 继续 prompt）。

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
/// 进入待决队列的权限请求（带 broker 分配的关联 id）
pub struct PendingPermission {
    pub id: Uuid,
    pub request: PermissionRequest,
}

/// 所有 driver 的权限请求汇入统一队列；规则引擎先行裁决，
/// 未命中的请求广播给订阅方（UI 审批中心 / CLI 交互），应答后回写对应协议。
pub struct ApprovalBroker { /* 规则(P0-6) + 待决表 */ }

impl ApprovalBroker {
    /// driver 的权限回调入口（P0-5：无规则，一律进入待决队列）：
    /// 1. (P0-6) 命中 allow/deny 规则 → 直接返回裁决，不打扰用户
    /// 2. 未命中 → 分配 Uuid、登记待决表、广播 PendingPermission
    /// 3. 挂起等待 respond 回填；等待通道意外关闭 → 按拒绝处理（fail-closed）
    pub async fn resolve(&self, req: PermissionRequest) -> Result<PermissionDecision>;

    /// 订阅待决请求（broadcast：审批中心 UI 与 CLI 宿主可并存）
    pub fn subscribe(&self) -> broadcast::Receiver<PendingPermission>;

    /// 用户应答（allow once/always、reject once/always），驱动等待中的 resolve 返回
    pub async fn respond(&self, request_id: Uuid, decision: PermissionDecision) -> Result<()>;
}
```

**fail-closed 原则**：审批链路任何异常（无订阅方消费、通道关闭、宿主崩溃）都不得放行——
resolve 返回 Err，driver 层转为 ACP `cancelled` outcome，agent 收到"未获批准"。

**宿主接入形态**：
- CLI：spawn 一个审批任务消费 `subscribe()`，终端 y/a/n 交互后调 `respond()`；
  driver 的 PermissionHandler 绑定为 `broker.resolve`。
- 桌面（Phase 1）：审批中心 UI 消费同一广播，卡片式应答。

**预授权规则**（参考 opencode permission 配置语义）：

```jsonc
// ~/Library/Application Support/<bundle-id>/rules.json（Phase 0 先支持内置默认 + CLI 参数）
{
  "allow": ["read", "edit", "bash(git status)", "bash(git diff *)"],
  "deny":  ["bash(rm -rf *)", "bash(sudo *)"],
  "ask":   ["*"]        // 其余一律询问（默认）
}
```

**规则语法与求值**：
- 模式三形：`*`（全匹配）；`tool`（工具名全匹配，任意参数）；`tool(args)`（args 为
  glob：`*` 任意序列含空格、`?` 单字符）。
- 求值优先级：**deny > allow > ask**；全不命中 → 进入待决队列（人工裁决）。
- 匹配目标（tool, subject）从 `PermissionRequest` 推断：`raw_input` 含 `command`
  字符串字段 → (`bash`, command)；否则 tool = tool_name 首词、subject = tool_name。
  （ACP v1 权限请求不带机器可读工具名，此推断覆盖 opencode 的 bash 工具；后续随
  driver 侧 tool_call 关联补强。）
- 规则裁决的 option 选择：allow → 首个 allow 类 option（偏好 AllowOnce——持续性由
  我方规则承担）；deny → 首个 reject 类 option；agent 未提供所需类别时 fail-closed
  （allow 缺失降级为询问，deny 缺失报错拒绝）。

**权限模式（P1-5 落地；决策记录见 ADR-0006）**：
会话级 `PermissionMode { plan | ask | autoedit | full }`（serde snake_case）作为未匹配
请求的默认策略，规则库降级为高级例外层。`PermissionRules` 增加 ask 列表，
求值顺序 **deny > ask > allow**（ask 压过 allow——用户显式要求逐次确认的优先）。
ApprovalBroker 持有可热切换的 mode（`set_mode`），裁决管线
（对齐 ZCode `PermissionService.checkPermission` 位次）：

```
1. deny 规则 → 拒绝（任何模式最硬）
2. plan 模式 → 拒绝（allow 规则不再考察——计划模式保证只读）
3. full 模式 → 放行
4. ask 规则 → 待决队列
5. allow 规则 → 放行
6. autoedit ∧ 请求推断为 edit/write 类 → 放行（bash 类不在此列）
7. 兜底 → 待决队列（resolve）；无审批 UI 宿主 → 拒绝（resolve_fail_closed）
```

模式与规则兜底的裁决同样留痕：`DecisionSource` 新增 `Mode { mode }` 变体、
`RuleEffect` 扩展 `Ask`（ask 规则进队列不计裁决，应答后记 User）。

**管辖边界（重要产品语义）**：模式与规则只裁决 agent **主动询问**的操作。
opencode 对安全命令白名单（echo/ls 等）与新建文件 write 不发权限请求、直接放行——
这部分须由 P1-7 的严格模式引导（收紧 opencode `permission` 配置）纳入询问范围，
SuperCode 侧无法拦截。

**裁决留痕**：broker 广播 `DecisionRecord { request, source: Rule{pattern,effect} | User,
decision }`（`subscribe_decisions()`）——CLI 打印、Phase 1 审批历史 UI 消费；
SQLite approvals 表持久化在 P0-8 落地（表结构见 §6，decision_by = rule:<pattern>）。

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

### 4.6 事件聚合器 `EventAggregator`（`events` 模块）

```rust
/// 帧级合帧聚合器：吸收 driver 的高频事件，按帧批量输出（§5 事件管道的 Rust 侧实现）。
pub struct EventAggregator { /* tick 周期 */ }

impl EventAggregator {
    /// tick 为 flush 周期（桌面宿主用 ~16ms；测试可调大以保证确定性）
    pub fn new(tick: Duration) -> Self;
    /// 消费 input 直到关闭；每个 flush 周期输出一个批次（Vec）到 output。
    /// 合帧规则：相邻且同 message_id 的 MessageChunk 合并为一条（文本拼接）；
    /// 任何非 chunk 事件（或不同 message_id）切断合并并保持原序直通；
    /// input 关闭时 flush 余量后结束。
    pub async fn run(self, input: mpsc::Receiver<AgentEvent>, output: mpsc::Sender<Vec<AgentEvent>>);
}
```

输出为**批次**（`Vec<AgentEvent>`）：桌面宿主把整批经 Tauri Channel 一次推送；CLI 宿主逐条打印。

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

### 5.1 Tauri IPC 契约（P1-2 起，桌面宿主命令面）

supercode-desktop 对渲染层暴露的命令（invoke）；事件经 `tauri::ipc::Channel` 批量推送，载荷为 `Vec<AgentEvent>`（JSON 序列化沿用 §4.1 的 `tag=type, snake_case`，前端 TS 类型与其镜像）：

| 命令 | 参数 | 返回 | 语义 |
|---|---|---|---|
| `run_prompt` | `prompt`、`cwd`、`allow`、`deny`、`mode`、`on_events: Channel<Vec<AgentEvent>>` | `RunInfo { session_id }`（错误为 String） | 新会话一轮任务（StartMode::New）。宿主内部：driver events → tap（捕获 SessionStarted）→ EventAggregator(16ms) → Channel 批量推送；规则库（SQLite）与本次 draft 规则合并后建 ApprovalBroker（初始 mode） |
| `cancel_run` | `session_id` | `()` | 触发协议级取消链（§7：session/cancel → Cancelled → CANCEL_GRACE 兜底） |
| `set_permission_mode` | `session_id`、`mode` | `()` | 运行中热切换该会话的 PermissionMode（§4.3 管线） |
| `respond_permission` | `request_id`、`option_id` | `()` | 审批中心应答待决请求（转发 broker.respond） |
| `list_rules` / `add_rule` / `delete_rule` | — / `pattern`+`effect` / `id` | 规则列表 / `RuleEntry` / `()` | 规则库 CRUD（SQLite permission_rules 表，§6） |

- **权限事件（Tauri 全局事件，非 Channel）**：每个运行的 broker 经转发任务把
  `PendingPermission` / `DecisionRecord` 以 `permission-request` / `decision-record`
  事件广播给前端（审批中心消费）；request_id → broker 的映射由宿主登记，
  供 respond_permission 路由。
- **fail-closed 权限约定**：`resolve_fail_closed` 保留给无审批 UI 宿主；桌面宿主
  P1-5 起接审批中心，兜底走待决队列。**不可**用追加通配 deny（`"*"`）实现兜底：
  规则求值 deny 优先，通配 deny 会连 allow 规则一并压掉。
- **多会话并行（P1-3）**：`run_prompt` 可并发调用——每次运行独立 spawn agent 进程与合帧管道（互不共享状态）；Rust 侧 active run map 按 ACP session_id 管理取消与清理；前端以客户端会话键路由事件批到对应会话视图（列表 / 切换 / 取消）。
- 运行结束（`run` 返回 StopReason 或出错）后宿主将 handle 移出 active map；结束本身不再发额外事件，以流内 `turn_completed` / `driver_error` 为准。

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

permission_rules(id TEXT PK, pattern TEXT NOT NULL,  -- 规则库（P1-5，全局持久）
                 effect TEXT NOT NULL,               -- allow | deny | ask
                 created_at TEXT);
```

迁移管理：`sqlx migrate`（`crates/core/migrations/`），迁移文件只增不改。
P0-8 落地迁移 0001（六表）；P1-5 落地迁移 0002（permission_rules 规则库）。
运行期写入 sessions/messages/tool_calls/approvals
（`SessionRecorder` 消费事件流：消息 chunk 在 TurnCompleted 时组装落库），tasks 表 Phase 1 使用。
时间戳为 RFC3339 文本。`SUPERCODE_DB` 环境变量可覆盖库文件路径（测试/多环境用）。

## 7. 进程生命周期管理

- **ACP 连接（AcpDriver）**：进程生命周期交由 `agent-client-protocol` SDK 管理——`AcpAgent` 以独立进程组 spawn（unix process_group(0)，专治 npx 包装器孤儿问题），连接结束由 ChildGuard 整组回收，stderr 捕获进错误信息；`AcpAgent::with_debug` 可拿到原始收发行做日志。
- **取消链路（P0-7）**：`run_prompt(..., cancel: CancellationToken)`：
  1. prompt 期间监听 cancel；触发后先发协议层 `session/cancel` 通知（`CancelNotification`）；
  2. 继续等待 prompt 响应，agent 应回 `stopReason=Cancelled`（`CANCEL_GRACE = 10s` 宽限）；
  3. 超时未响应 → 返回 `CoreError::Timeout`，`connect_with` 结束触发 SDK teardown，
     ChildGuard 杀整组兜底。
  - CLI 宿主：Ctrl-C 触发 cancel；第二次 Ctrl-C 强制退出（用户显式覆盖）。
  - `supercode cancel` 跨进程子命令需要会话注册表，推迟到 Phase 1（记入 P1 任务）。
- **非 ACP 进程（StreamJsonDriver 等 / 后续 Sidecar）**：走 `ProcessManager`（command_group 进程组杀树）+ 心跳 + 宿主退出 `shutdown_all` 清理。

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
| 2026-09-25 | 0.6 | P1-4 会话视图落地：§4.1 diff 字段改为结构化 DiffPayload（ACP ToolCallContent::Diff 提取）；IPC 新增 read_text_file（write 新文件内容磁盘懒读）；前端 react-virtuoso + @pierre/diffs（依赖替换偏差见 roadmap） |
| 2026-09-25 | 0.5 | P1-3 多会话管理落地：§5.1 多会话并行说明（客户端会话键路由、active run map 并发）；前端 sessions store + 会话列表/切换；IPC 契约不变（run_prompt 并发调用） |
| 2026-09-25 | 0.4 | P1-2 事件管道落地：新增 §5.1 Tauri IPC 契约（run_prompt/cancel_run + Channel 批量推送）；§4.3 增补权限模式管线 v2 设计稿与管辖边界（ADR-0006，ZCode 源码研究结论），P1-5/P1-7 验收要点相应重写 |
| 2026-09-24 | 0.1 | Step 0 初版：分层架构、AgentDriver/AgentEvent/ApprovalBroker/Registry 接口、事件管道、数据模型、进程与安全约定 |
| 2026-09-25 | 0.3 | P1-1 脚手架落地：apps/desktop 为 Tauri v2 壳（crate `supercode-desktop` 并入 cargo workspace；pnpm-workspace 管理 apps/*）；前端 React 19 + Tailwind v4 + shadcn/ui（radix-nova 预设）；§5 事件管道与命令接入自 P1-2 起 |
| 2026-09-24 | 0.2 | Phase 0 落地（v0.1.0）：§4.1 对齐 ACP v1 实际 schema（ThoughtChunk、Option 字段、ToolKind 全集）；§4.3 规则引擎 + 留痕流；§4.5 ProcessManager；§4.6 EventAggregator；§4.2 StartMode 与 trait 化节奏；§6 迁移 0001 六表 + SessionRecorder；§7 取消链路与 SDK 托管进程组 |
