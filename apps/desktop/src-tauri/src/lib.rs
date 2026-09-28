//! SuperCode 桌面壳（Tauri v2）。
//! P1-5：审批中心——权限模式热切换、待决请求转发应答、规则库 SQLite 持久化（§5.1）。

use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Duration};

use supercode_core::approval::{ApprovalBroker, PermissionMode, PermissionRules, RuleEffect};
use supercode_core::db::{SessionRecorder, Store};
use supercode_core::driver::{AcpDriver, PermissionHandler, StartMode};
use supercode_core::events::{AgentEvent, EventAggregator};
use supercode_core::registry;
use tauri::{ipc::Channel, Emitter, Manager};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use uuid::Uuid as SessionUuid;
use uuid::Uuid;

/// 帧周期：~16ms（§5 硬性架构约束，非优化项）
const FRAME_TICK: Duration = Duration::from_millis(16);
/// 等待 SessionStarted 的上限（含 agent 进程冷启动）
const SESSION_READY_TIMEOUT: Duration = Duration::from_secs(30);

struct RunHandle {
    cancel: CancellationToken,
    /// 运行级审批代理（模式热切换 / 待决应答路由）
    broker: ApprovalBroker,
}

#[derive(Default)]
struct AppState {
    runs: tokio::sync::Mutex<HashMap<String, RunHandle>>,
    /// 待决请求 id → broker（respond_permission 路由；裁决后由转发任务移除）
    pending: tokio::sync::Mutex<HashMap<Uuid, ApprovalBroker>>,
    store: tokio::sync::OnceCell<Store>,
}

impl AppState {
    async fn store(&self) -> &Store {
        self.store
            .get_or_init(|| async { Store::open_default().await.expect("打开规则库失败") })
            .await
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "snake_case")]
struct RunInfo {
    session_id: String,
}

