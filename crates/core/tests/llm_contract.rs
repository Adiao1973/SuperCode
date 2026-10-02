use serde_json::{Value, json};
use supercode_core::{
    commander::llm::{LlmClient, LlmConfig},
    registry::AgentRegistry,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use tokio_util::sync::CancellationToken;

const KEY: &str = "fixture-secret-never-display";
fn config(endpoint: String) -> LlmConfig {
    serde_json::from_value(json!({"endpoint":endpoint,"model":"fixture-model","api_key_env":"SC_FIXTURE_KEY","timeout_secs":1})).unwrap()
}
fn content() -> Value {
    json!({"version":1,"objective":"model paraphrase","tasks":[{"id":"one","title":"Plan","agent_id":"codex","prompt":"Design only"}]})
}
fn response(content: Value) -> String {
    json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":content.to_string()}}]}).to_string()
}
async fn server(
    status: &str,
    body: String,
    delay_ms: u64,
) -> (String, tokio::task::JoinHandle<Vec<u8>>) {
    server_at_phase(status, body, delay_ms, false, false).await
}
async fn server_at_phase(
    status: &str,
    body: String,
    delay_ms: u64,
    delay_body: bool,
    omit_length: bool,
) -> (String, tokio::task::JoinHandle<Vec<u8>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    );
    let status = status.to_string();
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buffer = [0; 4096];
        loop {
            let n = stream.read(&mut buffer).await.unwrap();
            if n == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..n]);
            if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&request[..end]);
                let length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_lowercase()
                            .strip_prefix("content-length: ")
                            .and_then(|s| s.parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                if request.len() >= end + 4 + length {
                    break;
                }
            }
        }
        let length = if omit_length {
            String::new()
        } else {
            format!("Content-Length: {}\r\n", body.len())
        };
        let location = if status.starts_with("302") {
            "Location: http://127.0.0.1:1/never-follow\r\n"
        } else {
            ""
        };
        let headers = format!(
            "HTTP/1.1 {status}\r\n{length}{location}Content-Type: application/json\r\nConnection: close\r\n\r\n"
        );
        if delay_body {
            let _ = stream.write_all(headers.as_bytes()).await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        if !delay_body {
            let _ = stream.write_all(headers.as_bytes()).await;
        }
        let _ = stream.write_all(body.as_bytes()).await;
        request
    });
    (endpoint, task)
}
#[tokio::test]
async fn sends_contract_and_validates_response_without_executing() {
    let (endpoint, task) = server("200 OK", response(content()), 0).await;
    let client = LlmClient::new(config(endpoint), KEY.into()).unwrap();
    let result = client
        .generate_plan(
            "Design a todo app",
            &AgentRegistry::builtin(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result.plan.objective, "Design a todo app");
    assert_eq!(result.batches, vec![vec!["one"]]);
    let request = task.await.unwrap();
    let end = request.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    assert!(String::from_utf8_lossy(&request[..end]).contains(&format!("Bearer {KEY}")));
    let body: Value = serde_json::from_slice(&request[end + 4..]).unwrap();
    assert_eq!(body["model"], "fixture-model");
    assert_eq!(body["stream"], false);
    assert_eq!(body["messages"][1]["content"], "Design a todo app");
    let system = body["messages"][0]["content"].as_str().unwrap();
    assert!(system.contains("codex"));
    assert!(!system.contains("zcode"));
    assert!(!format!("{client:?}").contains(KEY));
}
#[tokio::test]
async fn rejects_errors_and_never_echoes_provider_content_or_key() {
    let mut invalid = content();
    invalid["tasks"][0]["agent_id"] = json!(KEY);
    let truncated=json!({"choices":[{"finish_reason":"length","message":{"role":"assistant","content":content().to_string()}}]}).to_string();
    for (status, body) in [
        ("401 Unauthorized", KEY.into()),
        ("302 Found", KEY.into()),
        ("200 OK", KEY.into()),
        ("200 OK", response(invalid)),
        ("200 OK", truncated),
        ("200 OK", " ".repeat(1024 * 1024 + 1)),
    ] {
        let (endpoint, task) = server(status, body, 0).await;
        let client = LlmClient::new(config(endpoint), KEY.into()).unwrap();
        let error = client
            .generate_plan("goal", &AgentRegistry::builtin(), CancellationToken::new())
            .await
            .unwrap_err();
        assert!(!error.to_string().contains(KEY));
        if status.starts_with("302") {
            assert!(error.to_string().contains("302"));
        }
        task.await.unwrap();
    }
}
#[tokio::test]
async fn timeout_and_cancel_cover_pending_http_request() {
    for cancel in [false, true] {
        let (endpoint, task) = server("200 OK", response(content()), 1500).await;
        let client = LlmClient::new(config(endpoint), KEY.into()).unwrap();
        let token = CancellationToken::new();
        if cancel {
            let token = token.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                token.cancel();
            });
        }
        let start = std::time::Instant::now();
        let error = client
            .generate_plan("goal", &AgentRegistry::builtin(), token)
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains(if cancel { "取消" } else { "超时" }));
        assert!(
            start.elapsed() < std::time::Duration::from_millis(if cancel { 500 } else { 1400 })
        );
        task.abort();
    }
}
#[test]
fn rejects_invalid_config_without_printing_secrets() {
    for endpoint in [
        "http://example.com/v1",
        "https://user:fixture-secret-never-display@example.com/v1",
        "https://example.com/v1?key=fixture-secret-never-display",
        "ftp://localhost/v1",
        "not a url",
    ] {
        let error = LlmClient::new(config(endpoint.into()), KEY.into())
            .unwrap_err()
            .to_string();
        assert!(!error.contains(KEY));
    }
    for (field, value) in [
        ("model", json!(" ")),
        ("api_key_env", json!("9INVALID")),
        ("timeout_secs", json!(0)),
        ("timeout_secs", json!(301)),
    ] {
        let mut value_config = json!({"endpoint":"https://example.com/v1","model":"m","api_key_env":"KEY","timeout_secs":1});
        value_config[field] = value;
        let config: LlmConfig = serde_json::from_value(value_config).unwrap();
        assert!(LlmClient::new(config, KEY.into()).is_err());
    }
}

