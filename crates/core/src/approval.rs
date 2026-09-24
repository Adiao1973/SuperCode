//! ApprovalBroker：所有 driver 的权限请求先经预授权规则引擎，
//! 未命中的进入待决队列广播给宿主（CLI 交互 / Phase 1 审批中心 UI），应答后回写。
//! fail-closed：链路异常一律不放行（docs/architecture.md §4.3）。

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{Mutex, broadcast, oneshot};
use uuid::Uuid;

use crate::driver::{PermissionDecision, PermissionOptionKind, PermissionRequest};
use crate::error::{CoreError, Result};

/// 进入待决队列的权限请求（带 broker 分配的关联 id）。
#[derive(Debug, Clone)]
pub struct PendingPermission {
    pub id: Uuid,
    pub request: PermissionRequest,
}

/// 裁决来源：预授权规则（带命中模式与效果）或用户。
#[derive(Debug, Clone, PartialEq)]
pub enum DecisionSource {
    Rule { pattern: String, effect: RuleEffect },
    User,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleEffect {
    Allow,
    Deny,
}

/// 裁决留痕记录（`subscribe_decisions()` 广播；SQLite 持久化在 P0-8 落地）。
#[derive(Debug, Clone)]
pub struct DecisionRecord {
    pub request: PermissionRequest,
    pub source: DecisionSource,
    pub decision: PermissionDecision,
}

/// 预授权规则集（deny > allow > ask，全不命中 → 询问）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PermissionRules {
    pub allow: Vec<String>,
    pub deny: Vec<String>,
}

impl PermissionRules {
    pub fn new(allow: Vec<String>, deny: Vec<String>) -> Self {
        Self { allow, deny }
    }

    /// 求值：返回首个命中的 deny/allow；None = 询问（进入待决队列）。
    /// deny 优先于 allow（保守：冲突时拒绝）。
    pub fn evaluate(&self, request: &PermissionRequest) -> Option<(String, RuleEffect)> {
        let (tool, subject) = infer_tool_and_subject(request);
        for pattern in &self.deny {
            if pattern_matches(pattern, &tool, &subject) {
                return Some((pattern.clone(), RuleEffect::Deny));
            }
        }
        for pattern in &self.allow {
            if pattern_matches(pattern, &tool, &subject) {
                return Some((pattern.clone(), RuleEffect::Allow));
            }
        }
        None
    }
}

/// 从 PermissionRequest 推断匹配目标 (tool, subject)。
/// raw_input 含 command 字符串字段 → (bash, command)；否则 tool = tool_name 首词。
fn infer_tool_and_subject(request: &PermissionRequest) -> (String, String) {
    if let Some(serde_json::Value::Object(map)) = &request.raw_input
        && let Some(serde_json::Value::String(command)) = map.get("command")
    {
        return ("bash".into(), command.clone());
    }
    let subject = request.tool_name.clone();
    let tool = subject
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_string();
    (tool, subject)
}

/// 模式三形：`*`（全匹配）；`tool`（工具名匹配，任意参数）；`tool(args)`（glob）。
fn pattern_matches(pattern: &str, tool: &str, subject: &str) -> bool {
    let pattern = pattern.trim();
    if pattern == "*" {
        return true;
    }
    if let Some(open) = pattern.find('(')
        && pattern.ends_with(')')
        && open > 0
    {
        let pattern_tool = &pattern[..open];
        let args = &pattern[open + 1..pattern.len() - 1];
        return pattern_tool == tool && glob_match(args, subject);
    }
    pattern == tool
}

