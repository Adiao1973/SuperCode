//! 进程管理器：以独立进程组 spawn agent 子进程，杀树干净、stderr 全量落日志。
//! 接口与行为约定见 docs/architecture.md §4.5 / §7。

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

use command_group::{AsyncCommandGroup, AsyncGroupChild};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

use crate::error::{CoreError, Result};

/// 进程管理器分配的句柄 id（区别于 OS pid，避免 pid 复用歧义）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ProcessId(u64);

/// spawn 一个子进程所需的最小描述（AgentRegistry 的 SpawnSpec 转换为它）。
#[derive(Debug, Clone)]
pub struct ProcessSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub envs: Vec<(String, String)>,
}

/// spawn 成功后交给调用方的句柄：stdin/stdout 由调用方持有（协议通道），
/// stderr 已由管理器接管写入日志文件。
#[derive(Debug)]
pub struct SpawnedProcess {
    pub id: ProcessId,
    pub pid: u32,
    pub log_path: PathBuf,
    pub stdin: ChildStdin,
    pub stdout: ChildStdout,
}

struct ManagedProcess {
    child: AsyncGroupChild,
}

/// 进程管理器：所有 agent 子进程的唯一出入口；宿主退出时调用 `shutdown_all` 清理。
pub struct ProcessManager {
    log_dir: PathBuf,
    next_id: AtomicU64,
    procs: Mutex<HashMap<ProcessId, ManagedProcess>>,
}

impl ProcessManager {
    pub fn new(log_dir: impl Into<PathBuf>) -> Self {
        Self {
            log_dir: log_dir.into(),
            next_id: AtomicU64::new(1),
            procs: Mutex::new(HashMap::new()),
        }
    }

    /// 以独立进程组 spawn；stderr 由后台任务逐行泵入 `<log_dir>/proc-<id>.log`。
    pub async fn spawn(&self, spec: ProcessSpec) -> Result<SpawnedProcess> {
        tokio::fs::create_dir_all(&self.log_dir).await?;
        let id = ProcessId(self.next_id.fetch_add(1, Ordering::Relaxed));
        let log_path = self.log_dir.join(format!("proc-{}.log", id.0));

        let mut cmd = Command::new(&spec.program);
        cmd.args(&spec.args)
            .envs(spec.envs)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(cwd) = spec.cwd {
            cmd.current_dir(cwd);
        }

        let mut child = cmd
            .group_spawn()
            .map_err(|e| CoreError::Spawn(format!("{}: {e}", spec.program)))?;

        let stderr = child.inner().stderr.take().expect("stderr 已设置为 piped");
        let stderr_log = log_path.clone();
        tokio::spawn(async move {
            let mut writer = tokio::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&stderr_log)
                .await?;
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) => break,
                    Ok(_) => {
                        // 不做输出缓冲：stderr 行级实时落盘，便于排障时 tail
                        if writer.write_all(line.as_bytes()).await.is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            Ok::<(), std::io::Error>(())
        });

        let pid = child.id().expect("刚 spawn 的进程必然有 pid");
        let stdin = child.inner().stdin.take().expect("stdin 已设置为 piped");
        let stdout = child.inner().stdout.take().expect("stdout 已设置为 piped");

        self.procs.lock().await.insert(id, ManagedProcess { child });

