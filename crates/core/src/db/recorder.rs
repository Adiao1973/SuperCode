//! SessionRecorder：消费 `AgentEvent` 事件流并落库。
//! 消息 chunk 在 TurnCompleted 时组装为完整 agent 消息写入（避免逐 chunk 写库）。

use std::collections::HashMap;

use uuid::Uuid;

use super::Store;
use crate::error::Result;
use crate::events::{AgentEvent, StopReason, ToolStatus};

pub struct SessionRecorder {
    store: Store,
    session: Uuid,
    agent_id: String,
    cwd: String,
    title: String,
    /// 会话建立后待落库的用户提示词（SessionStarted 时随会话行一起写入；
    /// resume 时同样记录——它是本轮新的用户消息）
    pending_user_prompt: Option<String>,
    /// 当前轮各消息的累积文本：message_id → 已拼接文本
    pending_messages: HashMap<String, String>,
}

impl SessionRecorder {
    pub fn new(
        store: Store,
        session: Uuid,
        agent_id: &str,
        cwd: &str,
        title: &str,
        user_prompt: &str,
    ) -> Self {
        Self {
            store,
            session,
            agent_id: agent_id.to_string(),
            cwd: cwd.to_string(),
            title: title.to_string(),
            pending_user_prompt: Some(user_prompt.to_string()),
            pending_messages: HashMap::new(),
        }
    }

    /// 消费一条事件并落库。错误只影响持久化，不打断事件流消费。
    pub async fn handle_event(&mut self, event: &AgentEvent) {
        let result = match event {
            AgentEvent::SessionStarted { session_id } => {
                let mut result = self
                    .store
                    .insert_session(
                        self.session,
                        &self.agent_id,
                        session_id,
                        &self.cwd,
                        &self.title,
                    )
                    .await;
                if result.is_ok()
                    && let Some(prompt) = self.pending_user_prompt.take()
                {
                    result = self.store.insert_user_message(self.session, &prompt).await;
                }
                result
            }
            AgentEvent::MessageChunk { message_id, text } => {
                self.pending_messages
                    .entry(message_id.clone())
                    .or_default()
                    .push_str(text);
                Ok(())
            }
            AgentEvent::ToolCall {
                tool_call_id,
                name,
                kind,
                raw_input,
                ..
            } => {
                self.store
                    .upsert_tool_call(
                        self.session,
                        tool_call_id,
                        name.as_deref(),
                        Some(&format!("{kind:?}").to_lowercase()),
                        Some("pending"),
                        raw_input.as_ref().map(|value| value.to_string()).as_deref(),
                    )
                    .await
            }
            AgentEvent::ToolCallUpdate {
                tool_call_id,
                status,
                ..
            } => {
                if let Some(status) = status {
                    let text = match status {
                        ToolStatus::Pending => "pending",
                        ToolStatus::InProgress => "in_progress",
                        ToolStatus::Completed => "completed",
                        ToolStatus::Failed => "failed",
                    };
                    self.store
                        .upsert_tool_call(self.session, tool_call_id, None, None, Some(text), None)
                        .await
                } else {
                    Ok(())
                }
            }
            AgentEvent::TurnCompleted { stop_reason } => {
                let status = match stop_reason {
                    StopReason::EndTurn => "completed",
                    StopReason::Cancelled => "cancelled",
                    _ => "failed",
                };
                match self.flush_messages().await {
                    Ok(()) => self.store.update_session_status(self.session, status).await,
                    Err(err) => Err(err),
                }
            }
            AgentEvent::DriverError { .. } => {
                self.store
                    .update_session_status(self.session, "failed")
                    .await
            }
            _ => Ok(()),
        };
        if let Err(err) = result {
            eprintln!("\x1b[2m· 持久化警告: {err}\x1b[0m");
        }
    }

    /// 轮次开始前显式记录用户消息（CLI 已由构造参数自动处理，保留给其他宿主）。
    pub async fn record_user_message(&self, prompt: &str) -> Result<()> {
        self.store.insert_user_message(self.session, prompt).await
    }

    /// 将本轮累积的 agent 消息落库并清空缓冲。
    async fn flush_messages(&mut self) -> Result<()> {
        let drained: Vec<String> = self.pending_messages.drain().map(|(_, v)| v).collect();
        for text in drained {
            if !text.trim().is_empty() {
                self.store.insert_agent_message(self.session, &text).await?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::Store;
    use super::*;
    use crate::events::{ContentBlock, ToolKind, ToolStatus};
    use sqlx::Row;

    /// 验收：事件流（SessionStarted → chunks → tool → TurnCompleted）落库成完整记录
    #[tokio::test]
    async fn 事件流落库为会话消息与工具调用() {
        let store = Store::open_in_memory().await.unwrap();
        store
            .upsert_agent("opencode", "OpenCode", "acp", None)
            .await
            .unwrap();
        let sid = Uuid::new_v4();
        let mut recorder =
            SessionRecorder::new(store.clone(), sid, "opencode", "/tmp", "标题", "你好");

        recorder
            .handle_event(&AgentEvent::SessionStarted {
                session_id: "ses_agent_1".into(),
            })
            .await;

        for text in ["你好", "，", "我是 agent"] {
            recorder
                .handle_event(&AgentEvent::MessageChunk {
                    message_id: "m1".into(),
                    text: text.into(),
                })
                .await;
        }
        recorder
            .handle_event(&AgentEvent::ToolCall {
                tool_call_id: "call_1".into(),
                name: Some("bash".into()),
                title: Some("git status".into()),
                kind: ToolKind::Execute,
                raw_input: None,
            })
            .await;
        recorder
            .handle_event(&AgentEvent::ToolCallUpdate {
                tool_call_id: "call_1".into(),
                status: Some(ToolStatus::Completed),
                content: vec![ContentBlock::Text { text: "ok".into() }],
                locations: Vec::new(),
                diff: None,
            })
            .await;
        recorder
            .handle_event(&AgentEvent::TurnCompleted {
                stop_reason: StopReason::EndTurn,
            })
            .await;

        // 会话行（SessionStarted 落库，TurnCompleted 更新状态）
        let session = store.get_session(sid).await.unwrap().unwrap();
        assert_eq!(session.agent_session_id, "ses_agent_1");
        assert_eq!(session.status, "completed");

        // 消息：user 1 条 + agent 1 条（三个 chunk 组装）
        let roles: Vec<String> =
            sqlx::query("SELECT role, content_json FROM messages ORDER BY created_at")
                .fetch_all(&store.pool)
                .await
                .unwrap()
                .iter()
                .map(|row| row.get("role"))
                .collect();
        assert_eq!(roles, vec!["user".to_string(), "agent".to_string()]);

        let agent_text: String =
            sqlx::query("SELECT content_json FROM messages WHERE role='agent'")
                .fetch_one(&store.pool)
                .await
                .unwrap()
                .get("content_json");
        assert!(
            agent_text.contains("你好，我是 agent"),
            "chunk 应组装完整: {agent_text}"
        );
    }
}
