//! Whole-database regression from the released 1.0 migration boundary.
use super::*;

async fn snapshot(pool: &SqlitePool) -> Vec<(String, Vec<String>)> {
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='_sqlx_migrations' AND name NOT LIKE '%_preferences' ORDER BY name",
    ).fetch_all(pool).await.unwrap();
    let mut result = Vec::new();
    for table in tables {
        let columns: Vec<String> = sqlx::query(&format!("PRAGMA table_info({table})"))
            .fetch_all(pool)
            .await
            .unwrap()
            .iter()
            .map(|row| row.get::<String, _>("name"))
            .collect();
        let rows = sqlx::query_scalar::<_, String>(&format!(
            "SELECT json_array({}) FROM {table} ORDER BY 1",
            columns.join(",")
        ))
        .fetch_all(pool)
        .await
        .unwrap();
        result.push((table, rows));
    }
    result
}

#[tokio::test]
async fn upgrade_v1_preserves_all_records_and_never_dispatches_on_open() {
    let root = std::env::temp_dir().join(format!("sc-upgrade-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("fixture.db");
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true),
        )
        .await
        .unwrap();
    let mut old = sqlx::migrate!("./migrations");
    old.migrations =
        std::borrow::Cow::Owned(old.iter().filter(|m| m.version <= 7).cloned().collect());
    old.run(&pool).await.unwrap();
    for statement in [
        "INSERT INTO agents VALUES('fixture','历史 Agent','acp','{}','{}','1.0','2026-01-01')",
        "INSERT INTO workspaces VALUES('default','默认空间',NULL,'default','2026-01-01')",
        "INSERT INTO workspaces VALUES('project','中文项目','/fixture/project','project','2026-01-01')",
        "INSERT INTO sessions VALUES('session','fixture','original-acp','/fixture/worktree','中文会话','completed','2026-01-01','2026-01-01','project')",
        r#"INSERT INTO messages VALUES('message','session','user','[{"text":"升级保留中文\n第二行"}]','2026-01-01')"#,
        "INSERT INTO tool_calls VALUES('tool','session','read','read','completed','{}','{}','2026-01-01','2026-01-01')",
        "INSERT INTO approvals VALUES('approval','session','tool','read','{}','allow','user','2026-01-01','2026-01-01')",
        "INSERT INTO permission_rules VALUES('rule','read:*','ask','2026-01-01')",
        "INSERT INTO tasks VALUES('task','保留任务','/fixture/worktree','review','2026-01-01','2026-01-01','project','original-acp')",
        r#"INSERT INTO commander_config VALUES(1,'{"endpoint":"https://example.com/v1","model":"synthetic","api_key_env":"SC_UPGRADE_UNUSED"}')"#,
        "INSERT INTO commander_credentials VALUES('synthetic-scope','synthetic-not-a-key')",
    ] {
        sqlx::query(statement).execute(&pool).await.unwrap();
    }
    let plan = r#"{"version":1,"objective":"升级不执行","tasks":[{"id":"one","title":"保留任务","agent_id":"opencode","prompt":"仅测试","depends_on":[]}]}"#;
    for status in ["draft", "running", "succeeded"] {
        sqlx::query("INSERT INTO commander_runs VALUES(?1,?2,'/fixture/worktree',?1,?3,2,'2026-01-01','2026-01-01')")
            .bind(status).bind(plan)
            .bind(format!(r#"[{{"id":"one","status":"{}","session_id":null}}]"#, if status == "draft" { "pending" } else { status }))
            .execute(&pool).await.unwrap();
    }
    let before = snapshot(&pool).await;
    pool.close().await;
    for _ in 0..2 {
        let store = Store::open(&path).await.unwrap();
        assert_eq!(snapshot(&store.pool).await, before);
        assert_eq!(
            store.get_appearance_preferences().await.unwrap(),
            AppearancePreferences::default()
        );
        assert_eq!(
            store.get_motion_preferences().await.unwrap(),
            MotionPreferences::default()
        );
        assert_eq!(
            store.get_layout_preferences().await.unwrap(),
            LayoutPreferences::default()
        );
        let version: i64 =
            sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations WHERE success=1")
                .fetch_one(&store.pool)
                .await
                .unwrap();
        assert_eq!(version, 10);
        store.pool.close().await;
    }
    std::fs::remove_dir_all(root).unwrap();
}