        Ok(SpawnedProcess {
            id,
            pid,
            log_path,
            stdin,
            stdout,
        })
    }

    /// 杀掉整个进程组（孙进程一并终止）；进程已自然退出视为成功。
    pub async fn kill(&self, id: ProcessId) -> Result<()> {
        let mut guard = self.procs.lock().await;
        let Some(proc_) = guard.get_mut(&id) else {
            return Err(CoreError::ProcessNotFound(id.0));
        };
        if proc_.child.kill().await.is_err() {
            // kill 失败通常意味着进程已退出；以 wait 确认终态，能取到终态即视为成功
            let _ = proc_.child.wait().await?;
        }
        Ok(())
    }

    /// 等待退出并移除登记。
    pub async fn wait(&self, id: ProcessId) -> Result<ExitStatus> {
        let mut proc_ = self
            .procs
            .lock()
            .await
            .remove(&id)
            .ok_or(CoreError::ProcessNotFound(id.0))?;
        Ok(proc_.child.wait().await?)
    }

    /// 宿主退出清理：对所有存活进程组发终止信号，返回处理数量。
    pub async fn shutdown_all(&self) -> Result<usize> {
        let mut guard = self.procs.lock().await;
        let mut killed = 0;
        for proc_ in guard.values_mut() {
            let _ = proc_.child.kill().await;
            killed += 1;
        }
        Ok(killed)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::Duration;

    fn spec(program: &str, args: Vec<&str>) -> ProcessSpec {
        ProcessSpec {
            program: program.to_string(),
            args: args.into_iter().map(String::from).collect(),
            cwd: None,
            envs: Vec::new(),
        }
    }

    fn log_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("supercode-p0-2-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    async fn process_exists(pattern: &str) -> bool {
        tokio::process::Command::new("pgrep")
            .args(["-f", pattern])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .is_ok_and(|s| s.success())
    }

    async fn assert_eventually_gone(pattern: &str) {
        for _ in 0..40 {
            if !process_exists(pattern).await {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("进程在 2s 后仍存活: {pattern}");
    }

    /// 验收标准：kill 后孙进程一并退出，pgrep 无残留
    #[tokio::test]
    async fn kill_终止整个进程组含孙进程() {
        let mgr = ProcessManager::new(log_dir("kill"));
        // bash（子进程）派生两个 sleep（孙进程）；若只杀 leader，孙进程会残留
        let p = mgr
            .spawn(spec("bash", vec!["-c", "sleep 986111 & sleep 986112"]))
            .await
            .expect("spawn 应成功");
        assert!(p.pid > 0);

        // 等孙进程真正跑起来，避免 kill 抢跑
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(process_exists("sleep 986111").await, "孙进程应已启动");

        mgr.kill(p.id).await.expect("kill 应成功");
        assert_eventually_gone("sleep 986111").await;
        assert_eventually_gone("sleep 986112").await;

        let status = mgr.wait(p.id).await.expect("wait 应成功");
        assert!(!status.success(), "被 kill 的进程不应以成功码退出");
    }

    /// 验收标准：stderr 全量写入日志文件（存在且非空）
    #[tokio::test]
    async fn stderr_全量写入日志文件() {
        let mgr = ProcessManager::new(log_dir("stderr"));
        let p = mgr
            .spawn(spec(
                "bash",
                vec!["-c", "echo supercode-p0-2-stderr-marker >&2; sleep 986113"],
            ))
            .await
            .expect("spawn 应成功");

        // 轮询等待后台泵任务把 marker 写入日志（≤2s）
        let mut found = false;
        for _ in 0..40 {
            if let Ok(content) = tokio::fs::read_to_string(&p.log_path).await
                && content.contains("supercode-p0-2-stderr-marker")
            {
                found = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            found,
            "日志文件应包含 stderr marker: {}",
            p.log_path.display()
        );

        mgr.kill(p.id).await.expect("kill 应成功");
        let _ = mgr.wait(p.id).await;
        assert_eventually_gone("sleep 986113").await;
    }

    #[tokio::test]
    async fn kill_未知句柄返回错误() {
        let mgr = ProcessManager::new(log_dir("notfound"));
        let err = mgr.kill(ProcessId(999)).await;
        assert!(matches!(err, Err(CoreError::ProcessNotFound(999))));
    }

    #[tokio::test]
    async fn spawn_不存在的程序返回spawn错误() {
        let mgr = ProcessManager::new(log_dir("spawnfail"));
        let err = mgr
            .spawn(spec("supercode-missing-binary-986114", vec![]))
            .await;
        assert!(matches!(err, Err(CoreError::Spawn(_))));
    }
}
