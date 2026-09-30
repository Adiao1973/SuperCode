use super::{Store, TASK_STATUSES, TaskEntry, now_rfc3339};
use crate::error::{CoreError, Result};

impl Store {
    /// 一条语句移动看板归属与状态；会话、执行 cwd 和标题保持原值。
    pub async fn move_task(&self, id: &str, workspace_id: &str, status: &str) -> Result<TaskEntry> {
        if !TASK_STATUSES.contains(&status) {
            return Err(CoreError::Db(format!("非法任务状态：{status}")));
        }
        let row = sqlx::query_as::<_, (String, String, String, Option<String>, String)>(
            "UPDATE tasks SET workspace_id=?2, status=?3, updated_at=?4
             WHERE id=?1 AND EXISTS (SELECT 1 FROM workspaces WHERE id=?2)
             RETURNING id, workspace_id, title, session_id, status",
        )
        .bind(id)
        .bind(workspace_id)
        .bind(status)
        .bind(now_rfc3339())
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| CoreError::Db(e.to_string()))?
        .ok_or_else(|| CoreError::Db("任务或目标空间不存在，请刷新看板".into()))?;
        Ok(TaskEntry {
            id: row.0,
            workspace_id: row.1,
            title: row.2,
            session_id: row.3,
            status: row.4,
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::DEFAULT_WORKSPACE;
    #[tokio::test]
    async fn movement_is_atomic_preserves_execution_and_survives_reopen() {
        let root = std::env::temp_dir().join(format!("sc-p28-{}", uuid::Uuid::new_v4()));
        let path = root.join("test.sqlite");
        let store = Store::open(&path).await.unwrap();
        let source = store.create_workspace("/example/source").await.unwrap();
        let destination = store
            .create_workspace("/example/destination")
            .await
            .unwrap();
        let task = store.create_task(&source.id, "move me").await.unwrap();
        store
            .upsert_agent("opencode", "OpenCode", "acp", None)
            .await
            .unwrap();
        store
            .insert_session(
                uuid::Uuid::new_v4(),
                "opencode",
                "ses_move",
                "/example/source",
                "history",
                &source.id,
            )
            .await
            .unwrap();
        store
            .update_task(&task.id, None, Some("ses_move"))
            .await
            .unwrap();
        let moved = store
            .move_task(&task.id, &destination.id, "review")
            .await
            .unwrap();
        assert_eq!(moved.workspace_id, destination.id);
        assert_eq!(moved.status, "review");
        assert_eq!(moved.session_id.as_deref(), Some("ses_move"));
        assert_eq!(moved.title, task.title);
        let cwd: String = sqlx::query_scalar("SELECT cwd FROM tasks WHERE id=?")
            .bind(&task.id)
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(cwd, "/example/source");
        assert_eq!(
            store.list_sessions().await.unwrap()[0].workspace_id,
            source.id
        );
        for (workspace, status) in [("missing", "done"), (DEFAULT_WORKSPACE, "invalid")] {
            assert!(store.move_task(&task.id, workspace, status).await.is_err());
            assert_eq!(store.get_task(&task.id).await.unwrap().unwrap(), moved);
        }
        assert!(
            store
                .move_task("missing", DEFAULT_WORKSPACE, "done")
                .await
                .is_err()
        );
        let moved = store
            .move_task(&task.id, DEFAULT_WORKSPACE, "done")
            .await
            .unwrap();
        store.pool.close().await;
        let reopened = Store::open(&path).await.unwrap();
        assert_eq!(reopened.get_task(&task.id).await.unwrap().unwrap(), moved);
        reopened.pool.close().await;
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}
