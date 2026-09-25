//! SQLite 持久层（sqlx，docs/architecture.md §6）。
//! Store 为连接池薄封装（Clone 廉价）；事件流落库经 [`recorder::SessionRecorder`]。

mod recorder;

pub use recorder::SessionRecorder;

use std::path::PathBuf;

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
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true);
        Self::connect(options).await
    }

    pub async fn open_in_memory() -> Result<Self> {
        // SqliteConnectOptions::new() 默认即 :memory:
        Self::connect(SqliteConnectOptions::new()).await
    }

    async fn connect(options: SqliteConnectOptions) -> Result<Self> {
        // 单连接：:memory: 库每个连接独立，多连接会"丢表"；CLI 场景吞吐足够
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .map_err(|e| CoreError::Db(e.to_string()))?;
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .map_err(|e| CoreError::Db(e.to_string()))?;
        Ok(Self { pool })
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
    pub async fn insert_session(
        &self,
        id: Uuid,
        agent_id: &str,
        agent_session_id: &str,
        cwd: &str,
        title: &str,
    ) -> Result<()> {
        let now = now_rfc3339();
        sqlx::query(
            "INSERT OR IGNORE INTO sessions (id, agent_id, agent_session_id, cwd, title, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?6)",
        )
        .bind(id.to_string())
        .bind(agent_id)
        .bind(agent_session_id)
        .bind(cwd)
        .bind(title)
        .bind(&now)
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
            "SELECT id, agent_id, agent_session_id, cwd, title, status, updated_at
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
            })
            .collect())
    }

    pub async fn get_session(&self, id: Uuid) -> Result<Option<SessionRow>> {
        let row = sqlx::query(
            "SELECT id, agent_id, agent_session_id, cwd, title, status, updated_at
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
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
            .insert_session(sid, "opencode", "ses_x", "/tmp", "t")
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
}
