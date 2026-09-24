//! supercode — SuperCode 的 CLI 宿主（Phase 0 原型）。
//!
//! Phase 0 目标：`supercode run "任务" --cwd .` 经 ACP 驱动本机 opencode，
//! 事件流式打印、权限请求终端应答、可取消与会话恢复（见 docs/roadmap.md）。
//! 当前为脚手架占位：仅 --version / 占位帮助。

use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--version") | Some("-V") => {
            println!(
                "supercode {} (core {})",
                env!("CARGO_PKG_VERSION"),
                supercode_core::VERSION
            );
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!(
                "supercode {} — Phase 0 原型脚手架",
                env!("CARGO_PKG_VERSION")
            );
            eprintln!("子命令（run/detect/sessions/resume）将在后续任务中实现，见 docs/roadmap.md");
            ExitCode::from(2)
        }
    }
}
