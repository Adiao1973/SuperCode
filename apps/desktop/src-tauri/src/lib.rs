//! SuperCode 桌面壳（Tauri v2）。
//! P1-2：事件管道接通——core 合帧输出（~16ms 批）经 Tauri Channel 推送（architecture §5.1）。

use std::{collections::HashMap, sync::Arc, time::Duration};

use supercode_core::approval::{ApprovalBroker, PermissionRules};
use supercode_core::driver::{AcpDriver, PermissionHandler, StartMode};
use supercode_core::events::{AgentEvent, EventAggregator};
use supercode_core::registry;
use tauri::{ipc::Channel, Manager};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

/// 帧周期：~16ms（§5 硬性架构约束，非优化项）
const FRAME_TICK: Duration = Duration::from_millis(16);
/// 等待 SessionStarted 的上限（含 agent 进程冷启动）
const SESSION_READY_TIMEOUT: Duration = Duration::from_secs(30);

struct RunHandle {
    cancel: CancellationToken,
}

#[derive(Default)]
struct AppState {
    runs: tokio::sync::Mutex<HashMap<String, RunHandle>>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "snake_case")]
struct RunInfo {
    session_id: String,
}

#[tauri::command]
async fn run_prompt(
    app: tauri::AppHandle,
    prompt: String,
    cwd: String,
    allow: Vec<String>,
    deny: Vec<String>,
    on_events: Channel<Vec<AgentEvent>>,
) -> Result<RunInfo, String> {
    let def = registry::AgentDefinition::find("opencode").map_err(|e| e.to_string())?;
    // fail-closed：未匹配任何 allow 规则的权限请求直接拒绝（resolve_fail_closed），
    // 直至 P1-5 审批中心接管。注意不可用通配 deny 兜底——deny 优先求值会压掉 allow。
    let broker = ApprovalBroker::with_rules(PermissionRules::new(allow, deny));
    let permissions: PermissionHandler = {
        let broker = broker.clone();
        Arc::new(move |request| {
            let broker = broker.clone();
            Box::pin(async move { broker.resolve_fail_closed(request).await })
        })
    };

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
            // 诊断日志（P1-4 write 兜底排查用，验收后移除）
            if let Ok(line) = serde_json::to_string(&batch) {
                use std::io::Write;
                if let Ok(mut f) = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open("/tmp/supercode-events.log")
                {
                    let _ = writeln!(f, "{line}");
                }
            }
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
    state
        .runs
        .lock()
        .await
        .insert(session_id.clone(), RunHandle { cancel });
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
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            run_prompt,
            cancel_run,
            read_text_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
