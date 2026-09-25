//! AcpDriver：经 ACP（Agent Client Protocol v1）驱动 agent 子进程（当前：opencode）。
//!
//! 进程生命周期由 SDK 管理：`AcpAgent` 以独立进程组 spawn，连接结束整组回收。
//! 事件经 `session/update` 通知流入，转换为统一的 [`AgentEvent`]。

use std::path::PathBuf;
use std::str::FromStr;

use agent_client_protocol::schema::v1 as acp;
use agent_client_protocol::{AcpAgent, Agent, Client as AcpClient, ConnectionTo};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::{
    PermissionDecision, PermissionHandler, PermissionOption, PermissionOptionKind,
    PermissionRequest,
};
use crate::error::{CoreError, Result};
use crate::events::{
    AgentEvent, ContentBlock, DiffPayload, FileLocation, PlanEntry, PlanEntryStatus, StopReason,
    ToolKind, ToolStatus,
};

/// ACP 的 message_id 缺失时，同一连接内 agent 输出共用的合成消息 id
///（一次性 run_prompt 只有一轮，合成 id 使聚合器可正确拼接）。
const SYNTHETIC_MESSAGE_ID: &str = "agent-message";

/// JSON-RPC internal error code，用于把 CoreError 映射进 SDK 的错误通道
const JSONRPC_INTERNAL_ERROR: i32 = -32603;

/// 取消宽限期：session/cancel 发出后等待 agent 以 Cancelled 收尾的上限，
/// 超时则由连接 teardown（ChildGuard 杀整组）兜底（docs/architecture.md §7）。
const CANCEL_GRACE: std::time::Duration = std::time::Duration::from_secs(10);

fn acp_error(err: CoreError) -> agent_client_protocol::Error {
    agent_client_protocol::Error::new(JSONRPC_INTERNAL_ERROR, err.to_string())
}

pub struct AcpDriver {
    /// spawn 命令（shell-words 语法，如 "opencode acp"）
    pub command: String,
}

/// 会话启动方式：新建或恢复既有 agent 会话。
#[derive(Debug, Clone)]
pub enum StartMode {
    /// session/new
    New,
    /// session/load：agent 重放历史通知后沿用原 session id 继续 prompt
    Load(String),
}

impl AcpDriver {
    pub fn new(command: impl Into<String>) -> Self {
        Self {
            command: command.into(),
        }
    }

    /// 一次性新会话（兼容入口）。见 [`Self::run`]。
    pub async fn run_prompt(
        &self,
        cwd: PathBuf,
        prompt: String,
        events: mpsc::Sender<AgentEvent>,
        permissions: PermissionHandler,
        cancel: CancellationToken,
    ) -> Result<StopReason> {
        self.run(cwd, StartMode::New, prompt, events, permissions, cancel)
            .await
    }

