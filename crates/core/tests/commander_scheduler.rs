use std::{path::PathBuf, sync::Arc};
use supercode_core::{
    approval::{ApprovalBroker, PermissionRules},
    commander::{
        TaskPlan,
        scheduler::{BrokerFactory, DispatchEvent, DispatchOptions, Scheduler},
    },
    db::{DEFAULT_WORKSPACE, PlanStatus, Store, TaskStatus},
    registry::AgentRegistry,
};
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;

fn brokers() -> BrokerFactory {
    Arc::new(|_| ApprovalBroker::with_rules(PermissionRules::new(vec!["edit".into()], vec![])))
}
async fn setup(prompts: &[(&str, &str, Vec<&str>)]) -> (Scheduler, Store, uuid::Uuid) {
    let dir = std::env::temp_dir().join(format!("sc-p34-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/scheduler-agent.mjs");
    let entries = serde_json::json!([{"id":"opencode","display_name":"fixture","driver_kind":"acp","command":format!("node '{}'",path.display()),"version_args":[path.to_str().unwrap(),"--version"]}]);
    let file = dir.join("agents.json");
    std::fs::write(&file, entries.to_string()).unwrap();
    let mut registry = AgentRegistry::builtin();
    registry.merge_user_file(&file);
    let store = Store::open(&dir.join("state.sqlite")).await.unwrap();
    let plan:TaskPlan=serde_json::from_value(serde_json::json!({"version":1,"objective":"test","tasks":prompts.iter().map(|(id,prompt,deps)|serde_json::json!({"id":id,"title":id,"agent_id":"opencode","prompt":prompt,"depends_on":deps})).collect::<Vec<_>>()})).unwrap();
    let id = store
        .create_commander_run(plan, dir.to_str().unwrap(), &registry)
        .await
        .unwrap();
    (Scheduler::new(store.clone(), registry), store, id)
}
#[tokio::test]
async fn dispatches_batches_and_persists_owned_sessions() {
    let (scheduler, store, id) = setup(&[
        ("a", "slow", vec![]),
        ("b", "fast", vec![]),
        ("c", "fast", vec!["a", "b"]),
    ])
    .await;
    let (events, mut rx) = broadcast::channel(256);
    let run = scheduler
        .execute(
            id,
            DispatchOptions {
                max_concurrency: 2,
                workspace_id: DEFAULT_WORKSPACE.into(),
                ..Default::default()
            },
            brokers(),
            events,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(run.status, PlanStatus::Succeeded);
    assert!(run.tasks.iter().all(|s| s.status == TaskStatus::Succeeded));
    let sessions = store.list_sessions().await.unwrap();
    assert_eq!(sessions.len(), 3);
    assert!(sessions.iter().all(|s| s.cwd == run.cwd
        && s.agent_id == "opencode"
        && s.workspace_id == DEFAULT_WORKSPACE));
    assert!(run.tasks.iter().all(|s| {
        sessions
            .iter()
            .any(|row| Some(row.id.clone()) == s.session_id.map(|id| id.to_string()))
    }));
    let mut stream = Vec::new();
    while let Ok(event) = rx.try_recv() {
        stream.push(event);
    }
    assert!(stream.iter().any(|e| e.task_id == "c"));
    let mut active = std::collections::HashSet::new();
    let mut peak = 0;
    let mut done = std::collections::HashSet::new();
    for e in &stream {
        use supercode_core::events::AgentEvent;
        match e.event {
            AgentEvent::SessionStarted { .. } => {
                if e.task_id == "c" {
                    assert!(done.contains("a") && done.contains("b"));
                }
                active.insert(e.task_id.clone());
                peak = peak.max(active.len());
            }
            AgentEvent::TurnCompleted { .. } => {
                active.remove(&e.task_id);
                done.insert(e.task_id.clone());
            }
            _ => {}
        }
    }
    assert_eq!(peak, 2);

    assert!(
        scheduler
            .execute(
                id,
                DispatchOptions::default(),
                brokers(),
                broadcast::channel(32).0,
                CancellationToken::new()
            )
            .await
            .is_err()
    );
}
#[tokio::test]
async fn failure_skips_descendants_but_independent_branch_finishes() {
    let (scheduler, _, id) = setup(&[
        ("a", "fail", vec![]),
        ("b", "fast", vec![]),
        ("c", "fast", vec!["a"]),
        ("d", "fast", vec!["c"]),
    ])
    .await;
    let run = scheduler
        .execute(
            id,
            DispatchOptions::default(),
            brokers(),
            broadcast::channel(128).0,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(run.status, PlanStatus::Failed);
    assert_eq!(run.tasks[1].status, TaskStatus::Succeeded);
    assert_eq!(run.tasks[2].status, TaskStatus::Skipped);
    assert_eq!(run.tasks[3].status, TaskStatus::Skipped);
}
#[tokio::test]
async fn cancellation_drains_driver_and_stops_pending_tasks() {
    let (scheduler, store, id) = setup(&[("a", "hang", vec![]), ("b", "fast", vec!["a"])]).await;
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    let (events, mut rx) = broadcast::channel::<DispatchEvent>(128);
    let watcher = tokio::spawn(async move {
        while let Ok(e) = rx.recv().await {
            if e.task_id == "a" {
                trigger.cancel();
                break;
            }
        }
    });
    let run = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        scheduler.execute(id, DispatchOptions::default(), brokers(), events, cancel),
    )
    .await
    .unwrap()
    .unwrap();
    watcher.await.unwrap();
    assert_eq!(run.status, PlanStatus::Cancelled);
    assert!(run.tasks.iter().all(|s| s.status == TaskStatus::Cancelled));
    assert_eq!(store.list_sessions().await.unwrap().len(), 1);
}
#[tokio::test]
async fn invalid_options_and_concurrent_claims_do_not_duplicate_dispatch() {
    let (scheduler, store, id) = setup(&[("a", "slow", vec![])]).await;
    assert!(
        scheduler
            .execute(
                id,
                DispatchOptions {
                    max_concurrency: 0,
                    ..Default::default()
                },
                brokers(),
                broadcast::channel(128).0,
                CancellationToken::new()
            )
            .await
            .is_err()
    );
    assert_eq!(
        store.get_commander_run(id).await.unwrap().unwrap().status,
        PlanStatus::Draft
    );
    let a = scheduler.execute(
        id,
        DispatchOptions::default(),
        brokers(),
        broadcast::channel(128).0,
        CancellationToken::new(),
    );
    let b = scheduler.execute(
        id,
        DispatchOptions::default(),
        brokers(),
        broadcast::channel(128).0,
        CancellationToken::new(),
    );
    let (a, b) = tokio::join!(a, b);
    assert_ne!(a.is_ok(), b.is_ok());
    assert_eq!(store.list_sessions().await.unwrap().len(), 1);
}

#[tokio::test]
async fn concurrency_limit_and_approval_ownership_are_preserved() {
    let (scheduler, store, id) =
        setup(&[("a", "permission", vec![]), ("b", "permission", vec![])]).await;
    let (tx, mut rx) = broadcast::channel(256);
    let run = scheduler
        .execute(
            id,
            DispatchOptions {
                max_concurrency: 1,
                ..Default::default()
            },
            brokers(),
            tx,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(run.status, PlanStatus::Succeeded);
    let mut active = 0;
    while let Ok(e) = rx.try_recv() {
        match e.event {
            supercode_core::events::AgentEvent::SessionStarted { .. } => {
                active += 1;
                assert_eq!(active, 1);
            }
            supercode_core::events::AgentEvent::TurnCompleted { .. } => active -= 1,
            _ => {}
        }
    }
    let pool = sqlx::SqlitePool::connect(&format!("sqlite://{}/state.sqlite", run.cwd))
        .await
        .unwrap();
    let approvals: Vec<(String, String)> =
        sqlx::query_as("SELECT session_id,decision FROM approvals")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(approvals.len(), 2);
    for (sid, decision) in approvals {
        assert_eq!(decision, "allow");
        assert!(
            run.tasks
                .iter()
                .any(|t| t.session_id.map(|id| id.to_string()) == Some(sid.clone()))
        );
    }
    assert_eq!(store.list_sessions().await.unwrap().len(), 2);
}
#[tokio::test]
async fn invalid_workspace_directory_and_stop_reason_are_rejected() {
    let (scheduler, store, id) = setup(&[("a", "max", vec![])]).await;
    assert!(
        scheduler
            .execute(
                id,
                DispatchOptions {
                    workspace_id: "missing".into(),
                    ..Default::default()
                },
                brokers(),
                broadcast::channel(128).0,
                CancellationToken::new()
            )
            .await
            .is_err()
    );
    assert_eq!(
        store.get_commander_run(id).await.unwrap().unwrap().status,
        PlanStatus::Draft
    );
    let run = scheduler
        .execute(
            id,
            DispatchOptions::default(),
            brokers(),
            broadcast::channel(128).0,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(run.status, PlanStatus::Failed);
    let missing = store
        .create_commander_run(
            run.plan.clone(),
            "/tmp/sc-p34-does-not-exist",
            &AgentRegistry::builtin(),
        )
        .await
        .unwrap();
    assert!(
        scheduler
            .execute(
                missing,
                DispatchOptions::default(),
                brokers(),
                broadcast::channel(128).0,
                CancellationToken::new()
            )
            .await
            .is_err()
    );
    assert_eq!(
        store
            .get_commander_run(missing)
            .await
            .unwrap()
            .unwrap()
            .status,
        PlanStatus::Draft
    );
}
#[tokio::test]
async fn cancellation_releases_explicit_ask_without_dispatching_descendants() {
    let (scheduler, store, id) =
        setup(&[("a", "permission", vec![]), ("b", "fast", vec!["a"])]).await;
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    let factory: BrokerFactory = Arc::new(move |_| {
        let mut rules = PermissionRules::default();
        rules.ask.push("edit".into());
        let broker = ApprovalBroker::with_rules(rules);
        let mut pending = broker.subscribe();
        let token = trigger.clone();
        tokio::spawn(async move {
            if pending.recv().await.is_ok() {
                token.cancel();
            }
        });
        broker
    });
    let run = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        scheduler.execute(
            id,
            DispatchOptions::default(),
            factory,
            broadcast::channel(128).0,
            cancel,
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(run.status, PlanStatus::Cancelled);
    assert_eq!(store.list_sessions().await.unwrap().len(), 1);
    let pool = sqlx::SqlitePool::connect(&format!("sqlite://{}/state.sqlite", run.cwd))
        .await
        .unwrap();
    let decision: String = sqlx::query_scalar("SELECT decision FROM approvals")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(decision, "reject");
}

#[tokio::test]
async fn unavailable_adapter_keeps_draft_without_sessions() {
    let (_, store, id) = setup(&[("a", "fast", vec![])]).await;
    let run = store.get_commander_run(id).await.unwrap().unwrap();
    let file = PathBuf::from(&run.cwd).join("unavailable.json");
    std::fs::write(&file,serde_json::json!([{"id":"opencode","display_name":"unavailable","driver_kind":"acp","command":"/bin/false","version_args":["--version"]}]).to_string()).unwrap();
    let mut registry = AgentRegistry::builtin();
    registry.merge_user_file(&file);
    let scheduler = Scheduler::new(store.clone(), registry);
    assert!(
        scheduler
            .execute(
                id,
                DispatchOptions::default(),
                brokers(),
                broadcast::channel(128).0,
                CancellationToken::new()
            )
            .await
            .is_err()
    );
    assert_eq!(
        store.get_commander_run(id).await.unwrap().unwrap().status,
        PlanStatus::Draft
    );
    assert!(store.list_sessions().await.unwrap().is_empty());
}
#[tokio::test]
async fn dropping_execution_cancels_owned_driver_then_explicit_recovery_interrupts_plan() {
    let (scheduler, store, id) = setup(&[("a", "hang", vec![]), ("b", "fast", vec!["a"])]).await;
    let (events, mut rx) = broadcast::channel::<DispatchEvent>(128);
    let mut execution = Box::pin(scheduler.execute(
        id,
        DispatchOptions::default(),
        brokers(),
        events,
        CancellationToken::new(),
    ));
    tokio::select! {result=&mut execution=>panic!("unexpected completion {result:?}"),event=rx.recv()=>{assert_eq!(event.unwrap().task_id,"a");}}
    drop(execution);
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            if store
                .list_sessions()
                .await
                .unwrap()
                .iter()
                .all(|s| s.status != "active")
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        store.get_commander_run(id).await.unwrap().unwrap().status,
        PlanStatus::Running
    );
    assert_eq!(store.recover_commander_runs().await.unwrap(), 1);
    let run = store.get_commander_run(id).await.unwrap().unwrap();
    assert_eq!(run.status, PlanStatus::Interrupted);
    assert_eq!(run.tasks[0].status, TaskStatus::Interrupted);
    assert_eq!(run.tasks[1].status, TaskStatus::Cancelled);
}
#[tokio::test]
async fn persistence_failure_never_reports_success() {
    let (scheduler, store, id) = setup(&[("a", "fast", vec![])]).await;
    let run = store.get_commander_run(id).await.unwrap().unwrap();
    let pool = sqlx::SqlitePool::connect(&format!("sqlite://{}/state.sqlite", run.cwd))
        .await
        .unwrap();
    sqlx::query("DROP TABLE messages")
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        scheduler
            .execute(
                id,
                DispatchOptions::default(),
                brokers(),
                broadcast::channel(128).0,
                CancellationToken::new()
            )
            .await
            .is_err()
    );
    assert_ne!(
        store.get_commander_run(id).await.unwrap().unwrap().status,
        PlanStatus::Succeeded
    );
}

#[tokio::test]
async fn interactive_approval_uses_normal_ask_pipeline_and_single_record() {
    let (scheduler, store, id) =
        setup(&[("a", "permission", vec![]), ("b", "permission", vec![])]).await;
    let factory: BrokerFactory = Arc::new(|_| {
        let broker = ApprovalBroker::with_rules(PermissionRules::default());
        let mut pending = broker.subscribe();
        let answering = broker.clone();
        tokio::spawn(async move {
            let request = pending.recv().await.unwrap();
            answering
                .respond(
                    request.id,
                    supercode_core::driver::PermissionDecision {
                        option_id: "allow".into(),
                        updated_input: None,
                    },
                )
                .await
                .unwrap();
        });
        broker
    });
    let run = scheduler
        .execute(
            id,
            DispatchOptions {
                interactive_approvals: true,
                ..Default::default()
            },
            factory,
            broadcast::channel(128).0,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(run.status, PlanStatus::Succeeded);
    let pool = sqlx::SqlitePool::connect(&format!("sqlite://{}/state.sqlite", run.cwd))
        .await
        .unwrap();
    let decisions: Vec<String> = sqlx::query_scalar("SELECT decision FROM approvals")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(decisions, vec!["allow", "allow"]);
    assert_eq!(store.list_sessions().await.unwrap().len(), 2);
    let owners: i64 = sqlx::query_scalar("SELECT count(DISTINCT session_id) FROM approvals")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(owners, 2);
}

#[tokio::test]
async fn interactive_fallback_ask_cancels_with_one_rejection_and_no_descendant_session() {
    let (scheduler, store, id) =
        setup(&[("a", "permission", vec![]), ("b", "fast", vec!["a"])]).await;
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    let factory: BrokerFactory = Arc::new(move |_| {
        let broker = ApprovalBroker::with_rules(PermissionRules::default());
        let mut pending = broker.subscribe();
        let token = trigger.clone();
        tokio::spawn(async move {
            pending.recv().await.unwrap();
            token.cancel();
        });
        broker
    });
    let run = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        scheduler.execute(
            id,
            DispatchOptions {
                interactive_approvals: true,
                ..Default::default()
            },
            factory,
            broadcast::channel(128).0,
            cancel,
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(run.status, PlanStatus::Cancelled);
    assert_eq!(store.list_sessions().await.unwrap().len(), 1);
    let pool = sqlx::SqlitePool::connect(&format!("sqlite://{}/state.sqlite", run.cwd))
        .await
        .unwrap();
    let decisions: Vec<String> = sqlx::query_scalar("SELECT decision FROM approvals")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(decisions, vec!["reject"]);
}
