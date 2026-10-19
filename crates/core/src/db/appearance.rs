use super::Store;
use crate::error::{CoreError, Result};

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThemePreference {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppearancePreferences {
    pub theme: ThemePreference,
}

impl Store {
    pub async fn get_appearance_preferences(&self) -> Result<AppearancePreferences> {
        let value: Option<String> =
            sqlx::query_scalar("SELECT theme FROM appearance_preferences WHERE id=1")
                .fetch_optional(&self.pool)
                .await
                .map_err(|e| CoreError::Db(e.to_string()))?;
        match value {
            None => Ok(AppearancePreferences::default()),
            Some(theme) => serde_json::from_value(serde_json::json!({"theme":theme}))
                .map_err(|e| CoreError::Db(e.to_string())),
        }
    }
    pub async fn save_appearance_preferences(
        &self,
        preferences: AppearancePreferences,
    ) -> Result<()> {
        let value = serde_json::to_value(preferences).map_err(|e| CoreError::Db(e.to_string()))?;
        sqlx::query("INSERT INTO appearance_preferences(id,theme) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET theme=excluded.theme")
            .bind(value["theme"].as_str().expect("theme enum serializes to string"))
            .execute(&self.pool).await.map_err(|e| CoreError::Db(e.to_string()))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn appearance_contract_rejects_unknown_fields_and_values() {
        for value in ["system", "light", "dark"] {
            let json = serde_json::json!({"theme":value});
            let prefs: AppearancePreferences = serde_json::from_value(json.clone()).unwrap();
            assert_eq!(serde_json::to_value(prefs).unwrap(), json);
        }
        for json in [
            serde_json::json!({"theme":"invalid"}),
            serde_json::json!({"theme":"dark","key":"fixture"}),
            serde_json::json!({}),
        ] {
            assert!(serde_json::from_value::<AppearancePreferences>(json).is_err());
        }
    }
    #[tokio::test]
    async fn appearance_defaults_and_atomic_save() {
        let store = Store::open_in_memory().await.unwrap();
        assert_eq!(
            store.get_appearance_preferences().await.unwrap(),
            AppearancePreferences::default()
        );
        let dark = AppearancePreferences {
            theme: ThemePreference::Dark,
        };
        store.save_appearance_preferences(dark).await.unwrap();
        assert!(
            sqlx::query("UPDATE appearance_preferences SET theme='invalid'")
                .execute(&store.pool)
                .await
                .is_err()
        );
        assert_eq!(store.get_appearance_preferences().await.unwrap(), dark);
    }
    #[tokio::test]
    async fn appearance_upgrade_preserves_v1_sessions_credentials_and_reopens() {
        use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
        let directory =
            std::env::temp_dir().join(format!("supercode-appearance-{}", uuid::Uuid::new_v4()));
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
            store.get_appearance_preferences().await.unwrap().theme,
            ThemePreference::System
        );
        store
            .save_appearance_preferences(AppearancePreferences {
                theme: ThemePreference::Light,
            })
            .await
            .unwrap();
        store.pool.close().await;
        let reopened = Store::open(&path).await.unwrap();
        assert_eq!(
            reopened.get_appearance_preferences().await.unwrap().theme,
            ThemePreference::Light
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
