//! supercode-core — SuperCode 的 Rust 核心库，与宿主（CLI / Tauri 桌面）完全解耦。
//!
//! 模块划分与接口语义的单一事实源：`docs/architecture.md`。
//! 当前为 Phase 0 脚手架：各模块为占位，随后续任务（P0-2 起）逐步填充。
//!
//! - [`driver`] — Agent 适配层，统一 `AgentDriver` trait 与实现
//! - [`approval`] — ApprovalBroker，统一审批队列 + 预授权规则引擎
//! - [`events`] — 统一事件模型 `AgentEvent` 与帧级合帧聚合器
//! - [`proc`] — 进程管理器（进程组 spawn / 杀树 / 心跳 / 退出清理）
//! - [`registry`] — AgentRegistry，agent 定义与安装探测
//! - [`db`] — sqlx + SQLite 持久化
//! - [`orchestrator`] — 编排核心，会话生命周期与任务调度

pub mod approval;
pub mod db;
pub mod driver;
pub mod error;
pub mod events;
pub mod orchestrator;
pub mod proc;
pub mod registry;

/// 核心 crate 版本，与 workspace 版本保持一致。
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod tests {
    use super::VERSION;

    #[test]
    fn version_is_defined() {
        assert!(!VERSION.is_empty());
    }
}
