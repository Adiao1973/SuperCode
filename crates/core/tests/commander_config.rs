use serde_json::json;
use supercode_core::{commander::llm::LlmConfig, db::Store};
#[tokio::test]
async fn settings_survive_reopen_and_invalid_save_preserves_old_config() {
    let root = std::env::temp_dir().join(format!("sc-p32-settings-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("test.sqlite");
    let store = Store::open(&path).await.unwrap();
    assert!(store.get_commander_config().await.unwrap().is_none());
    let config:LlmConfig=serde_json::from_value(json!({"endpoint":"https://example.com/v1/chat/completions","model":"placeholder","api_key_env":"SC_PRIVATE_KEY"})).unwrap();
    store.save_commander_config(&config).await.unwrap();
    drop(store);
    let store = Store::open(&path).await.unwrap();
    let saved = store.get_commander_config().await.unwrap().unwrap();
    assert_eq!(saved.model, "placeholder");
    assert_eq!(saved.timeout_secs, 60);
    let mut oversized = saved.clone();
    oversized.endpoint = format!("https://example.com/{}", "x".repeat(64 * 1024));
    assert!(store.save_commander_config(&oversized).await.is_err());
    let mut invalid = saved.clone();
    invalid.endpoint = "http://example.com".into();
    assert!(store.save_commander_config(&invalid).await.is_err());
    assert_eq!(
        store
            .get_commander_config()
            .await
            .unwrap()
            .unwrap()
            .endpoint,
        config.endpoint
    );
    assert!(store.list_sessions().await.unwrap().is_empty());
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn config_file_rejects_key_values_unknown_fields_and_oversize_without_echoing() {
    let root = std::env::temp_dir().join(format!("sc-p32-config-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("config.json");
    for content in [
        r#"{"api_key":"do-not-print-private-test-secret"}"#.to_string(),
        "{".into(),
        " ".repeat(64 * 1024 + 1),
    ] {
        std::fs::write(&path, content).unwrap();
        let error = LlmConfig::read(&path).err().unwrap().to_string();
        assert!(!error.contains("do-not-print-private-test-secret"));
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn local_key_survives_reopen_and_never_crosses_provider_scope() {
    use supercode_core::commander::llm::credentials::CredentialSource;
    let root = std::env::temp_dir().join(format!("sc-private-key-{}", uuid::Uuid::new_v4()));
    let path = root.join("test.sqlite");
    let store = Store::open(&path).await.unwrap();
    let config:LlmConfig=serde_json::from_value(json!({"endpoint":"https://example.com/v1","model":"fixture","api_key_env":format!("SC_MISSING_{}",uuid::Uuid::new_v4().simple())})).unwrap();
    assert_eq!(
        store.commander_credential_source(&config).await.unwrap(),
        CredentialSource::Missing
    );
    store
        .save_commander_key(&config, " fixture-key\n")
        .await
        .unwrap();
    assert!(
        store
            .save_commander_key(&config, "bad internal key")
            .await
            .is_err()
    );
    drop(store);
    let store = Store::open(&path).await.unwrap();
    assert_eq!(
        store.commander_credential_source(&config).await.unwrap(),
        CredentialSource::Sqlite
    );
    assert_eq!(
        store.commander_key(&config).await.unwrap().as_deref(),
        Some("fixture-key")
    );
    let mut complete = config.clone();
    complete.endpoint.push_str("/chat/completions");
    assert_eq!(
        store.commander_credential_source(&complete).await.unwrap(),
        CredentialSource::Sqlite
    );
    complete.endpoint = "https://other.example.com/v1".into();
    assert_eq!(
        store.commander_credential_source(&complete).await.unwrap(),
        CredentialSource::Missing
    );
    assert!(store.list_sessions().await.unwrap().is_empty());
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}
