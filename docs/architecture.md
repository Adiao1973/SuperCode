# SuperCode 架构设计文档

> 本文档是 SuperCode 接口设计的**单一事实源**：任何接口 / 数据模型变更，先改本文档再改代码。
> 更新：2026-10-07；现行 dev 契约截至 P3-7。当前开发与发布范围为 macOS，Windows 延期（ADR-0008）。当前任务状态见 [roadmap](roadmap.md)，历史演进见 [快照](history/architecture-through-p3-3.md)。

> v1.0.0 macOS 交付：ACP 路径支持 OpenCode、Claude Code、Codex、MiMo，指挥官直连规划后经确认派单；NativeDriver 限核心库。StreamJsonDriver、Windows 延期，当前包仅 arm64；安装/签名限制见 Phase 3 验收。

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
│  │   ├─ AcpDriver        （ACP：opencode / MiMo 原生，      │
│  │   │                    claude/codex 经官方 adapter）       │
│  │   ├─ StreamJsonDriver （ZCode 延期，独立分支） │
│  │   └─ NativeDriver     （codex app-server 等，Phase 3）    │
│  ├─ proc           进程管理器：spawn/进程组杀树/心跳/退出清理   │
│  ├─ events         事件模型 + 帧级合帧聚合器                   │
│  ├─ registry       AgentRegistry：agent 定义与探测            │
│  └─ db             sqlx + SQLite 持久化                     │
├──────────────────────────────────────────────────────────┤
│  supercode-cli（Phase 0 原型）   apps/desktop 的 Tauri 壳（Phase 1）│
└──────────────────────────────────────────────────────────┘
        ↓ spawn 子进程 · stdio JSON-RPC（ACP）
   opencode acp   （已接入：npx @agentclientprotocol/claude-agent-acp
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
    pub option_id: String, // Agent 提供的不透明 option_id；裁决类型从 options.kind 查询
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
// 规则语义示例；App 规则实际保存在 SQLite permission_rules 表
{
  "allow": ["read", "edit", "bash(git status)", "bash(git diff *)"],
  "deny":  ["bash(rm -rf *)", "bash(sudo *)"],
  "ask":   []           // 未匹配项由会话权限模式决定
}
```

**规则语法与求值**：
- 模式三形：`*`（全匹配）；`tool`（工具名全匹配，任意参数）；`tool(args)`（args 为
  glob：`*` 任意序列含空格、`?` 单字符）。
- 求值优先级：**deny > ask > allow**；未命中项交由会话权限模式处理（完整管线见下文）。
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
/// 一个 agent 的接入声明。新增 agent = 在注册表加一条配置，AcpDriver 零改动。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DriverKind { Acp, StreamJson, Native }

/// agent 能力位（UI 展示与功能开关；P2-1 先落字段，消费方随各接入任务展开）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Capabilities {
    pub supports_load_session: bool,  // 续聊 session/load
    pub supports_diff: bool,          // 工具事件携带结构化 diff
    pub supports_permission: bool,    // 可外部审批（zcode=false，受限支持）
}

/// 一个 agent 的接入声明（serde 双向：内置常量 + ~/.supercode/agents.json 用户自定义）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentDefinition {
    pub id: String,               // "opencode" | "claude-code" | "codex" | "mimo" | "zcode" | 自定义
    pub display_name: String,
    pub driver_kind: DriverKind,  // Acp | StreamJson | Native
    /// spawn 命令（shell-words 语法，如 "opencode acp"、"npx -y @agentclientprotocol/claude-agent-acp"）
    pub command: String,
    /// 版本探测命令参数（默认 `<program> --version`）
    #[serde(default = "default_version_args")]
    pub version_args: Vec<String>,
    pub capabilities: Capabilities,
}

/// 注册表 = 内置定义 + 用户自定义；同 id 用户条目覆盖内置。
pub struct AgentRegistry { /* entries: Vec<AgentDefinition> */ }
impl AgentRegistry {
    /// 内置注册表（P2-1 起五条齐备，见下表）
    pub fn builtin() -> Self;
    /// 从 `~/.supercode/agents.json` 读用户自定义（文件缺失/解析失败 → 空，不阻塞启动）；
    /// 与 builtin 合并，同 id 用户覆盖内置。
    pub fn load() -> Self;
    /// 按 id 查找（load 后的合并视图）
    pub fn find(&self, id: &str) -> Result<&AgentDefinition>;
    /// 全部条目（内置顺序 + 用户新增）
    pub fn entries(&self) -> &[AgentDefinition];
    /// 批量探测安装与版本：`(definition, Option<version>)`
    pub async fn probe_installed(&self) -> Vec<(AgentDefinition, Option<String>)>;
}

// ── 用户自定义写路径（P2-2：设置 UI agent 管理） ──
impl AgentRegistry {
    /// 仅用户文件中的条目（不含内置；文件缺失/解析失败 → 空）
    pub fn load_user_entries() -> Vec<AgentDefinition>;
    /// 原子写回用户文件（`~/.supercode/` 自动创建；临时文件 + rename）
    pub fn save_user_entries(entries: &[AgentDefinition]) -> Result<()>;
    /// upsert 进用户文件（同 id 覆盖；覆盖内置 id = 用户覆盖语义）
    pub fn upsert_user_agent(def: AgentDefinition) -> Result<()>;
    /// 从用户文件移除：纯自定义即消失，覆盖内置则恢复内置条目；
    /// 用户文件中不存在该 id → Err
    pub fn remove_user_agent(id: &str) -> Result<()>;
}
```

**用户自定义格式**（`~/.supercode/agents.json`，JSON 数组；只读合并，写入由设置 UI 负责）：

```jsonc
[
  {
    "id": "my-agent",
    "display_name": "My Agent",
    "driver_kind": "acp",
    "command": "my-agent --acp",
    "version_args": ["--version"],
    "capabilities": {
      "supports_load_session": true,
      "supports_diff": true,
      "supports_permission": true
    }
  }
]
```

内置注册表（P2-1 起五条齐备；接入阶段指该条目被宿主真实驱动的里程碑）：

| id | command | driver_kind | supports_permission | 接入阶段 |
|---|---|---|---|---|
| opencode | `opencode acp` | Acp | ✓ | Phase 0 |
| claude-code | `npx -y @agentclientprotocol/claude-agent-acp` | Acp | ✓ | P2-3 |
| codex | `npx -y @agentclientprotocol/codex-acp` | Acp | ✓ | P2-4 |
| mimo | `mimo acp` | Acp | ✓ | P2-5 |
| zcode | `zcode -p --output-format stream-json --mode yolo` | StreamJson | ✗（受限支持：`--mode yolo` 预授权，UI 明确标注） | P2-6 |

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

### 4.7 环境探测 `envcheck` 模块（P1-7）

只产**事实**，引导文案由前端负责；读操作，绝不代改用户配置（"自动写入托管配置"留待后续评估，见 ADR-0006 实证记录）。

```rust
/// opencode 权限条目的解析结果。NotConfigured 按 opencode 默认语义 = allow。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionLevel {
    NotConfigured,            // 配置存在但未写该键（opencode 默认放行）
    Allow, Ask, Deny,
    Custom,                   // pattern 对象且无 "*" 通配——用户显式配置，不判定宽松
    Unparseable,              // 值形态不可识别（非字符串/对象）
}

#[derive(Debug, Clone, Serialize)]
pub struct OpencodeEnvReport {
    pub installed: bool,
    pub version: Option<String>,
    pub bin_path: Option<String>,
    pub probe_error: Option<String>,      // 探测失败原因（找不到/超时）
    pub global_config_path: Option<String>,   // ~/.config/opencode/opencode.json(c)
    pub global_model: Option<String>,     // P0-4：缺省时 acp 回退免费模型（限流）
    pub global_edit: PermissionLevel,
    pub global_bash: PermissionLevel,
    pub project_config_path: Option<String>,  // <cwd>/opencode.json(c)，cwd=None 时为 None
    pub project_edit: PermissionLevel,
    pub project_bash: PermissionLevel,
    pub strict: bool,                     // 有效 edit∧bash 均 ∈ {ask, deny, custom}
    pub config_error: Option<String>,     // 配置存在但 JSONC 解析失败
}

/// cwd=Some 时附检项目级配置；有效级别项目覆盖全局。
pub async fn check(cwd: Option<&Path>) -> OpencodeEnvReport;
```

- **安装探测**：PATH 逐目录扫描 `opencode` 可执行文件（不引 `which` crate）；命中后 `opencode --version`（5s 超时）取版本。
- **GUI PATH 修正（P1-10）**：Finder/Dock 启动的 .app 不继承用户 shell PATH（launchd 只给
  `/usr/bin:/bin:/usr/sbin:/sbin`）——Homebrew（`/opt/homebrew/bin`、`/usr/local/bin`）与
  官方安装脚本（`~/.opencode/bin`、`~/.local/bin`）装的 agent 对打包应用不可见，探测与
  driver spawn（PATH 查找）双失效。桌面宿主启动早期调用 `augment_gui_path()` 把上述
  目录并入进程 PATH（幂等、只增不改序），此后所有子进程继承修正后的 PATH。
- **配置发现**：全局 `$XDG_CONFIG_HOME/opencode` 或 `~/.config/opencode` 下 `opencode.jsonc` → `opencode.json`；项目 `<cwd>/` 同名序。JSONC 解析用 `json5`（注释/尾逗号，字符串内 `//` 安全——`$schema` URL 必须存活）。
- **严格判定**：`permission.edit` 与 `permission.bash` 的有效级别（项目覆盖全局）都 ∈ {ask, deny, custom} 才算严格；字符串值直接映射，对象值取 `"*"` 键递归，无 `"*"` 记 Custom。任一为 NotConfigured/allow 即宽松——opencode 默认放行 bash/edit 且对安全命令、新建文件不发询问（ADR-0006 管辖边界）。

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

### P2-4 Codex ACP 适配边界

Codex 注册表条目继续使用 `npx -y @agentclientprotocol/codex-acp`，按 §4.4
`AcpDriver` 处理。适配器启动 Codex App Server；SuperCode 只处理标准 ACP
`initialize/session/new/session/load/session/prompt`、`session/update` 与
`session/request_permission`。扩展能力（推荐模型、沙箱模式、原生子会话等）
本任务不接入。认证由适配器/Codex 管理；UI 只读探测 Node/npx，不读取或保存凭证。
Codex 会话的 `agent_id` 须入库，恢复时保持原 agent、cwd 与 ACP session id；
同一宿主中并行运行的 Codex/Claude 必须各自有独立事件 Channel、broker 和
recorder。会话选择器读取注册表定义时不执行 npx 版本探测（新增
`list_agent_definitions` IPC，返回 `AgentRow` 且 `installed_version=None`）；设置页的
`list_agents` 才执行探测，避免选择器挂载时与运行中 npx 冷启动争用 npm 缓存。任何适配器不经 ACP 请求而自行执行的操作不属于 SuperCode 审批管辖。

