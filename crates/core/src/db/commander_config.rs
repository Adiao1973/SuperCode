use super::Store;
use crate::{
    commander::llm::LlmConfig,
    error::{CoreError, Result},
};
impl Store {
    pub async fn get_commander_config(&self) -> Result<Option<LlmConfig>> {
        let value: Option<String> =
            sqlx::query_scalar("SELECT config_json FROM commander_config WHERE id = 1")
                .fetch_optional(&self.pool)
                .await
                .map_err(|_| CoreError::Db("读取指挥官配置失败".into()))?;
        value
            .map(|json| {
                serde_json::from_str(&json).map_err(|_| CoreError::Db("指挥官配置格式无效".into()))
            })
            .transpose()
    }
    pub async fn save_commander_config(&self, config: &LlmConfig) -> Result<()> {
        config.validate()?;
        let json = serde_json::to_string(config)
            .map_err(|_| CoreError::Db("指挥官配置格式无效".into()))?;
        sqlx::query("INSERT INTO commander_config (id,config_json) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json").bind(json).execute(&self.pool).await.map_err(|_|CoreError::Db("保存指挥官配置失败".into()))?;
        Ok(())
    }
}

impl Store {
    pub async fn save_commander_key(&self, config: &LlmConfig, key: &str) -> Result<()> {
        use crate::commander::llm::credentials::{account, validate_key};
        let scope = account(config)?;
        let key = validate_key(key)?;
        sqlx::query("INSERT INTO commander_credentials(scope,key_value) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET key_value=excluded.key_value")
            .bind(scope).bind(key).execute(&self.pool).await.map_err(|_|CoreError::Db("本机密钥保存失败".into()))?;
        Ok(())
    }
    /// Internal host use only: never expose this return value over IPC or logs.
    pub async fn commander_key(&self, config: &LlmConfig) -> Result<Option<String>> {
        use crate::commander::llm::credentials::account;
        sqlx::query_scalar("SELECT key_value FROM commander_credentials WHERE scope=?")
            .bind(account(config)?)
            .fetch_optional(&self.pool)
            .await
            .map_err(|_| CoreError::Db("本机密钥读取失败".into()))
    }
    pub async fn commander_credential_source(
        &self,
        config: &LlmConfig,
    ) -> Result<crate::commander::llm::credentials::CredentialSource> {
        use crate::commander::llm::credentials::{CredentialSource, choose_key};
        let saved = self.commander_key(config).await?;
        let environment = std::env::var(&config.api_key_env).ok();
        if saved.is_none() && environment.is_none() {
            return Ok(CredentialSource::Missing);
        }
        choose_key(saved, environment).map(|(_, source)| source)
    }
    pub async fn commander_client(
        &self,
        config: LlmConfig,
    ) -> Result<crate::commander::llm::LlmClient> {
        use crate::commander::llm::{LlmClient, credentials::choose_key};
        let (key, _) = choose_key(
            self.commander_key(&config).await?,
            std::env::var(&config.api_key_env).ok(),
        )?;
        LlmClient::new(config, key)
    }
    pub async fn commander_models(&self, config: LlmConfig) -> Result<Vec<String>> {
        use crate::commander::llm::{LlmClient, credentials::choose_key};
        let (key, _) = choose_key(
            self.commander_key(&config).await?,
            std::env::var(&config.api_key_env).ok(),
        )?;
        LlmClient::discover_models(config, key).await
    }
}
