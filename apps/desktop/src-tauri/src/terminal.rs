//! P2-9: owned PTYs with bounded output, explicit teardown and child reaping.
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::Duration,
};
use tauri::ipc::Channel;

type Sink = Arc<dyn Fn(Output) -> bool + Send + Sync>;
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Output {
    Data { bytes: Vec<u8> },
    Exit { code: Option<u32> },
    Error { message: String },
}
struct Terminal {
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    #[cfg(unix)]
    session: Option<u32>,
    pid: Option<u32>,
    closed: AtomicBool,
    exited: AtomicBool,
    ack: mpsc::SyncSender<()>,
    done: Mutex<mpsc::Receiver<()>>,
}
#[derive(Clone, Default)]
pub struct Terminals(Arc<Mutex<HashMap<String, Arc<Terminal>>>>, Arc<AtomicBool>);
fn size(cols: u16, rows: u16) -> Result<PtySize, String> {
    if !(2..=500).contains(&cols) || !(1..=300).contains(&rows) {
        return Err("终端尺寸超出范围".into());
    }
    Ok(PtySize {
        cols,
        rows,
        pixel_width: 0,
        pixel_height: 0,
    })
}
fn directory(cwd: &str) -> Result<std::path::PathBuf, String> {
    let path = Path::new(cwd);
    if !path.is_absolute() || !path.is_dir() {
        return Err("终端目录必须是已存在的绝对目录".into());
    }
    path.canonicalize().map_err(|e| e.to_string())
}
impl Terminals {
    fn open(
        &self,
        id: String,
        cwd: String,
        cols: u16,
        rows: u16,
        sink: Sink,
    ) -> Result<(), String> {
        // Lock covers registration so close cannot race past an in-flight spawn.
        let mut entries = self.0.lock().unwrap();
        if self.1.load(Ordering::Acquire) {
            return Err("应用正在关闭".into());
        }
        if entries.contains_key(&id) {
            return Err("终端已打开".into());
        }
        let cwd = directory(&cwd)?;
        let pair = portable_pty::native_pty_system()
            .openpty(size(cols, rows)?)
            .map_err(|e| e.to_string())?;
        #[cfg(unix)]
        let raw_fd = pair.master.as_raw_fd();
        #[cfg(unix)]
        if let Some(fd) = raw_fd {
            // SAFETY: valid owned PTY fd. Nonblocking prevents read/close deadlocks on macOS.
            unsafe {
                let flags = libc::fcntl(fd, libc::F_GETFL);
                if flags < 0 || libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
                    return Err(std::io::Error::last_os_error().to_string());
                }
            }
        }
        #[cfg(unix)]
        let (reader, raw_fd): (Box<dyn Read + Send>, Option<i32>) = {
            use std::os::fd::FromRawFd;
            let fd = raw_fd.ok_or_else(|| "PTY 未提供原生句柄".to_string())?;
            // SAFETY: duplicate owned fd with close-on-exec; reader owns the duplicate.
            let duplicate = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
            if duplicate < 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            (
                Box::new(unsafe { std::fs::File::from_raw_fd(duplicate) }),
                Some(duplicate),
            )
        };
        #[cfg(not(unix))]
        let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        // Unit PTY contracts must not load personal shell plugins or write user history.
        #[cfg(test)]
        let shell = "/bin/sh";
        #[cfg(not(test))]
        let shell = std::env::var("SHELL")
            .unwrap_or_else(|_| if cfg!(windows) { "cmd.exe" } else { "/bin/sh" }.into());
        let mut command = CommandBuilder::new(shell);
        #[cfg(unix)]
        command.arg("-i");
        command.cwd(cwd);
        command.env("TERM", "xterm-256color");
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| e.to_string())?;
        drop(pair.slave);
        let (ack, ack_rx) = mpsc::sync_channel(1);
        let (done_tx, done) = mpsc::channel();
        let handle = Arc::new(Terminal {
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(writer)),
            killer: Mutex::new(child.clone_killer()),
            #[cfg(unix)]
            session: child.process_id().and_then(session_of),
            pid: child.process_id(),
            closed: AtomicBool::new(false),
            exited: AtomicBool::new(false),
            ack,
            done: Mutex::new(done),
        });
        entries.insert(id.clone(), handle.clone());
        let read_handle = handle.clone();
        let read_sink = sink.clone();
        let reader_thread = std::thread::spawn(move || {
            let mut reader = reader;
            let mut bytes = [0; 8192];
            while !read_handle.closed.load(Ordering::Acquire) {
                #[cfg(unix)]
                if let Some(fd) = raw_fd {
                    let mut descriptor = libc::pollfd {
                        fd,
                        events: libc::POLLIN,
                        revents: 0,
                    };
                    // SAFETY: fd is owned by reader throughout this thread.
                    let ready = unsafe { libc::poll(&mut descriptor, 1, 100) };
                    if ready == 0 {
                        continue;
                    }
                    if ready < 0 {
                        read_handle.stop();
                        break;
                    }
                }
                match reader.read(&mut bytes) {
                    Ok(0) => break,
                    Ok(n) => {
                        if !read_sink(Output::Data {
                            bytes: bytes[..n].to_vec(),
                        }) {
                            read_handle.stop();
                            break;
                        }
                        // At most one 8KiB chunk awaiting xterm consumption.
                        let deadline = std::time::Instant::now() + Duration::from_secs(10);
                        loop {
                            if read_handle.closed.load(Ordering::Acquire) {
                                break;
                            }
                            match ack_rx.recv_timeout(Duration::from_millis(100)) {
                                Ok(()) => break,
                                Err(_) if std::time::Instant::now() < deadline => continue,
                                Err(_) => {
                                    read_sink(Output::Error {
                                        message: "终端输出应答超时，已关闭进程".into(),
                                    });
                                    read_handle.stop();
                                    break;
                                }
                            }
                        }
                    }
                    #[cfg(unix)]
                    Err(e) if e.raw_os_error() == Some(libc::EIO) => break,
                    Err(e)
                        if e.kind() == std::io::ErrorKind::WouldBlock
                            || e.kind() == std::io::ErrorKind::Interrupted =>
                    {
                        continue
                    }
                    Err(e) => {
                        if !read_handle.closed.load(Ordering::Acquire) {
                            read_sink(Output::Error {
                                message: e.to_string(),
                            });
                            read_handle.stop();
                        }
                        break;
                    }
                }
            }
        });
        let registry = self.clone();
        std::thread::spawn(move || {
            // Poll under the kill lock: never signal a PID after reaping it.
            let code = loop {
                let guard = handle.killer.lock().unwrap();
                let result = child.try_wait();
                match result {
                    Ok(Some(status)) => {
                        handle.exited.store(true, Ordering::Release);
                        break Some(status.exit_code());
                    }
                    Err(_) => {
                        handle.exited.store(true, Ordering::Release);
                        break None;
                    }
                    Ok(None) => {}
                }
                drop(guard);
                std::thread::sleep(Duration::from_millis(20));
            };
            #[cfg(unix)]
            if let Some(session) = &handle.session {
                kill_session(session, handle.pid);
            }
            let _ = reader_thread.join();
            if !handle.closed.load(Ordering::Acquire) {
                sink(Output::Exit { code });
            }
            let mut entries = registry.0.lock().unwrap();
            if entries
                .get(&id)
                .is_some_and(|entry| Arc::ptr_eq(entry, &handle))
            {
                entries.remove(&id);
            }
            drop(entries);
            let _ = done_tx.send(());
        });
        Ok(())
    }
    fn get(&self, id: &str) -> Result<Arc<Terminal>, String> {
        self.0
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| "终端已关闭".into())
    }
    fn write(&self, id: &str, data: &str) -> Result<(), String> {
        if data.len() > 65536 {
            return Err("单次输入不能超过 64KiB".into());
        }
        let handle = self.get(id)?;
        let mut guard = handle.writer.lock().unwrap();
        let writer = guard.as_mut().ok_or_else(|| "终端已关闭".to_string())?;
        let mut bytes = data.as_bytes();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !bytes.is_empty() {
            if handle.closed.load(Ordering::Acquire) {
                return Err("终端已关闭".into());
            }
            match writer.write(bytes) {
                Ok(0) => return Err("终端输入已关闭".into()),
                Ok(n) => bytes = &bytes[n..],
                Err(e)
                    if e.kind() == std::io::ErrorKind::WouldBlock
                        || e.kind() == std::io::ErrorKind::Interrupted =>
                {
                    if std::time::Instant::now() >= deadline {
                        return Err("终端输入超时".into());
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(e) => return Err(e.to_string()),
            }
        }
        writer.flush().map_err(|e| e.to_string())
    }
    fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        self.get(id)?
            .master
            .lock()
            .unwrap()
            .as_ref()
            .ok_or_else(|| "终端已关闭".to_string())?
            .resize(size(cols, rows)?)
            .map_err(|e| e.to_string())
    }
    fn close(&self, id: &str) -> Result<(), String> {
        let handle = self.0.lock().unwrap().remove(id);
        if let Some(handle) = handle {
            handle.stop();
            handle
                .done
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(3))
                .map_err(|_| "终端进程回收超时".to_string())?;
        }
        Ok(())
    }
    pub fn close_all(&self) {
        self.1.store(true, Ordering::Release);
        let ids: Vec<_> = self.0.lock().unwrap().keys().cloned().collect();
        for id in ids {
            let _ = self.close(&id);
        }
    }
}
impl Terminal {
    fn stop(&self) {
        let mut killer = self.killer.lock().unwrap();
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        #[cfg(unix)]
        {
            if let Some(session) = &self.session {
                kill_session(
                    session,
                    self.exited
                        .load(Ordering::Acquire)
                        .then_some(self.pid)
                        .flatten(),
                );
            } else if let Some(pid) = self.pid {
                kill_descendants(pid);
            }
            if let Some(pid) = self.pid.filter(|_| !self.exited.load(Ordering::Acquire)) {
                // SAFETY: owned child is not reaped while this lock is held.
                unsafe {
                    libc::kill(pid as i32, libc::SIGKILL);
                }
            }
        }
        if !self.exited.load(Ordering::Acquire) {
            let _ = killer.kill();
        }
        let _ = self.ack.try_send(());
        self.writer.lock().unwrap().take();
        self.master.lock().unwrap().take();
    }
}
#[cfg(unix)]
fn session_of(pid: u32) -> Option<u32> {
    // SAFETY: read-only lookup; portable-pty established this child via setsid.
    let sid = unsafe { libc::getsid(pid as i32) };
    (sid == pid as i32).then_some(pid)
}
#[cfg(unix)]
fn kill_session(session: &u32, exclude: Option<u32>) {
    let Ok(output) = std::process::Command::new("/bin/ps")
        .args(["-axo", "pid="])
        .output()
    else {
        return;
    };
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if let Ok(pid) = line.trim().parse::<u32>() {
            // SAFETY: read-only lookup; only signal members of our owned setsid session.
            unsafe {
                if Some(pid) != exclude && libc::getsid(pid as i32) == *session as i32 {
                    libc::kill(pid as i32, libc::SIGKILL);
                }
            }
        }
    }
}
/// Kill only descendants of our owned shell, including jobs in separate process groups.
#[cfg(unix)]
fn kill_descendants(root: u32) {
    let Ok(output) = std::process::Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid="])
        .output()
    else {
        return;
    };
    let pairs: Vec<(u32, u32)> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut values = line.split_whitespace();
            Some((values.next()?.parse().ok()?, values.next()?.parse().ok()?))
        })
        .collect();
    let mut tree = vec![root];
    let mut i = 0;
    while i < tree.len() {
        let parent = tree[i];
        for &(pid, ppid) in &pairs {
            if ppid == parent && !tree.contains(&pid) {
                tree.push(pid);
            }
        }
        i += 1;
    }
    for pid in tree.into_iter().skip(1).rev() {
        // SAFETY: positive PID from the process table, restricted to this PTY's descendants.
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
    }
}
#[tauri::command]
pub async fn open_terminal(
    state: tauri::State<'_, Terminals>,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    on_output: Channel<Output>,
) -> Result<(), String> {
    let terminals = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        terminals.open(
            id,
            cwd,
            cols,
            rows,
            Arc::new(move |event| on_output.send(event).is_ok()),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn write_terminal(
    state: tauri::State<'_, Terminals>,
    id: String,
    data: String,
) -> Result<(), String> {
    let terminals = state.inner().clone();
    tokio::task::spawn_blocking(move || terminals.write(&id, &data))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn resize_terminal(
    state: tauri::State<'_, Terminals>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let terminals = state.inner().clone();
    tokio::task::spawn_blocking(move || terminals.resize(&id, cols, rows))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn ack_terminal(state: tauri::State<'_, Terminals>, id: String) {
    if let Ok(handle) = state.get(&id) {
        let _ = handle.ack.try_send(());
    }
}
#[tauri::command]
pub async fn close_terminal(state: tauri::State<'_, Terminals>, id: String) -> Result<(), String> {
    let terminals = state.inner().clone();
    tokio::task::spawn_blocking(move || terminals.close(&id))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::Instant;
    fn harness() -> (Terminals, mpsc::Receiver<Output>, Sink) {
        let terminals = Terminals::default();
        let (tx, rx) = mpsc::channel();
        let ack_registry = terminals.clone();
        let sink: Sink = Arc::new(move |event| {
            let is_data = matches!(event, Output::Data { .. });
            let ok = tx.send(event).is_ok();
            if is_data {
                if let Ok(handle) = ack_registry.get("test") {
                    let _ = handle.ack.try_send(());
                }
            }
            ok
        });
        (terminals, rx, sink)
    }
    fn until(rx: &mpsc::Receiver<Output>, marker: &str) -> String {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut result = Vec::new();
        while Instant::now() < deadline {
            if let Output::Data { bytes } = rx.recv_timeout(Duration::from_secs(2)).unwrap() {
                result.extend(bytes);
            }
            if String::from_utf8_lossy(&result).contains(marker) {
                return String::from_utf8_lossy(&result).into();
            }
        }
        panic!("PTY did not produce expected marker");
    }
    #[test]
    fn pty_io_resize_close_and_exit_reap_owned_jobs() {
        let (terminals, rx, sink) = harness();
        let root = std::env::temp_dir().join(format!("sc-p29-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        terminals
            .open(
                "test".into(),
                root.to_string_lossy().into(),
                80,
                24,
                sink.clone(),
            )
            .unwrap();
        let handle = terminals.get("test").unwrap();
        let pid = handle.pid.unwrap();
        assert_eq!(handle.session, Some(pid));
        terminals.resize("test", 100, 32).unwrap();
        // Disable echo so the command text cannot satisfy output assertions.
        terminals.write("test", "stty -echo\n").unwrap();
        terminals.write("test", "pwd; stty size; printf '\\344\\270\\255\\346\\226\\207\\n'; printf 'P29_%s\\n' READY\n").unwrap();
        let output = until(&rx, "P29_READY");
        assert!(output.contains(root.to_string_lossy().as_ref()));
        assert!(output.contains("32 100"));
        assert!(output.contains("中文"));
        assert!(terminals.resize("test", 0, 24).is_err());
        assert!(terminals.write("test", &"x".repeat(65537)).is_err());
        let child_file = root.join("child.pid");
        terminals
            .write(
                "test",
                &format!(
                    "sleep 120 & echo $! > '{}'; printf 'P29_%s\\n' CHILD\n",
                    child_file.display()
                ),
            )
            .unwrap();
        until(&rx, "P29_CHILD");
        let child: i32 = std::fs::read_to_string(child_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        terminals.close("test").unwrap();
        assert!(terminals.get("test").is_err());
        // Root was waited; child was killed. A short zombie lifetime is possible until init reaps it.
        assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
        let child_state = std::process::Command::new("/bin/ps")
            .args(["-p", &child.to_string(), "-o", "stat="])
            .output()
            .unwrap();
        let child_state = String::from_utf8_lossy(&child_state.stdout);
        assert!(child_state.trim().is_empty() || child_state.trim().starts_with('Z'));
        terminals.close("test").unwrap();
        terminals
            .open("test".into(), root.to_string_lossy().into(), 80, 24, sink)
            .unwrap();
        let exit_child = root.join("exit-child.pid");
        terminals
            .write(
                "test",
                &format!(
                    "exec /bin/sh -c 'trap \"\" HUP; sleep 120 & echo $! > {}; exit 7'\n",
                    exit_child.display()
                ),
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Output::Exit { code } = rx.recv_timeout(Duration::from_secs(2)).unwrap() {
                assert_eq!(code, Some(7));
                break;
            }
            assert!(Instant::now() < deadline);
        }
        // Exit notification can precede registry removal by a few instructions.
        terminals.close("test").unwrap();
        assert!(terminals.get("test").is_err());
        let child = std::fs::read_to_string(exit_child).unwrap();
        let state = std::process::Command::new("/bin/ps")
            .args(["-p", child.trim(), "-o", "stat="])
            .output()
            .unwrap();
        let state = String::from_utf8_lossy(&state.stdout);
        assert!(state.trim().is_empty() || state.trim().starts_with('Z'));
        terminals.close_all();
        assert!(terminals
            .open(
                "again".into(),
                root.to_string_lossy().into(),
                80,
                24,
                Arc::new(|_| true)
            )
            .is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn closing_unacknowledged_output_and_shutdown_during_start_do_not_leak() {
        let terminals = Terminals::default();
        let (tx, rx) = mpsc::channel();
        terminals
            .open(
                "blocked".into(),
                "/tmp".into(),
                80,
                24,
                Arc::new(move |event| tx.send(event).is_ok()),
            )
            .unwrap();
        let pid = terminals.get("blocked").unwrap().pid.unwrap();
        rx.recv_timeout(Duration::from_secs(5)).unwrap(); // Deliberately no ack.
        terminals.close("blocked").unwrap();
        assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
        let opener = terminals.clone();
        let started = std::thread::spawn(move || {
            opener.open("racing".into(), "/tmp".into(), 80, 24, Arc::new(|_| true))
        });
        terminals.close_all();
        let _ = started.join().unwrap(); // Either shutdown rejects spawn or owns and closes it.
        assert!(terminals.0.lock().unwrap().is_empty());
    }
    #[test]
    fn invalid_directory_does_not_spawn_or_create() {
        let (terminals, _, sink) = harness();
        let missing = std::env::temp_dir().join(format!("sc-p29-missing-{}", uuid::Uuid::new_v4()));
        for path in [
            "relative".into(),
            missing.to_string_lossy().into_owned(),
            "/bin/sh".into(),
        ] {
            assert!(terminals
                .open("test".into(), path, 80, 24, sink.clone())
                .is_err());
            assert!(terminals.get("test").is_err());
        }
        assert!(!missing.exists());
    }
}