fn parse_mode(mode: &str) -> Result<PermissionMode, String> {
    PermissionMode::from_str_value(mode).ok_or_else(|| format!("未知权限模式: {mode}"))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri IPC 参数展开，语义即数据面
async fn run_prompt(
    app: tauri::AppHandle,
    prompt: String,
    agent_id: Option<String>,
    cwd: String,
    allow: Vec<String>,
    deny: Vec<String>,
    mode: String,
    // P1-6：Some → StartMode::Load 续聊既有会话（agent_session_id）
    resume_session_id: Option<String>,
    // P1-8：会话归属工作空间（ADR-0007）；None → 默认空间
    workspace_id: Option<String>,
    on_events: Channel<Vec<AgentEvent>>,
) -> Result<RunInfo, String> {
    let def = registry::AgentDefinition::find(agent_id.as_deref().unwrap_or("opencode"))
        .map_err(|e| e.to_string())?;
    let permission_mode = parse_mode(&mode)?;
    let state = app.state::<AppState>();
    let store = state.store().await;
    let existing = if let Some(id) = &resume_session_id {
        let local_id = store
            .find_session_by_agent(id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("续聊会话不存在")?;
        Some(
            store
                .get_session(local_id)
                .await
                .map_err(|e| e.to_string())?
                .ok_or("续聊会话不存在")?,
        )
    } else {
        None
    };
    supercode_core::orchestrator::validate_launch(&def, existing.as_ref(), &cwd)
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&cwd).map_err(|e| format!("创建工作目录失败：{e}"))?;
    store
        .upsert_agent(&def.id, &def.display_name, "acp", None)
        .await
        .map_err(|e| e.to_string())?;
    let mut rules = PermissionRules::new(allow, deny);
    for entry in store
        .list_permission_rules()
        .await
        .map_err(|e| e.to_string())?
    {
        let pattern = entry.pattern;
        match entry.effect {
            RuleEffect::Allow => rules.allow.push(pattern),
            RuleEffect::Deny => rules.deny.push(pattern),
            RuleEffect::Ask => rules.ask.push(pattern),
        }
    }

    // P1-5：审批中心接管——兜底走待决队列（resolve）
    let broker = ApprovalBroker::with_rules(rules);
    broker.set_mode(permission_mode);
    let permissions: PermissionHandler = {
        let broker = broker.clone();
        Arc::new(move |request| {
            let broker = broker.clone();
            Box::pin(async move { broker.resolve(request).await })
        })
    };

    // broker → 前端事件转发：待决请求 / 裁决留痕（§5.1）
    let app_for_relay = app.clone();
    let broker_for_relay = broker.clone();
    let mut pending_rx = broker_for_relay.subscribe();
    let mut decisions_rx = broker_for_relay.subscribe_decisions();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                pending = pending_rx.recv() => {
                    match pending {
                        Ok(pending) => {
                            app_for_relay
                                .state::<AppState>()
                                .pending
                                .lock()
                                .await
                                .insert(pending.id, broker_for_relay.clone());
                            let _ = app_for_relay.emit("permission-request", &pending);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(_) => break,
                    }
                }
                record = decisions_rx.recv() => {
                    match record {
                        Ok(record) => {
                            let _ = app_for_relay.emit("decision-record", &record);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(_) => break,
                    }
                }
            }
        }
    });

    // driver 原始事件 → tap（捕获 session_id）→ 合帧器 → Channel 批量推送
    let (raw_tx, raw_rx) = mpsc::channel::<AgentEvent>(256);
    let (frame_in_tx, frame_in_rx) = mpsc::channel::<AgentEvent>(256);
    let (frame_tx, frame_rx) = mpsc::channel::<Vec<AgentEvent>>(32);
    // invoke 返回 RunInfo 后的晚失败兜底也要能推事件（见 done watcher）
    let frame_in_tx_for_done = frame_in_tx.clone();
    let (session_tx, session_rx) = oneshot::channel::<String>();
    let (done_tx, mut done_rx) = oneshot::channel::<supercode_core::error::Result<()>>();
    let session_of_run = Arc::new(std::sync::Mutex::new(None::<String>));
    let cancel = CancellationToken::new();
    let cancel_for_run = cancel.clone();
    let cancel_for_tap = cancel.clone();

    // P1-6 落库：resume 沿用原会话行（按 agent_session_id 反查），新跑生成新 UUID。
    // insert_session OR IGNORE 幂等；本轮提示词作为新用户消息记录。
    // recorder 跑在独立任务（有界通道缓冲）——逐事件 DB 写不得阻塞事件转发（§5 管线）
    let recorder_store = state.store().await.clone();
    let supercode_session = match &existing {
        Some(row) => SessionUuid::parse_str(&row.id).map_err(|e| e.to_string())?,
        None => SessionUuid::new_v4(),
    };
    let mut recorder = SessionRecorder::new(
        recorder_store,
        supercode_session,
        &def.id,
        &cwd,
        &prompt.chars().take(24).collect::<String>(),
        &prompt,
        workspace_id
            .as_deref()
            .filter(|id| !id.is_empty())
            .unwrap_or(supercode_core::db::DEFAULT_WORKSPACE),
    );
    let start_mode = resume_session_id
        .map(StartMode::Load)
        .unwrap_or(StartMode::New);
    let (rec_tx, mut rec_rx) = mpsc::channel::<AgentEvent>(512);
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rec_rx.recv().await {
            recorder.handle_event(&event).await;
        }
    });

    tauri::async_runtime::spawn(async move {
        let mut raw_rx = raw_rx;
        let mut session_tx = Some(session_tx);
        let mut frontend_dead = false;
        while let Some(event) = raw_rx.recv().await {
            // SessionStarted 捕获必须先于一切可能失败的转发（invoke 依赖它返回）。
            // 只能在事件匹配时 take——续聊时重放事件先于 session/load 响应到达，
            // 先 take 后匹配会把 oneshot sender 丢在非匹配事件上，RunInfo 永远
            // 等不到（轮末误报"agent 未返回会话信息"，超 30s 还会误触建立超时取消）。
            if let AgentEvent::SessionStarted { session_id } = &event {
                if let Some(tx) = session_tx.take() {
                    let _ = tx.send(session_id.clone());
                }
            }
            // 落库通道失效仅丢持久化，不中断捕获与转发
            if rec_tx.send(event.clone()).await.is_err() {
                eprintln!("[p1-6] recorder 通道失效，事件持久化中断");
            }
            // 前端管道失效（页面重载等）：终止孤儿运行（否则 agent 跑完整轮白烧
            // token，且 SessionStarted 丢失导致 invoke 误报"未返回会话信息"），
            // 循环保持排空以完成收尾
            if frame_in_tx.send(event).await.is_err() && !frontend_dead {
                frontend_dead = true;
                eprintln!("[p1-6] 前端通道失效，终止本次运行");
                cancel_for_tap.cancel();
            }
        }
    });
    tauri::async_runtime::spawn(async move {
        EventAggregator::new(FRAME_TICK)
            .run(frame_in_rx, frame_tx)
            .await;
    });
    tauri::async_runtime::spawn(async move {
        let mut frame_rx = frame_rx;
        while let Some(batch) = frame_rx.recv().await {
            // 窗口已关闭等推送失败：事件流只剩丢弃一条路
            let _ = on_events.send(batch);
        }
    });

    let driver = AcpDriver::new(def.command);
    let cleanup_session = session_of_run.clone();
    let app_for_cleanup = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = driver
            .run(
                std::path::PathBuf::from(cwd),
                start_mode,
                prompt,
                raw_tx,
                permissions,
                cancel_for_run,
            )
            .await;
        // 运行结束：移出 active map（cancel_run 随即报"不在运行中"）
        let finished = cleanup_session.lock().unwrap().clone();
        if let Some(session_id) = finished {
            let state = app_for_cleanup.state::<AppState>();
            state.runs.lock().await.remove(&session_id);
        }
        let _ = done_tx.send(result.map(|_| ()));
    });

    // session_id 就绪即返回；若运行先于会话建立失败，立即把错误抛回调用方
    let session_id = tokio::select! {
        id = session_rx => match id {
            Ok(id) => id,
            // 事件流关闭：driver.run 已返回——取真实结果而非笼统报错
            Err(_) => {
                cancel.cancel();
                return match done_rx.await {
                    Ok(Ok(())) => Err("会话建立失败：agent 未返回会话信息".into()),
                    Ok(Err(e)) => Err(format!("会话建立失败：{e}")),
                    Err(_) => Err("事件流在会话建立前关闭".into()),
                };
            }
        },
        done = &mut done_rx => {
            cancel.cancel();
            return match done {
                Ok(Ok(())) => Err("运行在会话建立前即结束".into()),
                Ok(Err(e)) => Err(format!("会话建立失败：{e}")),
                Err(_) => Err("运行任务异常退出".into()),
            };
        }
        _ = tokio::time::sleep(SESSION_READY_TIMEOUT) => {
            cancel.cancel();
            return Err("等待会话建立超时（agent 冷启动无响应）".into());
        }
    };
    *session_of_run.lock().unwrap() = Some(session_id.clone());
    let state = app.state::<AppState>();
    state.runs.lock().await.insert(
        session_id.clone(),
        RunHandle {
            cancel,
            broker: broker.clone(),
        },
    );

    // 晚失败兜底（P1-6 验收发现）：invoke 返回后无人消费 done——运行晚失败
    // （如 agent 进程死亡）必须转成 DriverError 事件让前端结束运行态
    tauri::async_runtime::spawn(async move {
        if let Ok(Err(e)) = done_rx.await {
            eprintln!("[p1-6] 运行晚失败：{e}");
            let _ = frame_in_tx_for_done
                .send(AgentEvent::DriverError {
                    message: format!("运行失败：{e}"),
                })
                .await;
        }
    });

    Ok(RunInfo { session_id })
}

