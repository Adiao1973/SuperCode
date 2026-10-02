use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, ChildStdout, Command, Stdio},
};
struct Fixture {
    child: Child,
    root: PathBuf,
    url: String,
    _reader: BufReader<ChildStdout>,
}
impl Fixture {
    fn new(mode: &str) -> Self {
        let root = std::env::temp_dir().join(format!("sc-p35-cli-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join(".supercode")).unwrap();
        let path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../core/tests/fixtures/llm-server.mjs");
        let mut child = Command::new("node")
            .arg(path)
            .arg(mode)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut url = String::new();
        let mut reader = BufReader::new(child.stdout.take().unwrap());
        reader.read_line(&mut url).unwrap();
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../core/tests/fixtures/scheduler-agent.mjs");
        let entries:Vec<_>=["opencode","codex"].iter().map(|id|json!({"id":id,"display_name":id,"driver_kind":"acp","command":format!("node '{}'",fixture.display()),"version_args":[fixture.to_str().unwrap(),"--version"]})).collect();
        std::fs::write(
            root.join(".supercode/agents.json"),
            json!(entries).to_string(),
        )
        .unwrap();
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let store = supercode_core::db::Store::open(&root.join("state.sqlite"))
                .await
                .unwrap();
            store
                .save_commander_config(&supercode_core::commander::llm::LlmConfig {
                    endpoint: url.trim().into(),
                    model: "fixture-model".into(),
                    api_key_env: "SC_CLI_FIXTURE_KEY".into(),
                    timeout_secs: 5,
                })
                .await
                .unwrap();
        });
        Self {
            child,
            root,
            url: url.trim().into(),
            _reader: reader,
        }
    }
    fn command(&self) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_supercode"));
        c.env("HOME", &self.root)
            .env("SUPERCODE_DB", self.root.join("state.sqlite"))
            .env("SC_CLI_FIXTURE_KEY", "local-fixture-key");
        c
    }
    fn preview(&self) -> Value {
        let o = self
            .command()
            .args(["plan", "run", "Generic fixture objective", "--cwd"])
            .arg(&self.root)
            .args(["--agents", "opencode,codex"])
            .output()
            .unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        serde_json::from_slice(&o.stdout).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
#[test]
fn preview_confirm_execute_and_report_form_a_closed_loop() {
    let f = Fixture::new("cli-plan");
    assert!(f.url.starts_with("http://127.0.0.1"));
    let p = f.preview();
    let id = p["summary"]["run_id"].as_str().unwrap();
    assert_eq!(p["summary"]["status"], "draft");
    let o = f.command().args(["plan", "execute", id]).output().unwrap();
    assert_eq!(o.status.code(), Some(2));
    let o = f
        .command()
        .args(["plan", "execute", id, "--yes"])
        .output()
        .unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    let report: Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(report["status"], "succeeded");
    assert_eq!(report["counts"]["succeeded"], 3);
    assert!(
        report["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .all(|t| t["session_id"].is_string() && t["result"].is_string())
    );
    let o = f.command().args(["plan", "report", id]).output().unwrap();
    assert!(o.status.success());
    assert_eq!(serde_json::from_slice::<Value>(&o.stdout).unwrap(), report);
    assert!(
        !f.command()
            .args(["plan", "execute", id, "--yes"])
            .output()
            .unwrap()
            .status
            .success()
    );
}
#[test]
fn failures_and_skips_are_explicit_and_not_exit_success() {
    let f = Fixture::new("cli-fail");
    let p = f.preview();
    let id = p["summary"]["run_id"].as_str().unwrap();
    let o = f
        .command()
        .args(["plan", "execute", id, "--yes"])
        .output()
        .unwrap();
    assert!(!o.status.success());
    let report: Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(report["counts"]["failed"], 1);
    assert_eq!(report["counts"]["skipped"], 1);
    assert_eq!(report["counts"]["succeeded"], 1);
    assert!(!String::from_utf8_lossy(&o.stdout).contains("local-fixture-key"));
}
#[test]
fn invalid_identity_agent_limit_and_jobs_do_not_dispatch() {
    let f = Fixture::new("cli-plan");
    assert!(
        !f.command()
            .args(["plan", "report", "bad-id"])
            .output()
            .unwrap()
            .status
            .success()
    );
    let o = f
        .command()
        .args(["plan", "run", "goal", "--cwd"])
        .arg(&f.root)
        .args(["--agents", "zcode"])
        .output()
        .unwrap();
    assert!(!o.status.success());
    let p = f.preview();
    let id = p["summary"]["run_id"].as_str().unwrap();
    assert!(
        !f.command()
            .args(["plan", "execute", id, "--yes", "--jobs", "0"])
            .output()
            .unwrap()
            .status
            .success()
    );
    let o = f.command().args(["plan", "report", id]).output().unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&o.stdout).unwrap()["status"],
        "draft"
    );
}
#[cfg(unix)]
#[test]
fn ctrl_c_cancels_execution_and_preserves_report() {
    let f = Fixture::new("cli-hang");
    let p = f.preview();
    let id = p["summary"]["run_id"].as_str().unwrap();
    let mut c = f
        .command()
        .args(["plan", "execute", id, "--yes"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut reader = BufReader::new(c.stderr.take().unwrap());
    let mut line = String::new();
    loop {
        line.clear();
        assert!(reader.read_line(&mut line).unwrap() > 0);
        if line.contains("session_started") {
            break;
        }
    }
    assert!(
        Command::new("kill")
            .args(["-INT", &c.id().to_string()])
            .status()
            .unwrap()
            .success()
    );
    let o = c.wait_with_output().unwrap();
    assert_eq!(o.status.code(), Some(130));
    assert_eq!(
        serde_json::from_slice::<Value>(&o.stdout).unwrap()["status"],
        "cancelled"
    );
}

#[test]
fn missing_config_unknown_plan_and_disallowed_model_agent_fail_closed() {
    let f = Fixture::new("cli-plan");
    let output = f
        .command()
        .env("SUPERCODE_DB", f.root.join("unconfigured.sqlite"))
        .args(["plan", "run", "goal", "--cwd"])
        .arg(&f.root)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stderr).contains("local-fixture-key"));
    assert!(
        !f.command()
            .args(["plan", "report", &uuid::Uuid::new_v4().to_string()])
            .output()
            .unwrap()
            .status
            .success()
    );
    let output = f
        .command()
        .args(["plan", "run", "goal", "--cwd"])
        .arg(&f.root)
        .args(["--agents", "codex"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
}
