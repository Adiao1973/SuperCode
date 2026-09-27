//! 统一事件模型 `AgentEvent`：所有 driver 的输出归一到该模型，
//! 变体直接对齐 ACP v1 `session/update`（docs/architecture.md §4.1）。

mod aggregator;

pub use aggregator::EventAggregator;

use std::path::PathBuf;

use serde::Serialize;

/// 一个 agent 会话产生的统一事件流。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    /// 会话已创建（含 sessionId）
    SessionStarted { session_id: String },

    /// agent 消息增量块（同一 message_id 的 chunk 按序拼接；ACP 的 message_id
    /// 可选，缺失时由 driver 按连接合成固定 id）
    MessageChunk { message_id: String, text: String },

    /// agent 思考过程增量块（ACP agent_thought_chunk）
    ThoughtChunk { message_id: String, text: String },

    /// 工具调用（首次出现，status=pending；ACP 的 name/raw_input 均可选）
    ToolCall {
        tool_call_id: String,
        name: Option<String>,
        title: Option<String>,
        kind: ToolKind,
        raw_input: Option<serde_json::Value>,
        /// ACP `ToolCallContent::Diff` 映射（opencode edit 类工具随首事件携带）
        diff: Option<DiffPayload>,
    },

    /// 工具调用状态更新（status 可选：update 可能只带 content/locations）
    ToolCallUpdate {
        tool_call_id: String,
        status: Option<ToolStatus>,
        content: Vec<ContentBlock>,
        locations: Vec<FileLocation>,
        /// 有值时覆盖同 id 工具此前的 diff
        diff: Option<DiffPayload>,
    },

    /// agent 生成的计划（plan 模式）
    Plan { entries: Vec<PlanEntry> },

    /// token/费用用量更新
    UsageUpdate {
        used: Option<u64>,
        size: Option<u64>,
        cost: Option<f64>,
    },

    /// 一轮对话结束
    TurnCompleted { stop_reason: StopReason },

    /// driver 层错误（进程崩溃、协议异常等）
    DriverError { message: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolKind {
    Read,
    Edit,
    Delete,
    Move,
    Search,
    Execute,
    Fetch,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text { text: String },
    Image { data: String, mime_type: String },
    ResourceLink { uri: String },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FileLocation {
    pub path: PathBuf,
    pub line: Option<u32>,
}

/// 结构化文件修改，对齐 ACP `ToolCallContent::Diff`。
/// diff 计算与渲染由前端完成（@git-diff-view/react 接收原始新旧内容）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DiffPayload {
    pub path: String,
    /// None 表示新建文件（整文件为新增）
    pub old_text: Option<String>,
    pub new_text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PlanEntry {
    pub content: String,
    pub status: PlanEntryStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanEntryStatus {
    Pending,
    InProgress,
    Completed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    EndTurn,
    Cancelled,
    MaxTokens,
    MaxTurnRequests,
    Refusal,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 事件经 Tauri Channel 送往前端，序列化格式（snake_case tag）是与前端的契约，锁死。
    #[test]
    fn 序列化格式_符合前端契约() {
        let ev = AgentEvent::MessageChunk {
            message_id: "m1".into(),
            text: "你好".into(),
        };
        let json = serde_json::to_value(&ev).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"type": "message_chunk", "message_id": "m1", "text": "你好"})
        );

        let ev = AgentEvent::ToolCallUpdate {
            tool_call_id: "t1".into(),
            status: Some(ToolStatus::InProgress),
            content: vec![ContentBlock::Text { text: "ok".into() }],
            locations: Vec::new(),
            diff: None,
        };
        let json = serde_json::to_value(&ev).unwrap();
        assert_eq!(json["type"], "tool_call_update");
        assert_eq!(json["status"], "in_progress");
        assert_eq!(json["content"][0]["type"], "text");

        let ev = AgentEvent::ToolCall {
            tool_call_id: "t2".into(),
            name: Some("write".into()),
            title: Some("write file".into()),
            kind: ToolKind::Edit,
            raw_input: None,
            diff: Some(DiffPayload {
                path: "/tmp/a.txt".into(),
                old_text: None,
                new_text: "hi\n".into(),
            }),
        };
        let json = serde_json::to_value(&ev).unwrap();
        assert_eq!(json["diff"]["path"], "/tmp/a.txt");
        assert_eq!(json["diff"]["new_text"], "hi\n");
        assert_eq!(json["diff"]["old_text"], serde_json::Value::Null);
    }
}