#[tauri::command]
async fn cancel_run(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let runs = state.runs.lock().await;
    match runs.get(&session_id) {
        Some(handle) => {
            handle.cancel.cancel();
            // 权限挂起会阻塞取消链（opencode 等应答时收不到 session/cancel），
            // 先把待决请求按拒绝收尾，让 agent 走完取消流程
            let rejected = handle.broker.reject_all_pending().await;
            if rejected > 0 {
                eprintln!("[p1-5] 取消时收尾 {rejected} 条待决权限");
            }
            Ok(())
        }
        None => Err(format!("会话 {session_id} 不在运行中")),
    }
}

/// 运行中热切换权限模式（§4.3 管线即时生效）
#[tauri::command]
async fn set_permission_mode(
    app: tauri::AppHandle,
    session_id: String,
    mode: String,
) -> Result<(), String> {
    let permission_mode = parse_mode(&mode)?;
    let state = app.state::<AppState>();
    let runs = state.runs.lock().await;
    match runs.get(&session_id) {
        Some(handle) => {
            handle.broker.set_mode(permission_mode);
            Ok(())
        }
        None => Err(format!("会话 {session_id} 不在运行中")),
    }
}

/// 历史会话列表（P1-6：启动时注入前端）
#[tauri::command]
async fn list_history_sessions(app: tauri::AppHandle) -> Result<Vec<HistorySession>, String> {
    let state = app.state::<AppState>();
    let store = state.store().await;
    let rows = store.list_sessions().await.map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|row| HistorySession {
            agent_id: row.agent_id,
            agent_session_id: row.agent_session_id,
            cwd: row.cwd,
            title: row.title,
            status: row.status,
            updated_at: row.updated_at,
            workspace_id: row.workspace_id,
        })
        .collect())
}

