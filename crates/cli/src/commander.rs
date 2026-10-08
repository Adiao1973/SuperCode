use std::{path::PathBuf, process::ExitCode, sync::Arc};
use supercode_core::{
    approval::{ApprovalBroker, PermissionRules},
    commander::scheduler::{DispatchOptions, Scheduler},
    db::{PlanStatus, Store},
    error::{CoreError, Result},
    registry::AgentRegistry,
};
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
fn emit(value: impl serde::Serialize) -> Result<()> {
    let text = serde_json::to_string_pretty(&value)
        .map_err(|_| CoreError::Protocol("无法序列化指挥官结果".into()))?;
    println!("{text}");
    Ok(())
}
fn finish(result: Result<()>) -> ExitCode {
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}
fn signal(cancel: CancellationToken) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            cancel.cancel();
        }
    })
}
pub async fn preview(objective: String, cwd: PathBuf, agents: Vec<String>) -> ExitCode {
    let cancel = CancellationToken::new();
    let watcher = signal(cancel.clone());
    let result = async {
        if !cwd.is_absolute() || !cwd.is_dir() {
            return Err(CoreError::Protocol("计划目录须为存在的绝对目录".into()));
        }
        let mut registry = AgentRegistry::load();
        if !agents.is_empty() {
            registry = registry.restricted(&agents)?;
        }
        let store = Store::open_default().await?;
        let config = store
            .get_commander_config()
            .await?
            .ok_or_else(|| CoreError::Protocol("尚未保存指挥官模型配置".into()))?;
        let client = store.commander_client(config).await?;
        let plan = client
            .generate_plan(&objective, &registry, cancel.clone())
            .await?;
        if cancel.is_cancelled() {
            return Err(CoreError::Protocol("计划生成已取消".into()));
        }
        let id = store
            .create_commander_run(
                plan.plan.clone(),
                cwd.to_str()
                    .ok_or_else(|| CoreError::Protocol("目录编码无效".into()))?,
                &registry,
            )
            .await?;
        let summary = store.summarize_commander_run(id).await?;
        emit(serde_json::json!({"plan":plan.plan,"batches":plan.batches,"summary":summary}))
    }
    .await;
    watcher.abort();
    if cancel.is_cancelled() {
        if let Err(e) = result {
            eprintln!("{e}");
        }
        ExitCode::from(130)
    } else {
        finish(result)
    }
}
pub async fn report(id: Uuid) -> ExitCode {
    finish(
        async {
            let store = Store::open_default().await?;
            emit(store.summarize_commander_run(id).await?)
        }
        .await,
    )
}
pub async fn execute(
    id: Uuid,
    yes: bool,
    jobs: usize,
    allows: Vec<String>,
    denies: Vec<String>,
) -> ExitCode {
    if !yes {
        eprintln!("请先审阅已保存计划，再使用 --yes 明确确认执行");
        return ExitCode::from(2);
    }
    let cancel = CancellationToken::new();
    let watcher = signal(cancel.clone());
    let outcome: Result<PlanStatus> = async {
        let store = Store::open_default().await?;
        let scheduler = Scheduler::new(store.clone(), AgentRegistry::load());
        let (events, mut rx) = broadcast::channel(256);
        let printer = tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(e) => {
                        let e: supercode_core::commander::scheduler::DispatchEvent = e;
                        let label = match e.event {
                            supercode_core::events::AgentEvent::SessionStarted { .. } => {
                                "session_started"
                            }
                            supercode_core::events::AgentEvent::TurnCompleted { .. } => {
                                "turn_completed"
                            }
                            supercode_core::events::AgentEvent::DriverError { .. } => {
                                "driver_error"
                            }
                            _ => continue,
                        };
                        eprintln!("{} {} {} {label}", e.task_id, e.agent_id, e.session_id);
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        eprintln!("事件显示滞后，以 SQLite 报告为准")
                    }
                    Err(_) => break,
                }
            }
        });
        let execution = scheduler
            .execute(
                id,
                DispatchOptions {
                    max_concurrency: jobs,
                    ..Default::default()
                },
                Arc::new(move |_| {
                    ApprovalBroker::with_rules(PermissionRules::new(allows.clone(), denies.clone()))
                }),
                events,
                cancel.clone(),
            )
            .await;
        let _ = printer.await;
        let summary = store.summarize_commander_run(id).await?;
        let status = summary.status;
        emit(summary)?;
        execution?;
        Ok(status)
    }
    .await;
    watcher.abort();
    match outcome {
        Ok(PlanStatus::Succeeded) => ExitCode::SUCCESS,
        Ok(PlanStatus::Cancelled) => ExitCode::from(130),
        Ok(_) => ExitCode::FAILURE,
        Err(e) => {
            eprintln!("{e}");
            if cancel.is_cancelled() {
                ExitCode::from(130)
            } else {
                ExitCode::FAILURE
            }
        }
    }
}