### P2-5 MiMo ACP 适配边界

MiMo Code 使用注册表中预留的 `mimo acp` 原生 ACP 入口，继续走现有
`AcpDriver`、会话持久化和 `session/load` 路径。MiMo 的安装、认证、默认模型与
供应商配置由 MiMo CLI 自身管理；SuperCode 只探测 `mimo --version`、提供官方
安装与认证引导，不读取或保存凭证。桌面选择器使用 P2-4 的无探测注册表 IPC。
若内置 `mimo acp` 不在宿主 PATH 中，但官方安装器的
`~/.mimocode/bin/mimo` 存在，则版本探测和启动使用该可执行文件；PATH 中的
`mimo` 优先。用户自定义 MiMo 命令不做此回退。模型仍由 MiMo 配置决定，
SuperCode 不覆盖全局或项目模型设置。
MiMo ACP 服务将 `session/new` 的 cwd 限制在服务**进程当前目录**之内；其
`--cwd` 参数在 0.1.15 中并不改变服务根目录。注册表新增可选
`acp_process_cwd`，内置 MiMo 设为 true；driver 在 Unix 上经 `sh` 的独立参数
安全切换至会话 cwd 后 `exec` agent，保留其环境变量，进程组清理语义不变。
其余 agent 缺省 false，旧版用户注册表 JSON 保持兼容；CLI 和桌面共用该字段。
本阶段以真实 CLI 的 `initialize → session/new → session/prompt → session/load`
链路验证兼容性；若 MiMo 的 ACP 事件或权限选项与现有映射有差异，先添加契约
测试，再作最小协议修正。与其他 agent 并行时继续按每会话独立 Channel、broker
和 recorder 隔离。MiMo CLI 自行执行且未通过 ACP 请求的操作不在 SuperCode
审批范围内。桌面 broker 的裁决广播同时写入当前会话的 SQLite approvals，
与 CLI 的审批留痕行为一致。若 `session/prompt` 返回 EndTurn 而本轮没有消息、工具或计划事件，
`AcpDriver` 将其视为模型服务/认证异常，发 `DriverError` 并标记会话失败；
`session/load` 的历史重放不计入本轮活动。

### P2-3 多 Agent 运行与恢复

- `run_prompt` 新增 `agent_id: Option<String>`（缺省 opencode），按注册表解析；仅 ACP 驱动可运行，其他驱动明确报错。
- 新会话持久化真实 agent id/name；历史 DTO 带 `agent_id`，前端草稿默认 opencode，历史恢复原 agent。已有会话锁定 agent 与 cwd；服务端续聊必须找到本地记录、校验 agent/cwd 与支持 load 的能力，不允许回退新建。
- `check_node_env` 返回 `{ node_version: Option<String>, npx_version: Option<String> }`，并行执行 `node --version` / `npx --version`，5 秒超时、kill_on_drop。仅检测运行依赖，不代表认证或模型服务可用。
- Claude 会话显示 Node/npx 探测与可复制安装/登录指引；OpenCode permission 配置检查仅在 OpenCode 会话启用。鉴权仍由 agent 管理。
- CLI `run --agent <id>` 使用同一注册表，`resume` 按数据库 agent 归属恢复，便于真实链路验收。

### 5.1 Tauri IPC 契约（P1-2 起，桌面宿主命令面）

supercode-desktop 对渲染层暴露的命令（invoke）；事件经 `tauri::ipc::Channel` 批量推送，载荷为 `Vec<AgentEvent>`（JSON 序列化沿用 §4.1 的 `tag=type, snake_case`，前端 TS 类型与其镜像）：

| 命令 | 参数 | 返回 | 语义 |
|---|---|---|---|
| `run_prompt` | `agent_id: Option`（P2-3，缺省 opencode）、`prompt`、`cwd`、`allow`、`deny`、`mode`、`resume_session_id: Option`（P1-6：Some → StartMode::Load 续聊）、`workspace_id: Option`（P1-8：会话归属空间，None → 默认空间）、`on_events: Channel<Vec<AgentEvent>>` | `RunInfo { session_id }`（错误为 String） | 一轮任务。宿主内部：driver events → tap（捕获 SessionStarted）→ EventAggregator(16ms) → Channel 批量推送；tap 同时喂 SessionRecorder（落库 sessions/messages，resume 复用原 agent_session_id，OR IGNORE 幂等）；规则库（SQLite）与本次 draft 规则合并后建 ApprovalBroker（初始 mode） |
| `cancel_run` | `session_id` | `()` | 触发协议级取消链（§7：session/cancel → Cancelled → CANCEL_GRACE 兜底） |
| `set_permission_mode` | `session_id`、`mode` | `()` | 运行中热切换该会话的 PermissionMode（§4.3 管线） |
| `list_history_sessions` | — | `Vec<HistorySession>`（含 `agent_id`、`workspace_id`） | 历史会话列表（sessions 表，P1-6 启动时注入前端；按空间分组展示） |
| `list_session_messages` | `agent_session_id` | `Vec<MessageRow>` | 单个会话的落库消息（P1-6 历史渲染） |
| `respond_permission` | `request_id`、`option_id` | `()` | 审批中心应答待决请求（转发 broker.respond） |
| `list_rules` / `add_rule` / `delete_rule` | — / `pattern`+`effect` / `id` | 规则列表 / `RuleEntry` / `()` | 规则库 CRUD（SQLite permission_rules 表，§6） |
| `delete_session` | `agent_session_id` | `()` | 删除会话（SuperCode 侧级联删除 messages/tool_calls/approvals；运行中拒绝；P1-6） |
| `check_node_env` | — | `NodeEnvReport { node_version, npx_version }` | Node/npx 并行版本探测（5 秒超时）；Claude 界面提示 Node ≥22，缺失时给安装引导 |
| `check_opencode_env` | `cwd: Option`（P1-7：Some 时附检 `<cwd>` 项目级配置） | `OpencodeEnvReport`（§4.7） | opencode 环境探测：安装/版本、全局与项目配置的 permission/model 解析、严格判定。只读不改配置；引导文案在前端（设置页区块 + 运行框 cwd 联检） |
| `list_workspaces` / `create_workspace` / `delete_workspace` | — / `path` / `id` | 空间列表 / `Workspace` / `()`（P1-8，ADR-0007） | 工作空间 CRUD：默认空间单例（kind=default）恒在排最后，project 空间按项目根绝对路径 UNIQUE 去重（name 取目录名）；删除仅限 project 空间，会话移入默认空间不级联删 |
| `list_tasks` / `create_task` / `update_task` / `delete_task` | — / `title`+`workspace_id` / `id`+`status?`/`session_id?` / `id` | 任务列表 / `TaskEntry` / `TaskEntry` / `()`（P1-9 简版看板） | 任务=标题+空间+绑定会话+状态（backlog\|in_progress\|review\|done）；绑定会话随 delete_session 级联解绑；看板按空间分节四列展示（拖拽升级在 Phase 2） |
| `list_agent_definitions` | — | `Vec<AgentRow>`（`installed_version=None`） | 仅取合并注册表定义供会话选择，不启动探测子进程 |
| `list_agents` | — | `Vec<AgentRow>`（P2-2） | 注册表合并视图（内置顺序+用户新增）+ 并行探测安装版本；`is_user_defined` 标记用户文件条目（含覆盖内置） |
| `add_agent` / `update_agent` | `id`、`display_name`、`driver_kind`、`command`、`version_args`、`capabilities`（update 带 `id`） | `AgentRow` | 写入 `~/.supercode/agents.json` 并返回探测后的行（同 id 覆盖=用户覆盖内置语义） |
| `delete_agent` | `id` | `()` | 从用户文件移除：纯自定义消失，覆盖内置则恢复出厂条目；文件中无此 id 报错 |

`AgentRow` = `AgentDefinition` 序列化字段 + `is_user_defined: bool` + `installed_version: Option<String>`
（前端 TS 镜像；探测语义沿用 §4.4，`list_agents` 内并行探测）。

- **权限事件（Tauri 全局事件，非 Channel）**：每个运行的 broker 经转发任务把
  `PendingPermission` / `DecisionRecord` 以 `permission-request` / `decision-record`
  事件广播给前端（审批中心消费）；request_id → broker 的映射由宿主登记，
  供 respond_permission 路由。应答成功才移除路由；运行结束/取消清理时广播 permission-removed { ids }，前端三处视图按 UUID 同步清队列。
- **fail-closed 权限约定**：`resolve_fail_closed` 保留给无审批 UI 宿主；桌面宿主
  P1-5 起接审批中心，兜底走待决队列。**不可**用追加通配 deny（`"*"`）实现兜底：
  规则求值 deny 优先，通配 deny 会连 allow 规则一并压掉。
- **多会话并行（P1-3）**：`run_prompt` 可并发调用——每次运行独立 spawn agent 进程与合帧管道（互不共享状态）；Rust 侧 active run map 按 ACP session_id 管理取消与清理；前端以客户端会话键路由事件批到对应会话视图（列表 / 切换 / 取消）。
- 运行结束（`run` 返回 StopReason 或出错）后宿主将 handle 移出 active map；执行终态仍以流内 `turn_completed` / `driver_error` 为准；审批队列清理另发 `permission-removed`，该事件不代表任务成功。

## 6. 数据模型（SQLite，sqlx）

库文件：`~/Library/Application Support/<bundle-id>/supercode.db`（`dirs` crate 定位；开发期可用 `SUPERCODE_DB` 覆盖）。

```sql
agents(id TEXT PK, display_name TEXT, driver_kind TEXT, spawn_json TEXT,
       capabilities_json TEXT, installed_version TEXT NULL, updated_at TEXT);

workspaces(id TEXT PK,          -- 工作空间（ADR-0007，P1-8 落地）
           name TEXT, path TEXT UNIQUE NULL,    -- project 空间=项目根绝对路径；默认空间 path 为空
           kind TEXT,           -- project | default（默认空间全局单例）
           created_at TEXT);

sessions(id TEXT PK,            -- SuperCode 侧 UUID
         agent_id TEXT REFERENCES agents(id),
         workspace_id TEXT REFERENCES workspaces(id),  -- 会话归属空间（历史按 distinct cwd 回填）
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

tasks(id TEXT PK, session_id TEXT, workspace_id TEXT REFERENCES workspaces(id),
      title TEXT, cwd TEXT NULL, status TEXT,       -- backlog|in_progress|review|done；cwd 缺省取空间路径
      created_at TEXT, updated_at TEXT);             -- P1-9 简版看板（按空间组织）；session 关联经 tasks.session_id（迁移 0004）

permission_rules(id TEXT PK, pattern TEXT NOT NULL,  -- 规则库（P1-5，全局持久）
                 effect TEXT NOT NULL,               -- allow | deny | ask
                 created_at TEXT);
```

