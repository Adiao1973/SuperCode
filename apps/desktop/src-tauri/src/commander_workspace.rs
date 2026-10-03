use super::AppState;
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use supercode_core::{
    approval::{ApprovalBroker, PermissionRules, RuleEffect},
    commander::scheduler::{BrokerFactory, DispatchOptions, Scheduler},
    db::{CommanderRun, RunSummary, Store},
    registry::AgentRegistry,
};
use tauri::{Emitter, Manager};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Default)]
pub struct CommanderWork(Mutex<HashMap<Uuid, CancellationToken>>);
impl CommanderWork {
    fn begin(&self, id: Uuid) -> Result<WorkGuard<'_>, String> {
        let mut work = self.0.lock().map_err(|_| "指挥官状态不可用")?;
        if !work.is_empty() {
            return Err("已有规划或执行正在进行".into());
        }
        let token = CancellationToken::new();
        work.insert(id, token.clone());
        Ok(WorkGuard {
            work: self,
            id,
            token,
        })
    }
    pub fn active(&self, id: Uuid) -> bool {
        self.0.lock().is_ok_and(|w| w.contains_key(&id))
    }
    pub fn busy(&self) -> bool {
        self.0.lock().is_ok_and(|w| !w.is_empty())
    }
    pub fn cancel_all(&self) {
        if let Ok(w) = self.0.lock() {
            for t in w.values() {
                t.cancel();
            }
        }
    }
    fn cancel(&self, id: Uuid) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|_| "指挥官状态不可用")?
            .get(&id)
            .ok_or("该请求不由当前应用运行")?
            .cancel();
        Ok(())
    }
}
struct WorkGuard<'a> {
    work: &'a CommanderWork,
    id: Uuid,
    token: CancellationToken,
}
impl Drop for WorkGuard<'_> {
    fn drop(&mut self) {
        self.token.cancel();
        if let Ok(mut w) = self.work.0.lock() {
            w.remove(&self.id);
        }
    }
}
fn confirmed(value: bool) -> Result<(), String> {
    if value {
        Ok(())
    } else {
        Err("请先审阅计划并确认执行".into())
    }
}
#[derive(Serialize)]
pub struct RunView {
    run: CommanderRun,
    summary: RunSummary,
    batches: Vec<Vec<String>>,
    active: bool,
}
async fn view(store: &Store, work: &CommanderWork, id: Uuid) -> Result<RunView, String> {
    let run = store
        .get_commander_run(id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("计划不存在")?;
    let batches = run.plan.dependency_batches().map_err(|e| e.to_string())?;
    let summary = store
        .summarize_commander_run(id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(RunView {
        run,
        summary,
        batches,
        active: work.active(id),
    })
}
#[tauri::command]
pub async fn list_commander_run_views(
    state: tauri::State<'_, AppState>,
    work: tauri::State<'_, CommanderWork>,
) -> Result<Vec<RunView>, String> {
    let store = state.store().await;
    let mut runs = store
        .list_commander_runs()
        .await
        .map_err(|e| e.to_string())?;
    runs.reverse();
    let mut result = Vec::new();
    for run in runs.into_iter().take(50) {
        result.push(view(store, &work, run.id).await?);
    }
    Ok(result)
}
#[tauri::command]
pub async fn get_commander_run_view(
    state: tauri::State<'_, AppState>,
    work: tauri::State<'_, CommanderWork>,
    run_id: Uuid,
) -> Result<RunView, String> {
    view(state.store().await, &work, run_id).await
}
#[tauri::command]
pub async fn generate_commander_run(
    state: tauri::State<'_, AppState>,
    work: tauri::State<'_, CommanderWork>,
    request_id: Uuid,
    objective: String,
    cwd: String,
    agents: Vec<String>,
) -> Result<RunView, String> {
    if !std::path::Path::new(&cwd).is_absolute() || !std::path::Path::new(&cwd).is_dir() {
        return Err("请选择已存在的绝对工作目录".into());
    }
    let guard = work.begin(request_id)?;
    let store = state.store().await;
    let registry = AgentRegistry::load()
        .restricted(&agents)
        .map_err(|e| e.to_string())?;
    let config = store
        .get_commander_config()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("请先配置指挥官模型")?;
    let plan = store
        .commander_client(config)
        .await
        .map_err(|e| e.to_string())?
        .generate_plan(&objective, &registry, guard.token.clone())
        .await
        .map_err(|e| e.to_string())?;
    if guard.token.is_cancelled() {
        return Err("规划已取消".into());
    }
    let run = store
        .create_commander_run(plan.plan, &cwd, &registry)
        .await
        .map_err(|e| e.to_string())?;
    view(store, &work, run).await
}
#[tauri::command]
pub fn cancel_commander_work(
    work: tauri::State<'_, CommanderWork>,
    request_id: Uuid,
) -> Result<(), String> {
    work.cancel(request_id)
}
#[tauri::command]
pub async fn execute_commander_run(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    work: tauri::State<'_, CommanderWork>,
    run_id: Uuid,
    confirmed: bool,
    jobs: usize,
    on_progress: tauri::ipc::Channel<String>,
) -> Result<RunView, String> {
    self::confirmed(confirmed)?;
    let guard = work.begin(run_id)?;
    let store = state.store().await;
    let mut rules = PermissionRules::default();
    for entry in store
        .list_permission_rules()
        .await
        .map_err(|e| e.to_string())?
    {
        match entry.effect {
            RuleEffect::Allow => rules.allow.push(entry.pattern),
            RuleEffect::Deny => rules.deny.push(entry.pattern),
            RuleEffect::Ask => rules.ask.push(entry.pattern),
        }
    }
    let finished = CancellationToken::new();
    let relays = Arc::new(Mutex::new(Vec::new()));
    let factory: BrokerFactory = {
        let finished = finished.clone();
        let relays = relays.clone();
        Arc::new(move |ctx| {
            let broker = ApprovalBroker::with_rules(rules.clone());
            let mut pending = broker.subscribe();
            let mut decisions = broker.subscribe_decisions();
            let app = app.clone();
            let relay_broker = broker.clone();
            let finished = finished.clone();
            let run_id = ctx.run_id;
            let task_id = ctx.task_id.clone();
            let handle = tokio::spawn(async move {
                let mut owned = Vec::new();
                loop {
                    tokio::select! { biased;
                        Ok(record)=decisions.recv()=>{ let _=app.emit("decision-record",record); },
                        Ok(p)=pending.recv()=>{ app.state::<AppState>().pending.lock().await.insert(p.id,relay_broker.clone());owned.push(p.id); let _=app.emit("permission-request",serde_json::json!({"id":p.id,"request":p.request,"commander_run_id":run_id,"commander_task_id":task_id})); },
                        _=finished.cancelled()=>break,
                    }
                }
                let state = app.state::<AppState>();
                let mut routes = state.pending.lock().await;
                for id in owned {
                    routes.remove(&id);
                }
            });
            relays.lock().unwrap().push(handle);
            broker
        })
    };
    let (events, mut rx) = tokio::sync::broadcast::channel(256);
    let progress = tokio::spawn(async move {
        while let Ok(event) = rx.recv().await {
            let event: supercode_core::commander::scheduler::DispatchEvent = event;
            let _ = on_progress.send(event.task_id);
        }
    });
    let result = Scheduler::new(store.clone(), AgentRegistry::load())
        .execute(
            run_id,
            DispatchOptions {
                max_concurrency: jobs,
                interactive_approvals: true,
                ..Default::default()
            },
            factory,
            events,
            guard.token.clone(),
        )
        .await;
    finished.cancel();
    let handles = std::mem::take(&mut *relays.lock().unwrap());
    for handle in handles {
        let _ = handle.await;
    }
    let _ = progress.await;
    result.map_err(|e| e.to_string())?;
    drop(guard);
    view(store, &work, run_id).await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_confirmation_is_required() {
        assert!(confirmed(false).is_err());
        assert!(confirmed(true).is_ok());
    }
    #[test]
    fn work_is_exclusive_and_cancel_is_scoped() {
        let work = CommanderWork::default();
        let id = Uuid::new_v4();
        let guard = work.begin(id).unwrap();
        assert!(work.begin(Uuid::new_v4()).is_err());
        assert!(work.cancel(Uuid::new_v4()).is_err());
        work.cancel(id).unwrap();
        assert!(guard.token.is_cancelled());
        assert!(work.busy());
        drop(guard);
        assert!(!work.busy());
        assert!(work.begin(id).is_ok());
    }
}
