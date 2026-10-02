use supercode_core::{
    commander::TaskPlan,
    db::{PlanStatus, Store, TaskStatus},
    registry::AgentRegistry,
};
#[tokio::test]
async fn summary_tracks_mixed_results_in_order_without_running_tasks() {
    let store = Store::open_in_memory().await.unwrap();
    let plan: TaskPlan = serde_json::from_value(
        serde_json::json!({"version":1,"objective":"summary","tasks":[
 {"id":"a","title":"A","agent_id":"opencode","prompt":"a"},
 {"id":"b","title":"B","agent_id":"codex","prompt":"b","depends_on":["a"]},
 {"id":"c","title":"C","agent_id":"opencode","prompt":"c"}]}),
    )
    .unwrap();
    let id = store
        .create_commander_run(plan, "/tmp", &AgentRegistry::builtin())
        .await
        .unwrap();
    let draft = store.summarize_commander_run(id).await.unwrap();
    assert_eq!(draft.counts.pending, 3);
    assert_eq!(draft.status, PlanStatus::Draft);
    store.start_commander_run(id).await.unwrap();
    store.start_commander_task(id, "a", None).await.unwrap();
    store
        .finish_commander_task(id, "a", TaskStatus::Failed)
        .await
        .unwrap();
    store.start_commander_task(id, "c", None).await.unwrap();
    store
        .finish_commander_task(id, "c", TaskStatus::Succeeded)
        .await
        .unwrap();
    let summary = store.summarize_commander_run(id).await.unwrap();
    assert_eq!(summary.status, PlanStatus::Failed);
    assert_eq!(summary.counts.failed, 1);
    assert_eq!(summary.counts.skipped, 1);
    assert_eq!(summary.counts.succeeded, 1);
    assert_eq!(
        summary
            .tasks
            .iter()
            .map(|t| t.id.as_str())
            .collect::<Vec<_>>(),
        vec!["a", "b", "c"]
    );
    assert!(store.list_sessions().await.unwrap().is_empty());
}
#[tokio::test]
async fn summary_binds_owned_session_and_truncates_unicode_result() {
    let store = Store::open_in_memory().await.unwrap();
    let reg = AgentRegistry::builtin();
    let plan:TaskPlan=serde_json::from_value(serde_json::json!({"version":1,"objective":"result","tasks":[{"id":"a","title":"A","agent_id":"opencode","prompt":"a"}]})).unwrap();
    let id = store
        .create_commander_run(plan, "/tmp", &reg)
        .await
        .unwrap();
    let sid = uuid::Uuid::new_v4();
    store
        .upsert_agent("opencode", "OpenCode", "acp", None)
        .await
        .unwrap();
    store
        .insert_session(
            sid,
            "opencode",
            "remote-id",
            "/tmp",
            "A",
            supercode_core::db::DEFAULT_WORKSPACE,
        )
        .await
        .unwrap();
    store
        .insert_agent_message(sid, &"好".repeat(4000))
        .await
        .unwrap();
    store.start_commander_run(id).await.unwrap();
    store
        .start_commander_task(id, "a", Some(sid))
        .await
        .unwrap();
    store
        .finish_commander_task(id, "a", TaskStatus::Succeeded)
        .await
        .unwrap();
    let report = store.summarize_commander_run(id).await.unwrap();
    assert!(report.tasks[0].truncated);
    assert!(report.tasks[0].result.as_ref().unwrap().len() <= 8192);
    assert_eq!(
        report.tasks[0].agent_session_id.as_deref(),
        Some("remote-id")
    );
}

#[tokio::test]
async fn summary_never_reads_another_agents_colliding_remote_session() {
    let store = Store::open_in_memory().await.unwrap();
    let plan:TaskPlan=serde_json::from_value(serde_json::json!({"version":1,"objective":"collision","tasks":[{"id":"a","title":"A","agent_id":"opencode","prompt":"a"}]})).unwrap();
    let id = store
        .create_commander_run(plan, "/tmp", &AgentRegistry::builtin())
        .await
        .unwrap();
    let own = uuid::Uuid::new_v4();
    let other = uuid::Uuid::new_v4();
    for (sid, agent, text) in [(own, "opencode", "OWN"), (other, "codex", "OTHER")] {
        store.upsert_agent(agent, agent, "acp", None).await.unwrap();
        store
            .insert_session(
                sid,
                agent,
                "same-remote-id",
                "/tmp",
                "title",
                supercode_core::db::DEFAULT_WORKSPACE,
            )
            .await
            .unwrap();
        store.insert_agent_message(sid, text).await.unwrap();
    }
    store.start_commander_run(id).await.unwrap();
    store
        .start_commander_task(id, "a", Some(own))
        .await
        .unwrap();
    store
        .finish_commander_task(id, "a", TaskStatus::Succeeded)
        .await
        .unwrap();
    assert_eq!(
        store.summarize_commander_run(id).await.unwrap().tasks[0]
            .result
            .as_deref(),
        Some("OWN")
    );
}

#[tokio::test]
async fn cancelled_and_interrupted_reports_keep_completed_results() {
    for interrupted in [false, true] {
        let store = Store::open_in_memory().await.unwrap();
        let plan:TaskPlan=serde_json::from_value(serde_json::json!({"version":1,"objective":"terminal states","tasks":[
            {"id":"done","title":"Done","agent_id":"opencode","prompt":"reply"},
            {"id":"active","title":"Active","agent_id":"opencode","prompt":"reply"},
            {"id":"pending","title":"Pending","agent_id":"opencode","prompt":"reply","depends_on":["active"]}]})).unwrap();
        let id = store
            .create_commander_run(plan, "/tmp", &AgentRegistry::builtin())
            .await
            .unwrap();
        store.start_commander_run(id).await.unwrap();
        store.start_commander_task(id, "done", None).await.unwrap();
        store
            .finish_commander_task(id, "done", TaskStatus::Succeeded)
            .await
            .unwrap();
        store
            .start_commander_task(id, "active", None)
            .await
            .unwrap();
        let active = store.summarize_commander_run(id).await.unwrap();
        assert_eq!(active.counts.running, 1);
        assert_eq!(active.counts.pending, 1);
        if interrupted {
            store.recover_commander_runs().await.unwrap();
        } else {
            store.cancel_commander_run(id).await.unwrap();
        }
        let report = store.summarize_commander_run(id).await.unwrap();
        assert_eq!(report.counts.succeeded, 1);
        assert_eq!(report.counts.interrupted, usize::from(interrupted));
        assert_eq!(report.counts.cancelled, if interrupted { 1 } else { 2 });
    }
}

#[tokio::test]
async fn wrong_session_owner_is_rejected_instead_of_relabelled() {
    let store = Store::open_in_memory().await.unwrap();
    let plan:TaskPlan=serde_json::from_value(serde_json::json!({"version":1,"objective":"ownership","tasks":[{"id":"a","title":"A","agent_id":"opencode","prompt":"a"}]})).unwrap();
    let id = store
        .create_commander_run(plan, "/tmp", &AgentRegistry::builtin())
        .await
        .unwrap();
    let sid = uuid::Uuid::new_v4();
    store
        .upsert_agent("codex", "Codex", "acp", None)
        .await
        .unwrap();
    store
        .insert_session(
            sid,
            "codex",
            "remote",
            "/tmp",
            "title",
            supercode_core::db::DEFAULT_WORKSPACE,
        )
        .await
        .unwrap();
    store.start_commander_run(id).await.unwrap();
    store
        .start_commander_task(id, "a", Some(sid))
        .await
        .unwrap();
    assert!(store.summarize_commander_run(id).await.is_err());
}
