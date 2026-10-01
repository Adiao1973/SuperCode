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
// 看板空间是组织归属，已创建的隔离目录仍从原项目的记录恢复。
async fn find_existing(store: &Store, task_id: &str) -> Result<Option<TaskWorktree>, String> {
    let mut found: Option<TaskWorktree> = None;
    for workspace in store.list_workspaces().await.map_err(|e| e.to_string())? {
        let Some(path) = workspace.path.map(PathBuf::from) else {
            continue;
        };
        if !path.join(".git").exists() {
            continue;
        }
        for entry in TaskWorktree::list(&path).await.map_err(|e| e.to_string())? {
            if entry.task_id == task_id {
                if let Some(existing) = &found {
                    // 同一 Git common dir 的多个项目空间可能读到同一条托管记录。
                    if existing.path == entry.path {
                        continue;
                    }
                    return Err("任务有多个隔离目录，请先整理托管记录".into());
                }
                found = Some(entry);
            }
        }
    }
    Ok(found)
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
    if let Some(entry) = find_existing(store, &task_id).await? {
        entry.validate_git().await.map_err(|e| e.to_string())?;
        return Ok(entry);
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
    if task
        .session_id
        .as_deref()
        .is_some_and(|id| Some(id) != resume)
    {
        return Err("任务已绑定其他会话，请打开已有会话".into());
    }
    let entry = find_existing(store, task_id)
        .await?
        .ok_or("任务 worktree 不存在")?;
    if workspace_id != Some(entry.workspace_id.as_str()) {
        return Err("隔离会话必须归属原项目空间".into());
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn moved_isolated_task_keeps_original_execution_owner() {
        let root = std::env::temp_dir().join(format!("sc-p28-host-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&root).await.unwrap();
        for args in [
            vec!["init"],
            vec![
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "--allow-empty",
                "-m",
                "initial",
            ],
        ] {
            assert!(tokio::process::Command::new("git")
                .current_dir(&root)
                .args(args)
                .output()
                .await
                .unwrap()
                .status
                .success());
        }
        let store = Store::open_in_memory().await.unwrap();
        let workspace = store
            .create_workspace(&root.to_string_lossy())
            .await
            .unwrap();
        let task = store
            .create_task(&workspace.id, "isolated move")
            .await
            .unwrap();
        let entry = TaskWorktree::create(&root, &workspace.id, &task.id)
            .await
            .unwrap();
        let linked = root.join("linked-project");
        assert!(tokio::process::Command::new("git")
            .current_dir(&root)
            .args(["worktree", "add", "--detach", &linked.to_string_lossy()])
            .output()
            .await
            .unwrap()
            .status
            .success());
        store
            .create_workspace(&linked.to_string_lossy())
            .await
            .unwrap();
        store
            .move_task(&task.id, "default", "review")
            .await
            .unwrap();
        let found = find_existing(&store, &task.id).await.unwrap().unwrap();
        assert_eq!(found.path, entry.path);
        assert_eq!(found.workspace_id, workspace.id);
        assert!(validate_task(
            &store,
            &task.id,
            Some(&workspace.id),
            &entry.path.to_string_lossy(),
            None
        )
        .await
        .is_ok());
        assert!(validate_task(
            &store,
            &task.id,
            Some("default"),
            &entry.path.to_string_lossy(),
            None
        )
        .await
        .is_err());
        tokio::process::Command::new("git")
            .current_dir(&root)
            .args(["worktree", "remove", &entry.path.to_string_lossy()])
            .output()
            .await
            .unwrap();
        assert!(tokio::process::Command::new("git")
            .current_dir(&root)
            .args(["worktree", "remove", &linked.to_string_lossy()])
            .output()
            .await
            .unwrap()
            .status
            .success());
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}
