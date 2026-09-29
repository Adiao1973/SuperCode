//! supercode — SuperCode 的 CLI 宿主（Phase 0 原型）。
//!
//! `supercode detect` 探测本机 agent；`supercode run "任务" --cwd .` 经 ACP 驱动
//! 本机 opencode（事件流打印、权限审批、Ctrl-C 取消、SQLite 落库）；
//! `supercode sessions list` 查看历史；`supercode resume <id> "继续"` 恢复会话。

use std::io::Write as _;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use clap::{Parser, Subcommand};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use supercode_core::approval::{ApprovalBroker, DecisionRecord, DecisionSource, PermissionRules};
use supercode_core::db::{SessionRecorder, Store};
use supercode_core::driver::{
    AcpDriver, PermissionDecision, PermissionHandler, PermissionOptionKind, PermissionRequest,
    StartMode,
};
use supercode_core::events::AgentEvent;
use supercode_core::registry;

#[derive(Parser)]
#[command(
    name = "supercode",
    version,
    about = "多 Agent 总控客户端（Phase 0 原型）"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// 探测本机已安装的 agent
    Detect,
    /// 运行一次性 agent 会话（默认 opencode）
    Run {
        /// 发给 agent 的任务提示词
        prompt: String,
        /// 注册表 agent id
        #[arg(long, default_value = "opencode")]
        agent: String,
        /// 会话工作目录（默认当前目录）
        #[arg(long)]
        cwd: Option<PathBuf>,
        /// 预授权放行规则（可重复），如 --allow 'bash(git status)' --allow 'bash(git diff *)'
        #[arg(long = "allow")]
        allows: Vec<String>,
        /// 预授权拒绝规则（可重复），优先级高于 allow
        #[arg(long = "deny")]
        denies: Vec<String>,
    },
    /// 查看历史会话（默认 list）
    Sessions {
        #[command(subcommand)]
        cmd: Option<SessionsCmd>,
    },
    /// 恢复既有会话并继续对话
    Resume {
        /// supercode sessions 列出的会话 id
        session_id: String,
        /// 追加的提示词
        prompt: String,
        /// 预授权放行规则（可重复）
        #[arg(long = "allow")]
        allows: Vec<String>,
        /// 预授权拒绝规则（可重复）
        #[arg(long = "deny")]
        denies: Vec<String>,
    },
}

#[derive(Subcommand)]
enum SessionsCmd {
    /// 列出最近会话
    List,
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Detect => cmd_detect().await,
        Cmd::Run {
            agent,
            prompt,
            cwd,
            allows,
            denies,
        } => run_session(Target::New { agent }, prompt, cwd, allows, denies).await,
        Cmd::Sessions { cmd } => cmd_sessions(cmd).await,
        Cmd::Resume {
            session_id,
            prompt,
            allows,
            denies,
        } => {
            let Ok(id) = Uuid::parse_str(&session_id) else {
                eprintln!("无效的会话 id（应为 UUID，见 supercode sessions list）: {session_id}");
                return ExitCode::from(2);
            };
            run_session(Target::Resume { id }, prompt, None, allows, denies).await
        }
    }
}

/// CLI 侧会话目标：新会话或恢复 SuperCode 侧 UUID 对应的会话。
enum Target {
    New { agent: String },
    Resume { id: Uuid },
}

async fn cmd_detect() -> ExitCode {
    let reg = registry::AgentRegistry::load();
    for (def, version) in reg.probe_installed().await {
        match version {
            Some(version) => println!("{} {version} ✓", def.display_name),
            None => println!("{} —（{}）", def.display_name, def.command),
        }
    }
    ExitCode::SUCCESS
}

async fn cmd_sessions(cmd: Option<SessionsCmd>) -> ExitCode {
    match cmd {
        None | Some(SessionsCmd::List) => {
            let store = match Store::open_default().await {
                Ok(store) => store,
                Err(err) => {
                    eprintln!("打开数据库失败: {err}");
                    return ExitCode::FAILURE;
                }
            };
            let sessions = match store.list_sessions().await {
                Ok(sessions) => sessions,
                Err(err) => {
                    eprintln!("查询会话失败: {err}");
                    return ExitCode::FAILURE;
                }
            };
            if sessions.is_empty() {
                println!("（暂无历史会话，用 supercode run 开始第一个）");
                return ExitCode::SUCCESS;
            }
            for s in sessions {
                println!(
                    "{}  {:<9} {:<24} {}",
                    s.id,
                    s.status,
                    truncate(&s.title, 24),
                    s.cwd
                );
            }
            ExitCode::SUCCESS
        }
    }
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        let cut: String = text.chars().take(max - 1).collect();
        format!("{cut}…")
    }
}