#[tokio::test]
async fn body_reads_share_the_deadline_and_support_cancellation() {
    for cancel in [false, true] {
        let (endpoint, task) =
            server_at_phase("200 OK", response(content()), 1500, true, false).await;
        let client = LlmClient::new(config(endpoint), KEY.into()).unwrap();
        let token = CancellationToken::new();
        if cancel {
            let token = token.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                token.cancel();
            });
        }
        let error = client
            .generate_plan("goal", &AgentRegistry::builtin(), token)
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains(if cancel { "取消" } else { "超时" }));
        task.abort();
    }
}
#[tokio::test]
async fn bounds_responses_without_content_length_and_rejects_refusals() {
    let (endpoint, task) =
        server_at_phase("200 OK", " ".repeat(1024 * 1024 + 1), 0, false, true).await;
    let error = LlmClient::new(config(endpoint), KEY.into())
        .unwrap()
        .generate_plan("goal", &AgentRegistry::builtin(), CancellationToken::new())
        .await
        .unwrap_err();
    assert!(error.to_string().contains("1 MiB"));
    task.await.unwrap();
    for message in [
        json!({"role":"assistant","content":"", "refusal":KEY}),
        json!({"role":"assistant","content":content().to_string(),"tool_calls":[]}),
        json!({"role":"assistant","content":{}}),
    ] {
        let (endpoint, task) = server(
            "200 OK",
            json!({"choices":[{"finish_reason":"stop","message":message}]}).to_string(),
            0,
        )
        .await;
        let error = LlmClient::new(config(endpoint), KEY.into())
            .unwrap()
            .generate_plan("goal", &AgentRegistry::builtin(), CancellationToken::new())
            .await
            .unwrap_err();
        assert!(!error.to_string().contains(KEY));
        task.await.unwrap();
    }
}

