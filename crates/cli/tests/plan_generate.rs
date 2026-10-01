use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader},
    path::Path,
    process::{Child, ChildStdout, Command, Stdio},
};
struct Fixture {
    child: Child,
    reader: BufReader<ChildStdout>,
    url: String,
}
impl Fixture {
    fn new(mode: &str) -> Self {
        let script =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../core/tests/fixtures/llm-server.mjs");
        let mut child = Command::new("node")
            .arg(script)
            .arg(mode)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut reader = BufReader::new(child.stdout.take().unwrap());
        let mut url = String::new();
        reader.read_line(&mut url).unwrap();
        Self {
            child,
            reader,
            url: url.trim().into(),
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn command(root: &Path, endpoint: &str) -> Command {
    let file = root.join("config.json");
    std::fs::write(&file,json!({"endpoint":endpoint,"model":"fixture-model","api_key_env":"SC_CLI_FIXTURE_KEY","timeout_secs":5}).to_string()).unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_supercode"));
    command
        .args(["plan", "generate", "Design a todo app", "--config"])
        .arg(file)
        .env("SC_CLI_FIXTURE_KEY", "local-fixture-key")
        .env("SUPERCODE_DB", root.join("unused.sqlite"));
    command
}
#[test]
fn cli_generates_validated_plan_and_redacts_http_errors() {
    let root = std::env::temp_dir().join(format!("sc-p32-cli-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    for mode in ["ok", "error"] {
        let fixture = Fixture::new(mode);
        let output = command(&root, &fixture.url).output().unwrap();
        if mode == "ok" {
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let v: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(v["batches"], json!([["design"]]));
        } else {
            assert!(!output.status.success());
            assert!(!String::from_utf8_lossy(&output.stderr).contains("local-fixture-key"));
        }
    }
    assert!(!root.join("unused.sqlite").exists());
    std::fs::remove_dir_all(root).unwrap();
}
#[cfg(unix)]
#[test]
fn cli_ctrl_c_cancels_request() {
    let root = std::env::temp_dir().join(format!("sc-p32-cancel-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let mut fixture = Fixture::new("slow");
    let child = command(&root, &fixture.url)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = String::new();
    fixture.reader.read_line(&mut line).unwrap();
    assert_eq!(line.trim(), "request");
    let start = std::time::Instant::now();
    assert!(
        Command::new("kill")
            .args(["-INT", &child.id().to_string()])
            .status()
            .unwrap()
            .success()
    );
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("取消"));
    assert!(start.elapsed() < std::time::Duration::from_secs(2));
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn cli_uses_local_sqlite_settings_without_creating_execution_sessions() {
    use supercode_core::{commander::llm::LlmConfig, db::Store};
    let root = std::env::temp_dir().join(format!("sc-p32-default-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("test.sqlite");
    let fixture = Fixture::new("ok");
    let store = Store::open(&path).await.unwrap();
    let config:LlmConfig=serde_json::from_value(json!({"endpoint":fixture.url,"model":"fixture-model","api_key_env":"SC_CLI_FIXTURE_KEY","timeout_secs":5})).unwrap();
    store.save_commander_config(&config).await.unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_supercode"))
        .args(["plan", "generate", "Design a todo app"])
        .env("SUPERCODE_DB", &path)
        .env("SC_CLI_FIXTURE_KEY", "local-fixture-key")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(store.list_sessions().await.unwrap().is_empty());
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}