/// run / resume 共用的会话执行器：探测 → 建档 → ACP 全链路 → 事件入库 + 打印。
async fn run_session(
    target: Target,
    prompt: String,
    cwd: Option<PathBuf>,
    allows: Vec<String>,
    denies: Vec<String>,
) -> ExitCode {
    let store = match Store::open_default().await {
        Ok(store) => store,
        Err(err) => {
            eprintln!("打开数据库失败（可用 SUPERCODE_DB 覆盖路径）: {err}");
            return ExitCode::FAILURE;
        }
    };
    let existing = match &target {
        Target::Resume { id } => match store.get_session(*id).await {
            Ok(Some(row)) => Some(row),
            Ok(None) => {
                eprintln!("会话不存在: {id}");
                return ExitCode::from(2);
            }
            Err(err) => {
                eprintln!("读取会话失败: {err}");
                return ExitCode::FAILURE;
            }
        },
        Target::New { .. } => None,
    };
    let agent_id = match &target {
        Target::New { agent } => agent.as_str(),
        Target::Resume { .. } => &existing.as_ref().unwrap().agent_id,
    };
    let def = match registry::AgentDefinition::find(agent_id) {
        Ok(def) => def,
        Err(err) => {
            eprintln!("{err}");
            return ExitCode::from(2);
        }
    };
    if let Err(err) = supercode_core::orchestrator::validate_launch(
        &def,
        existing.as_ref(),
        existing.as_ref().map(|s| s.cwd.as_str()).unwrap_or(""),
    ) {
        eprintln!("{err}");
        return ExitCode::from(2);
    }
    let version = def.detect_version().await;
    eprintln!(
        "· agent: {} {}",
        def.display_name,
        version.as_deref().unwrap_or("版本未知")
    );
    if let Err(err) = store
        .upsert_agent(&def.id, &def.display_name, "acp", version.as_deref())
        .await
    {
        eprintln!("保存 agent 失败: {err}");
        return ExitCode::FAILURE;
    }

    // 会话档案：New 新建 UUID；Resume 从库中取 agent 侧会话 id 与原 cwd
    let (our_id, agent_session_id, cwd, title) = match &target {
        Target::New { .. } => {
            let cwd = cwd
                .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")));
            (Uuid::new_v4(), None, cwd, truncate(prompt.trim(), 60))
        }
        Target::Resume { id } => {
            let Some(row) = store.get_session(*id).await.ok().flatten() else {
                eprintln!("会话不存在: {id}");
                return ExitCode::from(2);
            };
            // 协议要求 cwd 与会话原 cwd 一致
            let cwd = PathBuf::from(row.cwd);
            let our_id = Uuid::parse_str(&row.id).unwrap_or(*id);
            (our_id, Some(row.agent_session_id), cwd, row.title)
        }
    };
    if matches!(target, Target::Resume { .. }) {
        eprintln!("· 恢复会话（历史将重放）…");
    }
    eprintln!("· cwd: {}", cwd.display());

    let (events_tx, mut events_rx) = mpsc::channel::<AgentEvent>(256);
    let recorder = SessionRecorder::new(
        store.clone(),
        our_id,
        &def.id,
        &cwd.to_string_lossy(),
        &title,
        // run 与 resume：本轮 prompt 都是一条新的用户消息
        prompt.trim(),
        // CLI 宿主暂无空间选择，会话归默认空间（ADR-0007）
        supercode_core::db::DEFAULT_WORKSPACE,
    );
    // 消费循环：先落库再打印（持久化失败不打断事件流）
    let printer = tokio::spawn(async move {
        let mut recorder = recorder;
        while let Some(event) = events_rx.recv().await {
            recorder.handle_event(&event).await;
            print_event(&event);
        }
    });

    // 审批代理：driver 的权限回调统一走 broker，终端审批任务消费待决队列
    let broker = ApprovalBroker::with_rules(PermissionRules::new(allows, denies));
    let mut requests = broker.subscribe();
    let mut decision_log = broker.subscribe_decisions();
    let approver = tokio::spawn({
        let broker = broker.clone();
        let store = store.clone();
        let session_id = our_id;
        async move {
            loop {
                tokio::select! {
                    Ok(pending) = requests.recv() => {
                        let decision = console_decide(&pending.request);
                        if broker.respond(pending.id, decision).await.is_err() {
                            break; // broker 链路异常（如请求已超时移除），退出审批任务
                        }
                    }
                    Ok(record) = decision_log.recv() => {
                        print_decision_record(&record);
                        let _ = store.insert_approval(session_id, &record).await;
                    }
                    else => break,
                }
            }
        }
    });
    let permissions: PermissionHandler = {
        let broker = broker.clone();
        Arc::new(move |request: PermissionRequest| {
            let broker = broker.clone();
            Box::pin(async move { broker.resolve(request).await })
        })
    };

    // 取消：第一次 Ctrl-C 走协议层取消，第二次强制退出（用户显式覆盖）
    let cancel = CancellationToken::new();
    tokio::spawn({
        let cancel = cancel.clone();
        async move {
            if tokio::signal::ctrl_c().await.is_ok() {
                eprintln!("\n· 收到 Ctrl-C，正在取消当前任务（再按一次强制退出）…");
                cancel.cancel();
                if tokio::signal::ctrl_c().await.is_ok() {
                    eprintln!("· 强制退出");
                    std::process::exit(130);
                }
            }
        }
    });

    let driver = AcpDriver::new(def.command).with_process_cwd(def.acp_process_cwd);
    let start = match agent_session_id {
        Some(agent_sid) => StartMode::Load(agent_sid),
        None => StartMode::New,
    };
    let stop_reason = driver
        .run(cwd, start, prompt, events_tx.clone(), permissions, cancel)
        .await;

    drop(events_tx);
    let _ = printer.await;
    approver.abort();

    match stop_reason {
        Ok(reason) => {
            println!("\n—— 轮次结束（run）: {reason:?} ——");
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("\n✗ driver 错误: {err}");
            ExitCode::FAILURE
        }
    }
}

