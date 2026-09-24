//! supercode — SuperCode 的 CLI 宿主（Phase 0 原型）。
//!
//! `supercode detect` 探测本机 agent；`supercode run "任务" --cwd .` 经 ACP
//! 驱动本机 opencode：事件流式打印、权限请求终端 y/n 应答。

use std::io::Write as _;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use clap::{Parser, Subcommand};
use futures::future::BoxFuture;
use tokio::sync::mpsc;

use supercode_core::driver::{
    AcpDriver, PermissionDecision, PermissionHandler, PermissionOptionKind, PermissionRequest,
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
        /// 会话工作目录（默认当前目录）
        #[arg(long)]
        cwd: Option<PathBuf>,
    },
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Detect => cmd_detect().await,
        Cmd::Run { prompt, cwd } => cmd_run(prompt, cwd).await,
    }
}

async fn cmd_detect() -> ExitCode {
    for def in registry::builtin() {
        match def.detect_version().await {
            Some(version) => println!("{} {version} ✓", def.display_name),
            None => println!("{} 未安装 ✗（{}）", def.display_name, def.command),
        }
    }
    ExitCode::SUCCESS
}

async fn cmd_run(prompt: String, cwd: Option<PathBuf>) -> ExitCode {
    let def = registry::AgentDefinition::find("opencode").expect("内置注册表必有 opencode");
    if let Some(version) = def.detect_version().await {
        eprintln!("· agent: {} {version}", def.display_name);
    } else {
        eprintln!("未检测到 opencode，请先安装（https://opencode.ai/docs）");
        return ExitCode::from(2);
    }

    let cwd = match cwd {
        Some(dir) => dir,
        None => std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")),
    };
    eprintln!("· cwd: {}", cwd.display());

    let (events_tx, mut events_rx) = mpsc::channel::<AgentEvent>(256);
    let printer = tokio::spawn(async move {
        while let Some(event) = events_rx.recv().await {
            print_event(&event);
        }
    });

    let driver = AcpDriver::new(def.command);
    let stop_reason = driver
        .run_prompt(cwd, prompt, events_tx.clone(), interactive_permissions())
        .await;

    drop(events_tx);
    let _ = printer.await;

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

/// 终端交互审批：y=允许一次 / a=总是允许 / n=拒绝。其余输入按拒绝处理（保守默认）。
fn interactive_permissions() -> PermissionHandler {
    Arc::new(
        |request: PermissionRequest| -> BoxFuture<'_, supercode_core::error::Result<PermissionDecision>> {
            Box::pin(async move {
                eprintln!();
                eprintln!("⚡ 权限请求: {}", request.tool_name);
                if let Some(input) = &request.raw_input {
                    eprintln!("   输入: {input}");
                }
                for option in &request.options {
                    eprintln!("   - {} [{:?}]", option.name, option.kind);
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

                Ok(PermissionDecision {
                    option_id,
                    updated_input: None,
                })
            })
        },
    )
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