迁移管理：`sqlx migrate`（`crates/core/migrations/`），迁移文件只增不改。
P2-4：两个独立宿主首次并行打开同一新库时，sqlx SQLite migrator 可能遇到 SQLite busy、`_sqlx_migrations.version` 唯一键冲突，或并发建表/加列冲突；仅对这些瞬时迁移竞态做有限退避重试，其他迁移错误立即返回。
P0-8 落地迁移 0001（六表）；P1-5 落地迁移 0002（permission_rules 规则库）；
P1-8 落地迁移 0003（workspaces + sessions.workspace_id，历史会话按 distinct cwd
回填为 project 空间并归类；删除空间不删会话，会话移入默认空间——ADR-0007）。
运行期写入 sessions/messages/tool_calls/approvals
（`SessionRecorder` 消费事件流：消息 chunk 在 TurnCompleted 时组装落库），tasks 表 Phase 1 使用。
迁移 0004 增 tasks.session_id 引用；0005～0007 的指挥官配置、凭据和运行快照见 §12。
时间戳为 RFC3339 文本。`SUPERCODE_DB` 环境变量可覆盖库文件路径（测试/多环境用）。


### 6.8 外观偏好与首帧（P4-4）

SQLite 迁移 0008 新增 `appearance_preferences(id=1, theme CHECK system/light/dark)`，旧库无行时默认 system；不修改已有会话、配置或凭据表。DTO `AppearancePreferences { theme: system|light|dark }` 拒绝未知字段。IPC `get_appearance_preferences()` 返回偏好、`save_appearance_preferences(preferences)` 校验并原子 upsert。SQLite 为唯一持久事实源，无 localStorage 缓存，不导出用户数据库。

主窗口配置初始 `visible=false`。前端在 mount 前读取偏好，设置根 dark 类、data-theme 与 color-scheme，React 提交且 layout effect 已应用主题后调用 `appearance_ready(dark: bool, theme: system|light|dark)`；命令仅设置调用窗口不透明背景色、匹配的原生主题并 show（system 使用 None 恢复 OS 跟随）。读取失败或 5 秒超时采用系统主题、展示可重试错误，再显示窗口，不能静默把回退偏好写入 SQLite。保存成功才更新当前偏好；失败保留旧主题并显示错误，保存期间禁用重复操作。系统主题只在 system 偏好时影响 resolved theme，监听 change 并清理。

颜色/字体/间距/圆角由 CSS token 统一，图标与主要控件继承语义色。终端通过更新现有 xterm options.theme、diff 通过 themeType 跟随 resolved theme；不能把主题变化加入 PTY 启动 effect 依赖。动效偏好独立使用 0009（§6.9）；密度等后续偏好不在本迁移中预建。

### 6.9 动效基础与减少动态（P4-5）

迁移 0009 新增本机单例 `motion_preferences(id=1, motion CHECK system/reduce/full)`，无行默认 system；不修改 0008 外观 DTO 或历史表。严格 DTO `MotionPreferences { motion }`，IPC `get_motion_preferences()` / `save_motion_preferences(preferences)` 原子 upsert，未知字段/枚举拒绝。与主题独立保存，避免更新一项覆盖另一项。前端启动并行读取两类偏好；读取失败/超时保守回退 reduce、显示可重试错误，不写回回退值。

MotionProvider 监听 `(prefers-reduced-motion: reduce)`，system 才跟随；根 data-motion=reduce/full 在显示前应用。减少模式停止既有 CSS spin/pulse/位移动画、平滑滚动与终端光标闪动，禁用 Motion 位移/退出等待；完整模式统一 120ms 微交互、180ms 存在变化、ease [0.2,0,0,1]。仅使用开源 Motion 14.0.0，LazyMotion strict + m + 异步 domAnimation，不安装另一引擎；既有 tw-animate-css 是 CSS 工具，统一受偏好控制。特性未加载/加载失败时内容直接显示可用，不阻塞操作。

MotionNotice 仅用于非交互短反馈，入场/退出不承载运行宿主、审批或取消按钮；退出节点无指针交互且不参与播报。本轮以复制反馈接入存在变化，后续布局/消息动效复用基础。事件与 RPC 在操作时立即发出，不在 onAnimationComplete 中派单/裁决；减少模式即时反馈、无持续闪动。

### 6.10 本机分栏偏好（P4-7）

迁移 0010 新增单例 `layout_preferences(id=1, session_list_width INTEGER CHECK 180..400, session_list_collapsed INTEGER CHECK 0/1, terminal_height INTEGER CHECK 96..360, terminal_collapsed INTEGER CHECK 0/1)`。严格 DTO 为同名四字段，默认 224/false/224/false，拒绝未知字段、缺字段及越界。IPC `get_layout_preferences()` / `save_layout_preferences(preferences)` 原子 upsert，不改会话/凭据/其它偏好。只存像素偏好与用户收拢意图，不存终端打开状态、PTY id、路径或窗口派生尺寸。

启动并行读取主题、动效、分栏偏好；失败/5 秒超时用默认可用布局，显示可重试错误，读取成功前不写入默认值。前端 LayoutProvider 为内存工作副本，保存串行、合并最新操作（拖动结束写、非每个 pointermove 写），失败显示可重试提示，保留当前可用布局；重试保存只写布局。自动约束/窗口 resize/隐藏模块不写偏好，不能以自动收拢覆盖用户意图。

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
- 执行 agent 的 API key 不进入 SuperCode：各 agent 自管鉴权。Phase 3 指挥官直连模型是独立配置，只保存 endpoint/model/key 环境变量名；运行时读取该变量，不保存密钥、不复用 agent 登录凭据。
- exec 类工具的命令内容在审批 UI 中**完整可见**（不截断命令、展示 cwd）。

## 10. 技术约束与开发规范（WebKit 相关）

1. xterm.js 锁 `>=5.3.0`（修复 Safari/WKWebView 输入问题）；避免透明 canvas（WebKit 绿色伪影）。
2. macOS 慎用 `backdrop-filter` + 窗口透明 / `position:fixed` 组合（WRY 已知 bug）；用 sticky 替代 fixed。
3. 事件流禁止使用 SSE/EventSource（`tauri://` 不支持），一律 Tauri Channel / WebSocket 插件。
4. 跨平台 CSS：每个涉及视觉的验收任务须在 macOS 实测，当前按 [ADR-0008](adr/0008-macos-priority.md) 聚焦 macOS，Windows 延期；恢复 Windows 发布范围时增加对应实测。

## 11. 工作区、看板与终端

### P4-6 — AppShell、导航与焦点

AppShell 提供五个模块、可折叠导航、全局待审批计数和当前会话项目定位。折叠状态仅当前窗口内存，不新增迁移/IPC 或配置事实源；项目上下文来自现有 workspaces 与活动会话 draft.cwd，不猜测 Git 仓库或改执行目录。计数直接订阅 PermissionCenter 队列，折叠仍有可读名称及提示，不额外裁决审批。

会话与指挥官宿主持续挂载，模块切页使用 hidden/inert 隔离不可见面板，不用动画 key 重建运行宿主。会话切页保留草稿、Channel 与已开 PTY，后台事件继续按原 key 更新；切回不重复 run_prompt/open_terminal，退出/关闭仍走原收尾。各页快捷键必须检查页面 active、组合输入、弹层和终端焦点，隐藏会话不能拦截 Cmd-R/Cmd-.。现有会话之间的选择生命周期不在本任务改造。

项目定位使用现有 Radix modal Popover（Tab 圈定、Esc/回焦），指挥官确认用 Radix Dialog（初焦返回审阅、Tab 圈定、Esc 只关闭、回到触发器），内容与执行契约不变。导航后焦点移至模块标题，弹层存在时全局快捷键不抢焦点；关闭弹层不调用执行/审批。切离指挥官关闭其确认弹层，保留目标草稿与运行宿主。960×640 下主操作可达，研究编号只在注释/文档，不进入标题。

### P4-7 — 工作区/详情/终端可调整分栏

沿用 P4-2 验证的 react-resizable-panels 4.14.3（MIT），仅接入现有会话工作区：横向列表/详情、纵向内容/终端。Separator 支持鼠标、方向键、Home/End 与 Enter 收拢，提供名称、方向和数值；用细线/抓手与统一 120ms 颜色反馈，不给运行宿主加布局进入/退出动画或变化 key。减少动态模式保持即时尺寸变化。

会话列表默认 224px、展开最小 180px、最大 400px，详情最小 460px；工作区可用宽度低于 780px 自动收拢列表，变宽后按用户原意恢复，不记自动收拢。始终可通过列表按钮显式收拢/展开；窄窗口时显示收拢原因，不能强行展开挤掉主区。终端默认 224px、最小 96px、最大 360px 且不超过可用区 45%，上方主内容最小 300px（P4-9 底部输入约束时按可用高度收缩）/不足时允许滚动；高度计算只在实际可见容器尺寸有效时进行。手动收起终端仅隐藏面板、保留 SessionTerminal/PTY；关闭终端/切换 cwd/会话/退出仍按已有生命周期清理，终端打开状态不持久化。切模块不重建任何 Panel 宿主。

xterm ResizeObserver 在宿主宽高为零/隐藏时跳过 fit/resize，恢复显示后按实际尺寸拟合；不将尺寸/收拢/主题加入 PTY 启动 effect。输入、ANSI、中文、Ctrl-C、Channel 背压/关闭与退出语义不变。布局读取与保存错误在工作区可见，允许重试；不调用模型，不上传 SQLite。

### P2-7 任务 worktree 隔离

`core::worktree` 用 Git 参数数组创建 `supercode/task-<task UUID>` 分支，基于项目 HEAD（不复制未提交源码）。托管目录及独立 JSON 记录位于 Git common dir 的 `supercode-worktrees/` 下；任务 UUID 唯一，重复请求复用既有目录，不替换已有同名分支。记录 task_id/workspace_id/project/path/branch，重启可恢复，不新增数据库表。

`.worktreeinclude` 每行一个相对文件路径（空行及 # 注释忽略，不解释 glob）；只允许项目内真实普通文件，拒绝绝对路径、..、符号链接及 .git，先校验全部文件再建 worktree，复制到新目录时不覆盖受 Git 跟踪的文件。失败回滚本次 worktree 和新分支，原项目不变。

看板项目任务提供“隔离会话”按钮，预填任务标题和 worktree cwd，workspace_id 始终为原项目。新增 IPC：`create_task_worktree(task_id)` → TaskWorktree（task_id/workspace_id/project/path/branch）；`cleanup_task_worktrees(workspace_id)` → removed/skipped 字符串列表。`run_prompt` 可携 task_id，宿主校验其托管 cwd 与原空间一致；SessionStarted 落库后绑定任务并更新为进行中。新建隔离草稿不自动调用模型。

