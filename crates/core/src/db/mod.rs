//! SQLite 持久层（sqlx，docs/architecture.md §6）。
//! Store 为连接池薄封装（Clone 廉价）；事件流落库经 [`recorder::SessionRecorder`]。

mod commander_config;
mod commander_runs;
mod commander_summary;
pub use commander_runs::{CommanderRun, CommanderTaskState, PlanStatus, TaskStatus};
pub use commander_summary::{RunSummary, TaskCounts, TaskSummary};
mod recorder;
mod task_move;

pub use recorder::SessionRecorder;

use std::{path::PathBuf, time::Duration};

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};
use uuid::Uuid;

use crate::approval::{DecisionRecord, RuleEffect};
use crate::error::{CoreError, Result};

/// 规则库条目（permission_rules 表；effect 序列化为 allow/deny/ask 文本）
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct PermissionRuleEntry {
    pub id: String,
    pub pattern: String,
    pub effect: RuleEffect,
}

/// 落库消息行（P1-6：历史会话消息渲染）。content_json 为拼接后的纯文本。
#[derive(Debug, Clone, serde::Serialize)]
pub struct MessageRow {
    pub role: String,
    pub text: String,
    pub created_at: String,
}

/// 会话列表行。
#[derive(Debug, Clone)]

pub struct SessionRow {
    pub id: String,
    pub agent_id: String,
    pub agent_session_id: String,
    pub cwd: String,
    pub title: String,
    pub status: String,
    pub updated_at: String,
    /// 归属工作空间（ADR-0007）；历史 NULL 行经 COALESCE 读作默认空间
    pub workspace_id: String,
}

/// 默认空间的固定 id：不绑项目的会话（普通聊天/电脑操作）归属于此。
pub const DEFAULT_WORKSPACE: &str = "default";

/// 工作空间条目（workspaces 表，ADR-0007）。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct WorkspaceEntry {
    pub id: String,
    pub name: String,
    /// project 空间=项目根绝对路径（UNIQUE）；默认空间为 None
    pub path: Option<String>,
    pub kind: String, // project | default
}

/// 任务状态流转序（P1-9 简版看板）：backlog → in_progress → review → done。
pub const TASK_STATUSES: [&str; 4] = ["backlog", "in_progress", "review", "done"];

/// 任务条目（tasks 表，P1-9 简版看板：标题+空间+绑定会话+状态）。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct TaskEntry {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    /// 绑定的 agent 会话（指派给某个会话执行；None=未指派）
    pub session_id: Option<String>,
    pub status: String, // TASK_STATUSES 之一
}

#[derive(Clone)]
pub struct Store {
    pool: SqlitePool,
}

pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

impl Store {
    /// 默认库：`~/Library/Application Support/SuperCode/supercode.db`；
    /// `SUPERCODE_DB` 环境变量可覆盖完整路径。
    pub async fn open_default() -> Result<Self> {
        let path = match std::env::var("SUPERCODE_DB") {
            Ok(path) => PathBuf::from(path),
            Err(_) => {
                let dir = dirs::data_dir()
                    .ok_or_else(|| CoreError::Io(std::io::Error::other("无法定位数据目录")))?;
                dir.join("SuperCode").join("supercode.db")
            }
        };
        Self::open(&path).await
    }

