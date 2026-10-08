use serde_json::{Value, json};
use supercode_core::{commander::TaskPlan, registry::AgentRegistry};

fn plan() -> Value {
    json!({"version":1,"objective":"goal","tasks":[
        {"id":"b","title":"B","agent_id":"codex","prompt":"B","depends_on":["a"]},
        {"id":"a","title":"A","agent_id":"claude-code","prompt":"A"},
        {"id":"c","title":"C","agent_id":"mimo","prompt":"C","depends_on":["a"]}
    ]})
}
fn valid(value: Value) -> bool {
    serde_json::from_value::<TaskPlan>(value)
        .is_ok_and(|p| p.validate(&AgentRegistry::builtin()).is_ok())
}
#[test]
fn produces_stable_dependency_batches_and_preserves_plan() {
    let p: TaskPlan = serde_json::from_value(plan()).unwrap();
    let validated = p.validate(&AgentRegistry::builtin()).unwrap();
    assert_eq!(validated.batches, vec![vec!["a"], vec!["b", "c"]]);
    assert_eq!(
        serde_json::to_value(&validated.plan).unwrap()["tasks"][0]["id"],
        "b"
    );
}
#[test]
fn rejects_invalid_structure_agents_and_dependency_graphs() {
    for (field, value) in [
        ("version", json!(2)),
        ("objective", json!(" ")),
        ("tasks", json!([])),
    ] {
        let mut p = plan();
        p[field] = value;
        assert!(!valid(p), "{field}");
    }
    for (field, value) in [
        ("id", json!("a")),
        ("id", json!("bad id")),
        ("id", json!("a".repeat(65))),
        ("title", json!(" ")),
        ("prompt", json!("")),
        ("agent_id", json!("missing")),
        ("agent_id", json!("zcode")),
        ("depends_on", json!(["b"])),
        ("depends_on", json!(["missing"])),
        ("depends_on", json!(["a", "a"])),
    ] {
        let mut p = plan();
        p["tasks"][0][field] = value;
        assert!(!valid(p), "{field}");
    }
    let mut p = plan();
    p["tasks"][1]["depends_on"] = json!(["c"]);
    assert!(!valid(p));
    let mut p = plan();
    p["extra"] = json!(true);
    assert!(!valid(p));
    let mut p = plan();
    p["tasks"][0]["permission_mode"] = json!("full");
    assert!(!valid(p));
    let mut p = plan();
    p["tasks"] = json!(
        (0..65)
            .map(|i| json!({"id":format!("t{i}"),"title":"T","agent_id":"codex","prompt":"P"}))
            .collect::<Vec<_>>()
    );
    assert!(!valid(p));
}
#[test]
fn accepts_custom_acp_agent_and_rejects_disabled_driver() {
    let mut registry = AgentRegistry::builtin();
    let mut custom = registry.find("codex").unwrap().clone();
    custom.id = "custom".into();
    let path = std::env::temp_dir().join(format!("sc-p31-{}.json", uuid::Uuid::new_v4()));
    AgentRegistry::save_user_entries_at(&path, &[custom]).unwrap();
    registry.merge_user_file(&path);
    std::fs::remove_file(path).unwrap();
    let mut value = plan();
    value["tasks"][0]["agent_id"] = json!("custom");
    let p: TaskPlan = serde_json::from_value(value).unwrap();
    assert!(p.validate(&registry).is_ok());
}

#[test]
fn accepts_limit_and_keeps_independent_tasks_in_input_order() {
    let tasks: Vec<_> = (0..64)
        .map(|i| json!({"id":format!("t{i}"),"title":"T","agent_id":"codex","prompt":"P"}))
        .collect();
    let p: TaskPlan =
        serde_json::from_value(json!({"version":1,"objective":"goal","tasks":tasks})).unwrap();
    let v = p.validate(&AgentRegistry::builtin()).unwrap();
    assert_eq!(v.batches.len(), 1);
    assert_eq!(v.batches[0].len(), 64);
    assert_eq!(v.batches[0][63], "t63");
}

#[test]
fn history_dependency_layout_survives_removed_agent_without_authorizing_execution() {
    let plan: supercode_core::commander::TaskPlan = serde_json::from_value(serde_json::json!({"version":1,"objective":"historical","tasks":[{"id":"a","title":"a","agent_id":"removed-agent","prompt":"old","depends_on":[]},{"id":"b","title":"b","agent_id":"removed-agent","prompt":"old","depends_on":["a"]}]})).unwrap();
    assert_eq!(
        plan.dependency_batches().unwrap(),
        vec![vec!["a".to_string()], vec!["b".to_string()]]
    );
    assert!(
        plan.validate(&supercode_core::registry::AgentRegistry::builtin())
            .is_err()
    );
}
