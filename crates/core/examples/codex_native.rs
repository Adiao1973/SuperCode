//! P3-7 dedicated host. Does not modify registry, credentials, or product defaults.
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use supercode_core::{
    approval::{ApprovalBroker, PermissionMode},
    driver::{NativeDriver, PermissionDecision, StartMode},
    events::{AgentEvent, StopReason},
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let cwd = PathBuf::from(args.get(1).ok_or(
        "usage: codex_native <absolute cwd> <new|thread-id> <text|approve|deny|cancel> [prompt]",
    )?);
    let start = match args.get(2).map(String::as_str).unwrap_or("new") {
        "new" => StartMode::New,
        id => StartMode::Load(id.into()),
    };
    let mode = args
        .get(3)
        .map(String::as_str)
        .unwrap_or("text")
        .to_string();
    if !["text", "approve", "deny", "cancel"].contains(&mode.as_str()) {
        return Err("unknown mode".into());
    }
    let prompt=args.get(4).cloned().unwrap_or_else(||match mode.as_str(){"text"=>"Do not use tools or read/write files. Reply exactly P37-NATIVE.".into(),_=>"For this isolated integration test, use the shell tool to run exactly `printf P37-FILE > native-approval.txt` in the current working directory. Do not read or modify any other file. Do not use apply_patch. If permission is denied, do not retry or use another tool; reply P37-DENIED. If successful reply P37-WRITTEN.".into()});
    let broker = ApprovalBroker::new();
    let mut pending = broker.subscribe();
    let mut decisions = broker.subscribe_decisions();
    let answering = broker.clone();
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    let approvals = Arc::new(AtomicUsize::new(0));
    let received = approvals.clone();
    let expected_mode = mode.clone();
    let expected_cwd = cwd.clone();
    let allowed_cwd = cwd.clone();
    let task = tokio::spawn(async move {
        while let Ok(p) = pending.recv().await {
            received.fetch_add(1, Ordering::Relaxed);
            println!(
                "APPROVAL {} {}",
                p.request.kind.as_deref().unwrap_or("unknown"),
                p.request.tool_name
            );
            if mode == "cancel" {
                trigger.cancel();
                continue;
            }
            // Print every proposed command and only permit this exact disposable test operation.
            let command = p
                .request
                .raw_input
                .as_ref()
                .and_then(|r| r.get("command"))
                .and_then(serde_json::Value::as_str);
            let allowed = p
                .request
                .raw_input
                .as_ref()
                .and_then(|p| p.get("cwd"))
                .and_then(serde_json::Value::as_str)
                == allowed_cwd.to_str()
                && mode == "approve"
                && command.is_some_and(|c| {
                    [
                        "printf P37-FILE > native-approval.txt",
                        "/bin/zsh -lc 'printf P37-FILE > native-approval.txt'",
                        "/bin/bash -lc 'printf P37-FILE > native-approval.txt'",
                    ]
                    .contains(&c)
                });
            if mode == "deny" {
                answering.set_mode(PermissionMode::Plan);
            }
            let _ = answering
                .respond(
                    p.id,
                    PermissionDecision {
                        option_id: if allowed { "accept" } else { "decline" }.into(),
                        updated_input: None,
                    },
                )
                .await;
        }
    });
    let (tx, mut rx) = mpsc::channel(256);
    let output = tokio::spawn(async move {
        let mut terminal = None;
        while let Some(event) = rx.recv().await {
            if let AgentEvent::TurnCompleted { stop_reason } = &event {
                terminal = Some(*stop_reason);
            }
            println!("{}", serde_json::to_string(&event).unwrap());
        }
        terminal
    });
    let driver = if let Ok(model) = std::env::var("SUPERCODE_NATIVE_TEST_MODEL") {
        NativeDriver::new(
            "codex",
            vec![
                "-c".into(),
                format!("model={}", serde_json::to_string(&model)?),
                "app-server".into(),
                "--listen".into(),
                "stdio://".into(),
            ],
        )
    } else {
        NativeDriver::default()
    };
    let result = tokio::time::timeout(
        Duration::from_secs(120),
        driver.run_with_broker(cwd, start, prompt, tx, broker.clone(), cancel.clone()),
    )
    .await;
    if result.is_err() {
        cancel.cancel();
        broker.reject_all_pending().await;
    }
    task.abort();
    let _ = task.await;
    let stop = output.await?;
    while let Ok(record) = decisions.try_recv() {
        println!("DECISION {}", record.decision.option_id);
    }
    result??;
    if expected_mode != "text" && approvals.load(Ordering::Relaxed) == 0 {
        return Err("no real approval observed".into());
    }
    if expected_mode == "cancel" && stop != Some(StopReason::Cancelled) {
        return Err("cancellation was not observed".into());
    }
    if expected_mode == "approve"
        && std::fs::read(expected_cwd.join("native-approval.txt"))? != b"P37-FILE"
    {
        return Err("unexpected test file content".into());
    }
    if matches!(expected_mode.as_str(), "deny" | "cancel")
        && expected_cwd.join("native-approval.txt").exists()
    {
        return Err("rejected test operation produced a file".into());
    }

    if !matches!(stop, Some(StopReason::EndTurn | StopReason::Cancelled)) {
        return Err("missing terminal state".into());
    }
    Ok(())
}
