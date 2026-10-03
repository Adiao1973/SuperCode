//! Explicit ACP dispatch. No model call, automatic resume, or approval bypass.
use super::PlannedTask;
use crate::{
    approval::ApprovalBroker,
    db::{CommanderRun, DEFAULT_WORKSPACE, PlanStatus, SessionRecorder, Store, TaskStatus},
    driver::{AcpDriver, PermissionHandler, StartMode},
    error::{CoreError, Result},
    events::{AgentEvent, StopReason},
    registry::{AgentDefinition, AgentRegistry},
};
use futures::{FutureExt, StreamExt, stream::FuturesUnordered};
use std::{collections::HashMap, path::PathBuf, sync::Arc};
use tokio::sync::{broadcast, mpsc, watch};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct DispatchOptions {
    pub max_concurrency: usize,
    pub workspace_id: String,
    pub interactive_approvals: bool,
}
impl Default for DispatchOptions {
    fn default() -> Self {
        Self {
            max_concurrency: 2,
            workspace_id: DEFAULT_WORKSPACE.into(),
            interactive_approvals: false,
        }
    }
}
#[derive(Debug, Clone)]
pub struct DispatchContext {
    pub run_id: Uuid,
    pub task_id: String,
    pub session_id: Uuid,
    pub agent_id: String,
}
#[derive(Debug, Clone)]
pub struct DispatchEvent {
    pub run_id: Uuid,
    pub task_id: String,
    pub session_id: Uuid,
    pub agent_id: String,
    pub event: AgentEvent,
}
pub type BrokerFactory = Arc<dyn Fn(&DispatchContext) -> ApprovalBroker + Send + Sync>;
pub struct Scheduler {
    store: Store,
    registry: AgentRegistry,
}
struct CancelOnDrop(CancellationToken);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}
fn invalid(message: &str) -> CoreError {
    CoreError::Protocol(format!("指挥官调度: {message}"))
}
impl Scheduler {
    pub fn new(store: Store, registry: AgentRegistry) -> Self {
        Self { store, registry }
    }
    pub async fn execute(
        &self,
        id: Uuid,
        options: DispatchOptions,
        brokers: BrokerFactory,
        events: broadcast::Sender<DispatchEvent>,
        cancel: CancellationToken,
    ) -> Result<CommanderRun> {
        if !(1..=16).contains(&options.max_concurrency) {
            return Err(invalid("并发上限须为 1～16"));
        }
        let initial = self
            .store
            .get_commander_run(id)
            .await?
            .ok_or_else(|| invalid("计划不存在"))?;
        if initial.status != PlanStatus::Draft {
            return Err(invalid("只允许执行 draft 计划"));
        }
        let validated = initial.plan.clone().validate(&self.registry)?;
        let cwd = PathBuf::from(&initial.cwd);
        if !cwd.is_absolute() || !cwd.is_dir() {
            return Err(invalid("工作目录不存在或不是绝对路径"));
        }
        if !self
            .store
            .list_workspaces()
            .await?
            .iter()
            .any(|w| w.id == options.workspace_id)
        {
            return Err(invalid("工作空间不存在"));
        }
        let mut definitions = HashMap::new();
        for task in &validated.plan.tasks {
            if !definitions.contains_key(&task.agent_id) {
                let def = self.registry.find(&task.agent_id)?.clone();
                let version = tokio::select! {biased; _=cancel.cancelled()=>return Err(invalid("执行前已取消")), version=def.detect_version()=>version};
                if version.is_none() {
                    return Err(invalid("计划中的 ACP 适配器未就绪"));
                }
                definitions.insert(task.agent_id.clone(), def);
            }
        }
        if cancel.is_cancelled() {
            return Err(invalid("执行前已取消"));
        }
        if !self.store.start_commander_run(id).await? {
            return Err(invalid("计划已被其他调用认领"));
        }
        let child = cancel.child_token();
        let _guard = CancelOnDrop(child.clone());
        let result = self
            .dispatch(
                id,
                &validated.batches,
                &validated.plan.tasks,
                &initial.cwd,
                &options,
                &definitions,
                &brokers,
                &events,
                &child,
            )
            .await;
        if result.is_err() || child.is_cancelled() {
            let current = self
                .store
                .get_commander_run(id)
                .await?
                .ok_or_else(|| invalid("计划不存在"))?;
            if current.status == PlanStatus::Running {
                while !self.store.cancel_commander_run(id).await? {}
            }
        }
        result?;
        self.store
            .get_commander_run(id)
            .await?
            .ok_or_else(|| invalid("计划不存在"))
    }
    #[allow(clippy::too_many_arguments)]
    async fn dispatch(
        &self,
        id: Uuid,
        batches: &[Vec<String>],
        tasks: &[PlannedTask],
        cwd: &str,
        options: &DispatchOptions,
        definitions: &HashMap<String, AgentDefinition>,
        brokers: &BrokerFactory,
        events: &broadcast::Sender<DispatchEvent>,
        cancel: &CancellationToken,
    ) -> Result<()> {
        for batch in batches {
            let mut queue = batch.iter();
            let mut active = FuturesUnordered::new();
            let mut failure = None;
            loop {
                while !cancel.is_cancelled() && active.len() < options.max_concurrency {
                    let Some(task_id) = queue.next() else { break };
                    let claim = async {
                        let run = self
                            .store
                            .get_commander_run(id)
                            .await?
                            .ok_or_else(|| invalid("计划不存在"))?;
                        if run
                            .tasks
                            .iter()
                            .any(|s| s.id == *task_id && s.status == TaskStatus::Skipped)
                        {
                            return Ok(false);
                        }
                        while !self.store.start_commander_task(id, task_id, None).await? {}
                        Ok::<_, CoreError>(true)
                    }
                    .await;
                    match claim {
                        Ok(false) => continue,
                        Ok(true) => {}
                        Err(error) => {
                            cancel.cancel();
                            failure = Some(error);
                            break;
                        }
                    }
                    let task = tasks.iter().find(|t| t.id == *task_id).unwrap().clone();
                    let def = definitions[&task.agent_id].clone();
                    let context = DispatchContext {
                        run_id: id,
                        task_id: task.id.clone(),
                        session_id: Uuid::new_v4(),
                        agent_id: task.agent_id.clone(),
                    };
                    let broker = brokers(&context);
                    active.push(tokio::spawn(run_task(
                        self.store.clone(),
                        def,
                        task,
                        cwd.into(),
                        options.workspace_id.clone(),
                        options.interactive_approvals,
                        context,
                        broker,
                        events.clone(),
                        cancel.child_token(),
                    )));
                }
                if active.is_empty() {
                    break;
                }
                let completion = active.next().await.unwrap();
                let result = match completion {
                    Ok(result) => result,
                    Err(_) => Err(invalid("派单任务异常退出")),
                };
                if let Err(error) = result {
                    cancel.cancel();
                    failure = Some(error);
                }
            }
            if let Some(error) = failure {
                return Err(error);
            }
            if cancel.is_cancelled() {
                break;
            }
        }
        Ok(())
    }
}
#[allow(clippy::too_many_arguments)]
async fn run_task(
    store: Store,
    def: AgentDefinition,
    task: PlannedTask,
    cwd: String,
    workspace: String,
    interactive_approvals: bool,
    context: DispatchContext,
    broker: ApprovalBroker,
    events: broadcast::Sender<DispatchEvent>,
    cancel: CancellationToken,
) -> Result<()> {
    let _guard = CancelOnDrop(cancel.clone());
    store
        .upsert_agent(&def.id, &def.display_name, "acp", None)
        .await?;
    let mut recorder = SessionRecorder::new(
        store.clone(),
        context.session_id,
        &def.id,
        &cwd,
        &task.title,
        &task.prompt,
        &workspace,
    );
    let (tx, mut rx) = mpsc::channel(256);
    let (ready_tx, ready_rx) = watch::channel(false);
    let permissions: PermissionHandler = {
        let broker = broker.clone();
        let token = cancel.clone();
        let store = store.clone();
        let session = context.session_id;
        Arc::new(move |request| {
            let broker = broker.clone();
            let token = token.clone();
            let store = store.clone();
            let mut ready = ready_rx.clone();
            Box::pin(async move {
                while !*ready.borrow_and_update() {
                    tokio::select! {biased; _=token.cancelled()=>return Err(invalid("审批已取消")), changed=ready.changed()=>changed.map_err(|_|invalid("会话未持久化"))?}
                }
                let request_session = request.session_id.clone();
                let request_tool = request.tool_call_id.clone();
                let mut decisions = broker.subscribe_decisions();
                let rejection = request
                    .options
                    .iter()
                    .find(|o| !o.kind.is_allow())
                    .map(|o| o.option_id.clone());
                let resolution = async {
                    if interactive_approvals {
                        broker.resolve(request).await
                    } else {
                        broker.resolve_fail_closed(request).await
                    }
                };
                tokio::pin!(resolution);
                let mut cancelled_approval = false;
                let mut decision = tokio::select! {biased;
                    _=token.cancelled()=>{
                        cancelled_approval=true;
                        broker.reject_all_pending().await;
                        match resolution.as_mut().now_or_never() {
                            Some(result)=>result?,
                            None=>{broker.reject_all_pending().await;resolution.await?}
                        }
                    },result=&mut resolution=>result?
                };
                let mut record = loop {
                    let record = decisions
                        .try_recv()
                        .map_err(|_| invalid("审批裁决记录缺失"))?;
                    if record.request.session_id == request_session
                        && record.request.tool_call_id == request_tool
                    {
                        break record;
                    }
                };
                if cancelled_approval {
                    decision.option_id =
                        rejection.ok_or_else(|| invalid("审批取消缺少拒绝选项"))?;
                    record.decision = decision.clone();
                    record.source = crate::approval::DecisionSource::Rule {
                        pattern: "<cancelled>".into(),
                        effect: crate::approval::RuleEffect::Deny,
                    };
                }
                store.insert_approval(session, &record).await?;
                Ok(decision)
            })
        })
    };
    let driver = AcpDriver::new(def.launch_command()).with_process_cwd(def.acp_process_cwd);
    let driver_future = driver.run(
        PathBuf::from(&cwd),
        StartMode::New,
        task.prompt,
        tx.clone(),
        permissions,
        cancel.clone(),
    );
    tokio::pin!(driver_future);
    let mut persistence = None;
    let reason = loop {
        tokio::select! {
            result=&mut driver_future => break result,
            Some(event)=rx.recv()=> {
                let started=matches!(event,AgentEvent::SessionStarted{..});
                match persist(&store,&context,&mut recorder,&events,event).await {
                    Err(error)=>{persistence=Some(error);cancel.cancel();},
                    Ok(())=>{if started {let _=ready_tx.send(true);}}
                }
            }
        }
    };
    broker.reject_all_pending().await;
    drop(tx);
    // Driver future may retain its sender until its scope ends; drain queued events.
    while let Ok(event) = rx.try_recv() {
        if let Err(error) = persist(&store, &context, &mut recorder, &events, event).await {
            persistence = Some(error);
        }
    }
    if reason.is_err()
        && let Err(error) = persist(
            &store,
            &context,
            &mut recorder,
            &events,
            AgentEvent::DriverError {
                message: "ACP 派单失败".into(),
            },
        )
        .await
    {
        persistence = Some(error);
    }
    if let Some(error) = persistence {
        return Err(error);
    }
    if !cancel.is_cancelled() {
        let status = if matches!(reason, Ok(StopReason::EndTurn)) {
            TaskStatus::Succeeded
        } else {
            TaskStatus::Failed
        };
        while !store
            .finish_commander_task(context.run_id, &context.task_id, status)
            .await?
        {}
    }
    Ok(())
}
async fn persist(
    store: &Store,
    context: &DispatchContext,
    recorder: &mut SessionRecorder,
    events: &broadcast::Sender<DispatchEvent>,
    event: AgentEvent,
) -> Result<()> {
    recorder.handle_event_checked(&event).await?;
    if matches!(event, AgentEvent::SessionStarted { .. }) {
        while !store
            .bind_commander_task_session(context.run_id, &context.task_id, context.session_id)
            .await?
        {}
    }
    let _ = events.send(DispatchEvent {
        run_id: context.run_id,
        task_id: context.task_id.clone(),
        session_id: context.session_id,
        agent_id: context.agent_id.clone(),
        event,
    });
    Ok(())
}
