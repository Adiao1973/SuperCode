# SuperCode 架构设计文档

> 本文档是 SuperCode 接口设计的**单一事实源**：任何接口 / 数据模型变更，先改本文档再改代码。
> 更新：2026-10-03；现行 dev 契约截至 P3-5。当前任务状态见 [roadmap](roadmap.md)，历史演进见 [快照](history/architecture-through-p3-3.md)。

> v0.3.0 已发布：ACP 路径支持 OpenCode、Claude Code、Codex、MiMo；StreamJsonDriver 是延期设计，未包含在本版。

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
4. 跨平台 CSS：每个涉及视觉的验收任务须在 macOS 实测，Phase 3 起增加 Windows 双测。

## 11. 工作区、看板与终端

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

### P2-9 — 会话内嵌终端

- 前端使用 `@xterm/xterm@6.0.0` 与 `@xterm/addon-fit@0.11.0`；不加载 canvas/WebGL addon，`allowTransparency=false`，不透明背景，ResizeObserver 同步字符行列。终端由会话详情显式打开，cwd 使用该会话 draft 的实际执行目录（包括 worktree），不使用看板分组路径；目录变更、切换会话/页面、关闭面板会销毁终端，重开为新 shell，不持久化 shell 状态。
- 桌面端使用 portable-pty 启动用户 shell 的交互实例；独立 PTY 不经过 agent 或审批队列。`open_terminal(id,cwd,cols,rows,onOutput)` / `write_terminal(id,data)` / `resize_terminal(id,cols,rows)` / `close_terminal(id)` / `ack_terminal(id)`；随机客户端 id 在异步启动前确定，关闭与启动共享注册表锁，前端即使在启动中卸载也等待启动结果后关闭，避免泄漏。IPC 使用 Tauri Channel 输出字节块（UTF-8 跨块由 xterm 解码），输出采用逐块应答背压，限制输入和尺寸；命令不阻塞 Tauri 主线程。
- 后端注册表只拥有本应用创建的 PTY；自然退出回收句柄并通知前端；关闭显式终止 shell 及其子进程并 wait 回收。应用退出/窗口销毁执行同样清理，Unix 通过原生 `getsid` 校验本 PTY 的独立 session，收集并终止各 job process group 中的进程（无法取得 session 时按自身树兜底），Windows 专项仍属 Phase 3。macOS 使用非阻塞 PTY 读取与可中断应答等待，关闭先释放 master/writer 再等待回收，避免 exiting 状态悬挂。终端仅在目录存在且为绝对路径时启动；失败显示错误，不自动创建目录。
- 不改数据库/schema。新增依赖理由：xterm 提供 ANSI/VT 解析和可访问输入，fit addon 匹配面板尺寸；portable-pty 提供真实 PTY/交互 shell 与窗口 resize，替代不支持 job control 的普通管道。