/// 删除会话（P1-6：SuperCode 侧级联删除；运行中禁止）
#[tauri::command]
async fn delete_session(app: tauri::AppHandle, agent_session_id: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    {
        let runs = state.runs.lock().await;
        if runs.contains_key(&agent_session_id) {
            return Err("会话运行中，请先停止再删除".into());
        }
    }
    let store = state.store().await;
    let _ = store
        .delete_session_by_agent(&agent_session_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 历史会话 DTO（Tauri IPC 返回类型需本地 Serialize）
#[derive(serde::Serialize)]
struct HistorySession {
    agent_id: String,
    agent_session_id: String,
    cwd: String,
    title: String,
    status: String,
    updated_at: String,
    workspace_id: String,
}

/// 历史消息 DTO
#[derive(serde::Serialize)]
struct HistoryMessage {
    role: String,
    text: String,
    created_at: String,
}

/// 单个会话的落库消息（P1-6：历史渲染）
#[tauri::command]
async fn list_session_messages(
    app: tauri::AppHandle,
    agent_session_id: String,
) -> Result<Vec<HistoryMessage>, String> {
    let state = app.state::<AppState>();
    let store = state.store().await;
    let rows = store
        .list_messages(&agent_session_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|row| HistoryMessage {
            role: row.role,
            text: row.text,
            created_at: row.created_at,
        })
        .collect())
}

/// 空间列表（P1-8，ADR-0007；本地 DTO：外部类型不满足 IpcResponse）
#[derive(serde::Serialize)]
struct WorkspaceDto {
    id: String,
    name: String,
    path: Option<String>,
    kind: String,
}

#[tauri::command]
async fn list_workspaces(app: tauri::AppHandle) -> Result<Vec<WorkspaceDto>, String> {
    let state = app.state::<AppState>();
    let store = state.store().await;
    let rows = store.list_workspaces().await.map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|w| WorkspaceDto {
            id: w.id,
            name: w.name,
            path: w.path,
            kind: w.kind,
        })
        .collect())
}

/// 新建（或返回既有）项目空间：要求目录已存在，name 取目录名
#[tauri::command]
async fn create_workspace(app: tauri::AppHandle, path: String) -> Result<WorkspaceDto, String> {
    let trimmed = path.trim().to_string();
    if trimmed.is_empty() {
        return Err("路径不能为空".into());
    }
    if !std::path::Path::new(&trimmed).is_dir() {
        return Err(format!("目录不存在：{trimmed}"));
    }
    let state = app.state::<AppState>();
    let store = state.store().await;
    let w = store
        .create_workspace(&trimmed)
        .await
        .map_err(|e| e.to_string())?;
    Ok(WorkspaceDto {
        id: w.id,
        name: w.name,
        path: w.path,
        kind: w.kind,
    })
}

/// 删除 project 空间：会话移入默认空间，不级联删（ADR-0007）
#[tauri::command]
async fn delete_workspace(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let store = state.store().await;
    store.delete_workspace(&id).await.map_err(|e| e.to_string())
}

/// 任务条目 DTO（P1-9 简版看板）
#[derive(serde::Serialize)]
struct TaskDto {
    id: String,
    workspace_id: String,
    title: String,
    session_id: Option<String>,
    status: String,
}

impl From<supercode_core::db::TaskEntry> for TaskDto {
    fn from(t: supercode_core::db::TaskEntry) -> Self {
        Self {
            id: t.id,
            workspace_id: t.workspace_id,
            title: t.title,
            session_id: t.session_id,
            status: t.status,
        }
    }
}

