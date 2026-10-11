use super::Store;
use crate::error::{CoreError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LayoutPreferences {
    pub session_list_width: u16,
    pub session_list_collapsed: bool,
    pub terminal_height: u16,
    pub terminal_collapsed: bool,
}
impl Default for LayoutPreferences {
    fn default() -> Self {
        Self {
            session_list_width: 224,
            session_list_collapsed: false,
            terminal_height: 224,
            terminal_collapsed: false,
        }
    }
}
impl LayoutPreferences {
    fn validate(self) -> Result<Self> {
        if !(180..=400).contains(&self.session_list_width)
            || !(96..=360).contains(&self.terminal_height)
        {
            return Err(CoreError::Protocol("分栏尺寸超出合法范围".into()));
        }
        Ok(self)
    }
}
impl Store {
    pub async fn get_layout_preferences(&self) -> Result<LayoutPreferences> {
        let row: Option<(i64,bool,i64,bool)> = sqlx::query_as("SELECT session_list_width,session_list_collapsed,terminal_height,terminal_collapsed FROM layout_preferences WHERE id=1")
            .fetch_optional(&self.pool).await.map_err(|e|CoreError::Db(e.to_string()))?;
        match row {
            None => Ok(LayoutPreferences::default()),
            Some((width, collapsed, height, terminal_collapsed)) => LayoutPreferences {
                session_list_width: u16::try_from(width)
                    .map_err(|_| CoreError::Db("分栏尺寸无效".into()))?,
                session_list_collapsed: collapsed,
                terminal_height: u16::try_from(height)
                    .map_err(|_| CoreError::Db("分栏尺寸无效".into()))?,
                terminal_collapsed,
            }
            .validate(),
        }
    }
    pub async fn save_layout_preferences(&self, preferences: LayoutPreferences) -> Result<()> {
        let p = preferences.validate()?;
        sqlx::query("INSERT INTO layout_preferences(id,session_list_width,session_list_collapsed,terminal_height,terminal_collapsed) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET session_list_width=excluded.session_list_width,session_list_collapsed=excluded.session_list_collapsed,terminal_height=excluded.terminal_height,terminal_collapsed=excluded.terminal_collapsed")
            .bind(p.session_list_width as i64).bind(p.session_list_collapsed).bind(p.terminal_height as i64).bind(p.terminal_collapsed)
            .execute(&self.pool).await.map_err(|e| CoreError::Db(e.to_string()))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strict_layout_contract_and_bounds() {
        let p = LayoutPreferences::default();
        let json = serde_json::to_value(p).unwrap();
        assert_eq!(
            serde_json::from_value::<LayoutPreferences>(json.clone()).unwrap(),
            p
        );
        for invalid in [
            serde_json::json!({}),
            serde_json::json!({"session_list_width":224,"session_list_collapsed":false,"terminal_height":224,"terminal_collapsed":false,"extra":true}),
            serde_json::json!({"session_list_width":-1,"session_list_collapsed":false,"terminal_height":224,"terminal_collapsed":false}),
        ] {
            assert!(serde_json::from_value::<LayoutPreferences>(invalid).is_err());
        }
        for width in [179, 401] {
            assert!(
                LayoutPreferences {
                    session_list_width: width,
                    ..p
                }
                .validate()
                .is_err()
            );
        }
        for height in [95, 361] {
            assert!(
                LayoutPreferences {
                    terminal_height: height,
                    ..p
                }
                .validate()
                .is_err()
            );
        }
        for (width, height) in [(180, 96), (400, 360)] {
            assert!(
                LayoutPreferences {
                    session_list_width: width,
                    terminal_height: height,
                    ..p
                }
                .validate()
                .is_ok()
            );
        }
    }
    #[tokio::test]
    async fn defaults_atomic_save_and_database_bounds() {
        let store = Store::open_in_memory().await.unwrap();
        assert_eq!(
            store.get_layout_preferences().await.unwrap(),
            LayoutPreferences::default()
        );
        let p = LayoutPreferences {
            session_list_width: 300,
            session_list_collapsed: true,
            terminal_height: 180,
            terminal_collapsed: true,
        };
        store.save_layout_preferences(p).await.unwrap();
        assert!(
            store
                .save_layout_preferences(LayoutPreferences {
                    terminal_height: 0,
                    ..p
                })
                .await
                .is_err()
        );
        assert!(
            sqlx::query("UPDATE layout_preferences SET session_list_width=401")
                .execute(&store.pool)
                .await
                .is_err()
        );
        assert_eq!(store.get_layout_preferences().await.unwrap(), p);
    }
    #[tokio::test]
    async fn layout_upgrade_preserves_v1_sessions_credentials_and_reopens() {
        use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
        let directory =
            std::env::temp_dir().join(format!("supercode-layout-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("fixture.db");
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
        sqlx::query("INSERT INTO agents(id,display_name,driver_kind,updated_at) VALUES('fixture','fixture','acp','2026-01-01')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO sessions(id,agent_id,agent_session_id,cwd,title,status,created_at,updated_at) VALUES('fixture-session','fixture','fixture-acp','/fixture','中文历史','completed','2026-01-01','2026-01-01')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO commander_credentials(scope,key_value) VALUES('fixture-scope','synthetic-not-a-key')").execute(&pool).await.unwrap();
        pool.close().await;
        let store = Store::open(&path).await.unwrap();
        assert_eq!(
            store.get_layout_preferences().await.unwrap(),
            LayoutPreferences::default()
        );
        let saved = LayoutPreferences {
            session_list_width: 320,
            terminal_height: 160,
            session_list_collapsed: true,
            terminal_collapsed: true,
        };
        store.save_layout_preferences(saved).await.unwrap();
        store.pool.close().await;
        let reopened = Store::open(&path).await.unwrap();
        assert_eq!(reopened.get_layout_preferences().await.unwrap(), saved);
        let title: String =
            sqlx::query_scalar("SELECT title FROM sessions WHERE id='fixture-session'")
                .fetch_one(&reopened.pool)
                .await
                .unwrap();
        let key: String = sqlx::query_scalar(
            "SELECT key_value FROM commander_credentials WHERE scope='fixture-scope'",
        )
        .fetch_one(&reopened.pool)
        .await
        .unwrap();
        assert_eq!(title, "中文历史");
        assert_eq!(key, "synthetic-not-a-key");
        reopened.pool.close().await;
        std::fs::remove_dir_all(directory).unwrap();
    }
}