/// 极简 glob：`*` 任意序列（含空格），`?` 单字符，其余字面匹配；
/// 尾通配空参数宽容——`git diff *` 也匹配无参的 `git diff`。
fn glob_match(pattern: &str, text: &str) -> bool {
    if let Some(prefix) = pattern.strip_suffix(" *")
        && text == prefix
    {
        return true;
    }
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    // 经典双指针回溯法
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut mark) = (usize::MAX, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = pi;
            mark = ti;
            pi += 1;
        } else if star != usize::MAX {
            pi = star + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

struct Waiting {
    /// 等待应答的请求：id → 回填通道
    entries: HashMap<Uuid, oneshot::Sender<PermissionDecision>>,
}

/// 审批代理。clone 友好（内部共享状态），CLI/桌面宿主持有一份传给 driver 即可。
#[derive(Clone)]
pub struct ApprovalBroker {
    rules: PermissionRules,
    waiting: Arc<Mutex<Waiting>>,
    /// 待决请求广播（审批中心 UI / CLI 宿主）；broadcast 自身线程安全，订阅无需加锁
    requests_tx: broadcast::Sender<PendingPermission>,
    /// 裁决留痕广播
    decisions_tx: broadcast::Sender<DecisionRecord>,
}

impl Default for ApprovalBroker {
    fn default() -> Self {
        Self::with_rules(PermissionRules::default())
    }
}

impl ApprovalBroker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_rules(rules: PermissionRules) -> Self {
        let (requests_tx, _) = broadcast::channel(64);
        let (decisions_tx, _) = broadcast::channel(128);
        Self {
            rules,
            waiting: Arc::new(Mutex::new(Waiting {
                entries: HashMap::new(),
            })),
            requests_tx,
            decisions_tx,
        }
    }

    /// driver 权限回调入口：规则引擎先行裁决；未命中（或 allow 规则无法适用）进入待决队列。
    pub async fn resolve(&self, request: PermissionRequest) -> Result<PermissionDecision> {
        // 1) 规则引擎先行（deny > allow）
        if let Some((pattern, effect)) = self.rules.evaluate(&request)
            // allow 规则命中但 agent 未提供 allow 选项 → None，降级为询问（落入待决队列）
            && let Some(decision) = self.rule_decision(&request, &pattern, effect)?
        {
            let _ = self.decisions_tx.send(DecisionRecord {
                request,
                source: DecisionSource::Rule { pattern, effect },
                decision: decision.clone(),
            });
            return Ok(decision);
        }

        // 2) 未命中 → 待决队列
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
            Ok(decision) => {
                let _ = self.decisions_tx.send(DecisionRecord {
                    request,
                    source: DecisionSource::User,
                    decision: decision.clone(),
                });
                Ok(decision)
            }
            // 回填通道被丢弃（respond 之外的路径移除了登记）→ fail-closed
            Err(_) => Err(CoreError::PermissionFailed(format!(
                "审批回填通道关闭，按拒绝处理：{}",
                request.tool_name
            ))),
        }
    }

    /// 规则裁决的 option 选择（architecture.md §4.3）：
    /// allow → 首个 allow 类 option（偏好 AllowOnce，持续性由规则承担），
    ///   agent 未提供 allow 选项时返回 None（调用方降级为询问）；
    /// deny → 首个 reject 类 option，未提供则报错（fail-closed）。
    fn rule_decision(
        &self,
        request: &PermissionRequest,
        pattern: &str,
        effect: RuleEffect,
    ) -> Result<Option<PermissionDecision>> {
        let pick = |want_allow: bool, prefer: PermissionOptionKind| -> Option<String> {
            request
                .options
                .iter()
                .filter(|option| option.kind.is_allow() == want_allow)
                .min_by_key(|option| (option.kind != prefer) as u8)
                .map(|option| option.option_id.clone())
        };
        let option_id = match effect {
            RuleEffect::Allow => pick(true, PermissionOptionKind::AllowOnce),
            RuleEffect::Deny => Some(pick(false, PermissionOptionKind::RejectOnce).ok_or_else(
                || {
                    CoreError::PermissionFailed(format!(
                        "规则 {pattern} 命中 deny 但 agent 未提供 reject 选项，按拒绝处理"
                    ))
                },
            )?),
        };
        Ok(option_id.map(|option_id| PermissionDecision {
            option_id,
            updated_input: None,
        }))
    }

    /// 订阅待决请求（broadcast：审批中心 UI 与 CLI 宿主可并存）。
    pub fn subscribe(&self) -> broadcast::Receiver<PendingPermission> {
        self.requests_tx.subscribe()
    }

    /// 订阅裁决留痕（CLI 打印 / Phase 1 审批历史 UI / P0-8 落库）。
    pub fn subscribe_decisions(&self) -> broadcast::Receiver<DecisionRecord> {
        self.decisions_tx.subscribe()
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
    use crate::driver::PermissionOption;

    fn sample_request() -> PermissionRequest {
        PermissionRequest {
            session_id: "ses_1".into(),
            tool_call_id: "call_1".into(),
            tool_name: "git status".into(),
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

    #[test]
    fn glob匹配_星号跨空格问号单字符() {
        assert!(glob_match("git status", "git status"));
        assert!(!glob_match("git status", "git status -s"));
        assert!(glob_match("git diff *", "git diff HEAD~1..HEAD"));
        assert!(glob_match("git diff *", "git diff"));
        assert!(glob_match("rm -rf *", "rm -rf /tmp/anything here"));
        assert!(glob_match("git ?ush", "git push"));
        assert!(!glob_match("git ?ush", "git pushh"));
        assert!(glob_match("", ""));
        assert!(glob_match("*", "任意内容 with spaces"));
    }

    #[test]
    fn 模式三形匹配() {
        // tool(args)
        assert!(pattern_matches("bash(git status)", "bash", "git status"));
        assert!(!pattern_matches("bash(git status)", "bash", "git log"));
        assert!(pattern_matches(
            "bash(git diff *)",
            "bash",
            "git diff main..dev"
        ));
        // 裸工具名
        assert!(pattern_matches("bash", "bash", "anything"));
        assert!(!pattern_matches("bash", "read", "anything"));
        // 全匹配
        assert!(pattern_matches("*", "bash", "anything"));
    }

    #[test]
    fn 从raw_input推断bash工具与命令() {
        let (tool, subject) = infer_tool_and_subject(&sample_request());
        assert_eq!(tool, "bash");
        assert_eq!(subject, "git status");

        let mut req = sample_request();
        req.raw_input = None;
        req.tool_name = "write /tmp/a.txt".into();
        let (tool, subject) = infer_tool_and_subject(&req);
        assert_eq!(tool, "write");
        assert_eq!(subject, "write /tmp/a.txt");
    }

    #[test]
    fn 规则求值_deny优先于allow() {
        let rules =
            PermissionRules::new(vec!["bash(git *)".into()], vec!["bash(git push *)".into()]);
        // 同时命中 allow(git *) 与 deny(git push *) → deny
        let effect = rules.evaluate(&sample_request_with_command("git push origin main"));
        assert_eq!(effect.map(|(_, e)| e), Some(RuleEffect::Deny));
        // 仅命中 allow
        let effect = rules.evaluate(&sample_request_with_command("git status"));
        assert_eq!(effect.map(|(_, e)| e), Some(RuleEffect::Allow));
        // 都不命中 → None（询问）
        let effect = rules.evaluate(&sample_request_with_command("ls -la"));
        assert_eq!(effect, None);
    }

    fn sample_request_with_command(command: &str) -> PermissionRequest {
        let mut req = sample_request();
        req.tool_name = command.into();
        req.raw_input = Some(serde_json::json!({ "command": command }));
        req
    }

    /// 验收：allow 规则命中 → 不进待决队列，直接放行且留痕为 Rule 来源
    #[tokio::test]
    async fn allow规则命中直接放行并留痕() {
        let broker = ApprovalBroker::with_rules(PermissionRules::new(
            vec!["bash(git status)".into()],
            vec![],
        ));
        let mut requests = broker.subscribe();
        let mut decisions = broker.subscribe_decisions();

        let resolved = broker.resolve(sample_request()).await.unwrap();
        assert_eq!(resolved.option_id, "allow-once");

        // 未进入待决队列
        assert!(
            requests.try_recv().is_err(), /* 无待决请求广播 */
            "规则命中不应广播待决请求"
        );
        // 留痕为规则裁决
        let record = decisions.try_recv().expect("应有裁决留痕");
        assert_eq!(
            record.source,
            DecisionSource::Rule {
                pattern: "bash(git status)".into(),
                effect: RuleEffect::Allow
            }
        );
    }

    /// 验收：deny 规则命中 → 直接拒绝且留痕
    #[tokio::test]
    async fn deny规则命中直接拒绝并留痕() {
        let broker = ApprovalBroker::with_rules(PermissionRules::new(
            vec![],
            vec!["bash(git status)".into()],
        ));
        let mut decisions = broker.subscribe_decisions();

        let resolved = broker.resolve(sample_request()).await.unwrap();
        assert_eq!(resolved.option_id, "reject-once");

        let record = decisions.try_recv().expect("应有裁决留痕");
        assert_eq!(
            record.source,
            DecisionSource::Rule {
                pattern: "bash(git status)".into(),
                effect: RuleEffect::Deny
            }
        );
    }

    #[tokio::test]
    async fn 未命中规则进入待决队列并回填() {
        let broker =
            ApprovalBroker::with_rules(PermissionRules::new(vec!["bash(git log)".into()], vec![]));
        let mut requests = broker.subscribe();
        let mut decisions = broker.subscribe_decisions();

        let resolver = tokio::spawn({
            let broker = broker.clone();
            async move { broker.resolve(sample_request()).await }
        });
        let pending = requests.recv().await.unwrap();
        broker
            .respond(pending.id, decision("reject-once"))
            .await
            .unwrap();
        assert_eq!(resolver.await.unwrap().unwrap().option_id, "reject-once");

        let record = decisions.try_recv().expect("应有裁决留痕");
        assert_eq!(record.source, DecisionSource::User);
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
        assert_eq!(pending.request.tool_name, "git status");

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
