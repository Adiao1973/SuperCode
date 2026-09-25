//! SuperCode 桌面壳（Tauri v2）。
//! P1-5：审批中心——权限模式热切换、待决请求转发应答、规则库 SQLite 持久化（§5.1）。

use std::{collections::HashMap, sync::Arc, time::Duration};

use supercode_core::approval::{ApprovalBroker, PermissionMode, PermissionRules, RuleEffect};
use supercode_core::db::Store;
use supercode_core::driver::{AcpDriver, PermissionHandler, StartMode};
use supercode_core::events::{AgentEvent, EventAggregator};
use supercode_core::registry;
use tauri::{ipc::Channel, Emitter, Manager};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;
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
async fn run_prompt(
    app: tauri::AppHandle,
    prompt: String,
    cwd: String,
    allow: Vec<String>,
    deny: Vec<String>,
    mode: String,
    on_events: Channel<Vec<AgentEvent>>,
) -> Result<RunInfo, String> {
    let def = registry::AgentDefinition::find("opencode").map_err(|e| e.to_string())?;
    let permission_mode = parse_mode(&mode)?;

    // 规则库（SQLite 持久）∪ 本次 draft 规则，合成 broker 规则集
    let state = app.state::<AppState>();
    let store = state.store().await;
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
    let (session_tx, session_rx) = oneshot::channel::<String>();
    let (done_tx, done_rx) = oneshot::channel::<supercode_core::error::Result<()>>();
    let session_of_run = Arc::new(std::sync::Mutex::new(None::<String>));

    tauri::async_runtime::spawn(async move {
        let mut raw_rx = raw_rx;
        let mut session_tx = Some(session_tx);
        while let Some(event) = raw_rx.recv().await {
            // driver 契约：SessionStarted 是首个事件；此后不再捕获
            if let (Some(tx), AgentEvent::SessionStarted { session_id }) =
                (session_tx.take(), &event)
            {
                let _ = tx.send(session_id.clone());
            }
            if frame_in_tx.send(event).await.is_err() {
                break;
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

    let cancel = CancellationToken::new();
    let cancel_for_run = cancel.clone();
    let driver = AcpDriver::new(def.command);
    let cleanup_session = session_of_run.clone();
    let app_for_cleanup = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = driver
            .run(
                std::path::PathBuf::from(cwd),
                StartMode::New,
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
        id = session_rx => id.map_err(|_| "事件流在会话建立前关闭".to_string())?,
        done = done_rx => {
            return match done {
                Ok(Ok(())) => Err("运行在会话建立前即结束".into()),
                Ok(Err(e)) => Err(e.to_string()),
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
    Ok(RunInfo { session_id })
}

#[tauri::command]
async fn cancel_run(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let runs = state.runs.lock().await;
    match runs.get(&session_id) {
        Some(handle) => {
            handle.cancel.cancel();
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
            list_rules,
            add_rule,
            delete_rule
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
