//! Agent 适配层：统一权限模型与各协议 driver。
//! `AgentDriver` trait 的完整定义见 docs/architecture.md §4.2（多 driver 出现时 trait 化）。

mod acp;

pub use acp::{AcpDriver, StartMode};

use futures::future::BoxFuture;
use std::sync::Arc;

use crate::error::Result;

/// driver 层向审批方（ApprovalBroker / CLI 交互）发起的权限请求。
#[derive(Debug, Clone)]
pub struct PermissionRequest {
    pub session_id: String,
    pub tool_call_id: String,
    /// 展示用：工具名或标题（尽力而为，各协议字段不同）
    pub tool_name: String,
    pub raw_input: Option<serde_json::Value>,
    /// agent 提供的可选项（option_id 是 agent 侧的不透明字符串，kind 才是语义）
    pub options: Vec<PermissionOption>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionOption {
    pub option_id: String,
    pub name: String,
    pub kind: PermissionOptionKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionOptionKind {
    AllowOnce,
    AllowAlways,
    RejectOnce,
    RejectAlways,
}

impl PermissionOptionKind {
    pub fn is_allow(self) -> bool {
        matches!(self, Self::AllowOnce | Self::AllowAlways)
    }
}

/// 审批裁决：回写 agent 提供的 option_id（不透明，须来自 options 列表）。
#[derive(Debug, Clone)]
pub struct PermissionDecision {
    pub option_id: String,
    pub updated_input: Option<serde_json::Value>,
}

/// 权限回调：阻塞等待裁决结果（等待期间 agent 的这一轮挂起）。
pub type PermissionHandler =
    Arc<dyn Fn(PermissionRequest) -> BoxFuture<'static, Result<PermissionDecision>> + Send + Sync>;
