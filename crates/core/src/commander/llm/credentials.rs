//! Credential scope/validation only; no secret serialization or diagnostics.
use super::{LlmConfig, invalid};
use crate::error::Result;
use serde::Serialize;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialSource {
    Sqlite,
    Environment,
    Missing,
}
pub(crate) fn account(config: &LlmConfig) -> Result<String> {
    let mut config = config.clone();
    config.model = "credential-scope".into();
    let url = config.validate()?;
    let path = url.path().trim_end_matches('/');
    let path = path.strip_suffix("/chat/completions").unwrap_or(path);
    Ok(format!(
        "{}{}|{}",
        url.origin().ascii_serialization(),
        path,
        config.api_key_env
    ))
}
pub(crate) fn validate_key(key: &str) -> Result<&str> {
    let key = key.trim();
    if key.is_empty() || key.len() > 16 * 1024 || !key.bytes().all(|c| c.is_ascii_graphic()) {
        return Err(invalid(
            "密钥不能为空、过长或包含内部空白/非法字符；请重新复制完整 key",
        ));
    }
    Ok(key)
}
pub(crate) fn choose_key(
    stored: Option<String>,
    environment: Option<String>,
) -> Result<(String, CredentialSource)> {
    if let Some(key) = stored {
        return Ok((validate_key(&key)?.into(), CredentialSource::Sqlite));
    }
    if let Some(key) = environment {
        return Ok((validate_key(&key)?.into(), CredentialSource::Environment));
    }
    Err(invalid(
        "尚未保存密钥，请在 App 内保存，或设置 key 环境变量",
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    fn config(url: &str) -> LlmConfig {
        LlmConfig {
            endpoint: url.into(),
            model: "".into(),
            api_key_env: "TEST_KEY".into(),
            timeout_secs: 60,
        }
    }
    #[test]
    fn scopes_are_stable_for_base_url_but_never_cross_origins_or_paths() {
        assert_eq!(
            account(&config("https://example.com/v1/")).unwrap(),
            account(&config("https://example.com/v1/chat/completions")).unwrap()
        );
        for url in [
            "https://other.example/v1",
            "https://example.com/other/v1",
            "https://example.com:444/v1",
        ] {
            assert_ne!(
                account(&config(url)).unwrap(),
                account(&config("https://example.com/v1")).unwrap()
            );
        }
        assert!(account(&config("http://example.com/v1")).is_err());
    }
    #[test]
    fn stored_key_precedes_environment_and_errors_never_echo_credentials() {
        assert_eq!(
            choose_key(Some(" fixture-key\n".into()), Some("bad key".into())).unwrap(),
            ("fixture-key".into(), CredentialSource::Sqlite)
        );
        assert_eq!(
            choose_key(None, Some("fixture-env".into())).unwrap().1,
            CredentialSource::Environment
        );
        assert!(choose_key(None, None).is_err());
        for value in ["fixture bad", "", "中文", &"x".repeat(16385)] {
            assert!(validate_key(value).is_err());
        }
        assert!(
            !validate_key("fixture bad")
                .unwrap_err()
                .to_string()
                .contains("fixture bad")
        );
    }
}
