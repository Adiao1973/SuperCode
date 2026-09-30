use crate::AppState;
use std::path::PathBuf;
use supercode_core::{
    db::Store,
    worktree::{CleanupReport, TaskWorktree},
};
use tauri::Manager;

pub static GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
async fn project(store: &Store, workspace_id: &str) -> Result<PathBuf, String> {
    store
        .list_workspaces()
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|w| w.id == workspace_id && w.kind == "project")
        .and_then(|w| w.path)
        .map(PathBuf::from)
        .ok_or("隔离任务需要 Git 项目空间".into())
}
#[tauri::command]
pub async fn create_task_worktree(
    app: tauri::AppHandle,
    task_id: String,
) -> Result<TaskWorktree, String> {
    let _gate = GATE.lock().await;
    let state = app.state::<AppState>();
    let store = state.store().await;
    let task = store
        .get_task(&task_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("任务不存在")?;
    if task.session_id.is_some() {
        return Err("任务已绑定会话，请打开已有会话".into());
    }
    let path = project(store, &task.workspace_id).await?;
    TaskWorktree::create(&path, &task.workspace_id, &task.id)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn cleanup_task_worktrees(
    app: tauri::AppHandle,
    workspace_id: String,
) -> Result<CleanupReport, String> {
    let _gate = GATE.lock().await;
    let state = app.state::<AppState>();
    if !state.runs.lock().await.is_empty() {
        return Err("有会话正在运行，请结束后再清扫".into());
    }
    let store = state.store().await;
    let path = project(store, &workspace_id).await?;
    let tasks = store
        .list_tasks()
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|t| t.id)
        .collect::<Vec<_>>();
    let protected = store
        .list_sessions()
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|s| PathBuf::from(s.cwd))
        .collect::<Vec<_>>();
    TaskWorktree::cleanup(&path, &tasks, &protected)
        .await
        .map_err(|e| e.to_string())
}
pub async fn validate_task(
    store: &Store,
    task_id: &str,
    workspace_id: Option<&str>,
    cwd: &str,
    resume: Option<&str>,
) -> Result<(), String> {
    let task = store.get_task(task_id).await.map_err(|e| e.to_string())?;
    let Some(task) = task else {
        // 删除任务只解绑；已有会话仍按后续历史 agent/cwd 校验续聊，不能被旧草稿 task_id 阻断。
        if resume.is_some() {
            return Ok(());
        }
        return Err("任务不存在".into());
    };
    if workspace_id != Some(task.workspace_id.as_str()) {
        return Err("隔离会话必须归属原项目空间".into());
    }
    if task
        .session_id
        .as_deref()
        .is_some_and(|id| Some(id) != resume)
    {
        return Err("任务已绑定其他会话，请打开已有会话".into());
    }
    let project = project(store, &task.workspace_id).await?;
    let entry = TaskWorktree::list(&project)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|entry| entry.task_id == task_id)
        .ok_or("任务 worktree 不存在")?;
    entry.validate_git().await.map_err(|e| e.to_string())?;
    if tokio::fs::canonicalize(cwd)
        .await
        .map_err(|e| e.to_string())?
        != entry.path
    {
        return Err("任务会话必须使用其隔离目录".into());
    }
    Ok(())
}
