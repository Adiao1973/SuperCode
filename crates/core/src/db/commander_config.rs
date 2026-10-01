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
