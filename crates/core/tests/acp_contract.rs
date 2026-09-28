//! ACP contract tests use the workspace's Node runtime and a local deterministic peer.
use std::{path::PathBuf, sync::Arc, time::Duration};
use supercode_core::{
    driver::{AcpDriver, PermissionDecision, PermissionHandler, StartMode},
    events::{AgentEvent, StopReason, ToolStatus},
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

async fn exercise(mode: StartMode, accept: bool, no_load: bool) -> (bool, Vec<AgentEvent>) {
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/acp-agent.mjs");
    let driver = AcpDriver::new(format!(
        "node '{}' {}",
        fixture.display(),
        if no_load { "no-load" } else { "" }
    ));
    let (tx, mut rx) = mpsc::channel(64);
    let permissions: PermissionHandler = Arc::new(move |request| {
        Box::pin(async move {
            assert_eq!(request.session_id, "claude-fixture-session");
            assert_eq!(request.kind.as_deref(), Some("edit"));
            assert_eq!(request.options.len(), 2);
            Ok(PermissionDecision {
                option_id: if accept { "accept" } else { "reject" }.into(),
                updated_input: None,
            })
        })
    });
    let result = tokio::time::timeout(
        Duration::from_secs(10),
        driver.run(
            std::env::temp_dir(),
            mode,
            "test".into(),
            tx,
            permissions,
            CancellationToken::new(),
        ),
    )
    .await
    .expect("ACP fixture timed out");
    let mut events = Vec::new();
    while let Some(event) = rx.recv().await {
        events.push(event);
    }
    (result.is_ok(), events)
}

#[tokio::test]
async fn acp_new_session_streams_tools_and_permission_decisions() {
    for accept in [true, false] {
        let (ok, events) = exercise(StartMode::New, accept, false).await;
        assert!(ok);
        assert!(matches!(
            events.first(),
            Some(AgentEvent::SessionStarted { .. })
        ));
        assert!(events.iter().any(
            |e| matches!(e, AgentEvent::ToolCallUpdate { status: Some(status), .. }
            if *status == if accept { ToolStatus::Completed } else { ToolStatus::Failed })
        ));
        assert!(events.iter().any(|e| matches!(e, AgentEvent::MessageChunk { text, .. } if text == if accept { "hi" } else { "denied" })));
        assert!(matches!(
            events.last(),
            Some(AgentEvent::TurnCompleted {
                stop_reason: StopReason::EndTurn
            })
        ));
    }
}

#[tokio::test]
async fn acp_load_replays_history_before_session_started() {
    let (ok, events) = exercise(
        StartMode::Load("claude-fixture-session".into()),
        true,
        false,
    )
    .await;
    assert!(ok);
    assert!(
        matches!(events.first(), Some(AgentEvent::MessageChunk { text, .. }) if text == "replayed history")
    );
    assert!(
        matches!(events.get(1), Some(AgentEvent::SessionStarted { session_id }) if session_id == "claude-fixture-session")
    );
}

#[tokio::test]
async fn acp_load_requires_negotiated_capability() {
    let (ok, events) = exercise(StartMode::Load("claude-fixture-session".into()), true, true).await;
    assert!(!ok);
    assert!(events.is_empty());
}
