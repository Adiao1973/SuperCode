//! 统一错误类型（docs/architecture.md §8）。变体随模块落地逐步增补。

/// core 内部统一 Result 别名。
pub type Result<T> = std::result::Result<T, CoreError>;

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    /// spawn 子进程失败（含进程组创建失败）
    #[error("spawn 进程失败: {0}")]
    Spawn(String),

    /// ACP/JSON-RPC 协议层错误（握手失败、非法响应等）
    #[error("协议错误: {0}")]
    Protocol(String),

    /// 操作的进程句柄不存在（已 wait 移除，或从未 spawn）
    #[error("进程不存在: {0}")]
    ProcessNotFound(u64),

    /// 审批链路失败（fail-closed：未知请求、通道关闭等，一律不放行）
    #[error("审批失败: {0}")]
    PermissionFailed(String),

    /// io 错误
    #[error("io 错误: {0}")]
    Io(#[from] std::io::Error),
}
