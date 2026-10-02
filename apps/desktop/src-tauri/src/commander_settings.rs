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

#[tauri::command]
pub async fn list_commander_models(
    state: tauri::State<'_, AppState>,
    config: LlmConfig,
) -> Result<Vec<String>, String> {
    state
        .store()
        .await
        .commander_models(config)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn save_commander_key(
    state: tauri::State<'_, AppState>,
    config: LlmConfig,
    key: String,
) -> Result<(), String> {
    state
        .store()
        .await
        .save_commander_key(&config, &key)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn commander_credential_source(
    state: tauri::State<'_, AppState>,
    config: LlmConfig,
) -> Result<supercode_core::commander::llm::credentials::CredentialSource, String> {
    state
        .store()
        .await
        .commander_credential_source(&config)
        .await
        .map_err(|e| e.to_string())
}

use std::{collections::HashMap, sync::Mutex};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
#[derive(Default)]
pub struct CommanderRequests(Mutex<HashMap<Uuid, CancellationToken>>);
impl CommanderRequests {
    fn begin(&self, id: Uuid) -> Result<RequestGuard<'_>, String> {
        let mut requests = self.0.lock().map_err(|_| "验证请求状态不可用")?;
        if !requests.is_empty() {
            return Err("已有模型验证正在进行，请先取消或等待完成".into());
        }
        let token = CancellationToken::new();
        requests.insert(id, token.clone());
        Ok(RequestGuard {
            requests: self,
            id,
            token,
        })
    }
    pub fn cancel_all(&self) {
        if let Ok(requests) = self.0.lock() {
            for token in requests.values() {
                token.cancel();
            }
        }
    }
}
struct RequestGuard<'a> {
    requests: &'a CommanderRequests,
    id: Uuid,
    token: CancellationToken,
}
impl Drop for RequestGuard<'_> {
    fn drop(&mut self) {
        self.token.cancel();
        if let Ok(mut requests) = self.requests.0.lock() {
            requests.remove(&self.id);
        }
    }
}
#[tauri::command]
pub async fn verify_commander_plan(
    state: tauri::State<'_, AppState>,
    requests: tauri::State<'_, CommanderRequests>,
    request_id: String,
) -> Result<supercode_core::commander::ValidatedPlan, String> {
    let id = Uuid::parse_str(&request_id).map_err(|_| "验证请求 ID 无效")?;
    let guard = requests.begin(id)?;
    let store = state.store().await;
    let config = store
        .get_commander_config()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("请先保存指挥官连接配置")?;
    let client = store
        .commander_client(config)
        .await
        .map_err(|e| e.to_string())?;
    client
        .generate_plan(
            "为一个待办应用提出开发计划，不执行任务",
            &supercode_core::registry::AgentRegistry::load(),
            guard.token.clone(),
        )
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn cancel_commander_plan(
    requests: tauri::State<'_, CommanderRequests>,
    request_id: String,
) -> Result<(), String> {
    let id = Uuid::parse_str(&request_id).map_err(|_| "验证请求 ID 无效")?;
    if let Some(token) = requests
        .0
        .lock()
        .map_err(|_| "验证请求状态不可用")?
        .get(&id)
    {
        token.cancel();
    }
    Ok(())
}
#[cfg(test)]
mod request_tests {
    use super::*;
    #[test]
    fn request_guard_prevents_overlap_and_releases_on_drop() {
        let requests = CommanderRequests::default();
        let id = Uuid::new_v4();
        let guard = requests.begin(id).unwrap();
        assert!(requests.begin(id).is_err());
        assert!(requests.begin(Uuid::new_v4()).is_err());
        let token = guard.token.clone();
        requests.cancel_all();
        assert!(token.is_cancelled());
        drop(guard);
        assert!(requests.begin(id).is_ok());
    }
}