P2-9 依赖选择与实测：5.5.0 在 React StrictMode/面板销毁后存在 viewport 定时回调访问已销毁 renderer 的异常，改用 6.0.0 稳定版，重复开关/切换复测无异常。官方变更见 [xterm 6.0 发布说明](https://github.com/xtermjs/xterm.js/releases/tag/6.0.0)；PTY 读写/resize 使用 [portable-pty](https://github.com/wezterm/wezterm/tree/main/pty)。

### P2-10 — 整体验收发现的宿主收尾修复

CLI 与桌面宿主一致：driver 返回 `Err` 时，在关闭事件通道、等待 recorder 排空之前补发 `DriverError`，让已有会话落库为 failed；会话未建立时不制造伪档案。新建和续聊均用真实 CLI + 无网络 ACP 对端回归验证。release 版本徽标读取 Tauri 实际 app version，`dev` 后缀仅开发构建显示，不再硬编码版本。v0.3.0 按用户批准范围排除 P2-6 后发布；延期不影响已批准版本。



### Claude CLI 与 ACP 探测边界

内置 Claude 行的 installed_version 仍表示 ACP 适配器版本，不能由 claude --version 替代。新增 cli_version 可空字段，仅原样内置 Claude 命令另行并发探测 claude --version；自定义命令不套用此检测。定义列表（不探测）置 null。UI 单独展示 CLI 已检测版本与 ACP 已检测/未就绪；失败包含缺少程序、退出失败与超时等原因，因此统一“未检测到/未就绪”而非断言未安装。不读取登录或 key，不以版本结果保证认证可用。

## 12. 指挥官契约（dev，截至 P3-5）

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

### P3-6 — 桌面指挥官工作区（实现中）

新增独立导航“指挥官”：目标和绝对 cwd → 生成并保存 draft → 显示任务、agent、依赖批次及全部 prompt → 明确确认执行 → 进度/审批/结果。模型配置继续使用设置页，页面显示保存的模型与密钥是否就绪及设置入口，不重复输入 key。可限制规划 agent、设置并发 1～16；不创建目录/worktree、不读取项目文件、不自动执行计划。阶段固定变更前确认模式与默认空间，显式显示执行 cwd，避免引入未持久化权限草稿。

IPC generate_commander_run(request_id,objective,cwd,agents) 读取本机配置/密钥，限制注册表并校验目录，保存 P3-3 draft；list/get_commander_run_view 返回计划、批次、P3-5 summary 与 active 标志。execute_commander_run(run_id,confirmed,jobs,on_progress) 要求 confirmed=true 且 draft，复用 P3-4；同 App 最多一个生成或执行，guard 在全部清理后移除；cancel_commander_work(request_id) 只取消本 App 的请求，不改其他 CLI 正在执行记录。Channel 只传 task/session/事件类型进度，SQLite 是状态与结果事实源；切换导航不取消执行，页面重新进入按库读取，不重发 execute。

DispatchOptions 增 interactive_approvals（默认 false，CLI 行为不变），desktop=true 使用原 broker.resolve 而非 fail-closed。独立 broker 载入全局规则、固定 Ask；待决/裁决转发既有 permission-request/decision-record 并按 AppState.pending 路由 respond_permission。裁决只由调度器写一次 SQLite，转发任务不重复写；前端待决移除同时匹配 ACP session_id/tool_call_id，避免不同 agent 同名工具串台。指挥官任务内联显示其审批卡，审批中心仍可应答；取消联动拒绝挂起请求与裁决留痕。

退出请求有活跃指挥官工作时先阻止退出、取消 token 并等待 guard 清除/driver 回收，再退出。重启从 SQLite 恢复 draft/终态/任务结果与引用，不自动执行或重跑终态。非本 App 活跃的 running 记录显示“其他宿主或遗留运行”，禁止再执行/跨宿主取消；不会自动 recover 全库以免中断 CLI。崩溃遗留记录可由独占宿主显式执行核心恢复接口，桌面不会猜测其它进程已停止。恢复指恢复历史与草稿审阅，不承诺续跑已中断任务。

本阶段不新增迁移/包。布局采用主工作区+历史列表，分隔线组织任务，prompt 按需展开，状态和操作有可读文本；配置不足/预检失败保持草稿并提示，不把安装检测视为推理可用。验收 macOS WebKit；Windows 实机专项仍归 P3-8/9，不能用 macOS 宣称 Windows 通过。

## 13. 设计变更与历史

现行接口在对应章节原位更新；过程、失败尝试和验收结果写任务验收记录，重大决策写 ADR。[历史快照](history/architecture-through-p3-3.md) 保留原变更表与 P3-2/3 演进过程，不作为现行约定。

| 日期 | 变更 | 证据 |
|---|---|---|
| 2026-10-02 | P3-1～4 计划契约、直连 LLM/本机凭据与执行状态持久化已集成 dev | [验收索引](acceptance/README.md) |
| 2026-10-02 | 文档结构整理，替代过时的环境变量唯一来源与裸 JSON 唯一输出约定 | [整理验收](acceptance/docs-alignment.md) |
