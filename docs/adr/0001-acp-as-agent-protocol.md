# ADR-0001: 采用 ACP（Agent Client Protocol）作为 agent 接入协议

- 状态：已接受（2026-09-24）
- 决策人：项目发起人 + ZCode 研究结论

## 背景

SuperCode 需要以外部程序身份驱动多家 agent CLI（opencode / claude-code / codex / MiMo-Code / ZCode）。候选接入方式：Zed 的 ACP、MCP 反向编排（agent 作为 MCP server）、Google A2A、各家原生协议（stream-json / app-server / HTTP server）、tmux 刮屏。

## 决策

以 **ACP v1 作为通用接入底座**：客户端 spawn agent 子进程，stdio JSON-RPC；headless stream-json 作兜底（StreamJsonDriver），原生协议（NativeDriver）留作后续增强。

## 理由

- ACP 是专为"GUI 客户端总控 agent"设计的协议：多会话并发、流式 chunk、工具调用展示、**权限审批转发客户端**、会话持久化（session/load/list）一应俱全。
- v1 稳定，Zed / JetBrains 生产验证；官方 Rust crate `agent-client-protocol`（Zed 自用）。
- 生态红利：opencode / MiMo 原生支持；claude-code、codex 有官方 adapter——新增 agent ≈ 注册表加一条 spawn 命令。

## 被否方案

| 方案 | 否决原因 |
|---|---|
| MCP 反向编排 | MCP 是 agent↔tool 协议：无会话概念、无 turn 生命周期、无面向人的审批与 diff 流，UI 语义全要自己发明 |
| Google A2A | 面向跨组织远程多 agent 委托，无本地文件信任模型与审批 UI，场景错位 |
| 仅各家原生协议 | 每家一套、无法统一扩展；作为 ACP 的补充保留（NativeDriver，Phase 3） |
| tmux 刮屏 | 脆弱（依赖 TUI 渲染细节）、无法结构化拿到权限语义 |

## 影响

- 锁定 ACP **v1** + `protocolVersion` 协商；v2（Draft）不提前采用。
- ZCode 无 ACP → 只能 StreamJsonDriver 受限支持（见 ADR-0004）。
- adapter 换名风险（社区包迁徙频繁）通过 AgentRegistry 可配置 spawn 命令缓解。