#[tauri::command]
async fn list_tasks(app: tauri::AppHandle) -> Result<Vec<TaskDto>, String> {
    let state = app.state::<AppState>();
    let store = state.store().await;
    store
        .list_tasks()
        .await
        .map(|rows| rows.into_iter().map(Into::into).collect())
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_task(
    app: tauri::AppHandle,
    title: String,
    workspace_id: String,
) -> Result<TaskDto, String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("任务标题不能为空".into());
    }
    let state = app.state::<AppState>();
    let store = state.store().await;
    store
        .create_task(&workspace_id, &title)
        .await
        .map(Into::into)
        .map_err(|e| e.to_string())
}

/// 更新任务：status 四态之一；session_id 空串=解绑（IPC 无法传 SQL NULL 的约定）
#[tauri::command]
async fn update_task(
    app: tauri::AppHandle,
    id: String,
    status: Option<String>,
    session_id: Option<String>,
) -> Result<TaskDto, String> {
    let state = app.state::<AppState>();
    let store = state.store().await;
    store
        .update_task(&id, status.as_deref(), session_id.as_deref())
        .await
        .map(Into::into)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_task(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let store = state.store().await;
    store.delete_task(&id).await.map_err(|e| e.to_string())
}

/// Claude ACP 的 Node/npx 依赖探测，只返回事实，不访问认证配置。
#[tauri::command]
async fn check_node_env() -> supercode_core::envcheck::NodeEnvReport {
    supercode_core::envcheck::check_node().await
}

/// OpenCode 安装/配置联检（只读）。
#[tauri::command]
async fn check_opencode_env(
    cwd: Option<String>,
) -> Result<supercode_core::envcheck::OpencodeEnvReport, String> {
    let cwd = cwd.map(PathBuf::from);
    Ok(supercode_core::envcheck::check(cwd.as_deref()).await)
}

/// 审批中心应答待决请求（应答成功即从待决映射移除）
#[tauri::command]
async fn respond_permission(
    app: tauri::AppHandle,
    request_id: String,
    option_id: String,
) -> Result<(), String> {
    let id = Uuid::parse_str(&request_id).map_err(|e| format!("非法请求 id: {e}"))?;
    let state = app.state::<AppState>();
    let broker = state.pending.lock().await.remove(&id);
    match broker {
        Some(broker) => broker
            .respond(
                id,
                supercode_core::driver::PermissionDecision {
                    option_id,
                    updated_input: None,
                },
            )
            .await
            .map_err(|e| e.to_string()),
        None => Err(format!("待决请求 {request_id} 不存在或已裁决")),
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "snake_case")]
struct RuleEntry {
    id: String,
    pattern: String,
    effect: String,
}

#[tauri::command]
async fn list_rules(app: tauri::AppHandle) -> Result<Vec<RuleEntry>, String> {
    let state = app.state::<AppState>();
    let store = state.store().await;
    let entries = store
        .list_permission_rules()
        .await
        .map_err(|e| e.to_string())?;
    Ok(entries
        .into_iter()
        .map(|entry| match entry.effect {
            RuleEffect::Allow => RuleEntry {
                id: entry.id,
                pattern: entry.pattern,
                effect: "allow".into(),
            },
            RuleEffect::Deny => RuleEntry {
                id: entry.id,
                pattern: entry.pattern,
                effect: "deny".into(),
            },
            RuleEffect::Ask => RuleEntry {
                id: entry.id,
                pattern: entry.pattern,
                effect: "ask".into(),
            },
        })
        .collect())
}

#[tauri::command]
async fn add_rule(
    app: tauri::AppHandle,
    pattern: String,
    effect: String,
) -> Result<RuleEntry, String> {
    if pattern.trim().is_empty() {
        return Err("规则不能为空".into());
    }
    let rule_effect: RuleEffect = effect
        .parse()
        .map_err(|e: supercode_core::error::CoreError| e.to_string())?;
    let state = app.state::<AppState>();
    let store = state.store().await;
    let entry = store
        .add_permission_rule(pattern.trim(), rule_effect)
        .await
        .map_err(|e| e.to_string())?;
    let effect_str = match entry.effect {
        RuleEffect::Allow => "allow",
        RuleEffect::Deny => "deny",
        RuleEffect::Ask => "ask",
    };
    Ok(RuleEntry {
        id: entry.id,
        pattern: entry.pattern,
        effect: effect_str.into(),
    })
}

#[tauri::command]
async fn delete_rule(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let store = state.store().await;
    store
        .delete_permission_rule(&id)
        .await
        .map_err(|e| e.to_string())
}

/// 读取文本文件（write 工具 diff 展示用：opencode 的 ACP 事件不含新文件内容，
/// 展开时从磁盘取）。上限 1MB，非 UTF-8 内容按替换字符降级。
#[tauri::command]
async fn read_text_file(path: String) -> Result<String, String> {
    const MAX_BYTES: u64 = 1024 * 1024;
    let meta = std::fs::metadata(&path).map_err(|e| format!("读取文件信息失败：{e}"))?;
    if meta.len() > MAX_BYTES {
        return Err("文件超过 1MB，不展示 diff".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("读取文件失败：{e}"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

// ── Agent 管理（P2-2，§5.1）：注册表合并视图 + 用户自定义 CRUD ──

#[derive(serde::Serialize)]
#[serde(rename_all = "snake_case")]
struct AgentRow {
    id: String,
    display_name: String,
    driver_kind: registry::DriverKind,
    command: String,
    version_args: Vec<String>,
    capabilities: registry::Capabilities,
    /// id 出现在用户文件（含覆盖内置）
    is_user_defined: bool,
    installed_version: Option<String>,
}

/// 新增/更新入参。Tauri 仅映射**顶层**命令形参（camelCase↔snake_case），
/// 嵌套 struct 走 serde 原样匹配——故这里显式 rename_all=camelCase 对齐前端
/// `AgentInput`（审查 critical：否则 add/update_agent 反序列化必失败）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentInput {
    id: String,
    display_name: String,
    driver_kind: String,
    command: String,
    version_args: Vec<String>,
    supports_load_session: bool,
    supports_diff: bool,
    supports_permission: bool,
}

impl AgentInput {
    fn into_definition(self) -> Result<registry::AgentDefinition, String> {
        let driver_kind = match self.driver_kind.as_str() {
            "acp" => registry::DriverKind::Acp,
            "stream_json" => registry::DriverKind::StreamJson,
            "native" => registry::DriverKind::Native,
            other => return Err(format!("未知 driver_kind: {other}")),
        };
        let id = self.id.trim().to_string();
        if id.is_empty()
            || !id
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        {
            return Err("id 须为 [a-z0-9-]+".into());
        }
        let command = self.command.trim().to_string();
        if command.is_empty() {
            return Err("command 不能为空".into());
        }
        let version_args = if self.version_args.is_empty() {
            vec!["--version".into()]
        } else {
            self.version_args
        };
        Ok(registry::AgentDefinition {
            id,
            display_name: self.display_name.trim().to_string(),
            driver_kind,
            command,
            version_args,
            capabilities: registry::Capabilities {
                supports_load_session: self.supports_load_session,
                supports_diff: self.supports_diff,
                supports_permission: self.supports_permission,
            },
        })
    }
}

fn user_defined_ids() -> std::collections::HashSet<String> {
    registry::AgentRegistry::load_user_entries()
        .into_iter()
        .map(|e| e.id)
        .collect()
}

async fn probe_row(def: registry::AgentDefinition, is_user_defined: bool) -> AgentRow {
    let installed_version = def.detect_version().await;
    AgentRow {
        id: def.id,
        display_name: def.display_name,
        driver_kind: def.driver_kind,
        command: def.command,
        version_args: def.version_args,
        capabilities: def.capabilities,
        is_user_defined,
        installed_version,
    }
}

/// 会话选择器只需要注册表定义；不在挂载时执行 npx 探测，避免与运行启动争用 npm 缓存。
#[tauri::command]
fn list_agent_definitions() -> Vec<AgentRow> {
    let user_ids = user_defined_ids();
    registry::AgentRegistry::load()
        .entries()
        .iter()
        .map(|def| AgentRow {
            id: def.id.clone(),
            display_name: def.display_name.clone(),
            driver_kind: def.driver_kind,
            command: def.command.clone(),
            version_args: def.version_args.clone(),
            capabilities: def.capabilities.clone(),
            is_user_defined: user_ids.contains(&def.id),
            installed_version: None,
        })
        .collect()
}

#[tauri::command]
async fn list_agents() -> Result<Vec<AgentRow>, String> {
    let reg = registry::AgentRegistry::load();
    let user_ids = user_defined_ids();
    // 并行探测（npx 类冷启动可达 8s 超时，串行会卡设置页）
    let futs = reg.entries().iter().map(|def| {
        let def = def.clone();
        let is_user = user_ids.contains(&def.id);
        async move { probe_row(def, is_user).await }
    });
    Ok(futures::future::join_all(futs).await)
}

#[tauri::command]
async fn add_agent(input: AgentInput) -> Result<AgentRow, String> {
    let def = input.into_definition()?;
    registry::AgentRegistry::upsert_user_agent(def.clone()).map_err(|e| e.to_string())?;
    Ok(probe_row(def, true).await)
}

#[tauri::command]
async fn update_agent(input: AgentInput) -> Result<AgentRow, String> {
    let def = input.into_definition()?;
    registry::AgentRegistry::upsert_user_agent(def.clone()).map_err(|e| e.to_string())?;
    Ok(probe_row(def, true).await)
}

#[tauri::command]
async fn delete_agent(id: String) -> Result<(), String> {
    registry::AgentRegistry::remove_user_agent(&id).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // GUI PATH 修正（P1-10，§4.7）：Finder/Dock 启动的 .app 只拿 launchd 的
    // 最小 PATH——Homebrew/官方脚本装的 opencode 不可见（探测与 spawn 双失效）。
    // 必须在任何探测/子进程 spawn 之前执行；终端启动时为幂等空操作。
    supercode_core::envcheck::augment_gui_path();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            runs: tokio::sync::Mutex::new(HashMap::new()),
            pending: tokio::sync::Mutex::new(HashMap::new()),
            store: tokio::sync::OnceCell::new(),
        })
        .invoke_handler(tauri::generate_handler![
            run_prompt,
            cancel_run,
            read_text_file,
            set_permission_mode,
            respond_permission,
            list_history_sessions,
            list_session_messages,
            delete_session,
            list_rules,
            add_rule,
            delete_rule,
            check_opencode_env,
            check_node_env,
            list_workspaces,
            create_workspace,
            delete_workspace,
            list_tasks,
            create_task,
            update_task,
            delete_task,
            list_agents,
            list_agent_definitions,
            add_agent,
            update_agent,
            delete_agent
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 前端 invoke 以 camelCase 发嵌套 input——serde 必须能对上（审查 critical 回归）。
    #[test]
    fn agent_input_accepts_camel_case_from_frontend() {
        let json = r#"{
            "id": "my-agent",
            "displayName": "My Agent",
            "driverKind": "acp",
            "command": "my-agent --acp",
            "versionArgs": ["--version"],
            "supportsLoadSession": true,
            "supportsDiff": true,
            "supportsPermission": false
        }"#;
        let input: AgentInput = serde_json::from_str(json).expect("camelCase 反序列化应成功");
        assert_eq!(input.id, "my-agent");
        assert_eq!(input.display_name, "My Agent");
        assert_eq!(input.driver_kind, "acp");
        assert_eq!(input.version_args, vec!["--version".to_string()]);
        assert!(!input.supports_permission);

        let def = input.into_definition().unwrap();
        assert_eq!(def.command, "my-agent --acp");
        assert_eq!(def.driver_kind, registry::DriverKind::Acp);
    }

    #[test]
    fn agent_input_rejects_bad_id_and_empty_command() {
        let bad_id: AgentInput = serde_json::from_str(
            r#"{"id":"Bad_ID","displayName":"x","driverKind":"acp","command":"x",
                "versionArgs":[],"supportsLoadSession":true,"supportsDiff":true,"supportsPermission":true}"#,
        )
        .unwrap();
        assert!(bad_id.into_definition().is_err());

        let empty_cmd: AgentInput = serde_json::from_str(
            r#"{"id":"ok","displayName":"x","driverKind":"acp","command":"  ",
                "versionArgs":[],"supportsLoadSession":true,"supportsDiff":true,"supportsPermission":true}"#,
        )
        .unwrap();
        assert!(empty_cmd.into_definition().is_err());
    }
}