“清扫孤儿”只处理当前项目托管记录：任务已不存在且无历史会话使用该 cwd、无活跃运行，且 Git status（含 ignored/untracked）为空才移除目录与记录。保留分支及提交；脏目录明确跳过，不使用 force，不触碰其他 worktree。操作由宿主互斥锁串行化；默认空间及非 Git 项目明确报错。

### P2-8 看板拖拽

采用 `@dnd-kit/core` DndContext/useDraggable/useDroppable：每个空间的四列为 drop target；任务专用拖拽把手支持 MouseSensor（6px 激活距离）、TouchSensor（150ms 长按、5px 容差）和 KeyboardSensor（空格拾取、方向键选择列、空格放下、Escape 取消）。DragOverlay 跨空间显示，空列可接收，取消或落在区域外不写入；同列放下不改变顺序。当前不引入列内持久化排序。

新增 IPC `move_task(id, workspace_id, status)` → TaskDto；SQLite 一条 UPDATE 同时写 workspace_id/status/updated_at，校验目标空间和四态，失败不改变任意字段。session_id/title/cwd 均保持；空间移动仅整理看板，不迁移会话或执行目录。前端松手后即时乐观显示，单次移动等待落库时禁用新拖拽与同卡修改；失败恢复原卡片并显示错误。其他任务操作在保存期间禁用，避免旧结果覆盖新结果。

P2-7 托管 worktree 的原空间记录继续作为执行归属：创建/恢复隔离会话按 task_id 在现有项目托管记录查找，移动后复用原目录、原 workspace_id；run_prompt 按该记录而非看板归属验证。已绑定会话跳转不变；未隔离的新任务在当前项目创建 worktree。默认空间允许恢复已有隔离记录，新建隔离仍需 Git 项目。