    /// 打开（必要时创建）指定路径的库并执行迁移。测试用 [`Self::open_in_memory`]。
    pub async fn open(path: &std::path::Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // 文件库：WAL + 4 连接（recorder 逐事件写入与规则/查询并发，单连接会阻塞事件转发）
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);
        // 首次并行打开同一个新库时，SQLite 的 WAL 初始化或 sqlx 的迁移
        // 元数据写入可能竞态。仅对这两类瞬时冲突重试；真正的迁移错误立即返回。
        for attempt in 0..8 {
            match Self::connect(options.clone()).await {
                Ok(store) => return Ok(store),
                Err(CoreError::Db(message))
                    if attempt < 7
                        && (message.contains("database is locked")
                            || message.contains("_sqlx_migrations.version")
                            || message.contains("already exists")
                            || message.contains("duplicate column name")) =>
                {
                    tokio::time::sleep(Duration::from_millis(25 * (attempt + 1))).await;
                }
                Err(err) => return Err(err),
            }
        }
        unreachable!("最后一次失败已在循环中返回")
    }

    pub async fn open_in_memory() -> Result<Self> {
        // SqliteConnectOptions::new() 默认即 :memory:
        Self::connect(SqliteConnectOptions::new()).await
    }

    async fn connect(options: SqliteConnectOptions) -> Result<Self> {
        // :memory: 库每个连接独立（多连接"丢表"）必须单连接；
        // 文件库 WAL 下并发安全，多连接避免 recorder 写入阻塞查询
        let max = if options.get_filename().as_os_str() == ":memory:" {
            1
        } else {
            4
        };
        let pool = SqlitePoolOptions::new()
            .max_connections(max)
            .connect_with(options)
            .await
            .map_err(|e| CoreError::Db(e.to_string()))?;
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .map_err(|e| CoreError::Db(e.to_string()))?;
        let store = Self { pool };
        // 工作空间（ADR-0007）：默认空间恒在 + 历史会话按 distinct cwd 回填归类（幂等）
        store.ensure_default_workspace().await?;
        store.backfill_session_workspaces().await?;
        Ok(store)
    }

    pub async fn upsert_agent(
        &self,
        id: &str,
        display_name: &str,
        driver_kind: &str,
        installed_version: Option<&str>,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO agents (id, display_name, driver_kind, spawn_json, capabilities_json, installed_version, updated_at)
             VALUES (?1, ?2, ?3, '{}', '{}', ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET display_name=?2, installed_version=?4, updated_at=?5",
        )
        .bind(id)
        .bind(display_name)
        .bind(driver_kind)
        .bind(installed_version)
        .bind(now_rfc3339())
        .execute(&self.pool)
        .await
        .map_err(|e| CoreError::Db(e.to_string()))?;
        Ok(())
    }

    /// 落库会话行（INSERT OR IGNORE：resume 时行已存在则保留原建档信息）。
    /// workspace_id：归属工作空间（ADR-0007），resume 复用原行时保留原归属。
    pub async fn insert_session(
        &self,
        id: Uuid,
        agent_id: &str,
        agent_session_id: &str,
        cwd: &str,
        title: &str,
        workspace_id: &str,
    ) -> Result<()> {
        let now = now_rfc3339();
        sqlx::query(
            "INSERT OR IGNORE INTO sessions (id, agent_id, agent_session_id, cwd, title, status, created_at, updated_at, workspace_id)
             VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?6, ?7)",
        )
        .bind(id.to_string())
        .bind(agent_id)
        .bind(agent_session_id)
        .bind(cwd)
        .bind(title)
        .bind(&now)
        .bind(workspace_id)
        .execute(&self.pool)
        .await
        .map_err(|e| CoreError::Db(e.to_string()))?;
        Ok(())
    }

    pub async fn update_session_status(&self, id: Uuid, status: &str) -> Result<()> {
        sqlx::query("UPDATE sessions SET status=?2, updated_at=?3 WHERE id=?1")
            .bind(id.to_string())
            .bind(status)
            .bind(now_rfc3339())
            .execute(&self.pool)
            .await
            .map_err(|e| CoreError::Db(e.to_string()))?;
        Ok(())
    }

    pub async fn insert_user_message(&self, session: Uuid, text: &str) -> Result<()> {
        self.insert_message(session, "user", text).await
    }

    pub async fn insert_agent_message(&self, session: Uuid, text: &str) -> Result<()> {
        self.insert_message(session, "agent", text).await
    }

    async fn insert_message(&self, session: Uuid, role: &str, text: &str) -> Result<()> {
        let content = serde_json::json!([{ "type": "text", "text": text }]).to_string();
        sqlx::query(
            "INSERT INTO messages (id, session_id, role, content_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(session.to_string())
        .bind(role)
        .bind(&content)
        .bind(now_rfc3339())
        .execute(&self.pool)
        .await
        .map_err(|e| CoreError::Db(e.to_string()))?;
        Ok(())
    }

    pub async fn upsert_tool_call(
        &self,
        session: Uuid,
        tool_call_id: &str,
        name: Option<&str>,
        kind: Option<&str>,
        status: Option<&str>,
        input_json: Option<&str>,
    ) -> Result<()> {
        let now = now_rfc3339();
        sqlx::query(
            "INSERT INTO tool_calls (id, session_id, name, kind, status, input_json, started_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET name=COALESCE(?3, name), kind=COALESCE(?4, kind),
                 status=COALESCE(?5, status), ended_at=?7",
        )
        .bind(tool_call_id)
        .bind(session.to_string())
        .bind(name)
        .bind(kind)
        .bind(status)
        .bind(input_json)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| CoreError::Db(e.to_string()))?;
        Ok(())
    }

    /// 规则库：列出全部规则（P1-5）
    pub async fn list_permission_rules(&self) -> Result<Vec<PermissionRuleEntry>> {
        let rows = sqlx::query_as::<_, (String, String, String)>(
            "SELECT id, pattern, effect FROM permission_rules ORDER BY created_at, id",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| CoreError::Db(e.to_string()))?;
        Ok(rows
            .into_iter()
            .map(|(id, pattern, effect)| PermissionRuleEntry {
                id,
                pattern,
                effect: effect.parse().unwrap_or(RuleEffect::Ask),
            })
            .collect())
    }

    /// 规则库：新增规则（pattern+effect 唯一，重复插入幂等返回既有 id）
    pub async fn add_permission_rule(
        &self,
        pattern: &str,
        effect: RuleEffect,
    ) -> Result<PermissionRuleEntry> {
        let id = Uuid::new_v4().to_string();
        let effect_str = match effect {
            RuleEffect::Allow => "allow",
            RuleEffect::Deny => "deny",
            RuleEffect::Ask => "ask",
        };
        let now = now_rfc3339();
        let result = sqlx::query(
            "INSERT OR IGNORE INTO permission_rules (id, pattern, effect, created_at) VALUES (?1, ?2, ?3, ?4)",
        )
        .bind(&id)
        .bind(pattern)
        .bind(effect_str)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| CoreError::Db(e.to_string()))?;
        if result.rows_affected() == 0 {
            // 重复：取回既有条目
            return sqlx::query_as::<_, (String, String, String)>(
                "SELECT id, pattern, effect FROM permission_rules WHERE pattern = ?1 AND effect = ?2",
            )
            .bind(pattern)
            .bind(effect_str)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| CoreError::Db(e.to_string()))
            .map(|(id, pattern, effect)| PermissionRuleEntry {
                id,
                pattern,
                effect: effect.parse().unwrap_or(RuleEffect::Ask),
            });
        }
        Ok(PermissionRuleEntry {
            id,
            pattern: pattern.to_string(),
            effect,
        })
    }

    /// 规则库：删除规则
    pub async fn delete_permission_rule(&self, id: &str) -> Result<()> {
        sqlx::query("DELETE FROM permission_rules WHERE id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|e| CoreError::Db(e.to_string()))?;
        Ok(())
    }

    pub async fn insert_approval(&self, session: Uuid, record: &DecisionRecord) -> Result<()> {
        let decided_by = match &record.source {
            crate::approval::DecisionSource::Rule { pattern, .. } => format!("rule:{pattern}"),
            crate::approval::DecisionSource::Mode { mode } => format!("mode:{mode:?}"),
            crate::approval::DecisionSource::User => "user".to_string(),
        };
        let now = now_rfc3339();
        sqlx::query(
            "INSERT INTO approvals (id, session_id, tool_call_id, tool_name, request_json, decision, decided_by, created_at, decided_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(session.to_string())
        .bind(&record.request.tool_call_id)
        .bind(&record.request.tool_name)
        .bind(serde_json::to_string(&record.request.raw_input).unwrap_or_else(|_| "null".into()))
        .bind(&record.decision.option_id)
        .bind(&decided_by)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| CoreError::Db(e.to_string()))?;
        Ok(())
    }

    pub async fn list_sessions(&self) -> Result<Vec<SessionRow>> {
        let rows = sqlx::query(
            "SELECT id, agent_id, agent_session_id, cwd, title, status, updated_at,
                    COALESCE(workspace_id, 'default') AS workspace_id
             FROM sessions ORDER BY updated_at DESC LIMIT 100",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| CoreError::Db(e.to_string()))?;
        Ok(rows
            .into_iter()
            .map(|row| SessionRow {
                id: row.get("id"),
                agent_id: row.get("agent_id"),
                agent_session_id: row.get("agent_session_id"),
                cwd: row.get("cwd"),
                title: row.get("title"),
                status: row.get("status"),
                updated_at: row.get("updated_at"),
                workspace_id: row.get("workspace_id"),
            })
            .collect())
    }

    /// 空间列表（ADR-0007）：project 空间按创建先后，默认空间恒排最后。
    pub async fn list_workspaces(&self) -> Result<Vec<WorkspaceEntry>> {
        let rows = sqlx::query(
            "SELECT id, name, path, kind FROM workspaces
             ORDER BY CASE WHEN kind = 'default' THEN 1 ELSE 0 END, created_at ASC",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| CoreError::Db(e.to_string()))?;
        Ok(rows
            .into_iter()
            .map(|row| WorkspaceEntry {
                id: row.get("id"),
                name: row.get("name"),
                path: row.get("path"),
                kind: row.get("kind"),
            })
            .collect())
    }

    /// 按路径取 project 空间（create_workspace 幂等的读侧）。
    async fn find_workspace_by_path(&self, path: &str) -> Result<Option<WorkspaceEntry>> {
        sqlx::query_as::<_, (String, String, Option<String>, String)>(
            "SELECT id, name, path, kind FROM workspaces WHERE path = ?1",
        )
        .bind(path)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| CoreError::Db(e.to_string()))
        .map(|opt| {
            opt.map(|(id, name, path, kind)| WorkspaceEntry {
                id,
                name,
                path,
                kind,
            })
        })
    }

    /// 项目根绝对路径 → 空间名（目录名；根目录等无文件名时退化为路径本身）。
    fn workspace_name_for(path: &str) -> String {
        std::path::Path::new(path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| path.to_string())
    }

    /// get-or-create project 空间（path UNIQUE 幂等；重复创建返回既有条目）。
    pub async fn create_workspace(&self, path: &str) -> Result<WorkspaceEntry> {
        if let Some(existing) = self.find_workspace_by_path(path).await? {
            return Ok(existing);
        }
        let id = Uuid::new_v4().to_string();
        let name = Self::workspace_name_for(path);
        let result = sqlx::query(
            "INSERT INTO workspaces (id, name, path, kind, created_at) VALUES (?1, ?2, ?3, 'project', ?4)
             ON CONFLICT(path) DO NOTHING",
        )
        .bind(&id)
        .bind(&name)
        .bind(path)
        .bind(now_rfc3339())
        .execute(&self.pool)
        .await
        .map_err(|e| CoreError::Db(e.to_string()))?;
        if result.rows_affected() == 0 {
            // 并发/重复：回读既有行
            return self
                .find_workspace_by_path(path)
                .await?
                .ok_or_else(|| CoreError::Db("工作空间创建后不可见".into()));
        }
        Ok(WorkspaceEntry {
            id,
            name,
            path: Some(path.to_string()),
            kind: "project".into(),
        })
    }

    /// 删除 project 空间：会话移入默认空间（不级联删，ADR-0007）；默认空间不可删。
    pub async fn delete_workspace(&self, id: &str) -> Result<()> {
        if id == DEFAULT_WORKSPACE {
            return Err(CoreError::Db("默认空间不可删除".into()));
        }
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| CoreError::Db(e.to_string()))?;
        sqlx::query("UPDATE sessions SET workspace_id = ?2 WHERE workspace_id = ?1")
            .bind(id)
            .bind(DEFAULT_WORKSPACE)
            .execute(&mut *tx)
            .await
            .map_err(|e| CoreError::Db(e.to_string()))?;
        sqlx::query("DELETE FROM workspaces WHERE id = ?1 AND kind = 'project'")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| CoreError::Db(e.to_string()))?;
        tx.commit()
            .await
            .map_err(|e| CoreError::Db(e.to_string()))?;
        Ok(())
    }

    /// 默认空间单例：缺失即补（固定 id `default`，幂等）。
    pub async fn ensure_default_workspace(&self) -> Result<()> {
        sqlx::query(
            "INSERT OR IGNORE INTO workspaces (id, name, path, kind, created_at)
             VALUES (?1, '默认空间', NULL, 'default', ?2)",
        )
        .bind(DEFAULT_WORKSPACE)
        .bind(now_rfc3339())
        .execute(&self.pool)
        .await
        .map_err(|e| CoreError::Db(e.to_string()))?;
        Ok(())
    }

    /// 历史回填（ADR-0007）：workspace_id 为 NULL 的会话按 distinct cwd
    /// get-or-create project 空间并归类。幂等（以 NULL 为游标）；返回归类会话数。
    pub async fn backfill_session_workspaces(&self) -> Result<usize> {
        let cwds: Vec<String> =
            sqlx::query_scalar("SELECT DISTINCT cwd FROM sessions WHERE workspace_id IS NULL")
                .fetch_all(&self.pool)
                .await
                .map_err(|e| CoreError::Db(e.to_string()))?;
        let mut moved = 0usize;
        for cwd in cwds {
            let workspace = self.create_workspace(&cwd).await?;
            let result = sqlx::query(
                "UPDATE sessions SET workspace_id = ?2 WHERE cwd = ?1 AND workspace_id IS NULL",
            )
            .bind(&cwd)
            .bind(&workspace.id)
            .execute(&self.pool)
            .await
            .map_err(|e| CoreError::Db(e.to_string()))?;
            moved += result.rows_affected() as usize;
        }
        Ok(moved)
    }

    // ---------- 任务（P1-9 简版看板） ----------

    /// 创建任务：挂在指定空间下，初始 backlog；cwd 缺省取空间路径（schema NOT NULL 兜底）。
    pub async fn create_task(&self, workspace_id: &str, title: &str) -> Result<TaskEntry> {
        let id = Uuid::new_v4().to_string();
        let now = now_rfc3339();
        sqlx::query(
            "INSERT INTO tasks (id, workspace_id, title, cwd, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, COALESCE((SELECT path FROM workspaces WHERE id = ?2), ''), 'backlog', ?4, ?4)",
        )
        .bind(&id)
        .bind(workspace_id)
        .bind(title)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| CoreError::Db(e.to_string()))?;
        Ok(TaskEntry {
            id,
            workspace_id: workspace_id.to_string(),
            title: title.to_string(),
            session_id: None,
            status: "backlog".into(),
        })
    }

    /// 任务列表（按创建先后；前端按空间分节展示）。
    pub async fn list_tasks(&self) -> Result<Vec<TaskEntry>> {
        let rows = sqlx::query_as::<_, (String, String, String, Option<String>, String)>(
            "SELECT id, workspace_id, title, session_id, status FROM tasks ORDER BY created_at ASC",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| CoreError::Db(e.to_string()))?;
        Ok(rows
            .into_iter()
            .map(|(id, workspace_id, title, session_id, status)| TaskEntry {
                id,
                workspace_id,
                title,
                session_id,
                status,
            })
            .collect())
    }

    /// 更新任务：status 必须是四态之一；session_id 传 Some("") 视为解绑（前端无法传 SQL NULL 的约定）。
    /// 返回更新后的条目；任务不存在报错。
    pub async fn update_task(
        &self,
        id: &str,
        status: Option<&str>,
        session_id: Option<&str>,
    ) -> Result<TaskEntry> {
        if let Some(status) = status
            && !TASK_STATUSES.contains(&status)
        {
            return Err(CoreError::Db(format!("非法任务状态：{status}")));
        }
        let result = sqlx::query("UPDATE tasks SET updated_at = ?2 WHERE id = ?1")
            .bind(id)
            .bind(now_rfc3339())
            .execute(&self.pool)
            .await
            .map_err(|e| CoreError::Db(e.to_string()))?;
        if result.rows_affected() == 0 {
            return Err(CoreError::Db(format!("任务不存在：{id}")));
        }
        if let Some(status) = status {
            sqlx::query("UPDATE tasks SET status = ?2 WHERE id = ?1")
                .bind(id)
                .bind(status)
                .execute(&self.pool)
                .await
                .map_err(|e| CoreError::Db(e.to_string()))?;
        }
        if let Some(session) = session_id {
            let bound = if session.is_empty() {
                None
            } else {
                Some(session)
            };
            sqlx::query("UPDATE tasks SET session_id = ?2 WHERE id = ?1")
                .bind(id)
                .bind(bound)
                .execute(&self.pool)
                .await
                .map_err(|e| CoreError::Db(e.to_string()))?;
        }
        self.get_task(id)
            .await?
            .ok_or_else(|| CoreError::Db(format!("任务不存在：{id}")))
    }

    pub async fn get_task(&self, id: &str) -> Result<Option<TaskEntry>> {
        sqlx::query_as::<_, (String, String, String, Option<String>, String)>(
            "SELECT id, workspace_id, title, session_id, status FROM tasks WHERE id = ?1",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| CoreError::Db(e.to_string()))
        .map(|opt| {
            opt.map(|(id, workspace_id, title, session_id, status)| TaskEntry {
                id,
                workspace_id,
                title,
                session_id,
                status,
            })
        })
    }

    pub async fn delete_task(&self, id: &str) -> Result<()> {
        sqlx::query("DELETE FROM tasks WHERE id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|e| CoreError::Db(e.to_string()))?;
        Ok(())
    }

    /// 会话被删时解绑引用它的任务（P1-9：绑定是引用不是从属，随 delete_session 级联）。
    pub async fn unbind_task_session(&self, agent_session_id: &str) -> Result<()> {
        sqlx::query("UPDATE tasks SET session_id = NULL, updated_at = ?2 WHERE session_id = ?1")
            .bind(agent_session_id)
            .bind(now_rfc3339())
            .execute(&self.pool)
            .await
            .map_err(|e| CoreError::Db(e.to_string()))?;
        Ok(())
    }

    /// 删除会话及其全部子记录（P1-6：messages/tool_calls/approvals 级联，
    /// FK 未启用需手动级联）。返回是否删除了会话行。
    pub async fn delete_session_by_agent(&self, agent_session_id: &str) -> Result<bool> {
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| CoreError::Db(e.to_string()))?;
        for table in ["messages", "tool_calls", "approvals"] {
            sqlx::query(&format!(
                "DELETE FROM {table} WHERE session_id IN (SELECT id FROM sessions WHERE agent_session_id = ?1)"
            ))
            .bind(agent_session_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| CoreError::Db(e.to_string()))?;
        }
        // 绑定该会话的任务解绑（P1-9：绑定是引用不是从属）
        sqlx::query("UPDATE tasks SET session_id = NULL, updated_at = ?2 WHERE session_id = ?1")
            .bind(agent_session_id)
            .bind(now_rfc3339())
            .execute(&mut *tx)
            .await
            .map_err(|e| CoreError::Db(e.to_string()))?;
        let result = sqlx::query("DELETE FROM sessions WHERE agent_session_id = ?1")
            .bind(agent_session_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| CoreError::Db(e.to_string()))?;
        tx.commit()
            .await
            .map_err(|e| CoreError::Db(e.to_string()))?;
        Ok(result.rows_affected() > 0)
    }

    /// 按 agent 侧会话 id 反查 SuperCode 会话 UUID（P1-6：resume 沿用原行，避免重复建行）
    pub async fn find_session_by_agent(&self, agent_session_id: &str) -> Result<Option<Uuid>> {
        let row = sqlx::query_scalar::<_, String>(
            "SELECT id FROM sessions WHERE agent_session_id = ?1 ORDER BY created_at LIMIT 1",
        )
        .bind(agent_session_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| CoreError::Db(e.to_string()))?;
        Ok(row.and_then(|id| id.parse().ok()))
    }

    /// 按会话取落库消息（P1-6：历史渲染；按 agent_session_id 关联）
    pub async fn list_messages(&self, agent_session_id: &str) -> Result<Vec<MessageRow>> {
        let rows = sqlx::query_as::<_, (String, String, String)>(
            "SELECT m.role, m.content_json, m.created_at FROM messages m
             JOIN sessions s ON m.session_id = s.id
             WHERE s.agent_session_id = ?1 ORDER BY m.created_at, m.rowid",
        )
        .bind(agent_session_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| CoreError::Db(e.to_string()))?;
        Ok(rows
            .into_iter()
            .map(|(role, content_json, created_at)| MessageRow {
                role,
                // recorder 落库的是 ContentBlock 数组 JSON；历史渲染只取文本
                text: extract_text_from_content_json(&content_json),
                created_at,
            })
            .collect())
    }

    pub async fn get_session(&self, id: Uuid) -> Result<Option<SessionRow>> {
        let row = sqlx::query(
            "SELECT id, agent_id, agent_session_id, cwd, title, status, updated_at,
                    COALESCE(workspace_id, 'default') AS workspace_id
             FROM sessions WHERE id = ?1",
        )
        .bind(id.to_string())
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| CoreError::Db(e.to_string()))?;
        Ok(row.map(|row| SessionRow {
            id: row.get("id"),
            agent_id: row.get("agent_id"),
            agent_session_id: row.get("agent_session_id"),
            cwd: row.get("cwd"),
            title: row.get("title"),
            status: row.get("status"),
            updated_at: row.get("updated_at"),
            workspace_id: row.get("workspace_id"),
        }))
    }
}

