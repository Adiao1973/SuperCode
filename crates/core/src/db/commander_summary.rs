use super::{PlanStatus, Store, TaskStatus};
use crate::error::{CoreError, Result};
use serde::Serialize;
use uuid::Uuid;
#[derive(Debug, Default, Serialize)]
pub struct TaskCounts {
    pub pending: usize,
    pub running: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub skipped: usize,
    pub cancelled: usize,
    pub interrupted: usize,
}
#[derive(Debug, Serialize)]
pub struct TaskSummary {
    pub id: String,
    pub title: String,
    pub agent_id: String,
    pub depends_on: Vec<String>,
    pub status: TaskStatus,
    pub session_id: Option<Uuid>,
    pub agent_session_id: Option<String>,
    pub result: Option<String>,
    pub truncated: bool,
}
#[derive(Debug, Serialize)]
pub struct RunSummary {
    pub run_id: Uuid,
    pub objective: String,
    pub cwd: String,
    pub status: PlanStatus,
    pub counts: TaskCounts,
    pub tasks: Vec<TaskSummary>,
}
impl Store {
    pub async fn summarize_commander_run(&self, id: Uuid) -> Result<RunSummary> {
        let run = self
            .get_commander_run(id)
            .await?
            .ok_or_else(|| CoreError::Protocol("指挥官计划不存在".into()))?;
        let mut counts = TaskCounts::default();
        let mut tasks = Vec::new();
        for task in &run.plan.tasks {
            let state = run
                .tasks
                .iter()
                .find(|s| s.id == task.id)
                .ok_or_else(|| CoreError::Db("计划任务状态缺失".into()))?;
            match state.status {
                TaskStatus::Pending => counts.pending += 1,
                TaskStatus::Running => counts.running += 1,
                TaskStatus::Succeeded => counts.succeeded += 1,
                TaskStatus::Failed => counts.failed += 1,
                TaskStatus::Skipped => counts.skipped += 1,
                TaskStatus::Cancelled => counts.cancelled += 1,
                TaskStatus::Interrupted => counts.interrupted += 1,
            }
            let mut remote = None;
            let mut result = None;
            let mut truncated = false;
            if let Some(sid) = state.session_id
                && let Some(session) = self.get_session(sid).await?
            {
                if session.agent_id != task.agent_id || session.cwd != run.cwd {
                    return Err(CoreError::Db("指挥官会话引用归属不一致".into()));
                }
                let content:Option<String>=sqlx::query_scalar("SELECT content_json FROM messages WHERE session_id=? AND role='agent' ORDER BY created_at DESC,rowid DESC LIMIT 1")
                    .bind(sid.to_string()).fetch_optional(&self.pool).await.map_err(|_|CoreError::Db("指挥官结果读取失败".into()))?;
                if let Some(content) = content {
                    let mut text = super::extract_text_from_content_json(&content);
                    truncated = text.len() > 8192;
                    if truncated {
                        let mut end = 8192;
                        while !text.is_char_boundary(end) {
                            end -= 1;
                        }
                        text.truncate(end);
                    }
                    result = Some(text);
                }
                remote = Some(session.agent_session_id);
            }
            tasks.push(TaskSummary {
                id: task.id.clone(),
                title: task.title.clone(),
                agent_id: task.agent_id.clone(),
                depends_on: task.depends_on.clone(),
                status: state.status,
                session_id: state.session_id,
                agent_session_id: remote,
                result,
                truncated,
            });
        }
        Ok(RunSummary {
            run_id: id,
            objective: run.plan.objective,
            cwd: run.cwd,
            status: run.status,
            counts,
            tasks,
        })
    }
}