    /// 一次会话轮次：initialize → (session/new | session/load) → session/prompt。
    /// 事件实时送入 `events`；权限请求经 `permissions` 裁决；
    /// `cancel` 触发后走协议层取消（session/cancel → Cancelled → 超时 teardown 兜底）。
    pub async fn run(
        &self,
        cwd: PathBuf,
        mode: StartMode,
        prompt: String,
        events: mpsc::Sender<AgentEvent>,
        permissions: PermissionHandler,
        cancel: CancellationToken,
    ) -> Result<StopReason> {
        let agent = AcpAgent::from_str(&self.command)
            .map_err(|e| CoreError::Spawn(format!("{}: {e}", self.command)))?;

        let events_for_notification = events.clone();
        let permissions_for_request = permissions;

        let stop_reason = AcpClient
            .builder()
            .on_receive_notification(
                move |notification: acp::SessionNotification, _cx| {
                    let events = events_for_notification.clone();
                    async move {
                        if let Some(event) = convert_update(&notification.update) {
                            let _ = events.send(event).await;
                        }
                        Ok::<(), agent_client_protocol::Error>(())
                    }
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_request(
                move |request: acp::RequestPermissionRequest,
                      responder: agent_client_protocol::Responder<
                    acp::RequestPermissionResponse,
                >,
                      _connection| {
                    let permissions = permissions_for_request.clone();
                    async move {
                        let decision: Result<PermissionDecision> =
                            (*permissions)(convert_permission_request(&request)).await;
                        match decision {
                            Ok(decision) => responder.respond(acp::RequestPermissionResponse::new(
                                acp::RequestPermissionOutcome::Selected(
                                    acp::SelectedPermissionOutcome::new(decision.option_id),
                                ),
                            )),
                            Err(_) => responder.respond(acp::RequestPermissionResponse::new(
                                acp::RequestPermissionOutcome::Cancelled,
                            )),
                        }
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .connect_with(agent, move |connection: ConnectionTo<Agent>| async move {
                let _init = connection
                    .send_request(acp::InitializeRequest::new(
                        agent_client_protocol::schema::ProtocolVersion::V1,
                    ))
                    .block_task()
                    .await
                    .map_err(|e| acp_error(CoreError::Protocol(format!("initialize 失败: {e}"))))?;

                let session_id = match mode {
                    StartMode::New => {
                        let session = connection
                            .send_request(acp::NewSessionRequest::new(cwd))
                            .block_task()
                            .await
                            .map_err(|e| {
                                acp_error(CoreError::Protocol(format!("session/new 失败: {e}")))
                            })?;
                        session.session_id
                    }
                    StartMode::Load(agent_session_id) => {
                        let session_id = acp::SessionId::from(agent_session_id);
                        // 重放的历史通知会先于响应流入 events 通道
                        connection
                            .send_request(acp::LoadSessionRequest::new(session_id.clone(), cwd))
                            .block_task()
                            .await
                            .map_err(|e| {
                                acp_error(CoreError::Protocol(format!("session/load 失败: {e}")))
                            })?;
                        // session/load 沿用原 session id（LoadSessionResponse 无新 id）
                        session_id
                    }
                };
                let _ = events
                    .send(AgentEvent::SessionStarted {
                        session_id: session_id.0.to_string(),
                    })
                    .await;

                let prompt_task = connection
                    .send_request(acp::PromptRequest::new(
                        session_id.clone(),
                        vec![acp::ContentBlock::Text(acp::TextContent::new(prompt))],
                    ))
                    .block_task();
                tokio::pin!(prompt_task);

                let response = tokio::select! {
                    res = &mut prompt_task => res.map_err(|e| {
                        acp_error(CoreError::Protocol(format!("session/prompt 失败: {e}")))
                    })?,
                    _ = cancel.cancelled() => {
                        // 协议层取消优先；失败不致命（连接 teardown 仍会兜底）
                        if let Err(e) = connection.send_notification(acp::CancelNotification::new(
                            session_id.clone(),
                        )) {
                            return Err(acp_error(CoreError::Protocol(format!(
                                "session/cancel 发送失败: {e}"
                            ))));
                        }
                        // 等待 agent 以 Cancelled 收尾；超时交给 teardown（ChildGuard 杀整组）
                        match tokio::time::timeout(CANCEL_GRACE, &mut prompt_task).await {
                            Ok(res) => res.map_err(|e| {
                                acp_error(CoreError::Protocol(format!("session/prompt 失败: {e}")))
                            })?,
                            Err(_) => {
                                return Err(acp_error(CoreError::Timeout(
                                    "agent 未在取消宽限期内响应，连接将被强制回收".into(),
                                )))
                            }
                        }
                    }
                };

                // 无论正常结束还是取消，轮次终点必须以 TurnCompleted 事件广播
                //（宿主依赖它落库/收尾，不只是拿 run() 的返回值）
                let stop_reason = StopReason::from(response.stop_reason);
                let _ = events.send(AgentEvent::TurnCompleted { stop_reason }).await;

                Ok::<StopReason, agent_client_protocol::Error>(stop_reason)
            })
            .await
            .map_err(|e| CoreError::Protocol(e.to_string()))?;

        Ok(stop_reason)
    }
}

/// ACP `SessionUpdate` → 统一 `AgentEvent`（纯函数，单测覆盖）。
/// 返回 None 的事件（用户消息回显、模式/配置更新等）在 P0-4 阶段忽略。
fn convert_update(update: &acp::SessionUpdate) -> Option<AgentEvent> {
    use acp::SessionUpdate as U;
    match update {
        U::AgentMessageChunk(chunk) => {
            let text = extract_text(&chunk.content)?;
            Some(AgentEvent::MessageChunk {
                message_id: chunk
                    .message_id
                    .as_ref()
                    .map(|id| id.0.to_string())
                    .unwrap_or_else(|| SYNTHETIC_MESSAGE_ID.into()),
                text,
            })
        }
        U::AgentThoughtChunk(chunk) => {
            let text = extract_text(&chunk.content)?;
            Some(AgentEvent::ThoughtChunk {
                message_id: chunk
                    .message_id
                    .as_ref()
                    .map(|id| id.0.to_string())
                    .unwrap_or_else(|| SYNTHETIC_MESSAGE_ID.into()),
                text,
            })
        }
        U::ToolCall(call) => Some(AgentEvent::ToolCall {
            tool_call_id: call.tool_call_id.0.to_string(),
            name: call.name.clone(),
            title: Some(call.title.clone()),
            kind: ToolKind::from(call.kind),
            raw_input: call.raw_input.clone(),
            diff: extract_diff(&call.content),
        }),
        U::ToolCallUpdate(update) => Some(AgentEvent::ToolCallUpdate {
            tool_call_id: update.tool_call_id.0.to_string(),
            status: update.fields.status.map(ToolStatus::from),
            content: update
                .fields
                .content
                .as_deref()
                .unwrap_or_default()
                .iter()
                .filter_map(convert_tool_content)
                .collect(),
            locations: update
                .fields
                .locations
                .as_deref()
                .unwrap_or_default()
                .iter()
                .map(|loc| FileLocation {
                    path: loc.path.clone(),
                    line: loc.line,
                })
                .collect(),
            diff: update.fields.content.as_deref().and_then(extract_diff),
        }),
        U::Plan(plan) => Some(AgentEvent::Plan {
            entries: plan
                .entries
                .iter()
                .map(|entry| PlanEntry {
                    content: entry.content.clone(),
                    status: PlanEntryStatus::from(entry.status.clone()),
                })
                .collect(),
        }),
        U::UsageUpdate(usage) => Some(AgentEvent::UsageUpdate {
            used: Some(usage.used),
            size: Some(usage.size),
            cost: usage.cost.as_ref().map(|c| c.amount),
        }),
        // 用户消息回显 / 模式与配置更新 / session_info：P0-4 忽略
        _ => None,
    }
}

fn extract_text(block: &acp::ContentBlock) -> Option<String> {
    match block {
        acp::ContentBlock::Text(text) => Some(text.text.clone()),
        _ => None,
    }
}

fn convert_tool_content(content: &acp::ToolCallContent) -> Option<ContentBlock> {
    match content {
        acp::ToolCallContent::Content(block) => match &block.content {
            acp::ContentBlock::Text(text) => Some(ContentBlock::Text {
                text: text.text.clone(),
            }),
            acp::ContentBlock::ResourceLink(link) => Some(ContentBlock::ResourceLink {
                uri: link.uri.clone(),
            }),
            _ => None,
        },
        // Diff 走 ToolCall/ToolCallUpdate 的专属字段；Terminal 呈现留待后续
        _ => None,
    }
}

/// 提取工具事件 content 中的首个 Diff 块（opencode edit 类工具携带）
fn extract_diff(content: &[acp::ToolCallContent]) -> Option<DiffPayload> {
    content.iter().find_map(|item| match item {
        acp::ToolCallContent::Diff(diff) => Some(DiffPayload {
            path: diff.path.to_string_lossy().into_owned(),
            old_text: diff.old_text.clone(),
            new_text: diff.new_text.clone(),
        }),
        _ => None,
    })
}

fn convert_permission_request(request: &acp::RequestPermissionRequest) -> PermissionRequest {
    PermissionRequest {
        session_id: request.session_id.0.to_string(),
        tool_call_id: request.tool_call.tool_call_id.0.to_string(),
        tool_name: request
            .tool_call
            .fields
            .title
            .clone()
            .or_else(|| request.tool_call.fields.name.clone())
            .unwrap_or_else(|| "未知工具".into()),
        raw_input: request.tool_call.fields.raw_input.clone(),
        options: request
            .options
            .iter()
            .map(|option| PermissionOption {
                option_id: option.option_id.0.to_string(),
                name: option.name.clone(),
                kind: PermissionOptionKind::from(option.kind),
            })
            .collect(),
    }
}

impl From<acp::ToolKind> for ToolKind {
    fn from(kind: acp::ToolKind) -> Self {
        match kind {
            acp::ToolKind::Read => Self::Read,
            acp::ToolKind::Edit => Self::Edit,
            acp::ToolKind::Delete => Self::Delete,
            acp::ToolKind::Move => Self::Move,
            acp::ToolKind::Search => Self::Search,
            acp::ToolKind::Execute => Self::Execute,
            acp::ToolKind::Fetch => Self::Fetch,
            _ => Self::Other,
        }
    }
}

impl From<acp::ToolCallStatus> for ToolStatus {
    fn from(status: acp::ToolCallStatus) -> Self {
        match status {
            acp::ToolCallStatus::Pending => Self::Pending,
            acp::ToolCallStatus::InProgress => Self::InProgress,
            acp::ToolCallStatus::Completed => Self::Completed,
            acp::ToolCallStatus::Failed => Self::Failed,
            _ => Self::Failed,
        }
    }
}

impl From<acp::PlanEntryStatus> for PlanEntryStatus {
    fn from(status: acp::PlanEntryStatus) -> Self {
        match status {
            acp::PlanEntryStatus::Pending => Self::Pending,
            acp::PlanEntryStatus::InProgress => Self::InProgress,
            acp::PlanEntryStatus::Completed => Self::Completed,
            _ => Self::Completed,
        }
    }
}

impl From<acp::StopReason> for StopReason {
    fn from(reason: acp::StopReason) -> Self {
        match reason {
            acp::StopReason::EndTurn => Self::EndTurn,
            acp::StopReason::Cancelled => Self::Cancelled,
            acp::StopReason::MaxTokens => Self::MaxTokens,
            acp::StopReason::MaxTurnRequests => Self::MaxTurnRequests,
            acp::StopReason::Refusal => Self::Refusal,
            _ => Self::EndTurn,
        }
    }
}

impl From<acp::PermissionOptionKind> for PermissionOptionKind {
    fn from(kind: acp::PermissionOptionKind) -> Self {
        match kind {
            acp::PermissionOptionKind::AllowOnce => Self::AllowOnce,
            acp::PermissionOptionKind::AllowAlways => Self::AllowAlways,
            acp::PermissionOptionKind::RejectOnce => Self::RejectOnce,
            acp::PermissionOptionKind::RejectAlways => Self::RejectAlways,
            _ => Self::RejectOnce,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_chunk(text: &str) -> acp::ContentChunk {
        acp::ContentChunk::new(acp::ContentBlock::Text(acp::TextContent::new(text)))
    }

    #[test]
    fn 消息块转换为message_chunk() {
        let event =
            convert_update(&acp::SessionUpdate::AgentMessageChunk(text_chunk("你好"))).unwrap();
        assert_eq!(
            event,
            AgentEvent::MessageChunk {
                message_id: SYNTHETIC_MESSAGE_ID.into(),
                text: "你好".into(),
            }
        );
    }

    #[test]
    fn 非文本消息块被忽略() {
        let chunk = acp::ContentChunk::new(acp::ContentBlock::Image(acp::ImageContent::new(
            "data",
            "image/png",
        )));
        assert!(convert_update(&acp::SessionUpdate::AgentMessageChunk(chunk)).is_none());
    }

    #[test]
    fn 工具调用与状态更新转换() {
        let call = acp::ToolCall::new("t1", "读取 Cargo.toml").kind(acp::ToolKind::Read);
        let event = convert_update(&acp::SessionUpdate::ToolCall(call)).unwrap();
        match event {
            AgentEvent::ToolCall {
                tool_call_id,
                kind,
                title,
                ..
            } => {
                assert_eq!(tool_call_id, "t1");
                assert_eq!(kind, ToolKind::Read);
                assert_eq!(title.as_deref(), Some("读取 Cargo.toml"));
            }
            other => panic!("应为 ToolCall: {other:?}"),
        }

        let update = acp::ToolCallUpdate::new(
            "t1",
            acp::ToolCallUpdateFields::new().status(acp::ToolCallStatus::Completed),
        );
        let event = convert_update(&acp::SessionUpdate::ToolCallUpdate(update)).unwrap();
        assert_eq!(
            event,
            AgentEvent::ToolCallUpdate {
                tool_call_id: "t1".into(),
                status: Some(ToolStatus::Completed),
                content: Vec::new(),
                locations: Vec::new(),
                diff: None,
            }
        );
    }

    /// P1-4：opencode edit 类工具在 content 中携带 Diff 块，须映射为结构化 diff
    #[test]
    fn 工具事件提取diff内容块() {
        let diff = acp::Diff::new("/tmp/a.txt", "新内容").old_text("旧内容");
        let call = acp::ToolCall::new("t1", "编辑 a.txt")
            .kind(acp::ToolKind::Edit)
            .content(vec![acp::ToolCallContent::Diff(diff)]);
        let event = convert_update(&acp::SessionUpdate::ToolCall(call)).unwrap();
        match event {
            AgentEvent::ToolCall { diff, kind, .. } => {
                let diff = diff.expect("ToolCall 应携带 diff");
                assert_eq!(kind, ToolKind::Edit);
                assert_eq!(diff.path, "/tmp/a.txt");
                assert_eq!(diff.old_text.as_deref(), Some("旧内容"));
                assert_eq!(diff.new_text, "新内容");
            }
            other => panic!("应为 ToolCall: {other:?}"),
        }

        // 新建文件：old_text 缺省（None）→ 全部为新增
        let update = acp::ToolCallUpdate::new(
            "t1",
            acp::ToolCallUpdateFields::new().content(vec![acp::ToolCallContent::Diff(
                acp::Diff::new("/tmp/b.txt", "新文件内容"),
            )]),
        );
        let event = convert_update(&acp::SessionUpdate::ToolCallUpdate(update)).unwrap();
        match event {
            AgentEvent::ToolCallUpdate { diff, .. } => {
                let diff = diff.expect("ToolCallUpdate 应携带 diff");
                assert_eq!(diff.old_text, None);
                assert_eq!(diff.new_text, "新文件内容");
            }
            other => panic!("应为 ToolCallUpdate: {other:?}"),
        }
    }

    #[test]
    fn 用量更新转换() {
        let usage = acp::UsageUpdate::new(1200, 200000).cost(acp::Cost::new(0.05, "USD"));
        let event = convert_update(&acp::SessionUpdate::UsageUpdate(usage)).unwrap();
        assert_eq!(
            event,
            AgentEvent::UsageUpdate {
                used: Some(1200),
                size: Some(200000),
                cost: Some(0.05),
            }
        );
    }

    #[test]
    fn 用户消息回显被忽略() {
        let chunk = acp::ContentChunk::new(acp::ContentBlock::Text(acp::TextContent::new("hi")));
        assert!(convert_update(&acp::SessionUpdate::UserMessageChunk(chunk)).is_none());
    }
}

#[cfg(test)]
mod debug_tests {
    use super::*;

    /// P1-4 排查：模拟 opencode write 工具的首事件，打印前端实际收到的 JSON
    #[test]
    fn 调试_write首事件json() {
        let call = acp::ToolCall::new("t1", "write w.txt")
            .kind(acp::ToolKind::Edit)
            .name("write")
            .raw_input(serde_json::json!({"content": "abc\n", "filePath": "/tmp/w.txt"}));
        let event = convert_update(&acp::SessionUpdate::ToolCall(call)).unwrap();
        println!("WRITE_EVENT_JSON: {}", serde_json::to_string(&event).unwrap());
    }
}