/// 从 ContentBlock 数组 JSON 提取文本（历史消息渲染用；解析失败回退原文）
fn extract_text_from_content_json(content_json: &str) -> String {
    serde_json::from_str::<serde_json::Value>(content_json)
        .ok()
        .and_then(|v| {
            v.as_array().map(|blocks| {
                blocks
                    .iter()
                    .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
                    .join("")
            })
        })
        .unwrap_or_else(|| content_json.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn 同一新库并行打开不会迁移冲突() {
        for _ in 0..3 {
            let path = std::env::temp_dir().join(format!("sc-p24-migrate-{}.db", Uuid::new_v4()));
            let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(4));
            let handles: Vec<_> = (0..4)
                .map(|_| {
                    let path = path.clone();
                    let barrier = barrier.clone();
                    tokio::spawn(async move {
                        barrier.wait().await;
                        Store::open(&path).await
                    })
                })
                .collect();
            for handle in handles {
                let store = handle.await.unwrap().expect("并行打开不应因迁移竞态失败");
                assert!(!store.list_workspaces().await.unwrap().is_empty());
            }
        }
    }

    #[tokio::test]
    async fn 会话增查列表闭环() {
        let store = Store::open_in_memory().await.unwrap();
        store
            .upsert_agent("opencode", "OpenCode", "acp", Some("1.18.30"))
            .await
            .unwrap();

        let our_id = Uuid::new_v4();
        store
            .insert_session(
                our_id,
                "opencode",
                "ses_agent_x",
                "/tmp/demo",
                "测试会话标题",
                DEFAULT_WORKSPACE,
            )
            .await
            .unwrap();
        store.insert_user_message(our_id, "你好").await.unwrap();
        store
            .insert_agent_message(our_id, "你好，我是 agent")
            .await
            .unwrap();
        store
            .update_session_status(our_id, "completed")
            .await
            .unwrap();

        let found = store.get_session(our_id).await.unwrap().expect("应能查到");
        assert_eq!(found.agent_session_id, "ses_agent_x");
        assert_eq!(found.status, "completed");
        assert_eq!(found.cwd, "/tmp/demo");

        let list = store.list_sessions().await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].title, "测试会话标题");

        let missing = store.get_session(Uuid::new_v4()).await.unwrap();
        assert!(missing.is_none());
    }

    #[tokio::test]
    async fn 工具调用与审批落库() {
        use crate::approval::{DecisionSource, RuleEffect};
        use crate::driver::{
            PermissionDecision, PermissionOption, PermissionOptionKind, PermissionRequest,
        };

        let store = Store::open_in_memory().await.unwrap();
        store
            .upsert_agent("opencode", "OpenCode", "acp", None)
            .await
            .unwrap();
        let sid = Uuid::new_v4();
        store
            .insert_session(sid, "opencode", "ses_x", "/tmp", "t", DEFAULT_WORKSPACE)
            .await
            .unwrap();

        store
            .upsert_tool_call(
                sid,
                "call_1",
                Some("bash"),
                Some("execute"),
                Some("pending"),
                None,
            )
            .await
            .unwrap();
        store
            .upsert_tool_call(sid, "call_1", None, None, Some("completed"), None)
            .await
            .unwrap();

        let record = DecisionRecord {
            request: PermissionRequest {
                session_id: "ses_x".into(),
                tool_call_id: "call_1".into(),
                tool_name: "git status".into(),
                kind: None,
                raw_input: None,
                options: vec![PermissionOption {
                    option_id: "allow-once".into(),
                    name: "允许".into(),
                    kind: PermissionOptionKind::AllowOnce,
                }],
            },
            source: DecisionSource::Rule {
                pattern: "bash(git status)".into(),
                effect: RuleEffect::Allow,
            },
            decision: PermissionDecision {
                option_id: "allow-once".into(),
                updated_input: None,
            },
        };
        store.insert_approval(sid, &record).await.unwrap();

        let count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM tool_calls")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(count, 1, "upsert 不应产生重复行");
        let status = sqlx::query_scalar::<_, String>("SELECT status FROM tool_calls")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(status, "completed");

        let decided_by = sqlx::query_scalar::<_, String>("SELECT decided_by FROM approvals")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(decided_by, "rule:bash(git status)");
    }

    /// P1-5：规则库 CRUD——新增幂等、列表、删除
    #[tokio::test]
    async fn 规则库增删查幂等() {
        let store = Store::open_in_memory().await.unwrap();

        let first = store
            .add_permission_rule("bash(git *)", RuleEffect::Allow)
            .await
            .unwrap();
        assert_eq!(first.pattern, "bash(git *)");

        // 重复插入幂等：返回既有条目
        let again = store
            .add_permission_rule("bash(git *)", RuleEffect::Allow)
            .await
            .unwrap();
        assert_eq!(again.id, first.id);

        // 同 pattern 不同 effect 是新条目
        let denied = store
            .add_permission_rule("bash(git *)", RuleEffect::Deny)
            .await
            .unwrap();
        assert_ne!(denied.id, first.id);

        assert_eq!(store.list_permission_rules().await.unwrap().len(), 2);

        store.delete_permission_rule(&first.id).await.unwrap();
        let rest = store.list_permission_rules().await.unwrap();
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].effect, RuleEffect::Deny);
    }

    /// P1-6：会话删除级联（sessions + messages 子记录一并清除）
    #[tokio::test]
    async fn 会话删除级联子记录() {
        let store = Store::open_in_memory().await.unwrap();
        store
            .upsert_agent("opencode", "OpenCode", "acp", None)
            .await
            .unwrap();
        let sid = Uuid::new_v4();
        store
            .insert_session(
                sid,
                "opencode",
                "ses_del_1",
                "/tmp",
                "待删",
                DEFAULT_WORKSPACE,
            )
            .await
            .unwrap();
        store.insert_user_message(sid, "问题").await.unwrap();
        store.insert_agent_message(sid, "回答").await.unwrap();

        assert!(store.delete_session_by_agent("ses_del_1").await.unwrap());
        assert!(!store.delete_session_by_agent("ses_del_1").await.unwrap());
        assert_eq!(store.list_messages("ses_del_1").await.unwrap().len(), 0);
        assert!(store.get_session(sid).await.unwrap().is_none());
    }

    /// P1-6：list_messages 按 agent_session_id 取落库消息（ContentBlock JSON → 文本）
    #[tokio::test]
    async fn 历史消息按agent会话id查询() {
        let store = Store::open_in_memory().await.unwrap();
        store
            .upsert_agent("opencode", "OpenCode", "acp", None)
            .await
            .unwrap();
        let sid = Uuid::new_v4();
        store
            .insert_session(
                sid,
                "opencode",
                "ses_hist_1",
                "/tmp",
                "历史会话",
                DEFAULT_WORKSPACE,
            )
            .await
            .unwrap();
        store.insert_user_message(sid, "第一问").await.unwrap();
        store.insert_agent_message(sid, "第一答").await.unwrap();

        // 另一会话不应串入
        let other = Uuid::new_v4();
        store
            .insert_session(
                other,
                "opencode",
                "ses_hist_2",
                "/tmp",
                "别的会话",
                DEFAULT_WORKSPACE,
            )
            .await
            .unwrap();
        store.insert_user_message(other, "别的问题").await.unwrap();

        let messages = store.list_messages("ses_hist_1").await.unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].text, "第一问");
        assert_eq!(messages[1].role, "agent");
        assert_eq!(messages[1].text, "第一答");
    }

    /// 打开库即有默认空间单例（ADR-0007）
    #[tokio::test]
    async fn 默认空间恒在且排最后() {
        let store = Store::open_in_memory().await.unwrap();
        let spaces = store.list_workspaces().await.unwrap();
        assert_eq!(spaces.len(), 1);
        assert_eq!(spaces[0].id, DEFAULT_WORKSPACE);
        assert_eq!(spaces[0].kind, "default");
        assert_eq!(spaces[0].path, None);

        // 项目空间创建后排前面（created_at 序），默认空间恒最后
        store.create_workspace("/tmp/ws-a").await.unwrap();
        let spaces = store.list_workspaces().await.unwrap();
        assert_eq!(spaces.len(), 2);
        assert_eq!(spaces[0].path.as_deref(), Some("/tmp/ws-a"));
        assert_eq!(spaces[1].id, DEFAULT_WORKSPACE);
    }

    /// 历史会话按 distinct cwd 回填为 project 空间（ADR-0007 零损失归类），且幂等
    #[tokio::test]
    async fn 历史会话按cwd回填归类() {
        let store = Store::open_in_memory().await.unwrap();
        store
            .upsert_agent("opencode", "OpenCode", "acp", None)
            .await
            .unwrap();

        // 模拟迁移前旧数据：workspace_id 为 NULL 的会话行（同 cwd 两会话 + 另一 cwd 一会话）
        for (agent_id, cwd) in [
            ("ses_old_1", "/repo/alpha"),
            ("ses_old_2", "/repo/alpha"),
            ("ses_old_3", "/repo/beta/"),
        ] {
            sqlx::query(
                "INSERT INTO sessions (id, agent_id, agent_session_id, cwd, title, status, created_at, updated_at)
                 VALUES (?1, 'opencode', ?2, ?3, '旧会话', 'completed', ?4, ?4)",
            )
            .bind(Uuid::new_v4().to_string())
            .bind(agent_id)
            .bind(cwd)
            .bind(now_rfc3339())
            .execute(&store.pool)
            .await
            .unwrap();
        }

        let moved = store.backfill_session_workspaces().await.unwrap();
        assert_eq!(moved, 3);

        // distinct cwd → 两个空间；目录名即空间名（尾斜杠容忍）
        let spaces = store.list_workspaces().await.unwrap();
        let projects: Vec<_> = spaces.iter().filter(|w| w.kind == "project").collect();
        assert_eq!(projects.len(), 2);
        assert!(
            projects
                .iter()
                .any(|w| w.name == "alpha" && w.path.as_deref() == Some("/repo/alpha"))
        );
        assert!(
            projects
                .iter()
                .any(|w| w.name == "beta" && w.path.as_deref() == Some("/repo/beta/"))
        );

        // 会话全部绑定，且同 cwd 同空间
        let sessions = store.list_sessions().await.unwrap();
        assert!(sessions.iter().all(|s| s.workspace_id != DEFAULT_WORKSPACE));
        let s1 = sessions
            .iter()
            .find(|s| s.agent_session_id == "ses_old_1")
            .unwrap();
        let s2 = sessions
            .iter()
            .find(|s| s.agent_session_id == "ses_old_2")
            .unwrap();
        assert_eq!(s1.workspace_id, s2.workspace_id);

        // 幂等：二次回填零改动
        assert_eq!(store.backfill_session_workspaces().await.unwrap(), 0);
    }

    /// create_workspace 按 path UNIQUE 幂等；删除空间移会话入默认空间、默认空间不可删
    #[tokio::test]
    async fn 空间创建幂等与删除迁移() {
        let store = Store::open_in_memory().await.unwrap();
        store
            .upsert_agent("opencode", "OpenCode", "acp", None)
            .await
            .unwrap();

        let ws = store.create_workspace("/repo/gamma").await.unwrap();
        assert_eq!(ws.name, "gamma");
        let again = store.create_workspace("/repo/gamma").await.unwrap();
        assert_eq!(ws.id, again.id, "同路径重复创建应返回既有空间");

        let sid = Uuid::new_v4();
        store
            .insert_session(
                sid,
                "opencode",
                "ses_ws_1",
                "/repo/gamma/sub",
                "子目录会话",
                &ws.id,
            )
            .await
            .unwrap();

        store.delete_workspace(&ws.id).await.unwrap();
        let sessions = store.list_sessions().await.unwrap();
        assert_eq!(
            sessions[0].workspace_id, DEFAULT_WORKSPACE,
            "删空间后会话移入默认空间"
        );
        assert_eq!(store.list_workspaces().await.unwrap().len(), 1);

        assert!(
            store.delete_workspace(DEFAULT_WORKSPACE).await.is_err(),
            "默认空间不可删"
        );
    }

    /// 任务闭环（P1-9）：创建 backlog → 绑会话 → 流转状态 → 会话删除时解绑
    #[tokio::test]
    async fn 任务创建绑定流转与级联解绑() {
        let store = Store::open_in_memory().await.unwrap();
        store
            .upsert_agent("opencode", "OpenCode", "acp", None)
            .await
            .unwrap();
        let ws = store.create_workspace("/repo/kanban").await.unwrap();

        // 创建：初始 backlog、挂空间、无绑定
        let task = store.create_task(&ws.id, "修复登录页崩溃").await.unwrap();
        assert_eq!(task.status, "backlog");
        assert_eq!(task.workspace_id, ws.id);
        assert_eq!(task.session_id, None);

        // 建会话并绑定
        store
            .insert_session(
                Uuid::new_v4(),
                "opencode",
                "ses_task_1",
                "/repo/kanban",
                "任务会话",
                &ws.id,
            )
            .await
            .unwrap();
        let task = store
            .update_task(&task.id, None, Some("ses_task_1"))
            .await
            .unwrap();
        assert_eq!(task.session_id.as_deref(), Some("ses_task_1"));

        // 状态流转 + 非法状态拒绝
        let task = store
            .update_task(&task.id, Some("in_progress"), None)
            .await
            .unwrap();
        assert_eq!(task.status, "in_progress");
        assert!(
            store
                .update_task(&task.id, Some("paused"), None)
                .await
                .is_err()
        );

        // 解绑约定：空串 = NULL
        let task = store.update_task(&task.id, None, Some("")).await.unwrap();
        assert_eq!(task.session_id, None);

        // 重绑后删会话：任务保留、绑定被级联解绑
        store
            .update_task(&task.id, None, Some("ses_task_1"))
            .await
            .unwrap();
        assert!(store.delete_session_by_agent("ses_task_1").await.unwrap());
        let task = store.get_task(&task.id).await.unwrap().unwrap();
        assert_eq!(task.session_id, None, "会话删除后任务应解绑而非删除");
        assert_eq!(task.status, "in_progress", "状态不受会话删除影响");

        // 删除任务
        store.delete_task(&task.id).await.unwrap();
        assert!(store.get_task(&task.id).await.unwrap().is_none());
    }
}