依赖依据：[dnd-kit 官方 DndContext](https://dndkit.com/legacy/api-documentation/context-provider/dnd-context/) 与 [useDraggable](https://dndkit.com/legacy/api-documentation/draggable/use-draggable/)。不变更数据库 schema。

### P4-8 — 会话列表与上下文定位

- 会话列表沿用现有工作空间归属与排序；项目组显示名称、完整目录提示及可见/总数，默认组和未知归属兜底不丢会话。列表以标题为主，状态、Agent 和实际 cwd 为次级信息；选中项使用 aria-current，操作按钮与选择按钮分离，键盘可达。
- 标题过滤仅在本机内存执行：trim 后大小写无关的连续子串匹配，只匹配 title，不读取消息、不请求 IPC、不承诺全文检索。隐藏无匹配项目组；无匹配显示清除入口。过滤不改变 activeKey，不卸载当前详情或取消运行；当前会话被过滤时明确提示并可清除恢复。新建会话清除过滤，外部快捷键激活的会话即使不匹配仍保留详情。
- 详情顶部常显会话标题、工作空间名、Agent 与实际 cwd；选择历史/草稿不改写其 cwd/agentId/workspaceId，运行 Channel 仍闭包绑定客户端 key。切换会话沿用现有终端关闭行为，切页仍保留宿主。本轮不新增更名接口或数据库迁移；标题继续由首轮 prompt/历史标题生成。
- 历史状态保留在前端 entry 的 historyStatus，尚未载入事件时显示历史完成/失败/取消/中断；新运行与实时事件优先，invokeError 显示出错，避免将历史失败标成空闲。状态不从正文推断，不新增后台运行恢复。

### P4-9 — 底部输入区与配置弹层

- 底部输入占用高度后，分栏以可用高度约束显示：内容区最小值取 min(300px,55%)、终端取 min(96px,45%)；用户保存的 96～360px 意图不被窗口约束覆盖，空间不足时允许实际显示更小，展开后重新 fit。
- 消息/审批与终端继续由现有宿主承载；输入区是详情底部固定 flex 区，不随消息滚动，不因配置弹层或模块切换重建。长提示词在限高输入框内滚动，960×640 仍能触达运行/停止。摘要常显 Agent、模式、实际目录与规则数量；目录完整值可通过提示/配置查看，警告仍有常显入口。
- 配置复用 Radix modal Dialog，键盘焦点圈定、Esc 关闭并回触发按钮；Agent/cwd/mode/rules 直接编辑现有 session draft，不引入独立保存按钮、数据库或 IPC。运行中/已有 ACP id 锁 Agent，运行中/已有 ACP id/托管 task 锁目录；解释锁定原因。模式运行中仍调用 set_permission_mode；规则是下一轮的预授权输入，不冒充热更新。
- 输入框 Enter 运行、Shift-Enter 换行；组合输入期间（isComposing、229、本地 composition 状态及结束后短窗口）Enter 不运行；粘贴仅修改 draft，不触发执行。运行中 Enter 不开新轮，start 同步互斥避免同一事件循环重复 invoke。⌘R/⌘. 保留，仅当前可见详情生效，组合输入/弹层/终端内不抢键。
- 运行仍用固定客户端 key 路由 Channel；新建/续聊、cwd/workspace/task/Agent/规则/权限管线无语义变化。底部停止直接请求 cancel_run，不等待动画；本轮不改消息渲染或滚动锚点（P4-10/11）。

### P2-9 — 会话内嵌终端

- 前端使用 `@xterm/xterm@6.0.0` 与 `@xterm/addon-fit@0.11.0`；不加载 canvas/WebGL addon，`allowTransparency=false`，不透明背景，ResizeObserver 同步字符行列。终端由会话详情显式打开，cwd 使用该会话 draft 的实际执行目录（包括 worktree），不使用看板分组路径；目录变更、切换会话/页面、关闭面板会销毁终端，重开为新 shell，不持久化 shell 状态。
- 桌面端使用 portable-pty 启动用户 shell 的交互实例；独立 PTY 不经过 agent 或审批队列。`open_terminal(id,cwd,cols,rows,onOutput)` / `write_terminal(id,data)` / `resize_terminal(id,cols,rows)` / `close_terminal(id)` / `ack_terminal(id)`；随机客户端 id 在异步启动前确定，关闭与启动共享注册表锁，前端即使在启动中卸载也等待启动结果后关闭，避免泄漏。IPC 使用 Tauri Channel 输出字节块（UTF-8 跨块由 xterm 解码），输出采用逐块应答背压，限制输入和尺寸；命令不阻塞 Tauri 主线程。
- 后端注册表只拥有本应用创建的 PTY；自然退出回收句柄并通知前端；关闭显式终止 shell 及其子进程并 wait 回收。应用退出/窗口销毁执行同样清理，Unix 通过原生 `getsid` 校验本 PTY 的独立 session，收集并终止各 job process group 中的进程（无法取得 session 时按自身树兜底），Windows 专项 P3-8/P3-9 已按 ADR-0008 延期，未包含在当前 dev 和 macOS 发布范围。macOS 使用非阻塞 PTY 读取与可中断应答等待，关闭先释放 master/writer 再等待回收，避免 exiting 状态悬挂。终端仅在目录存在且为绝对路径时启动；失败显示错误，不自动创建目录。
- 不改数据库/schema。新增依赖理由：xterm 提供 ANSI/VT 解析和可访问输入，fit addon 匹配面板尺寸；portable-pty 提供真实 PTY/交互 shell 与窗口 resize，替代不支持 job control 的普通管道。

P2-9 依赖选择与实测：5.5.0 在 React StrictMode/面板销毁后存在 viewport 定时回调访问已销毁 renderer 的异常，改用 6.0.0 稳定版，重复开关/切换复测无异常。官方变更见 [xterm 6.0 发布说明](https://github.com/xtermjs/xterm.js/releases/tag/6.0.0)；PTY 读写/resize 使用 [portable-pty](https://github.com/wezterm/wezterm/tree/main/pty)。

### P2-10 — 整体验收发现的宿主收尾修复

CLI 与桌面宿主一致：driver 返回 `Err` 时，在关闭事件通道、等待 recorder 排空之前补发 `DriverError`，让已有会话落库为 failed；会话未建立时不制造伪档案。新建和续聊均用真实 CLI + 无网络 ACP 对端回归验证。release 版本徽标读取 Tauri 实际 app version，`dev` 后缀仅开发构建显示，不再硬编码版本。v0.3.0 按用户批准范围排除 P2-6 后发布；延期不影响已批准版本。



### Claude CLI 与 ACP 探测边界

内置 Claude 行的 installed_version 仍表示 ACP 适配器版本，不能由 claude --version 替代。新增 cli_version 可空字段，仅原样内置 Claude 命令另行并发探测 claude --version；自定义命令不套用此检测。定义列表（不探测）置 null。UI 单独展示 CLI 已检测版本与 ACP 已检测/未就绪；失败包含缺少程序、退出失败与超时等原因，因此统一“未检测到/未就绪”而非断言未安装。不读取登录或 key，不以版本结果保证认证可用。

## 12. 指挥官契约（dev，截至 P3-6）

### P3-1 — 指挥官计划契约

`commander::TaskPlan { version, objective, tasks }` 是直连 LLM 与宿主之间的 JSON 契约，version 固定为 1，未知字段拒绝。每个 `PlannedTask { id, title, agent_id, prompt, depends_on }` 具有 1～64 字符的 ASCII 字母/数字/连字符/下划线 id，非空 title/prompt；depends_on 可省略为 []。计划必须有 1～64 个任务和非空 objective，总输入最多 1 MiB。agent_id 必须在宿主注册表存在且通过现有 launch 校验（当前仅 ACP）；ZCode 禁选逻辑保持一致。

`TaskPlan::validate(&AgentRegistry) -> Result<ValidatedPlan>` 拒绝重复 id、未知 agent、重复/缺失/自身依赖和环；返回按输入顺序稳定排列的拓扑执行批次。每个批次仅包含依赖在此前批次已完成的任务。该结果仅是静态建议，不创建会话、数据库记录、worktree 或子进程；实际安装探测、工作目录及审批在 P3-4 执行入口重新校验。计划自身不携带权限豁免或 shell 命令执行配置，不能越过既有审批管线。

CLI `supercode plan validate <file>` 读取不超过 1 MiB 的 JSON，按合并后的注册表验证，输出 `ValidatedPlan { plan, batches }` JSON；坏计划返回非零并给出字段/依赖诊断。不调用 LLM，不访问 SQLite，不执行 agent。直连模型响应复用同一契约校验。


### P3-2 — 直连 LLM、配置与本机凭据

`LlmConfig { endpoint, model, api_key_env, timeout_secs }` 使用严格 JSON，不包含 key 值。endpoint 接受完整 /chat/completions URL 或 /v1 Base URL（同源补全），要求 HTTPS 或字面 loopback HTTP，禁止 userinfo/query/fragment。model 非空；环境变量名符合 ASCII 命名规则。timeout 默认 60 秒，范围 1～300；配置/目标最多 64 KiB，响应/计划最多 1 MiB。

SQLite 0005 `commander_config(id=1,config_json)` 原子保存配置，无效输入不覆盖旧值；0006 `commander_credentials(scope,key_value)` 按用户选择保存明文密钥。scope 由 origin、规范化接口路径和变量名组成，不跨源复用，切换模型不改变绑定。默认 App/CLI 优先 SQLite key，再读环境变量；显式 CLI `--config` 只读指定普通文件和环境变量，不打开数据库。密钥首尾空白裁剪，非空且 ≤16 KiB，内部空白/非 ASCII/控制字符拒绝。

`LlmClient::from_config` 是环境变量构造入口；默认宿主通过 `Store::commander_client` 解析本机凭据。客户端 reqwest 0.13.5 使用 JSON/rustls，禁重定向与自动重试；敏感 Bearer 头及错误/Debug 不回显密钥、URL、目标或响应原文。不修改 agent 配置，不读取 agent 登录 token。

`generate_plan(objective,registry,cancel)` 一次非流式 POST，包含 model、stream=false、response_format={type:json_object} 和独立 system/user 消息。system 给出 P3-1 契约及 ACP agent 名单，不读取项目文件。响应要求唯一 choice、finish_reason=stop、assistant content 字符串，无 tool_calls/refusal。content 接受裸 JSON 或完整 json/无语言代码围栏，拒绝额外说明；严格反序列化并复用 DAG/agent 校验，objective 固定为原用户目标。发送及读取共用 deadline/CancellationToken；HTTP 错误只输出状态码，语法与字段错误仅分类诊断。

`plan generate` 与 `plan validate` 均输出 `ValidatedPlan { plan,batches }`，但 validate 的输入是 `TaskPlan`；复核 generate 结果须先取其 plan 字段。生成不创建执行会话或派单，Ctrl-C 取消返回非零。

模型发现 `discover_models` 使用同源、同路径前缀 /models GET 与同一凭据来源，允许表单 model 为空，严格解析 data[].id、排序去重，限制 1 MiB/4096 项。不跟随重定向、不探测其他供应商；目录不保证账号计费权限或文本规划能力，查询失败仍允许手填。

桌面设置分别展示已保存配置、当前模型与凭据来源，配置/密钥分开显式保存。password 框保存成功后清空；IPC 来源仅返回 sqlite/environment/missing，不返回 key。模型列表留内存，选择后显式保存；改连接参数清除旧列表。IPC：get_commander_config、save_commander_config、list_commander_models、save_commander_key、commander_credential_source、verify_commander_plan、cancel_commander_plan。

App 示例验证读取已保存配置与凭据，固定待办应用目标；每请求 UUID，最多一个活跃请求，取消/drop/窗口销毁回收 token。只展示合法任务与批次，不执行 agent；结果留内存。SQLite/WAL/SHM/journal、.env 和真实连接配置不入 Git。真实验收结果见 [P3-2](acceptance/p3-2.md)，不在设计契约重复保存过程状态。

参考：[reqwest](https://docs.rs/reqwest/0.13.5/reqwest/struct.ClientBuilder.html)、[MiMo 模型目录](https://mimo.mi.com/docs/zh-CN/api/model/list-models)、[MiMo JSON 输出](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/text-generation/structured-output)。

### P3-3 — 计划持久化与执行状态机

0007 commander_runs 保存不可变计划 JSON、工作目录、plan 状态、按原计划顺序排列的任务状态 JSON、revision 和时间戳。计划与全部初始状态单条 INSERT 原子写入；不得含连接配置/key。创建时重新校验 DAG/agent 和 1 MiB 上限，cwd 要求绝对路径（不访问文件）。每次转换读取快照后按 revision 做单条 UPDATE CAS，计划与任务状态原子变化；竞争失败返回 false，让调度器重新读取，非法转换返回分类错误。此任务只提供 Store API，不启动模型或 agent。

计划 draft → running（显式确认）→ succeeded/failed/cancelled/interrupted，终态不可重跑。任务 pending → running（计划 running 且依赖全部 succeeded）→ succeeded/failed；pending 可因失败依赖标记 skipped，running 不可直接 skipped。失败/跳过依赖的全部后代自动 skipped，独立任务继续；全部任务终态后计划有失败则 failed，否则 succeeded。显式取消 draft/running 时所有未终态任务 cancelled，已完成记录保留。任务启动时可绑定 session_id，或在 running 且尚未绑定时单次补绑（UUID 仅引用，不改会话表）；终态不可改绑。

读取/重开库只恢复记录，绝不自动执行；独占调度器启动时可显式 recover_commander_runs 将 running 计划改 interrupted，running 任务 interrupted、pending cancelled；draft 和既有终态不改。不能在 Store::open 自动执行恢复（其他连接可能仍有活跃任务）。P3-4 接入调度器后负责调用恢复、派单和回收进程。

### P3-4 — ACP 派单与批次调度（已集成 dev）

`commander::scheduler::Scheduler` 持有 Store 和注册表；`execute(run_id, DispatchOptions, BrokerFactory, broadcast::Sender<DispatchEvent>, CancellationToken)` 显式执行已确认 draft 计划，返回最终 CommanderRun。Options 为 max_concurrency（1～16）与 workspace_id；cwd 来自不可变计划记录。执行前重校验计划、目录存在/绝对路径、空间存在与各实际 ACP 适配器版本探测。预检失败保持 draft、无会话/任务运行；CAS draft→running 是跨调用唯一认领，不重跑 running/终态。

按 P3-1 稳定拓扑批次派单，同批受并发上限约束，全部结束后才进入下一批；失败后代由 P3-3 标 skipped，独立分支继续。每任务独立本机会话 UUID、AcpDriver、新建 ACP 会话、SessionRecorder 与 broker；事件信封包含 run_id/task_id/session_id/agent_id，输出广播不阻塞执行，SQLite 是持久化事实源。原 cwd、workspace_id、agent_id、审批管线保持。共享目录不自动创建 worktree；此阶段只核心库及验收示例，不新增产品 CLI/UI（P3-5/6）。

BrokerFactory 为每个派单创建独立 ApprovalBroker，宿主可事先订阅接入人工审批；调度器使用 resolve_fail_closed，无订阅的兜底拒绝，显式 ask 仍保持队列语义。取消联动 reject_all_pending，完成拒绝解析后以 <cancelled> 拒绝规则留痕，裁决单独绑定本机会话写 approvals，不借计划提升权限。SessionStarted 经可返回错误的 recorder 写入后绑定任务 session UUID；driver 错误补 DriverError，落库失败使任务失败，不宣称成功。仅 EndTurn 且无持久化错误视为 succeeded；其它停止原因失败，计划取消则保留已有完成结果，其余 cancelled。

取消停止新派单、取消全部自有 driver 并等待协议/进程清理及 recorder 排空，然后原子取消计划；不得杀无关进程。执行 future 意外被丢弃时取消 token，剩余运行记录由独占宿主显式 recover_commander_runs 恢复为 interrupted；普通读取/另一执行调用不自动恢复，以免打断仍活跃计划。P3-4 不引入后台自动恢复或自动重跑。

### P3-5 — 结果汇总与 CLI 闭环（已集成 dev）

`Store::summarize_commander_run(id)` 返回 RunSummary：run_id/objective/cwd/status、七种任务状态计数、按计划顺序的 task 摘要（id/title/agent_id/status/depends_on、本机 session_id、agent_session_id、最后一条 agent 消息 result、truncated）。读取不调用模型、不执行任务、不自动恢复或重跑。消息摘要最多 8 KiB（UTF-8 边界截断），无会话的失败/跳过仍输出明确状态。最后消息按本机会话 UUID 查询，远端 id 相同也不串台；读取引用需核对 agent/cwd 一致，缺失会话可返回空 agent_session_id，不能把其他会话结果归给该任务。状态来源是 SQLite，不使用输出文本推断成功。

CLI `plan run <objective> --cwd <dir> [--agents opencode,codex]` 使用本机 SQLite 模型与密钥生成并校验计划，保存 draft，stdout 输出完整 plan/batches/summary 供审阅；默认不派单。agents 是可选的规划名单限制，未知或非 ACP agent 拒绝，计划及执行重新校验；不改全局注册表。没有限制时用全部已接入 ACP 定义。真实验收限制为 OpenCode+Codex，不处理 Claude/MiMo ACP 环境。

`plan execute <run UUID> --yes [--jobs 2] [--allow ...] [--deny ...]` 显式确认已存 draft，不再次生成/改写计划；复用 P3-4 调度器。没有 --yes 退出 2、无派单；并发范围 1～16。CLI 无交互审批队列，按用户 allow/deny 规则使用独立 broker，未匹配操作 fail-closed，保留裁决落库，不改成 full 权限。事件按 run/task/session 归属写 stderr，stdout 仅最终 summary JSON。Ctrl-C 取消并等待驱动/审批/recorder 排空；成功退出 0，失败/中断/错误退出 1，取消退出 130。预检失败保留 draft 并输出可查询摘要。

`plan report <run UUID>` 输出同一摘要，成功查询退出 0，无论计划状态；不存在退出非零。完整生成输出包含 plan（TaskPlan）、batches 和 summary；执行/报告输出 RunSummary。报告不包含 endpoint/model/key，不调用额外 LLM，不处理桌面入口（P3-6）。没有迁移或新增包；CLI 直接使用锁文件已有 serde 序列化共用报告，复用 SQLite/调度器。

### P3-6 — 桌面指挥官工作区（已集成 dev，macOS 已验收）

新增独立导航“指挥官”：目标和绝对 cwd → 生成并保存 draft → 显示任务、agent、依赖批次及全部 prompt → 明确确认执行 → 进度/审批/结果。模型配置继续使用设置页，页面显示保存的模型与密钥是否就绪及设置入口，不重复输入 key。可限制规划 agent、设置并发 1～16；不创建目录/worktree、不读取项目文件、不自动执行计划。阶段固定变更前确认模式与默认空间，显式显示执行 cwd，避免引入未持久化权限草稿。

历史批次使用 dependency_batches 只读拓扑布局，不要求旧 Agent 仍注册；执行仍完整 validate 与预检。会话导航重新进入时刷新数据库历史，显示指挥官创建的会话。

IPC generate_commander_run(request_id,objective,cwd,agents) 读取本机配置/密钥，限制注册表并校验目录，保存 P3-3 draft；list_commander_run_views/get_commander_run_view 返回计划、批次、P3-5 summary 与 active 标志。execute_commander_run(run_id,confirmed,jobs,on_progress) 要求 confirmed=true 且 draft，复用 P3-4；同 App 最多一个生成或执行，guard 在全部清理后移除；cancel_commander_work(request_id) 只取消本 App 的请求，不改其他 CLI 正在执行记录。Channel 只传 task_id 刷新信号，不传模型输出或凭据，SQLite 是状态与结果事实源；切换导航不取消执行，页面重新进入按库读取，不重发 execute。

DispatchOptions 增 interactive_approvals（默认 false，CLI 行为不变），desktop=true 使用原 broker.resolve 而非 fail-closed。独立 broker 载入全局规则、固定 Ask；待决/裁决转发既有 permission-request/decision-record 并按 AppState.pending 路由 respond_permission。裁决只由调度器写一次 SQLite，转发任务不重复写；前端待决优先按 request_id 精确移除；仅兼容旧用户裁决事件时回退 ACP session_id/tool_call_id（无 UUID 的自动裁决不移除待决）。指挥官任务内联显示其审批卡，审批中心仍可应答；取消联动拒绝挂起请求与裁决留痕。

退出请求有活跃指挥官工作时先阻止退出、取消 token 并等待 guard 清除/driver 回收，再退出。重启从 SQLite 恢复 draft/终态/任务结果与引用，不自动执行或重跑终态。非本 App 活跃的 running 记录显示“其他宿主或遗留运行”，禁止再执行/跨宿主取消；不会自动 recover 全库以免中断 CLI。崩溃遗留记录可由独占宿主显式执行核心恢复接口，桌面不会猜测其它进程已停止。恢复指恢复历史与草稿审阅，不承诺续跑已中断任务。

本阶段不新增迁移/包。布局采用主工作区+历史列表，分隔线组织任务，prompt 按需展开，状态和操作有可读文本；配置不足/预检失败保持草稿并提示，不把安装检测视为推理可用。验收 macOS WebKit；Windows 实机专项仍归 P3-8/9，不能用 macOS 宣称 Windows 通过。

### P3-7 — Codex NativeDriver（已实现，核心库范围）

独立 `driver::NativeDriver` 使用 `codex app-server --listen stdio://`，JSON-RPC 逐行 JSON（无需 jsonrpc 字段）。依据 [官方 App Server 文档](https://learn.chatgpt.com/docs/app-server) 与本机 codex-cli 0.144.5 生成的稳定 schema；不启用 experimentalApi、不假定 initialize 返回不存在的 capability 列表。握手校验 userAgent，未知 RPC/不支持的方法明确失败。新建 thread/start、恢复 thread/resume，然后 turn/start；恢复返回 thread.id 必须与请求相同。保持 cwd，readOnly sandbox + untrusted 服务端审批策略固定，默认不覆盖用户模型/认证。专用验收 example 允许 SUPERCODE_NATIVE_TEST_MODEL 指定单次子进程模型（来源为本机 model/list 默认条目），不写配置；目录不是权限证明，仍须真实完成推理。未消费的通知（包括恢复时旧 turn 的 legacy 通知）忽略；消费的会话、turn、item 事件按 threadId/turnId 校验，不允许跨会话污染；只有 turn/completed.status=completed 映射 EndTurn，interrupted 映射 Cancelled，failed/EOF/错误不是成功。

命令及文件审批分别接入既有 PermissionHandler/ApprovalBroker，kind=execute/edit。每次 RPC 回调使用独立 tool_call_id（包括不透明 RPC id，不能只使用可重复 itemId），提供 accept/decline 两个一次性选项；不提供 acceptForSession/永久规则扩权，updated_input 不支持且拒绝。未知服务端请求回复 method-not-found，权限提升/交互输入等未实现请求不自动放行。审批异步等待，读循环继续处理取消与通知；完成或取消时收尾待决 futures。broker.set_mode 对后续请求生效；已进入队列的请求仍需明确 respond/reject_all_pending，不声称能热改服务器沙箱或撤销已执行操作。

沿用 ProcessManager 独立进程组及清理；stderr 仅留本机临时日志。单帧上限 4 MiB，启动缓冲 32 帧，同时审批最多 32 个，单轮请求身份最多 4096 个；握手/启动 RPC 有超时；取消优先，turn/interrupt 有限宽限后整组回收，未来被丢弃亦取消并清理。事件队列满时取消/错误终态采用 try_send，避免背压阻止清理；宿主也应检查返回结果与取消令牌，不能依赖满队列必有终态。NativeDriver 返回前等待进程退出，不遗留后台 approvals/reader。协议错误仅输出固定诊断，不回显原始远端错误/凭据。

本任务保持具体 driver 方法 `run(cwd,StartMode,prompt,events,permissions,cancel)`；普通宿主优先用 `run_with_broker`，其拥有 pending 队列并在取消/drop 时拒绝和清理，通用 callback 入口的外部队列仍由宿主负责，不提前引入设计示意 trait；提供核心验收 example，尚不注册产品原生入口、不修改现有 codex ACP、指挥官 ACP 约束、UI 或数据库 schema。真实出口已通过，按流程合入 dev。Windows 进程/PTY 与 UI 由 P3-8/9 实机验收，本机不冒充 Windows 通过。

## 13. 设计变更与历史

现行接口在对应章节原位更新；过程、失败尝试和验收结果写任务验收记录，重大决策写 ADR。[历史快照](history/architecture-through-p3-3.md) 保留原变更表与 P3-2/3 演进过程，不作为现行约定。

| 日期 | 变更 | 证据 |
|---|---|---|
| 2026-10-08 | P3-10A 整体回归及 P3-10B macOS arm64 安装交付；版本统一 1.0.0，无接口/迁移变更 | [Phase 3](acceptance/phase3.md) |
| 2026-10-02 | P3-1～4 计划契约、直连 LLM/本机凭据与执行状态持久化已集成 dev | [验收索引](acceptance/README.md) |
| 2026-10-02 | 文档结构整理，替代过时的环境变量唯一来源与裸 JSON 唯一输出约定 | [整理验收](acceptance/docs-alignment.md) |


### P4-10 — 流式 Markdown 与代码阅读

- 视觉：沿用纸白/石墨与单一强调色，正文以标题、列表、表格和留白形成阅读层次；代码仅用细边界与等宽字体。内容依次为正文、代码操作、原文回退。交互沿用短颜色反馈，不对 token 或正文高度做入场动画。
- 只替换会话 `message` 展示，用户文本/思考/工具/审批及 Channel、SQLite 历史契约不变。活跃和历史消息使用同一 renderer；原始文本永不改写，原文查看/全文复制随时可用。代码复制保留源位置内的内容（包括尾部换行），不复制围栏或语言名。
- 采用 P4-2 选定的 react-markdown 10.1.0 + remark-gfm 4.0.1（MIT），延迟加载；加载/解析失败回退原文。流中允许未闭合语法按 CommonMark 暂态呈现，Markdown与原文均以100ms合并展示更新，结束立即显示完整文本。活动消息超过 4K UTF-16 码元或任何消息超过 128K UTF-16 码元 时自动显示可复制原文，避免大文档每批重解析；不截断文本。
- 组件和插件引用固定，完成消息 memo，虚拟列表 key 与宿主不变。按需高亮只在用户点击时加载 Shiki 4.4.3 的 JS 引擎、两套主题与有限语言（JS/TS/JSON/Python/Bash/CSS）；只处理已结束消息、≤16K UTF-16 码元/200 行代码，不支持语言保持原文。令牌以 React span 文本渲染，禁止 dangerouslySetInnerHTML。
- skipHtml，不接 raw HTML 插件；图片仅显示替代文字且不创建 img/请求；链接只接受完整 http/https URL（无凭据、空白或控制符），危险/相对/本地链接退为文本。外链由 Radix 确认显示完整地址，用户点击“在浏览器打开”才调用现有 opener；Esc/取消回到链接，不自动导航。
- 原文切换和复制操作不重建执行宿主，复制/打开失败在原处可见。P4-10 不改阅读锚点/工具折叠（P4-11）。同构建口径记录首包 gzip 增量≤20% 与 lazy chunk；原生专项检查虚拟列表 20Hz 增量，仅活动消息更新，无全列表重新挂载。超预算先采用流中原文/完成后渲染对照，不带问题进入下一任务。


### P4-11 — 阅读锚点与思考/工具折叠

- 视觉：保留纸白/石墨与正文阅读宽度，思考/工具使用紧凑摘要和明确展开动作。内容依次为正文、可折叠上下文、底部新消息入口。交互只改变展开状态和滚动位置，不做高度动画或逐 token 入场；减少动态下同样即时操作。
- 保留 react-virtuoso、Channel 和原始 StreamItem。阅读状态在 SessionsWorkspace 的会话键 Map 中保存，不进入 SQLite/协议：跟随底部、首个可见 key/相对 top、滚动快照、未读标记、已展开 key。删除会话清理，列表内容重置后失效锚点回到底部；不缓存已卸载消息的 DOM。
- 新进入历史默认定位末尾。底部（24px 阈值）跟随追加及活动文本高度变化；用户向上阅读时保持 key/相对 top，不因新 token 强行滚动。离底后新增/更新正文、思考或工具标记“新消息”，按钮显式回到末尾并恢复跟随；不将每个 token 计数或 aria-live 播报。
- 切会话保存/恢复虚拟列表快照和 key 锚点；切模块不卸载宿主，隐藏时不把零高度/零位置写回。可见后恢复阅读位置。展开/折叠、Markdown 懒加载与尺寸变化以当前可见 key 锚定，允许虚拟列表重新测量，禁止通过重新挂载整个列表重置高度。
- 思考默认折叠为首行摘要/状态，展开保留完整可选择/复制文本；工具默认摘要包含名称/种类/状态，展开保留原位置/完整文本与既有 diff 懒读边界。展开状态按稳定 key 保存，虚拟条目回收/切会话不丢。历史仍按已有落库契约展示消息，不捏造数据库未保存的思考或工具记录。工具参数/耗时与变更详情见下方 P4-12。
- 自动验证阅读状态、1000 条混合 fixture、20Hz 事件更新、折叠语义/复制/持久化及完成条目引用；真实滚动/变高/会话与模块恢复须原生 WebKit 核对，jsdom 不冒充布局验收。只对可见 DOM 取锚点并合帧调整，不扫描全部历史正文或截断源数据。

### P4-12 — 工具与 diff 详情层次

- 视觉沿用纸白/石墨，摘要单行显示工具、种类、状态与耗时；展开后按“参数 / 输出 / 文件变更”分区，审批仍由独立 PendingCard 裁决，工具完成不等于审批批准。即时折叠、不增加高度动画或逐 token 动画。
- 前端 StreamItem 工具保留首次 tool_call 的 raw_input 原值与本机接收时间、首次终态接收时间。StreamAction batch 可传 receivedAt（测试固定时钟），缺省本机 Date.now；同批时差允许 0ms，终态更新不反复累加，正文更新不改完成工具引用。不显示后台执行精确耗时：完成时标“接收间隔”，无终态标“尚未结束”，未知时间不补造；跨重启不保存这些视图数据。原事件/SQLite 契约不改；未提供参数或仅后续事件拥有参数的 Agent 显示“当前事件未提供参数”，不从输出猜测。
- 摘要来自 title/name，参数仅在展开参数区时 stringify，文本与 JSON 完整可选/复制。execute 的字符串参数或 command/cmd 字符串支持完整命令复制，不执行命令。缺失、null、空对象/数组区分展示，不将参数/输出当 HTML 或 Markdown 执行。
- 工具详情及参数/输出/变更的展开键复用会话 ReadingMemory，虚拟回收/切会话保留展开；不缓存整个 DOM。diff 仅在用户展开文件变更后挂载，使用当前锁定 @pierre/diffs 和主题；无新增依赖。新旧总长 >128Ki UTF-16 或总行数 >4000 时直接用完整原文对照（分别按需展开/复制），不计算昂贵 diff/高亮、不截断复制数据；普通 diff 也可随时切原文。新增文件只显示新内容，不把整文件行数标为真实增删统计。
- writeLazyPath 延续已有 write/create/save + location 规则；仍只在显式展开变更时调用现有 read_text_file（1MiB 上限、lossy UTF-8）；不扫描目录、不自动刷新磁盘、不扩展后端授权范围。明确标识“当前磁盘内容”，不是调用时快照；失败原处显示错误、可重试，关闭/换路径/结构化 diff 到达时忽略旧请求回调，失败不污染消息流；重新读取只对该用户动作触发。
- diff 首次异步初始化期间显示生成状态，5 秒未产生代码节点转原处恢复入口；同步渲染异常由局部边界捕获。diff 渲染失败有原处重试/原文回退，懒读失败无内容时不能伪装成功；长 diff 和错误不阻塞正文/运行/停止。契约测试覆盖参数原值/复制、终态时间、长内容回退、懒读按需/重试/过期响应、渲染错误隔离；原生 WebKit 核对主题/窄窗、长 diff、复制、错误恢复与连续消息阅读。

### P4-13 — 指挥官目标与规划上下文（已验收）

输入区沿用现有运行宿主与生成/确认契约。App 传入当前会话 cwd 和项目空间列表；初始目录及用户尚未修改的目录跟随当前会话。用户手填/选择项目/目录后保留草稿，切模块不覆盖，可用“使用当前项目”显式恢复。项目选择只修改本次规划 cwd，不创建空间、不变更会话归属；默认空间无目录时要求选择。

目标输入、工作目录、参与 Agent 分区排列；窄窗口历史改为可折叠，避免挤压主要表单。Agent 使用 list_agent_definitions 只读名单，不运行版本探测或启动执行进程。ACP 可多选，未接入驱动禁选并说明；已接入不代表已安装或已登录，界面如实提示，刷新时移除已注销/不支持的选项。默认首次选择当前 ACP Agent（否则首个 ACP），不自动添加后来注册的条目。

模型状态在每次激活时重新查询：加载、未配置、缺少密钥、配置可用、查询失败各有文字及设置入口；“配置可用”不声称真实推理验证。异步结果在切页/下一次查询后失效。目标/目录/Agent/模型/忙状态均满足才允许生成；提交同步锁防双击，生成只调用原 generate_commander_run，成功仍是 draft，不触发 execute/run_prompt。

新增本机 IPC：validate_commander_directory(path) → void，要求已存在的绝对目录；pick_commander_directory(defaultPath?) → string|null，仅系统原生单目录选择、取消不改草稿、禁止在选择器创建目录。使用 Rust 侧 tauri-plugin-dialog =2.4.2（MIT/Apache-2.0，MSRV1.77.2 兼容项目1.88），无 JS 通用 dialog 权限扩张。选择结果及手填目录都由后端校验；generate_commander_run 再次复用目录检查与 AgentRegistry.restricted，防止目录消失或前端绕过。界面不读取项目文件、不扫描子目录，不更改 SQLite schema。计划审阅/执行监控的重构留到 P4-14/15。


### P4-14 — 计划审阅与确认（已验收）

草稿沿用纸白/石墨、单一强调色与细分隔线，先展示目标/目录，再展示任务导航和完整详情，最后显式确认执行。宽区域左右排列列表与详情，窄区域上下排列；提示词保持原始完整文本、自动换行，不执行 HTML/Markdown。任务选择按 run id 重置，显示任务 id、Agent、依赖及调度批次。已有运行/结果/审批展示不在本任务重构。

并发只接受 1～16 的整数；非法输入禁用确认并原处说明。Radix 标准确认弹层展示任务数、目录、默认空间、变更前确认权限及实际并发，初始焦点位于返回审阅，Tab 困在弹层，Esc/返回只关闭弹层并回到触发按钮，不执行、不取消、不裁决审批。确认期间不能切换历史或修改并发；切模块关闭弹层。弹层与执行宿主均使用同步 ref 锁防止同一事件周期重复派单，宿主还检查 active/draft/并发与全局忙状态。继续复用后端 confirmed 和运行互斥契约，不新增 IPC/数据库字段/依赖。


### P4-15 — 执行监控、结果与会话定位（已验收）

视觉沿用纸白/石墨、单一强调色，内容依次为真实状态计数、按批次任务、结果预览和查看会话。使用细分隔和原文结果，不引入进度估算/入场或高度动画；按钮沿用既有颜色反馈，减少动态无额外运动。非草稿默认收起规划输入（保持挂载保留草稿），监控优先；并发输入仅在草稿出现，避免把当前输入值伪作历史执行配置。状态和计数仅由 SQLite RunView.summary.tasks 推导，pending 显示排队，失败/跳过/取消/中断分别显示；inactive running 明确记录未结束且当前应用不运行，不自动恢复或伪记成功。草稿审阅保持 P4-14。

Channel 仅作为重新读取信号：合并繁密通知，但读取期间新通知需再读，最终执行返回及收尾刷新不能被旧读取覆盖。切模块不卸载执行宿主，不取消执行；重进读取持久化记录，不重跑。调度依赖/并发/取消仍由既有 Rust Scheduler 决定。

历史列表 DTO 新增 local_id（sessions.id），不迁移 schema。历史前端 key 使用完整本地 UUID，避免 ACP id 末尾碰撞；刷新非本机实时运行条目的持久化状态，保留草稿/流/运行连接。点击任务会话先重新查询列表，以 summary.session_id 本地 UUID 唯一匹配，校验 agent_id/cwd/agent_session_id；缺失/不一致/重复远端 ID 时原处报错，不猜测跳转。验证后 App hydrate 并激活对应前端会话，沿用历史消息加载，绝不调用 run_prompt/session-load。执行中的任务暂不提供会话跳转，提示结束后查看；指挥官拥有执行状态，不冒充普通会话实时 Channel。结果为既有 8192 字节摘要，明确说明截断及完整会话入口，无结果/无会话也说明原因。


### P4-16 — 审批上下文与裁决反馈（已验收）

视觉：沿用纸白/石墨、单一警示色与轻边界，只对待决裁决使用卡片。内容依次为所属任务/会话、工具类型与完整标识、命令/变更/完整输入、一次性裁决及状态。上下文/原文按需展开，按钮沿用颜色反馈与统一复制反馈；提交使用文字提示，不增加旋转或高度动画，减少动态同样可操作。命令仅复制不执行，变更以请求中明确提供的路径/旧文/新文原文对照，不读磁盘、不补造 diff。

PendingPermission 桌面事件增可选上下文 local_session_id、agent_id、cwd、session_title；指挥官增 task_title、plan_objective（保留 commander_run_id/task_id）。三处使用同一 PendingCard 和 PermissionCenter 按请求 UUID 共享 submitting/accepted/error 状态：连点/切页仅发送一次，成功等待后端裁决通知且不重新启用；失败留卡、显示原因并允许原动作重试。只展示原有 once 选项，不新增 always/批量放行/规则写入。复制失败原处可见。

DecisionRecord 增可选 request_id：排队请求为 Some(UUID)，自动裁决为 None；DecisionSource 序列化改为现有 TS 契约的 {type: user|rule|mode,...}，无数据库 schema 变更。近期裁决保留当前进程最多 50 条，不声称重启恢复。裁决反馈按 options 中的 option_id → kind 判断允许/拒绝，禁止用 option_id 字符串前缀猜测；未知选项显示未识别。取消拒绝来源标记 rule:<cancelled>，不伪记用户点击。Broker.respond 先验证 option_id 属于该请求，再消费通道；失败保留路由以便重试。

运行 relay 有明确结束信号，退出时清理该运行登记的 UUID 并广播 permission-removed，包含尚未转发的缓冲待决请求；取消/异常/退出均沿用既有拒绝/进程收尾。前端 App 将全局待决集合按 ACP session id 同步到会话，避免消息与审批到达顺序造成残卡或漏卡；指挥官和审批中心直接订阅同一集合。后端 request_id 和前端 UUID 防重是两层约束。


### P4-17 — 看板层次、拖拽反馈与任务详情（已验收）

视觉沿用克制工作台：空间标题/目录/数量构成分组，四列标题与计数清晰，卡片标题为详情入口，把手独立。窄窗口保持四列最小阅读宽度并在空间内横向滚动，不压缩成难读小卡。内容依次为保存反馈、空间/列、任务及只读详情；不新增列内排序。

沿用既有 dnd-kit 三种传感器、键盘坐标与 WebKit 最终松手坐标。源卡保留原尺寸占位，目标列显示不参与布局的虚线落点提示；DragOverlay 继续 dropAnimation=null。成功后短暂边界/底色落位反馈，只过渡颜色和透明度，不给 draggable/overlay 添加 Motion transform/layout。减少动态下 CSS 关闭过渡，状态/动作完全等价。Space/方向键/Space 可移动，Esc/区域外/同列不写库；推进/回退也复用 move_task 与同一保存/回滚路径。保存期间禁止新拖拽、刷新和任务修改，失败恢复原卡并保留明确错误与刷新入口，不以动画代替 SQLite 结果。

新增只读 IPC get_task_context(task_id) → {task, stored_cwd, worktree?, session?}，仅在显式打开详情/重试时读取。stored_cwd 来自 tasks.cwd，worktree 复用原项目托管记录查找（只读 Git/元数据、不创建、不清扫），session 为匹配绑定 ACP id 的现存 SessionRow；找不到会话返回 null、多个匹配报错。无 schema 迁移。详情显示完整标题/UUID、看板空间/状态、创建时目录、原 worktree 路径/分支/空间、实际会话目录/空间，明确组织移动不迁移执行归属；不把 stored_cwd 伪作当前执行 cwd。查询失败可重试，关闭/换任务忽略旧响应。

详情使用标准 Radix Dialog，初始焦点关闭按钮，Esc/关闭回到卡片详情入口；跳转会话不把焦点拉回看板。只读历史跳转重新查询列表并唯一匹配绑定 ACP id，hydrate 后激活，找不到/歧义原处报错，不启动 Agent。绑定/隔离/删除保留原明确动作，详情查看本身不执行任务或修改任何文件。

原生快速松手可能发生在 dnd-kit 测量 active 矩形之前，内部重置却不发送结束事件。mouseup/touchend 下一帧仅清理遗留拖拽显示并提示重试，不猜测落点、不发写库。正常结束先清理 ref；键盘移动成功或回滚后，定位新挂载的同任务把手恢复焦点。

### P4-18 — 分组设置与初次配置引导（已验收）

视觉：沿用纸白/石墨与单一主色，以顶部四组导航、简短步骤和分隔线替代连续卡片。内容依次为模型连接/密钥/验证、Agent 与项目目录、规则、外观。交互沿用颜色反馈与系统目录选择，不新增装饰位移；减少动态操作等价。

设置四组为模型、Agent 与项目、规则、外观，使用原生按钮/aria-current 与具名区域，导航独立于正文滚动；切组保留未保存输入与正在验证的请求，初次进入默认模型组。模型步骤独立展示连接保存、凭据来源、推理验证：保存连接或密钥绝不视为验证通过；列表查询也不作为推理验证。验证只使用已保存连接，显式按钮说明一次 API 调用且不执行任务。取消单独显示已取消，不伪记服务失败；结果仅在当前设置生命周期有效，编辑连接或更换密钥后清除；重开显示未验证，不持久化推理认证结论。模型操作与项目添加使用同步锁防重；读取失败可重试，不显示伪成功。关闭设置取消未完成验证，不把过期结果写入新页面。

复用既有 get/save_commander_config、credential_source、save_key、verify/cancel_plan IPC 和 SQLite 按 endpoint/环境变量名存凭据的范围，无 schema 迁移，不回读 key。连接表单与密钥输入禁用条件一致；凭据查询过期响应忽略。真实配置、key、SQLite 不进入日志/仓库。

Agent 分组明确版本探测仅表示命令可用，认证与模型权限需在会话实际运行确认，不自动运行或登录。项目目录引导复用 pick_commander_directory 与 create_workspace；选择取消保持原值，选择本身不保存，显式添加后保存本机空间，不改已有会话 cwd。保存后 App 刷新空间列表。规则与外观沿用既有持久化及权限语义。规则区按需渲染以确保 WebKit 辅助功能树可见，草稿仍由父组件保留；项目已添加但列表刷新失败时保留保存反馈，并提供只读列表重试。

### P4-19 — 统一空、错误、加载与短反馈（已验收）

视觉以标题、说明、单一操作为层次，空态不模拟数据；静态 Skeleton 搭配可读加载文字，避免把正在读取误作空列表。共用 EmptyState、LoadingState、InlineError，五页沿用同一排版。错误留在发生区域，保留原原因；只读查询显式重试，不自动重试生成、派单、运行、写库或审批。存在旧数据时保留旧内容并标明读取失败，不用空态覆盖。

保存/复制成功使用共用短提示：单例 Toast 最多一条、同文案合并、约 3 秒消失，可关闭，鼠标/键盘聚焦时暂停，关闭/局部 Esc 返回先前操作控件；不抢焦点、不携带 key/endpoint/命令原文。成功提示 polite，错误由原操作内联 alert 持续展示，不把失败藏进短提示。减少动态无位移/闪动，状态不只依赖颜色。复制兜底失败必须捕获并在原处提示，不能产生未处理 Promise；不重复播报同一成功提示。

会话历史/空间、计划历史、看板、规则与模型配置及审批监听分别区分读取中/失败/空数据。审批监听失败清理已注册监听后允许重新订阅，重试不裁决请求。保留 P4-16 UUID 应答防重和 P4-18 凭据/验证状态，无新增后端 IPC、schema 或依赖。

### P4-20 — Cmd-K 与快捷键发现（已验收）

视觉以单一搜索框、分组结果、作用域说明及按需快捷键说明构成命令面板；沿用现有 Radix Dialog 与颜色反馈，无新增依赖或装饰位移。侧栏提供可发现入口，Cmd/Ctrl-K 打开，方向键选择、Enter 导航，Esc 返回原控件；导航后焦点落到目标上下文，不被关闭回焦拉回。

搜索只投影 NAV_ITEMS、App 已加载 sessions 的 title/key/workspaceId 和看板成功读取的 tasks 的 title/id/workspace_id。仅标题/分组名称过滤，未加载任务明确提示先打开看板，结果标注模块/已加载会话/已加载任务和空间。过滤后最多显示 80 项，完整 UUID 作 key；不是全库全文搜索，不查询文件、密钥、prompt、正文、cwd 或环境配置，打开/输入搜索不发 IPC。缓存任务只作导航线索，跳转看板后重新读取，任务消失原处说明、不猜测替代。

动作白名单仅五个模块、激活会话、查看任务只读详情、新建默认空间会话和打开当前空间的新建任务表单（输入标题后才保存）。新建任务不立即写库；空间名称未加载时标为待核对，保留原 workspace id 并重新查询，不悄悄回退默认空间；空间失效关闭旧表单并报错。表单也拦截 IME/残余 Enter/按键重复。运行/停止/删除/审批/派单/生成不进入命令列表，不绕过原确认与权限路径。

中文 IME 组合输入和 keyCode229 不触发选择/快捷键；compositionend 后 50ms 内忽略残余 Enter，组合输入中的 Esc 不关闭面板。全局快捷键尊重 defaultPrevented、其他 Dialog 与终端焦点；现有 Cmd-N/数字、Cmd-R/Cmd-. 和输入 Enter 保持作用范围。说明面板列出这些快捷键与例外，终端通过侧栏入口打开搜索。标准 Dialog 圈定焦点，组合结束正常 Esc/关闭回原控件；减少动态等价可用。

P4-20 前端接线：AppShell.onSearch 打开受控 CommandPalette；App 仅在面板打开时构造投影，KanbanView.onTasksLoaded 发布成功读取/已保存的任务缓存。看板 request={id,kind:detail|create,nonce} 每次先刷新，再只处理一次并 onRequestHandled 清理；详情返回原卡片、表单聚焦标题。没有新 IPC 或数据库迁移。


### P4-21 — 性能回归检查（待验收）

生产构建输出Vite manifest。首包检查从唯一entry沿静态imports递归去重，逐文件gzip level9；dynamicImports不计入首包。基线369794 bytes、预算+20%，接入just verify，图测试覆盖共享、循环和按需依赖。临时原生探针只用于隔离验收，不进入产品、不导出正文或配置；性能结论只见[验收记录](acceptance/p4-21.md)。

非初始页面（指挥官、看板、审批、设置）首次访问才加载，指挥官首次进入后保持挂载。消息时间线和虚拟列表在实际存在消息后加载；审批复制按钮独立于虚拟列表模块。各页面/消息区域有独立加载与错误边界，不暂停会话宿主、输入、Channel或全局审批订阅。模块加载失败可切换页面，需重启应用重试。

TerminalLoader按需加载SessionTerminal/xterm；加载完成前关闭不会挂载或创建PTY。终端已打开后的切页保留规则不变，加载失败可以关闭，模块错误需重启应用重试。

活动Markdown阈值4K UTF-16码元、完成态阈值128K；两种活动展示均100ms合并更新，复制始终使用完整权威源。长原文按1024码元后首个换行切稳定块，以memo/layout containment隔离；不截断、不拆单行或代理对，结束后恢复原排版。新增条目立即校正位置，纯正文增长由既有DOM/尺寸观察器触发；跟随模式直接调整原生滚动容器到底部，离底锚点、首次恢复和显式跳转保持原逻辑。

主窗口配置create=false，由setup按原窗口配置创建；自动创建的开发/验收覆盖配置仍支持既有IPC路径。复用AppState Store预读三项界面偏好及各自读取错误，初始化脚本只注入这些字段和随机启动nonce，不包含模型连接、key或其他SQLite数据。读取失败保留各Provider默认值/错误及禁止覆盖语义。没有新增持久化表或IPC命令。

初始化脚本等待html根节点，先应用主题/动效属性，再通过受保护的Tauri桥接请求appearance_ready；原生背景在显示前设为对应颜色，应用模块随后加载。main消费预读快照并复用同主题显示promise；桥接不可用或期间系统主题变化时回退SDK调用。首次React root提交使用flushSync，之后维持正常调度。Provider观察首个显示请求错误，StrictMode重放不重复请求，后续主题变化仍同步原生窗口。

sessionStorage只保存无敏感信息的启动nonce。完整WebView重载不重放旧快照，重新走IPC读取当前偏好；sessionStorage不可用同样回退。新进程的新nonce允许新快照，不把界面偏好另存到浏览器。

流式更新只重绘变化的会话行摘要：标题、Agent/cwd、运行/结束状态、审批数、选中与删除确认独立为memo基础类型属性。行事件按key从最新已提交会话状态读取目标，避免缓存回调持有旧会话或异步删除后错误切换。导航aside按实际导航属性缓存；审批同步仅在待决集合或session身份映射变化时执行，正文变化不触发重复同步。

终端视口使用layout/paint containment，将xterm尺寸调整造成的布局和绘制影响限制在既有overflow-hidden视口内；保持即时fit、PTY通知和屏幕阅读模式。

### P4-22 — 可访问性与多尺寸

表单字段提供稳定的可访问名称，不依赖placeholder；新增Agent的标识/显示名/启动命令/版本参数/驱动协议分别命名。新建项目目录输入关联说明及校验错误，错误使用alert并标记aria-invalid，避免只靠颜色。沿用原保存/执行/权限和数据库契约，不新增常显说明。原生九格与VoiceOver/IME的实际出口见任务验收；AX树和jsdom不代替听读/布局实测。

长路径下原生select显式使用零宽flex基础与min-width:0，防止WebKit内在选项宽度撑出指挥官滚动区；选项完整路径与工作目录输入内容保持，不用裁剪父容器掩盖溢出。

会话数量、看板绑定动作、超时提醒及可操作删除图标使用完整muted-foreground，避免在浅色背景叠加透明度后丢失对比；隐藏图标仍在悬停/键盘聚焦时显示，禁用控件语义不变。

AppShell保留唯一main地标并以当前模块命名；指挥官内层滚动区改为名为“规划与审阅”的section，避免嵌套main干扰读屏地标导航。
