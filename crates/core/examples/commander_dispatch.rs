//! P3-4 manual acceptance harness, not the P3-5 product CLI.
use std::{path::PathBuf, sync::Arc};
use supercode_core::{
    approval::{ApprovalBroker, PermissionRules},
    commander::{
        TaskPlan,
        scheduler::{DispatchOptions, Scheduler},
    },
    db::{DEFAULT_WORKSPACE, PlanStatus, Store},
    events::AgentEvent,
    registry::AgentRegistry,
};
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(
        std::env::args()
            .nth(1)
            .ok_or("pass an absolute disposable acceptance directory")?,
    );
    if !root.is_absolute() || root.exists() {
        return Err("use a new absolute acceptance directory".into());
    }
    std::fs::create_dir_all(&root)?;
    let primary = std::env::args().nth(2).unwrap_or_else(|| "mimo".into());
    if !matches!(primary.as_str(), "mimo" | "opencode") {
        return Err("primary must be mimo or opencode".into());
    }
    let store = Store::open(&root.join("state.sqlite")).await?;
    let registry = AgentRegistry::load();
    let plan: TaskPlan = serde_json::from_value(
        serde_json::json!({"version":1,"objective":"P3-4 real ACP dispatch acceptance","tasks":[
          {"id":"mimo","title":"MiMo independent reply","agent_id":primary,"prompt":"请只回复 P34-MIMO，不调用任何工具、不修改任何文件。","depends_on":[]},
          {"id":"codex","title":"Codex independent reply","agent_id":"codex","prompt":"请只回复 P34-CODEX，不调用任何工具、不修改任何文件。","depends_on":[]},
          {"id":"after","title":"Dependency barrier reply","agent_id":primary,"prompt":"请只回复 P34-AFTER，不调用任何工具、不修改任何文件。","depends_on":["mimo","codex"]}
        ]}),
    )?;
    let id = store
        .create_commander_run(plan, root.to_str().ok_or("invalid path")?, &registry)
        .await?;
    let scheduler = Scheduler::new(store.clone(), registry);
    let (tx, mut rx) = broadcast::channel(1024);
    let printer = tokio::spawn(async move {
        let mut completed = std::collections::HashSet::new();
        while let Ok(e) = rx.recv().await {
            let e: supercode_core::commander::scheduler::DispatchEvent = e;
            if matches!(e.event, AgentEvent::SessionStarted { .. }) && e.task_id == "after" {
                assert!(completed.contains("mimo") && completed.contains("codex"));
            }
            if matches!(
                e.event,
                AgentEvent::TurnCompleted {
                    stop_reason: supercode_core::events::StopReason::EndTurn
                }
            ) {
                completed.insert(e.task_id.clone());
            }
            if matches!(
                e.event,
                AgentEvent::SessionStarted { .. } | AgentEvent::TurnCompleted { .. }
            ) {
                println!(
                    "{} {} {} {:?}",
                    e.task_id, e.agent_id, e.session_id, e.event
                );
            }
        }
    });
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    let signal = tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            trigger.cancel();
        }
    });
    let deadline_cancel = cancel.clone();
    let deadline = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(180)).await;
        deadline_cancel.cancel();
    });
    let result = scheduler
        .execute(
            id,
            DispatchOptions::default(),
            Arc::new(|_| ApprovalBroker::with_rules(PermissionRules::default())),
            tx,
            cancel,
        )
        .await;
    signal.abort();
    deadline.abort();
    printer.await?;
    let run = result?;
    println!("plan status: {:?}", run.status);
    assert_eq!(run.status, PlanStatus::Succeeded);
    let sessions = store.list_sessions().await?;
    assert_eq!(sessions.len(), 3);
    for task in &run.tasks {
        let sid = task.session_id.ok_or("missing session reference")?;
        let session = store
            .get_session(sid)
            .await?
            .ok_or("missing persisted session")?;
        assert_eq!(session.cwd, run.cwd);
        assert_eq!(session.workspace_id, DEFAULT_WORKSPACE);
        let agent = &run
            .plan
            .tasks
            .iter()
            .find(|t| t.id == task.id)
            .unwrap()
            .agent_id;
        assert_eq!(&session.agent_id, agent);
        let marker = match task.id.as_str() {
            "mimo" => "P34-MIMO",
            "codex" => "P34-CODEX",
            _ => "P34-AFTER",
        };
        assert!(
            store
                .list_messages(&session.agent_session_id)
                .await?
                .iter()
                .any(|m| m.role == "agent" && m.text.contains(marker))
        );
        println!("{} persisted {:?}: {}", task.id, task.status, marker);
    }
    drop(scheduler);
    drop(store);
    let reopened = Store::open(&root.join("state.sqlite")).await?;
    assert_eq!(
        reopened.get_commander_run(id).await?.unwrap().status,
        PlanStatus::Succeeded
    );
    println!("PASS: real ACP, references, cwd/agent/workspace, messages, reopen");
    Ok(())
}
