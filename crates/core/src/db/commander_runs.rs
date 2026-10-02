use super::{Store, now_rfc3339};
use crate::{
    commander::{MAX_PLAN_BYTES, TaskPlan},
    error::{CoreError, Result},
    registry::AgentRegistry,
};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanStatus {
    Draft,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Interrupted,
}
impl PlanStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Interrupted => "interrupted",
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Skipped,
    Interrupted,
}
impl TaskStatus {
    fn terminal(self) -> bool {
        !matches!(self, Self::Pending | Self::Running)
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommanderTaskState {
    pub id: String,
    pub status: TaskStatus,
    pub session_id: Option<Uuid>,
}
#[derive(Debug, Clone, Serialize)]
pub struct CommanderRun {
    pub id: Uuid,
    pub plan: TaskPlan,
    pub cwd: String,
    pub status: PlanStatus,
    pub tasks: Vec<CommanderTaskState>,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
}
fn invalid() -> CoreError {
    CoreError::Protocol("指挥官状态转换无效或依赖未完成".into())
}
fn database(_: impl std::fmt::Display) -> CoreError {
    CoreError::Db("指挥官计划存储失败或数据格式无效".into())
}
impl CommanderRun {
    fn require_running(&self) -> Result<()> {
        if self.status != PlanStatus::Running {
            return Err(invalid());
        }
        Ok(())
    }
    fn finish_if_terminal(&mut self) {
        if self.tasks.iter().all(|task| task.status.terminal()) {
            self.status = if self
                .tasks
                .iter()
                .any(|task| matches!(task.status, TaskStatus::Failed | TaskStatus::Skipped))
            {
                PlanStatus::Failed
            } else {
                PlanStatus::Succeeded
            };
        }
    }
    fn interrupt(&mut self, status: PlanStatus) {
        self.status = status;
        for task in &mut self.tasks {
            if task.status == TaskStatus::Running && status == PlanStatus::Interrupted {
                task.status = TaskStatus::Interrupted;
            } else if !task.status.terminal() {
                task.status = TaskStatus::Cancelled;
            }
        }
    }
}
impl Store {
    /// Saves plan + initial states in one atomic INSERT; never executes anything.
    pub async fn create_commander_run(
        &self,
        plan: TaskPlan,
        cwd: &str,
        registry: &AgentRegistry,
    ) -> Result<Uuid> {
        if !std::path::Path::new(cwd).is_absolute() || cwd.len() > 4096 {
            return Err(invalid());
        }
        let plan = plan.validate(registry)?.plan;
        let json = serde_json::to_string(&plan).map_err(database)?;
        if json.len() as u64 > MAX_PLAN_BYTES {
            return Err(invalid());
        }
        let tasks: Vec<_> = plan
            .tasks
            .iter()
            .map(|task| CommanderTaskState {
                id: task.id.clone(),
                status: TaskStatus::Pending,
                session_id: None,
            })
            .collect();
        let id = Uuid::new_v4();
        let now = now_rfc3339();
        sqlx::query("INSERT INTO commander_runs(id,plan_json,cwd,status,tasks_json,created_at,updated_at) VALUES(?,?,?,'draft',?,?,?)")
            .bind(id.to_string()).bind(json).bind(cwd).bind(serde_json::to_string(&tasks).map_err(database)?).bind(&now).bind(&now)
            .execute(&self.pool).await.map_err(database)?;
        Ok(id)
    }
    pub async fn get_commander_run(&self, id: Uuid) -> Result<Option<CommanderRun>> {
        let row = sqlx::query("SELECT * FROM commander_runs WHERE id=?")
            .bind(id.to_string())
            .fetch_optional(&self.pool)
            .await
            .map_err(database)?;
        row.map(|row| {
            Ok(CommanderRun {
                id,
                plan: serde_json::from_str(row.try_get("plan_json").map_err(database)?)
                    .map_err(database)?,
                cwd: row.try_get("cwd").map_err(database)?,
                status: serde_json::from_value(serde_json::json!(
                    row.try_get::<String, _>("status").map_err(database)?
                ))
                .map_err(database)?,
                tasks: serde_json::from_str(row.try_get("tasks_json").map_err(database)?)
                    .map_err(database)?,
                revision: row.try_get("revision").map_err(database)?,
                created_at: row.try_get("created_at").map_err(database)?,
                updated_at: row.try_get("updated_at").map_err(database)?,
            })
        })
        .transpose()
    }
    pub async fn list_commander_runs(&self) -> Result<Vec<CommanderRun>> {
        let ids: Vec<String> =
            sqlx::query_scalar("SELECT id FROM commander_runs ORDER BY created_at,id")
                .fetch_all(&self.pool)
                .await
                .map_err(database)?;
        let mut runs = Vec::new();
        for id in ids {
            if let Some(run) = self
                .get_commander_run(Uuid::parse_str(&id).map_err(database)?)
                .await?
            {
                runs.push(run);
            }
        }
        Ok(runs)
    }
    async fn mutate_commander_run(
        &self,
        id: Uuid,
        change: impl FnOnce(&mut CommanderRun) -> Result<()>,
    ) -> Result<bool> {
        let mut run = self.get_commander_run(id).await?.ok_or_else(invalid)?;
        change(&mut run)?;
        let next = run.revision.checked_add(1).ok_or_else(invalid)?;
        let updated = sqlx::query("UPDATE commander_runs SET status=?,tasks_json=?,revision=?,updated_at=? WHERE id=? AND revision=?")
            .bind(run.status.as_str()).bind(serde_json::to_string(&run.tasks).map_err(database)?).bind(next).bind(now_rfc3339()).bind(id.to_string()).bind(run.revision)
            .execute(&self.pool).await.map_err(database)?;
        Ok(updated.rows_affected() == 1)
    }
    /// false means an optimistic concurrency conflict: reload before retrying.
    pub async fn start_commander_run(&self, id: Uuid) -> Result<bool> {
        self.mutate_commander_run(id, |run| {
            if run.status != PlanStatus::Draft {
                return Err(invalid());
            }
            run.status = PlanStatus::Running;
            Ok(())
        })
        .await
    }
    pub async fn start_commander_task(
        &self,
        id: Uuid,
        task_id: &str,
        session_id: Option<Uuid>,
    ) -> Result<bool> {
        self.mutate_commander_run(id, |run| {
            run.require_running()?;
            let task = run
                .plan
                .tasks
                .iter()
                .find(|task| task.id == task_id)
                .ok_or_else(invalid)?;
            if !task.depends_on.iter().all(|dep| {
                run.tasks
                    .iter()
                    .any(|state| state.id == *dep && state.status == TaskStatus::Succeeded)
            }) {
                return Err(invalid());
            }
            let state = run
                .tasks
                .iter_mut()
                .find(|task| task.id == task_id)
                .ok_or_else(invalid)?;
            if state.status != TaskStatus::Pending {
                return Err(invalid());
            }
            state.status = TaskStatus::Running;
            state.session_id = session_id;
            Ok(())
        })
        .await
    }
    /// Bind a session arriving after dispatch; never replace an existing reference.
    pub async fn bind_commander_task_session(
        &self,
        id: Uuid,
        task_id: &str,
        session_id: Uuid,
    ) -> Result<bool> {
        self.mutate_commander_run(id, |run| {
            run.require_running()?;
            let state = run
                .tasks
                .iter_mut()
                .find(|task| task.id == task_id)
                .ok_or_else(invalid)?;
            if state.status != TaskStatus::Running || state.session_id.is_some() {
                return Err(invalid());
            }
            state.session_id = Some(session_id);
            Ok(())
        })
        .await
    }
    pub async fn finish_commander_task(
        &self,
        id: Uuid,
        task_id: &str,
        status: TaskStatus,
    ) -> Result<bool> {
        if !matches!(status, TaskStatus::Succeeded | TaskStatus::Failed) {
            return Err(invalid());
        }
        self.mutate_commander_run(id, |run| {
            run.require_running()?;
            let state = run
                .tasks
                .iter_mut()
                .find(|task| task.id == task_id)
                .ok_or_else(invalid)?;
            if state.status != TaskStatus::Running {
                return Err(invalid());
            }
            state.status = status;
            // Repeatedly propagate failure through arbitrary input order DAGs.
            loop {
                let skipped: Vec<String> =
                    run.plan
                        .tasks
                        .iter()
                        .filter(|task| {
                            run.tasks.iter().any(|state| {
                                state.id == task.id && state.status == TaskStatus::Pending
                            }) && task.depends_on.iter().any(|dep| {
                                run.tasks.iter().any(|state| {
                                    state.id == *dep
                                        && matches!(
                                            state.status,
                                            TaskStatus::Failed | TaskStatus::Skipped
                                        )
                                })
                            })
                        })
                        .map(|task| task.id.clone())
                        .collect();
                if skipped.is_empty() {
                    break;
                }
                for state in &mut run.tasks {
                    if skipped.contains(&state.id) {
                        state.status = TaskStatus::Skipped;
                    }
                }
            }
            run.finish_if_terminal();
            Ok(())
        })
        .await
    }
    pub async fn cancel_commander_run(&self, id: Uuid) -> Result<bool> {
        self.mutate_commander_run(id, |run| {
            if !matches!(run.status, PlanStatus::Draft | PlanStatus::Running) {
                return Err(invalid());
            }
            run.interrupt(PlanStatus::Cancelled);
            Ok(())
        })
        .await
    }
    /// Exclusive scheduler startup only: opening or reading a Store never calls this.
    pub async fn recover_commander_runs(&self) -> Result<usize> {
        let ids: Vec<String> =
            sqlx::query_scalar("SELECT id FROM commander_runs WHERE status='running'")
                .fetch_all(&self.pool)
                .await
                .map_err(database)?;
        let mut recovered = 0;
        for id in ids {
            let id = Uuid::parse_str(&id).map_err(database)?;
            if self
                .mutate_commander_run(id, |run| {
                    run.require_running()?;
                    run.interrupt(PlanStatus::Interrupted);
                    Ok(())
                })
                .await?
            {
                recovered += 1;
            }
        }
        Ok(recovered)
    }
}
