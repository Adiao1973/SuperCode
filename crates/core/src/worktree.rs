//! 托管任务 worktree；仅移除带有效记录、无引用且干净的目录。
use crate::error::{CoreError, Result};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
use tokio::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskWorktree {
    pub task_id: String,
    pub workspace_id: String,
    pub project: PathBuf,
    pub path: PathBuf,
    pub branch: String,
}
#[derive(Debug, Default, Serialize)]
pub struct CleanupReport {
    pub removed: Vec<String>,
    pub skipped: Vec<String>,
}
fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::Protocol(message.into())
}
async fn git(project: &Path, args: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .current_dir(project)
        .args(args)
        .output()
        .await?;
    if !output.status.success() {
        return Err(invalid(format!(
            "Git 操作失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim_end().into())
}
async fn root(project: &Path) -> Result<(PathBuf, PathBuf)> {
    let project = tokio::fs::canonicalize(project).await?;
    let top = git(&project, &["rev-parse", "--show-toplevel"]).await?;
    if tokio::fs::canonicalize(top).await? != project {
        return Err(invalid("项目空间必须绑定 Git 工作区根目录"));
    }
    let common = git(
        &project,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )
    .await?;
    let common = tokio::fs::canonicalize(common).await?;
    Ok((project, common.join("supercode-worktrees")))
}
fn names(root: &Path, task: &str) -> Result<(PathBuf, PathBuf, String)> {
    let task = uuid::Uuid::parse_str(task)
        .map_err(|_| invalid("非法任务 UUID"))?
        .to_string();
    Ok((
        root.join(&task),
        root.join(format!("{task}.json")),
        format!("supercode/task-{task}"),
    ))
}
async fn includes(project: &Path) -> Result<Vec<PathBuf>> {
    let include = project.join(".worktreeinclude");
    let content = match tokio::fs::read_to_string(&include).await {
        Ok(value) => value,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.into()),
    };
    if tokio::fs::symlink_metadata(&include)
        .await?
        .file_type()
        .is_symlink()
    {
        return Err(invalid(".worktreeinclude 不允许符号链接"));
    }
    let mut paths = Vec::new();
    for line in content
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
    {
        let relative = PathBuf::from(line);
        if !relative.components().all(|c| matches!(c, Component::Normal(v) if !v.to_string_lossy().eq_ignore_ascii_case(".git"))) {
            return Err(invalid(".worktreeinclude 只允许项目内相对文件路径，不允许 .. 或 .git"));
        }
        let mut source = project.to_path_buf();
        for component in relative.components() {
            source.push(component);
            if tokio::fs::symlink_metadata(&source)
                .await?
                .file_type()
                .is_symlink()
            {
                return Err(invalid(".worktreeinclude 不允许符号链接"));
            }
        }
        if !tokio::fs::metadata(&source).await?.is_file() {
            return Err(invalid(".worktreeinclude 条目必须是普通文件"));
        }
        let tracked = git(project, &["ls-files", "--", line]).await?;
        if !tracked.is_empty() {
            return Err(invalid(
                ".worktreeinclude 不应复制 Git 跟踪文件；它们由 HEAD 创建",
            ));
        }
        paths.push(relative);
    }
    Ok(paths)
}
impl TaskWorktree {
    pub async fn create(project: &Path, workspace: &str, task: &str) -> Result<Self> {
        let (project, root) = root(project).await?;
        let (path, record, branch) = names(&root, task)?;
        if record.exists() {
            let existing = Self::read(&project, &root, &record).await?;
            if existing.workspace_id != workspace || !existing.path.is_dir() {
                return Err(invalid("已有 worktree 的空间或目录不匹配"));
            }
            existing.validate_git().await?;
            return Ok(existing);
        }
        let files = includes(&project).await?;
        tokio::fs::create_dir_all(&root).await?;
        git(
            &project,
            &[
                "worktree",
                "add",
                "-b",
                &branch,
                &path.to_string_lossy(),
                "HEAD",
            ],
        )
        .await?;
        let entry = Self {
            task_id: task.into(),
            workspace_id: workspace.into(),
            project,
            path,
            branch,
        };
        let saved = async {
            for file in files {
                let destination = entry.path.join(&file);
                if destination.exists() {
                    return Err(invalid("include 目标已存在"));
                }
                tokio::fs::create_dir_all(destination.parent().unwrap()).await?;
                tokio::fs::copy(entry.project.join(file), destination).await?;
            }
            let json = serde_json::to_vec_pretty(&entry).map_err(|e| invalid(e.to_string()))?;
            let temporary = record.with_extension("json.tmp");
            tokio::fs::write(&temporary, json).await?;
            tokio::fs::rename(temporary, &record).await?;
            Ok::<(), CoreError>(())
        }
        .await;
        if let Err(error) = saved {
            // 回滚仅限刚创建、尚未向用户暴露的目录和分支。
            let rollback = git(
                &entry.project,
                &[
                    "worktree",
                    "remove",
                    "--force",
                    &entry.path.to_string_lossy(),
                ],
            )
            .await;
            if rollback.is_ok() {
                let _ = git(&entry.project, &["branch", "-D", &entry.branch]).await;
            }
            let _ = tokio::fs::remove_file(record).await;
            return Err(error);
        }
        Ok(entry)
    }
    async fn read(project: &Path, root: &Path, record: &Path) -> Result<Self> {
        let entry: Self = serde_json::from_slice(&tokio::fs::read(record).await?)
            .map_err(|e| invalid(e.to_string()))?;
        let (path, expected, branch) = names(root, &entry.task_id)?;
        if entry.project != project
            || entry.path != path
            || entry.branch != branch
            || expected != record
        {
            return Err(invalid("托管 worktree 记录校验失败"));
        }
        Ok(entry)
    }
    pub async fn validate_git(&self) -> Result<()> {
        if tokio::fs::symlink_metadata(&self.path)
            .await?
            .file_type()
            .is_symlink()
        {
            return Err(invalid("托管目录不能是符号链接"));
        }
        let (project, _) = root(&self.project).await?;
        let common = git(
            &project,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )
        .await?;
        let actual = git(
            &self.path,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )
        .await?;
        if actual != common || git(&self.path, &["branch", "--show-current"]).await? != self.branch
        {
            return Err(invalid("托管目录已更换仓库或分支，停止操作"));
        }
        Ok(())
    }
    pub async fn list(project: &Path) -> Result<Vec<Self>> {
        let (project, root) = root(project).await?;
        let mut directory = match tokio::fs::read_dir(&root).await {
            Ok(value) => value,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Err(e) => return Err(e.into()),
        };
        let mut entries = Vec::new();
        while let Some(file) = directory.next_entry().await? {
            if file.path().extension().is_some_and(|ext| ext == "json") {
                entries.push(Self::read(&project, &root, &file.path()).await?);
            }
        }
        Ok(entries)
    }
    pub async fn cleanup(
        project: &Path,
        task_ids: &[String],
        protected_cwds: &[PathBuf],
    ) -> Result<CleanupReport> {
        let (_, root) = root(project).await?;
        let mut protected = Vec::new();
        for cwd in protected_cwds {
            protected.push(
                tokio::fs::canonicalize(cwd)
                    .await
                    .unwrap_or_else(|_| cwd.clone()),
            );
        }
        let mut report = CleanupReport::default();
        for entry in Self::list(project).await? {
            if task_ids.contains(&entry.task_id) || protected.contains(&entry.path) {
                report
                    .skipped
                    .push(format!("{}：任务或会话仍引用", entry.task_id));
                continue;
            }
            if entry.path.exists() {
                if let Err(error) = entry.validate_git().await {
                    report.skipped.push(format!("{}：{error}", entry.task_id));
                    continue;
                }
                if !git(
                    &entry.path,
                    &[
                        "status",
                        "--porcelain",
                        "--untracked-files=all",
                        "--ignored",
                    ],
                )
                .await?
                .is_empty()
                {
                    report
                        .skipped
                        .push(format!("{}：含未提交或 ignored 文件，保留", entry.task_id));
                    continue;
                }
            }
            // 目录被外部删除时也注销对应 Git worktree，不做影响其他目录的全局 prune。
            git(
                &entry.project,
                &["worktree", "remove", &entry.path.to_string_lossy()],
            )
            .await?;
            let (_, record, _) = names(&root, &entry.task_id)?;
            tokio::fs::remove_file(record).await?;
            report.removed.push(entry.task_id);
        }
        Ok(report)
    }
}
#[cfg(test)]
mod tests;
