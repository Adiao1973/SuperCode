use serde_json::{Value, json};
use std::{path::Path, process::Command};

fn run(home: &Path, file: &Path) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_supercode"))
        .args(["plan", "validate"])
        .arg(file)
        .env("HOME", home)
        .env("SUPERCODE_DB", home.join("must-not-exist.sqlite"))
        .output()
        .unwrap()
}
#[test]
fn cli_checks_plans_without_creating_database_or_executing_agents() {
    let home = std::env::temp_dir().join(format!("sc-p31-cli-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&home).unwrap();
    let file = home.join("plan.json");
    let mut plan: Value =
        serde_json::from_str(include_str!("../../../docs/examples/commander-plan.json")).unwrap();
    std::fs::write(&file, serde_json::to_vec(&plan).unwrap()).unwrap();
    let output = run(&home, &file);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let validated: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        validated["batches"],
        json!([["research"], ["implement", "review"]])
    );
    let mut invalid = plan.clone();
    invalid["tasks"][0]["agent_id"] = json!("unknown");
    std::fs::write(&file, serde_json::to_vec(&invalid).unwrap()).unwrap();
    assert!(!run(&home, &file).status.success());
    let mut invalid = plan.clone();
    invalid["full_access"] = json!(true);
    std::fs::write(&file, serde_json::to_vec(&invalid).unwrap()).unwrap();
    assert!(!run(&home, &file).status.success());
    plan["tasks"][0]["depends_on"] = json!(["implement"]);
    std::fs::write(&file, serde_json::to_vec(&plan).unwrap()).unwrap();
    let output = run(&home, &file);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("循环依赖"));
    std::fs::write(&file, vec![b' '; 1024 * 1024 + 1]).unwrap();
    let output = run(&home, &file);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("1 MiB"));
    std::fs::write(&file, "{bad json}").unwrap();
    assert!(!run(&home, &file).status.success());
    assert!(!home.join("must-not-exist.sqlite").exists());
    std::fs::remove_dir_all(home).unwrap();
}
