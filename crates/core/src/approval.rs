//! ApprovalBroker：所有 driver 的权限请求汇入统一待决队列，
//! 广播给订阅宿主（CLI 交互 / Phase 1 审批中心 UI），应答后回写。
//! fail-closed：链路异常一律不放行（docs/architecture.md §4.3）。

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{Mutex, broadcast, oneshot};
use uuid::Uuid;

use crate::driver::{PermissionDecision, PermissionRequest};
use crate::error::{CoreError, Result};

/// 进入待决队列的权限请求（带 broker 分配的关联 id）。
#[derive(Debug, Clone)]
pub struct PendingPermission {
    pub id: Uuid,
    pub request: PermissionRequest,
}

struct Waiting {
    /// 等待应答的请求：id → 回填通道
    entries: HashMap<Uuid, oneshot::Sender<PermissionDecision>>,
}

/// 审批代理。clone 友好（内部共享状态），CLI/桌面宿主持有一份传给 driver 即可。
#[derive(Clone)]
pub struct ApprovalBroker {
    waiting: Arc<Mutex<Waiting>>,
    /// 待决请求广播（审批中心 UI / CLI 宿主）；broadcast 自身线程安全，订阅无需加锁
    requests_tx: broadcast::Sender<PendingPermission>,
}

impl Default for ApprovalBroker {
    fn default() -> Self {
        Self::new()
    }
}

impl ApprovalBroker {
    pub fn new() -> Self {
        let (requests_tx, _) = broadcast::channel(64);
        Self {
            waiting: Arc::new(Mutex::new(Waiting {
                entries: HashMap::new(),
            })),
            requests_tx,
        }
    }

    /// driver 权限回调入口：登记待决、广播、挂起等待应答。
    /// P0-6 将在此前置规则引擎（命中 allow/deny 直接裁决）。
    pub async fn resolve(&self, request: PermissionRequest) -> Result<PermissionDecision> {
        let id = Uuid::new_v4();
        let (decision_tx, decision_rx) = oneshot::channel();

        {
            let mut waiting = self.waiting.lock().await;
            waiting.entries.insert(id, decision_tx);
            // 无订阅方不视为错误：请求留在待决表，driver 侧挂起等待——
            // 宿主必须先 subscribe 再开跑（见 architecture.md 宿主接入形态）
            let _ = self.requests_tx.send(PendingPermission {
                id,
                request: request.clone(),
            });
        }

        match decision_rx.await {
            Ok(decision) => Ok(decision),
            // 回填通道被丢弃（respond 之外的路径移除了登记）→ fail-closed
            Err(_) => Err(CoreError::PermissionFailed(format!(
                "审批回填通道关闭，按拒绝处理：{}",
                request.tool_name
            ))),
        }
    }

    /// 订阅待决请求（broadcast：审批中心 UI 与 CLI 宿主可并存）。
    pub fn subscribe(&self) -> broadcast::Receiver<PendingPermission> {
        self.requests_tx.subscribe()
    }

    /// 用户应答：回填等待中的 resolve。未知/已完成的 id 返回错误。
    pub async fn respond(&self, request_id: Uuid, decision: PermissionDecision) -> Result<()> {
        let mut waiting = self.waiting.lock().await;
        match waiting.entries.remove(&request_id) {
            Some(decision_tx) => {
                decision_tx
                    .send(decision)
                    .map_err(|_| CoreError::PermissionFailed("resolve 侧已放弃等待".into()))?;
                Ok(())
            }
            None => Err(CoreError::PermissionFailed(format!(
                "未知的审批请求 id: {request_id}"
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::driver::{PermissionOption, PermissionOptionKind};

    fn sample_request() -> PermissionRequest {
        PermissionRequest {
            session_id: "ses_1".into(),
            tool_call_id: "call_1".into(),
            tool_name: "bash — git status".into(),
            raw_input: Some(serde_json::json!({"command": "git status"})),
            options: vec![
                PermissionOption {
                    option_id: "allow-once".into(),
                    name: "允许".into(),
                    kind: PermissionOptionKind::AllowOnce,
                },
                PermissionOption {
                    option_id: "reject-once".into(),
                    name: "拒绝".into(),
                    kind: PermissionOptionKind::RejectOnce,
                },
            ],
        }
    }

    fn decision(option_id: &str) -> PermissionDecision {
        PermissionDecision {
            option_id: option_id.into(),
            updated_input: None,
        }
    }

    /// 验收：resolve 广播待决请求，respond 回填后 resolve 返回用户裁决
    #[tokio::test]
    async fn resolve与respond构成审批闭环() {
        let broker = ApprovalBroker::new();
        let mut requests = broker.subscribe();

        let resolver = tokio::spawn({
            let broker = broker.clone();
            async move { broker.resolve(sample_request()).await }
        });

        let pending = tokio::time::timeout(std::time::Duration::from_secs(2), requests.recv())
            .await
            .expect("应收到待决请求")
            .expect("broker 不应已关闭");
        assert_eq!(pending.request.tool_name, "bash — git status");

        broker
            .respond(pending.id, decision("allow-once"))
            .await
            .unwrap();
        let resolved = resolver.await.unwrap().unwrap();
        assert_eq!(resolved.option_id, "allow-once");
    }

    #[tokio::test]
    async fn respond未知id返回错误() {
        let broker = ApprovalBroker::new();
        let err = broker
            .respond(Uuid::new_v4(), decision("allow-once"))
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::PermissionFailed(_)));
    }

    /// fail-closed：respond 只能回填一次，重复 respond 报错且不影响已完成的裁决
    #[tokio::test]
    async fn 同一请求只能应答一次() {
        let broker = ApprovalBroker::new();
        let mut requests = broker.subscribe();

        let resolver = tokio::spawn({
            let broker = broker.clone();
            async move { broker.resolve(sample_request()).await }
        });
        let pending = requests.recv().await.unwrap();

        broker
            .respond(pending.id, decision("reject-once"))
            .await
            .unwrap();
        assert!(
            broker
                .respond(pending.id, decision("allow-once"))
                .await
                .is_err()
        );

        let resolved = resolver.await.unwrap().unwrap();
        assert_eq!(resolved.option_id, "reject-once");
    }
}
