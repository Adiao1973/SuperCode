use super::AppState;
use supercode_core::commander::llm::LlmConfig;
#[tauri::command]
pub async fn get_commander_config(
    state: tauri::State<'_, AppState>,
) -> Result<Option<LlmConfig>, String> {
    state
        .store()
        .await
        .get_commander_config()
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn save_commander_config(
    state: tauri::State<'_, AppState>,
    config: LlmConfig,
) -> Result<(), String> {
    state
        .store()
        .await
        .save_commander_config(&config)
        .await
        .map_err(|e| e.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frontend_config_fields_roundtrip_without_accepting_a_key_value() {
        let input = serde_json::json!({"endpoint":"https://example.com/chat/completions","model":"placeholder","api_key_env":"SC_TEST_KEY","timeout_secs":60});
        let config: LlmConfig = serde_json::from_value(input.clone()).unwrap();
        config.validate().unwrap();
        assert_eq!(serde_json::to_value(config).unwrap(), input);
        let mut input = input;
        input["api_key"] = serde_json::json!("never-store-test-key");
        assert!(serde_json::from_value::<LlmConfig>(input).is_err());
    }
}
