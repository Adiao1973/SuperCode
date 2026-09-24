# ADR-0004: 首发只接入 opencode 验证链路

- 状态：已接受（2026-09-24，用户指定）

## 背景

Phase 0 可以选择一次接入多家（claude-code / codex / opencode）或只接一家打穿。用户明确：**初期只接 opencode 验证第一步**。

## 决策

Phase 0 / Phase 1 仅接入 opencode（`opencode acp`，原生 ACP）；claude-code、codex、MiMo 延至 Phase 2 经 ACP adapter 接入；ZCode 以 StreamJsonDriver 受限支持。

## 理由

- opencode 的 ACP 是**原生内置 + 官方文档化**，零 adapter、权限经 ACP 完整透传——验证链路的最短路径。
- 先把 AgentDriver / ApprovalBroker / 事件管道 / 存储这些**与具体 agent 无关的地基**在一家的真实负载下打磨稳定，再横向扩，返工最小。
- ACP 优先架构下，后续加 agent 的边际成本极低（注册表加 spawn 命令），"晚加"几乎不损失什么。

## 被否方案

| 方案 | 否决原因 |
|---|---|
| 三家齐上（claude+codex+opencode） | 接口最成熟但同期要调试两个 npx adapter + Node 依赖，验证周期拉长 |
| 五家一步到位 | ZCode 无 ACP 需自写 stream-json 适配器且权限体验有缺口，MVP 负担过重 |

## 影响

- Phase 0 验收剧本全部围绕 opencode；多 agent 并行场景的验证顺延到 Phase 2。
- AgentRegistry / AgentDefinition 从第一天就按多 agent 设计（内置表预留其余条目），避免单 agent 假设渗入接口。
- ZCode 定位明确标注：**受限支持**（headless + `--mode yolo` 预授权，无外部审批），不承诺审批中心体验。
