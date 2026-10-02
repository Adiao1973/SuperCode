use serde_json::json;
use supercode_core::{
    commander::TaskPlan,
    db::{PlanStatus, Store, TaskStatus},
    registry::AgentRegistry,
};
fn plan() -> TaskPlan {
    serde_json::from_value(json!({"version":1,"objective":"fixture goal","tasks":[{"id":"a","title":"A","agent_id":"codex","prompt":"fixture"},{"id":"b","title":"B","agent_id":"codex","prompt":"fixture","depends_on":["a"]},{"id":"c","title":"C","agent_id":"codex","prompt":"fixture","depends_on":["b"]},{"id":"d","title":"D","agent_id":"codex","prompt":"fixture"}]})).unwrap()
}
#[tokio::test]
async fn save_reopen_and_explicit_recovery_never_restart_tasks() {
    let root = std::env::temp_dir().join(format!("sc-p33-{}", uuid::Uuid::new_v4()));
    let path = root.join("test.sqlite");
    let store = Store::open(&path).await.unwrap();
    assert!(
        store
            .create_commander_run(plan(), "relative", &AgentRegistry::builtin())
            .await
            .is_err()
    );
    let mut bad = plan();
    bad.tasks[0].depends_on = vec!["missing".into()];
    assert!(
        store
            .create_commander_run(bad, "/tmp", &AgentRegistry::builtin())
            .await
            .is_err()
    );
    assert!(store.list_commander_runs().await.unwrap().is_empty());
    let draft = store
        .create_commander_run(plan(), "/tmp", &AgentRegistry::builtin())
        .await
        .unwrap();
    let id = store
        .create_commander_run(plan(), "/tmp", &AgentRegistry::builtin())
        .await
        .unwrap();
    store.start_commander_run(id).await.unwrap();
    store.start_commander_task(id, "a", None).await.unwrap();
    drop(store);
    let store = Store::open(&path).await.unwrap();
    let run = store.get_commander_run(id).await.unwrap().unwrap();
    assert_eq!(run.status, PlanStatus::Running);
    assert_eq!(run.tasks[0].status, TaskStatus::Running);
    assert_eq!(run.cwd, "/tmp");
    assert_eq!(run.plan.tasks[1].depends_on, vec!["a"]);
    assert!(store.list_sessions().await.unwrap().is_empty());
    assert_eq!(store.recover_commander_runs().await.unwrap(), 1);
    let run = store.get_commander_run(id).await.unwrap().unwrap();
    assert_eq!(run.status, PlanStatus::Interrupted);
    assert_eq!(run.tasks[0].status, TaskStatus::Interrupted);
    assert_eq!(run.tasks[1].status, TaskStatus::Cancelled);
    assert_eq!(
        store
            .get_commander_run(draft)
            .await
            .unwrap()
            .unwrap()
            .status,
        PlanStatus::Draft
    );
    assert_eq!(store.recover_commander_runs().await.unwrap(), 0);
    assert!(store.start_commander_run(id).await.is_err());
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn dependency_gate_failure_skip_and_success() {
    let store = Store::open_in_memory().await.unwrap();
    let id = store
        .create_commander_run(plan(), "/tmp", &AgentRegistry::builtin())
        .await
        .unwrap();
    assert!(store.start_commander_task(id, "a", None).await.is_err());
    store.start_commander_run(id).await.unwrap();
    assert!(store.start_commander_task(id, "b", None).await.is_err());
    store.start_commander_task(id, "a", None).await.unwrap();
    store
        .finish_commander_task(id, "a", TaskStatus::Failed)
        .await
        .unwrap();
    let run = store.get_commander_run(id).await.unwrap().unwrap();
    assert_eq!(run.tasks[1].status, TaskStatus::Skipped);
    assert_eq!(run.tasks[2].status, TaskStatus::Skipped);
    assert_eq!(run.tasks[3].status, TaskStatus::Pending);
    assert_eq!(run.status, PlanStatus::Running);
    store.start_commander_task(id, "d", None).await.unwrap();
    store
        .finish_commander_task(id, "d", TaskStatus::Succeeded)
        .await
        .unwrap();
    assert_eq!(
        store.get_commander_run(id).await.unwrap().unwrap().status,
        PlanStatus::Failed
    );
    assert!(store.start_commander_task(id, "a", None).await.is_err());
    let id = store
        .create_commander_run(plan(), "/tmp", &AgentRegistry::builtin())
        .await
        .unwrap();
    store.start_commander_run(id).await.unwrap();
    for task in ["a", "b", "c", "d"] {
        store.start_commander_task(id, task, None).await.unwrap();
        store
            .finish_commander_task(id, task, TaskStatus::Succeeded)
            .await
            .unwrap();
    }
    assert_eq!(
        store.get_commander_run(id).await.unwrap().unwrap().status,
        PlanStatus::Succeeded
    );
}
#[tokio::test]
async fn concurrent_start_has_one_winner_and_cancel_keeps_completed_results() {
    let root = std::env::temp_dir().join(format!("sc-p33-race-{}", uuid::Uuid::new_v4()));
    let store = Store::open(&root.join("test.sqlite")).await.unwrap();
    let id = store
        .create_commander_run(plan(), "/tmp", &AgentRegistry::builtin())
        .await
        .unwrap();
    store.start_commander_run(id).await.unwrap();
    let (a, b) = tokio::join!(
        store.start_commander_task(id, "a", None),
        store.start_commander_task(id, "a", None)
    );
    assert_eq!([a, b].iter().filter(|r| matches!(r, Ok(true))).count(), 1);
    store
        .finish_commander_task(id, "a", TaskStatus::Succeeded)
        .await
        .unwrap();
    let session = uuid::Uuid::new_v4();
    store
        .start_commander_task(id, "b", Some(session))
        .await
        .unwrap();
    assert!(
        store
            .finish_commander_task(id, "b", TaskStatus::Pending)
            .await
            .is_err()
    );
    store.cancel_commander_run(id).await.unwrap();
    let run = store.get_commander_run(id).await.unwrap().unwrap();
    assert_eq!(run.status, PlanStatus::Cancelled);
    assert_eq!(run.tasks[0].status, TaskStatus::Succeeded);
    assert_eq!(run.tasks[1].status, TaskStatus::Cancelled);
    assert_eq!(run.tasks[1].session_id, Some(session));
    assert!(
        store
            .finish_commander_task(id, "b", TaskStatus::Succeeded)
            .await
            .is_err()
    );
    assert!(store.cancel_commander_run(id).await.is_err());
    let draft = store
        .create_commander_run(plan(), "/tmp", &AgentRegistry::builtin())
        .await
        .unwrap();
    store.cancel_commander_run(draft).await.unwrap();
    assert_eq!(
        store
            .get_commander_run(draft)
            .await
            .unwrap()
            .unwrap()
            .status,
        PlanStatus::Cancelled
    );
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn independent_concurrent_updates_reload_without_losing_state() {
    let root = std::env::temp_dir().join(format!("sc-p33-independent-{}", uuid::Uuid::new_v4()));
    let store = Store::open(&root.join("test.sqlite")).await.unwrap();
    let id = store
        .create_commander_run(plan(), "/tmp", &AgentRegistry::builtin())
        .await
        .unwrap();
    store.start_commander_run(id).await.unwrap();
    let (a, d) = tokio::join!(
        store.start_commander_task(id, "a", None),
        store.start_commander_task(id, "d", None)
    );
    for (task, result) in [("a", a), ("d", d)] {
        if !result.unwrap() {
            assert!(store.start_commander_task(id, task, None).await.unwrap());
        }
    }
    let run = store.get_commander_run(id).await.unwrap().unwrap();
    assert_eq!(run.revision, 3);
    assert_eq!(run.tasks[0].status, TaskStatus::Running);
    assert_eq!(run.tasks[3].status, TaskStatus::Running);
    let session = uuid::Uuid::new_v4();
    assert!(
        store
            .bind_commander_task_session(id, "a", session)
            .await
            .unwrap()
    );
    assert!(
        store
            .bind_commander_task_session(id, "a", uuid::Uuid::new_v4())
            .await
            .is_err()
    );
    assert!(
        store
            .bind_commander_task_session(id, "b", session)
            .await
            .is_err()
    );
    store.cancel_commander_run(id).await.unwrap();
    assert_eq!(
        store.get_commander_run(id).await.unwrap().unwrap().tasks[0].session_id,
        Some(session)
    );
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn oversized_plans_are_not_persisted_and_failure_propagates_in_reverse_order() {
    let store = Store::open_in_memory().await.unwrap();
    let mut oversized = plan();
    oversized.tasks[0].prompt = "x".repeat(1024 * 1024);
    assert!(
        store
            .create_commander_run(oversized, "/tmp", &AgentRegistry::builtin())
            .await
            .is_err()
    );
    assert!(store.list_commander_runs().await.unwrap().is_empty());
    assert!(
        store
            .start_commander_run(uuid::Uuid::new_v4())
            .await
            .is_err()
    );
    let mut reversed = plan();
    reversed.tasks.reverse();
    let id = store
        .create_commander_run(reversed, "/tmp", &AgentRegistry::builtin())
        .await
        .unwrap();
    store.start_commander_run(id).await.unwrap();
    store.start_commander_task(id, "a", None).await.unwrap();
    store
        .finish_commander_task(id, "a", TaskStatus::Failed)
        .await
        .unwrap();
    let run = store.get_commander_run(id).await.unwrap().unwrap();
    for task in run
        .tasks
        .iter()
        .filter(|task| matches!(task.id.as_str(), "b" | "c"))
    {
        assert_eq!(task.status, TaskStatus::Skipped);
    }
    assert!(store.list_sessions().await.unwrap().is_empty());
}
