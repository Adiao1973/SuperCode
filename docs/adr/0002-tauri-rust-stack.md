# ADR-0002: 技术栈采用 Tauri v2 + Rust

- 状态：已接受（2026-09-24，用户指定）

## 背景

桌面客户端（Mac 优先、后续 Windows）需要在 Electron 与 Tauri 之间选型。用户明确不使用 Electron。

## 决策

**Tauri v2 桌面壳 + Rust 核心**：所有核心逻辑（driver / 审批 / 进程管理 / 存储）放在与 UI 解耦的 Rust workspace crates（`supercode-core`），CLI 与桌面 app 都是它的宿主。

## 理由

- 包小、内存占用低（系统 WebView：macOS WKWebView / Windows WebView2）。
- Rust 侧生态满足全部关键需求：`agent-client-protocol` crate（ACP 客户端）、`command_group`（进程组杀树）、`sqlx`（SQLite）、`portable-pty`、Tauri sidecar。
- 同类最成熟开源参照 Vibe Kanban（Apache-2.0）即 Rust + Tauri，架构可直接借鉴。
- Windows 兼容性无障碍：上述依赖均跨平台。

## 被否方案

| 方案 | 否决原因 |
|---|---|
| Electron + TypeScript | 用户否决；包大内存高（其优势——TS SDK 全家桶——经 ACP adapter 子进程化后不再必要） |
| Tauri 壳 + Node sidecar | 多一层运行时与调试复杂度；Rust 生态已够用 |

## 影响

- Claude Agent SDK（仅 TS/Python）不可直接用：claude-code 接入走官方 ACP adapter 子进程；若 Phase 3 需要 Claude 原生控制协议，参考 vibe-kanban 的 Apache-2.0 Rust 实现。
- npx 型 adapter 依赖本机 Node：Phase 2 做探测引导，必要时 sidecar 打包。
- 承担 WKWebView 的 CSS 兼容成本（见 architecture.md §10 红线）。