/// 终端审批：打印待决请求（完整命令可见），y/a/n 交互裁决。
/// 其余输入按拒绝处理（保守默认）。
fn console_decide(request: &PermissionRequest) -> PermissionDecision {
    eprintln!();
    eprintln!("⚡ 权限请求: {}", request.tool_name);
    if let Some(input) = &request.raw_input {
        eprintln!("   输入: {input}");
    }

    eprint!("允许吗？(y=允许一次 / a=总是允许 / n=拒绝): ");
    let _ = std::io::stderr().flush();

    // CLI 单任务场景，阻塞读 stdin 等人即可
    let mut answer = String::new();
    let _ = std::io::stdin().read_line(&mut answer);
    let pick = |kind: PermissionOptionKind| {
        request
            .options
            .iter()
            .find(|option| option.kind == kind)
            .map(|option| option.option_id.clone())
    };
    let option_id = match answer.trim() {
        "y" | "Y" => pick(PermissionOptionKind::AllowOnce),
        "a" | "A" => pick(PermissionOptionKind::AllowAlways),
        _ => pick(PermissionOptionKind::RejectOnce)
            .or_else(|| pick(PermissionOptionKind::RejectAlways)),
    }
    .unwrap_or_default();

    PermissionDecision {
        option_id,
        updated_input: None,
    }
}

fn print_decision_record(record: &DecisionRecord) {
    match &record.source {
        DecisionSource::Rule { pattern, effect } => eprintln!(
            "· 预授权命中 [{:?}] {pattern} → {}",
            effect, record.decision.option_id
        ),
        DecisionSource::Mode { mode } => eprintln!(
            "· 权限模式 [{mode:?}] 兜底裁决 {} → {}",
            record.request.tool_name, record.decision.option_id
        ),
        DecisionSource::User => eprintln!(
            "· 用户裁决 {} → {}",
            record.request.tool_name, record.decision.option_id
        ),
    }
}

fn print_event(event: &AgentEvent) {
    match event {
        AgentEvent::SessionStarted { session_id } => {
            eprintln!("· session: {session_id}");
        }
        AgentEvent::MessageChunk { text, .. } => {
            print!("{text}");
            let _ = std::io::stdout().flush();
        }
        AgentEvent::ThoughtChunk { text, .. } => {
            eprint!("\x1b[2m{text}\x1b[0m");
            let _ = std::io::stderr().flush();
        }
        AgentEvent::ToolCall {
            tool_call_id,
            name,
            title,
            kind,
            ..
        } => {
            let label = name.as_deref().unwrap_or("tool");
            let title = title.as_deref().unwrap_or("");
            println!("\n🔧 [{kind:?}] {label} — {title} ({tool_call_id})");
        }
        AgentEvent::ToolCallUpdate {
            tool_call_id,
            status,
            ..
        } => {
            if let Some(status) = status {
                println!("   ↳ {tool_call_id}: {status:?}");
            }
        }
        AgentEvent::Plan { entries } => {
            println!("📋 计划:");
            for entry in entries {
                println!(
                    "   [{:?}] {}",
                    entry.status,
                    entry.content.replace('\n', " ")
                );
            }
        }
        AgentEvent::UsageUpdate { used, size, cost } => {
            if let (Some(used), Some(size)) = (used, size) {
                eprintln!(
                    "\x1b[2m· tokens: {used}/{size}{}\x1b[0m",
                    cost.map(|c| format!(" · ${c:.4}")).unwrap_or_default()
                );
            }
        }
        AgentEvent::TurnCompleted { stop_reason } => {
            println!("\n—— 轮次结束: {stop_reason:?} ——");
        }
        AgentEvent::DriverError { message } => {
            eprintln!("✗ driver: {message}");
        }
    }
}
