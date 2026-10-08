use std::{path::PathBuf, sync::Arc, time::Duration};
use supercode_core::{
    approval::{ApprovalBroker, PermissionMode},
    driver::{NativeDriver, PermissionDecision, PermissionHandler, StartMode},
    events::{AgentEvent, StopReason},
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
fn driver(mode: &str) -> NativeDriver {
    NativeDriver::new(
        "node",
        vec![
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/native-agent.mjs")
                .to_string_lossy()
                .into(),
            mode.into(),
        ],
    )
    .with_timeouts(Duration::from_secs(2), Duration::from_millis(150))
}
fn deny() -> PermissionHandler {
    Arc::new(|_| {
        Box::pin(async {
            Ok(PermissionDecision {
                option_id: "decline".into(),
                updated_input: None,
            })
        })
    })
}
async fn execute(
    mode: &str,
    start: StartMode,
) -> (supercode_core::error::Result<()>, Vec<AgentEvent>) {
    let (tx, mut rx) = mpsc::channel(64);
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        driver(mode).run(
            std::env::temp_dir(),
            start,
            "test".into(),
            tx,
            deny(),
            CancellationToken::new(),
        ),
    )
    .await
    .unwrap();
    let mut events = Vec::new();
    while let Some(e) = rx.recv().await {
        events.push(e);
    }
    (result, events)
}
#[tokio::test]
async fn native_handshake_run_resume_and_normalized_events() {
    for start in [StartMode::New, StartMode::Load("thread-native".into())] {
        let (r, e) = execute("ok", start).await;
        r.unwrap();
        assert_eq!(
            e.first(),
            Some(&AgentEvent::SessionStarted {
                session_id: "thread-native".into()
            })
        );
        assert_eq!(
            e.iter()
                .filter(|e| matches!(e, AgentEvent::MessageChunk { .. }))
                .count(),
            1
        );
        assert!(e.iter().any(|e| matches!(e, AgentEvent::ToolCall { .. })));
        assert!(
            e.iter()
                .any(|e| matches!(e, AgentEvent::ThoughtChunk { .. }))
        );
        assert_eq!(
            e.last(),
            Some(&AgentEvent::TurnCompleted {
                stop_reason: StopReason::EndTurn
            })
        );
    }
}
#[tokio::test]
async fn invalid_protocol_never_reports_success_or_echoes_remote_error() {
    for mode in [
        "eof",
        "bad",
        "oversize",
        "envelope",
        "foreign",
        "wrong-turn",
        "failed",
        "unknown",
        "init-fail",
        "init-hang",
        "load-mismatch",
    ] {
        let (r, e) = execute(
            mode,
            if mode == "load-mismatch" {
                StartMode::Load("thread-native".into())
            } else {
                StartMode::New
            },
        )
        .await;
        let error = r.unwrap_err().to_string();
        assert!(!error.contains("secret-fixture-error"));
        assert!(
            !e.iter().any(|e| matches!(
                e,
                AgentEvent::TurnCompleted {
                    stop_reason: StopReason::EndTurn
                }
            )),
            "{mode}"
        );
    }
}
#[tokio::test]
async fn interrupted_is_not_success() {
    let (r, e) = execute("interrupted", StartMode::New).await;
    r.unwrap();
    assert_eq!(
        e.last(),
        Some(&AgentEvent::TurnCompleted {
            stop_reason: StopReason::Cancelled
        })
    );
}
#[tokio::test]
async fn runtime_broker_change_applies_to_next_approval_with_distinct_request_identity() {
    let broker = ApprovalBroker::new();
    let mut pending = broker.subscribe();
    let answering = broker.clone();
    let answers = tokio::spawn(async move {
        let p = pending.recv().await.unwrap();
        answering.set_mode(PermissionMode::Plan);
        answering
            .respond(
                p.id,
                PermissionDecision {
                    option_id: "accept".into(),
                    updated_input: None,
                },
            )
            .await
            .unwrap();
    });
    let callback: PermissionHandler = {
        let b = broker.clone();
        Arc::new(move |r| {
            let b = b.clone();
            Box::pin(async move { b.resolve(r).await })
        })
    };
    let (tx, mut rx) = mpsc::channel(64);
    driver("approval")
        .run(
            std::env::temp_dir(),
            StartMode::New,
            "test".into(),
            tx,
            callback,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    answers.await.unwrap();
    let mut text = String::new();
    while let Some(e) = rx.recv().await {
        if let AgentEvent::MessageChunk { text: t, .. } = e {
            text.push_str(&t)
        }
    }
    assert_eq!(text, "acceptdecline");
}
#[tokio::test]
async fn cancellation_remains_responsive_while_approval_is_pending() {
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    let permissions: PermissionHandler = Arc::new(move |_| {
        trigger.cancel();
        Box::pin(std::future::pending())
    });
    let (tx, mut rx) = mpsc::channel(64);
    tokio::time::timeout(
        Duration::from_secs(5),
        driver("approval").run(
            std::env::temp_dir(),
            StartMode::New,
            "test".into(),
            tx,
            permissions,
            cancel,
        ),
    )
    .await
    .unwrap()
    .unwrap();
    let mut terminal = Vec::new();
    while let Some(e) = rx.recv().await {
        if let AgentEvent::TurnCompleted { stop_reason } = e {
            terminal.push(stop_reason)
        }
    }
    assert_eq!(terminal, vec![StopReason::Cancelled]);
}
#[tokio::test]
async fn forged_or_modified_approval_cannot_be_sent() {
    for decision in [
        PermissionDecision {
            option_id: "acceptForSession".into(),
            updated_input: None,
        },
        PermissionDecision {
            option_id: "accept".into(),
            updated_input: Some(serde_json::json!({"command":"other"})),
        },
    ] {
        let (tx, _rx) = mpsc::channel(64);
        let callback: PermissionHandler = Arc::new(move |_| {
            let d = decision.clone();
            Box::pin(async move { Ok(d) })
        });
        assert!(
            driver("bad-decision")
                .run(
                    std::env::temp_dir(),
                    StartMode::New,
                    "test".into(),
                    tx,
                    callback,
                    CancellationToken::new()
                )
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn owned_broker_pending_queue_is_empty_after_cancel() {
    let broker = ApprovalBroker::new();
    let mut pending = broker.subscribe();
    let mut decisions = broker.subscribe_decisions();
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    let answering = tokio::spawn(async move {
        pending.recv().await.unwrap();
        trigger.cancel();
    });
    let (tx, _rx) = mpsc::channel(64);
    driver("approval")
        .run_with_broker(
            std::env::temp_dir(),
            StartMode::New,
            "test".into(),
            tx,
            broker.clone(),
            cancel,
        )
        .await
        .unwrap();
    answering.await.unwrap();
    assert_eq!(broker.reject_all_pending().await, 0);
    assert_eq!(decisions.try_recv().unwrap().decision.option_id, "decline");
}
#[tokio::test]
async fn pre_cancel_and_stubborn_server_have_bounded_cleanup() {
    let token = CancellationToken::new();
    token.cancel();
    let (tx, mut rx) = mpsc::channel(64);
    NativeDriver::new("not-a-real-program", vec![])
        .run(
            std::env::temp_dir(),
            StartMode::New,
            "test".into(),
            tx,
            deny(),
            token,
        )
        .await
        .unwrap();
    assert!(matches!(
        rx.recv().await,
        Some(AgentEvent::TurnCompleted {
            stop_reason: StopReason::Cancelled
        })
    ));
    let token = CancellationToken::new();
    let cancel = token.clone();
    let (tx, mut rx) = mpsc::channel(64);
    let running = tokio::spawn(async move {
        driver("stubborn")
            .run(
                std::env::temp_dir(),
                StartMode::New,
                "test".into(),
                tx,
                deny(),
                token,
            )
            .await
    });
    rx.recv().await.unwrap();
    cancel.cancel();
    tokio::time::timeout(Duration::from_secs(3), running)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}
#[cfg(unix)]
#[tokio::test]
async fn dropping_run_reaps_owned_process_group_and_pending_broker() {
    let path = std::env::temp_dir().join(format!("sc-p37-pids-{}.json", uuid::Uuid::new_v4()));
    let d = NativeDriver::new(
        "node",
        vec![
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/native-agent.mjs")
                .to_string_lossy()
                .into(),
            "approval".into(),
            path.to_string_lossy().into(),
        ],
    );
    let broker = ApprovalBroker::new();
    let mut pending = broker.subscribe();
    let (tx, _rx) = mpsc::channel(64);
    let mut run = Box::pin(d.run_with_broker(
        std::env::temp_dir(),
        StartMode::New,
        "test".into(),
        tx,
        broker.clone(),
        CancellationToken::new(),
    ));
    tokio::select! {r=&mut run=>panic!("unexpected completion {r:?}"),_=pending.recv()=>{}}
    drop(run);
    let pids: Vec<u32> = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let mut alive = false;
            for pid in &pids {
                if tokio::process::Command::new("/bin/kill")
                    .args(["-0", &pid.to_string()])
                    .stderr(std::process::Stdio::null())
                    .status()
                    .await
                    .unwrap()
                    .success()
                {
                    alive = true;
                }
            }
            if !alive {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(broker.reject_all_pending().await, 0);
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn full_event_receiver_does_not_block_cancel_cleanup() {
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    let (tx, rx) = mpsc::channel(1);
    let task = tokio::spawn(async move {
        driver("ok")
            .run(
                std::env::temp_dir(),
                StartMode::New,
                "test".into(),
                tx,
                deny(),
                cancel,
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(3), async {
        while rx.is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    trigger.cancel();
    tokio::time::timeout(Duration::from_millis(800), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn empty_text_delta_is_valid_and_does_not_duplicate_completed_text() {
    let (r, e) = execute("empty-delta", StartMode::New).await;
    r.unwrap();
    let texts: Vec<_> = e
        .iter()
        .filter_map(|e| {
            if let AgentEvent::MessageChunk { text, .. } = e {
                Some(text.as_str())
            } else {
                None
            }
        })
        .collect();
    assert_eq!(texts, vec!["hello"]);
}
