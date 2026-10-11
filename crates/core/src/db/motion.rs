use super::Store;
use crate::error::{CoreError, Result};

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MotionPreference {
    #[default]
    System,
    Full,
    Reduce,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MotionPreferences {
    pub motion: MotionPreference,
}

impl Store {
    pub async fn get_motion_preferences(&self) -> Result<MotionPreferences> {
        let value: Option<String> =
            sqlx::query_scalar("SELECT motion FROM motion_preferences WHERE id=1")
                .fetch_optional(&self.pool)
                .await
                .map_err(|e| CoreError::Db(e.to_string()))?;
        match value {
            None => Ok(MotionPreferences::default()),
            Some(motion) => serde_json::from_value(serde_json::json!({"motion":motion}))
                .map_err(|e| CoreError::Db(e.to_string())),
        }
    }
    pub async fn save_motion_preferences(&self, preferences: MotionPreferences) -> Result<()> {
        let value = serde_json::to_value(preferences).map_err(|e| CoreError::Db(e.to_string()))?;
        sqlx::query("INSERT INTO motion_preferences(id,motion) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET motion=excluded.motion")
            .bind(value["motion"].as_str().expect("motion enum serializes to string"))
            .execute(&self.pool).await.map_err(|e| CoreError::Db(e.to_string()))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn motion_contract_rejects_unknown_fields_and_values() {
        for value in ["system", "full", "reduce"] {
            let json = serde_json::json!({"motion":value});
            let prefs: MotionPreferences = serde_json::from_value(json.clone()).unwrap();
            assert_eq!(serde_json::to_value(prefs).unwrap(), json);
        }
        for json in [
            serde_json::json!({"motion":"invalid"}),
            serde_json::json!({"motion":"reduce","key":"fixture"}),
            serde_json::json!({}),
        ] {
            assert!(serde_json::from_value::<MotionPreferences>(json).is_err());
        }
    }
    #[tokio::test]
    async fn motion_defaults_and_atomic_save() {
        let store = Store::open_in_memory().await.unwrap();
        assert_eq!(
            store.get_motion_preferences().await.unwrap(),
            MotionPreferences::default()
        );
        let dark = MotionPreferences {
            motion: MotionPreference::Reduce,
        };
        store.save_motion_preferences(dark).await.unwrap();
        assert!(
            sqlx::query("UPDATE motion_preferences SET motion='invalid'")
                .execute(&store.pool)
                .await
                .is_err()
        );
        assert_eq!(store.get_motion_preferences().await.unwrap(), dark);
    }
    #[tokio::test]
    async fn motion_upgrade_preserves_v1_sessions_credentials_and_reopens() {
        use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
        let directory =
            std::env::temp_dir().join(format!("supercode-motion-{}", uuid::Uuid::new_v4()));
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
            std::borrow::Cow::Owned(old.iter().filter(|m| m.version <= 8).cloned().collect());
        old.run(&pool).await.unwrap();
        sqlx::query("INSERT INTO agents(id,display_name,driver_kind,updated_at) VALUES('fixture','fixture','acp','2026-01-01')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO sessions(id,agent_id,agent_session_id,cwd,title,status,created_at,updated_at) VALUES('fixture-session','fixture','fixture-acp','/fixture','中文历史','completed','2026-01-01','2026-01-01')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO commander_credentials(scope,key_value) VALUES('fixture-scope','synthetic-not-a-key')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO appearance_preferences(id,theme) VALUES(1,'dark')")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
        let store = Store::open(&path).await.unwrap();
        assert_eq!(
            store.get_motion_preferences().await.unwrap().motion,
            MotionPreference::System
        );
        store
            .save_motion_preferences(MotionPreferences {
                motion: MotionPreference::Full,
            })
            .await
            .unwrap();
        store.pool.close().await;
        let reopened = Store::open(&path).await.unwrap();
        assert_eq!(
            reopened.get_motion_preferences().await.unwrap().motion,
            MotionPreference::Full
        );
        assert_eq!(
            reopened.get_appearance_preferences().await.unwrap().theme,
            super::super::ThemePreference::Dark
        );
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