#[test]
fn missing_or_malformed_credentials_fail_without_echoing_values() {
    let mut config = config("https://example.com/chat/completions".into());
    config.api_key_env = format!("SC_MISSING_{}", uuid::Uuid::new_v4().simple());
    assert!(
        LlmClient::from_config(config.clone())
            .unwrap_err()
            .to_string()
            .contains("未设置")
    );
    assert!(LlmClient::new(config.clone(), " ".into()).is_err());
    let error = LlmClient::new(config, format!("{KEY}\r\nheader-injection"))
        .unwrap_err()
        .to_string();
    assert!(!error.contains(KEY));
}

#[tokio::test]
async fn model_discovery_uses_same_origin_and_sorts_without_requiring_model() {
    let (endpoint, task) = server(
        "200 OK",
        json!({"data":[{"id":"z"},{"id":"a"},{"id":"z"}]}).to_string(),
        0,
    )
    .await;
    let mut cfg = config(endpoint);
    cfg.model.clear();
    let models = LlmClient::discover_models(cfg, KEY.to_string())
        .await
        .unwrap();
    assert_eq!(models, vec!["a", "z"]);
    let request = String::from_utf8(task.await.unwrap()).unwrap();
    assert!(request.starts_with("GET /v1/models HTTP/1.1"));
    assert!(request.contains(&format!("authorization: Bearer {KEY}")));
}

#[tokio::test]
async fn model_discovery_rejects_bad_responses_without_echoing_secrets() {
    for (status, body) in [
        ("401 Unauthorized", KEY.to_string()),
        ("200 OK", KEY.to_string()),
        ("200 OK", json!({"data":[{"id":""}]}).to_string()),
        ("302 Found", KEY.to_string()),
    ] {
        let (endpoint, task) = server(status, body, 0).await;
        let error = LlmClient::discover_models(config(endpoint), KEY.to_string())
            .await
            .unwrap_err()
            .to_string();
        assert!(!error.contains(KEY));
        task.await.unwrap();
    }
}

#[tokio::test]
async fn model_discovery_bounds_body_items_and_timeout() {
    for body in [
        "x".repeat(1024 * 1024 + 1),
        json!({"data":vec![json!({"id":"a"});4097]}).to_string(),
    ] {
        let (endpoint, task) = server("200 OK", body, 0).await;
        assert!(
            LlmClient::discover_models(config(endpoint), KEY.to_string())
                .await
                .is_err()
        );
        // Client may close immediately upon oversized Content-Length.
        let _ = task.await;
    }
    let (endpoint, task) = server("200 OK", json!({"data":[]}).to_string(), 1500).await;
    let error = LlmClient::discover_models(config(endpoint), KEY.to_string())
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("超时"));
    task.abort();
    assert!(
        LlmClient::discover_models(config("https://example.com/custom".into()), KEY.to_string())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn copied_base_url_and_key_whitespace_are_normalized() {
    for suffix in ["", "/"] {
        let (endpoint, task) =
            server("200 OK", json!({"data":[{"id":"model"}]}).to_string(), 0).await;
        let base = endpoint.strip_suffix("/chat/completions").unwrap();
        assert_eq!(
            LlmClient::discover_models(config(format!("{base}{suffix}")), format!(" \r\n{KEY}\n"))
                .await
                .unwrap(),
            vec!["model"]
        );
        let request = String::from_utf8(task.await.unwrap()).unwrap();
        assert!(request.starts_with("GET /v1/models HTTP/1.1"));
        assert!(request.contains(&format!("authorization: Bearer {KEY}\r\n")));
    }
    let (endpoint, task) = server("200 OK", response(content()), 0).await;
    let base = endpoint.strip_suffix("/chat/completions").unwrap();
    LlmClient::new(config(base.into()), KEY.into())
        .unwrap()
        .generate_plan("goal", &AgentRegistry::builtin(), CancellationToken::new())
        .await
        .unwrap();
    assert!(
        String::from_utf8(task.await.unwrap())
            .unwrap()
            .starts_with("POST /v1/chat/completions HTTP/1.1")
    );
    for key in ["abc def", "abc\nxyz", "密钥"] {
        let error = LlmClient::new(config("https://example.com/v1".into()), key.into())
            .err()
            .unwrap()
            .to_string();
        assert!(!error.contains(key));
    }
}
