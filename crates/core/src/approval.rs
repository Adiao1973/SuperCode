//! ApprovalBroker：所有 driver 的权限请求先经预授权规则引擎，
//! 未命中的进入待决队列广播给宿主（CLI 交互 / Phase 1 审批中心 UI），应答后回写。
//! fail-closed：链路异常一律不放行（docs/architecture.md §4.3）。

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{Mutex, broadcast, oneshot};
use uuid::Uuid;

fn serialize_uuid<S: serde::Serializer>(
    value: &Uuid,
    serializer: S,
) -> std::result::Result<S::Ok, S::Error> {
    serializer.serialize_str(&value.to_string())
}

use crate::driver::{PermissionDecision, PermissionOptionKind, PermissionRequest};
use crate::error::{CoreError, Result};

/// 进入待决队列的权限请求（带 broker 分配的关联 id）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct PendingPermission {
    #[serde(serialize_with = "serialize_uuid")]
    pub id: Uuid,
    pub request: PermissionRequest,
}

/// 裁决来源：预授权规则（带命中模式与效果）、权限模式兜底或用户。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionSource {
    Rule {
        pattern: String,
        effect: RuleEffect,
    },
    /// 权限模式兜底（plan 拒绝 / full 放行 / autoedit 放行 / fail-closed 拒绝）
    Mode {
        mode: PermissionMode,
    },
    User,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleEffect {
    Allow,
    Deny,
    Ask,
}

impl std::str::FromStr for RuleEffect {
    type Err = CoreError;
    fn from_str(value: &str) -> Result<Self> {
        match value {
            "allow" => Ok(Self::Allow),
            "deny" => Ok(Self::Deny),
            "ask" => Ok(Self::Ask),
            other => Err(CoreError::PermissionFailed(format!(
                "未知规则效果: {other}"
            ))),
        }
    }
}

/// 权限模式（ADR-0006）：未匹配请求的默认策略，会话级可热切换。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    /// 计划：一律拒绝（只读保证，allow 规则不再考察）
    Plan,
    /// 变更前确认：全部进待决队列（默认）
    #[default]
    Ask,
    /// 自动编辑：edit/write 类放行，其余进队列
    AutoEdit,
    /// 完全访问：全部放行（deny 规则仍生效）
    FullAccess,
}

impl PermissionMode {
    pub fn from_str_value(value: &str) -> Option<Self> {
        match value {
            "plan" => Some(Self::Plan),
            "ask" => Some(Self::Ask),
            "autoedit" => Some(Self::AutoEdit),
            "full" => Some(Self::FullAccess),
            _ => None,
        }
    }
}

/// edit/write 类工具（AutoEdit 模式的放行范围；bash/execute 不在此列——ADR-0006）
fn is_edit_class_request(request: &PermissionRequest) -> bool {
    // ACP kind 是可靠标识（opencode 权限请求不带 name，title 常是路径/命令）
    if request.kind.as_deref() == Some("edit") {
        return true;
    }
    let (tool, _) = infer_tool_and_subject(request);
    matches!(
        tool.to_lowercase().as_str(),
        "write" | "edit" | "multiedit" | "notebookedit" | "patch" | "apply_patch" | "str_replace"
    )
}

/// 裁决留痕记录（`subscribe_decisions()` 广播；SQLite 持久化在 P0-8 落地）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct DecisionRecord {
    pub request: PermissionRequest,
    pub source: DecisionSource,
    pub decision: PermissionDecision,
}

/// 预授权规则集（求值顺序 deny > ask > allow，全不命中 → 按权限模式兜底）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PermissionRules {
    pub allow: Vec<String>,
    pub deny: Vec<String>,
    pub ask: Vec<String>,
}

impl PermissionRules {
    pub fn new(allow: Vec<String>, deny: Vec<String>) -> Self {
        Self {
            allow,
            deny,
            ask: Vec::new(),
        }
    }

    pub fn with_ask(mut self, ask: Vec<String>) -> Self {
        self.ask = ask;
        self
    }

    /// 求值：返回首个命中的 deny/ask/allow；None = 未命中（按权限模式兜底）。
    /// deny 优先（保守：冲突时拒绝）；ask 压过 allow（显式要求逐次确认的优先）。
    pub fn evaluate(&self, request: &PermissionRequest) -> Option<(String, RuleEffect)> {
        let (tool, subject) = infer_tool_and_subject(request);
        for pattern in &self.deny {
            if pattern_matches(pattern, &tool, &subject) {
                return Some((pattern.clone(), RuleEffect::Deny));
            }
        }
        for pattern in &self.ask {
            if pattern_matches(pattern, &tool, &subject) {
                return Some((pattern.clone(), RuleEffect::Ask));
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
    /// 权限模式（会话级，可经 set_mode 热切换）
    mode: Arc<std::sync::Mutex<PermissionMode>>,
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

/// 管线裁决结果：Queue = 待决队列（等用户应答）；Decision = 已裁决（含留痕）
enum PipelineOutcome {
    Queue,
    Decision(Box<DecisionRecord>),
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
            mode: Arc::new(std::sync::Mutex::new(PermissionMode::default())),
            waiting: Arc::new(Mutex::new(Waiting {
                entries: HashMap::new(),
            })),
            requests_tx,
            decisions_tx,
        }
    }

    /// 热切换权限模式（会话级模式选择器）
    pub fn set_mode(&self, mode: PermissionMode) {
        *self.mode.lock().unwrap() = mode;
    }

    pub fn mode(&self) -> PermissionMode {
        *self.mode.lock().unwrap()
    }

    /// 管线裁决（§4.3 v2）：Queue = 交由调用方入队等应答；Decision = 已裁决待广播。
    fn decide(&self, request: &PermissionRequest, fallback_deny: bool) -> Result<PipelineOutcome> {
        let matched = self.rules.evaluate(request);

        // 1) deny 规则 → 拒绝（任何模式最硬）
        if let Some((pattern, RuleEffect::Deny)) = &matched {
            let decision = self
                .rule_decision(request, pattern, RuleEffect::Deny)?
                .ok_or_else(|| {
                    CoreError::PermissionFailed(format!(
                        "规则 {pattern} 命中 deny 但 agent 未提供 reject 选项"
                    ))
                })?;
            return Ok(PipelineOutcome::Decision(Box::new(DecisionRecord {
                request: request.clone(),
                source: DecisionSource::Rule {
                    pattern: pattern.clone(),
                    effect: RuleEffect::Deny,
                },
                decision,
            })));
        }

        let mode = self.mode();

        // 2) plan 模式 → 拒绝（allow 规则不再考察——计划模式保证只读）
        if mode == PermissionMode::Plan {
            let decision = self
                .rule_decision(request, "<plan>", RuleEffect::Deny)?
                .ok_or_else(|| {
                    CoreError::PermissionFailed("agent 未提供拒绝选项（plan 模式）".into())
                })?;
            return Ok(PipelineOutcome::Decision(Box::new(DecisionRecord {
                request: request.clone(),
                source: DecisionSource::Mode { mode },
                decision,
            })));
        }

        // 3) full 模式 → 放行
        if mode == PermissionMode::FullAccess {
            let decision = self
                .rule_decision(request, "<full>", RuleEffect::Allow)?
                .ok_or_else(|| {
                    CoreError::PermissionFailed("agent 未提供允许选项（full 模式）".into())
                })?;
            return Ok(PipelineOutcome::Decision(Box::new(DecisionRecord {
                request: request.clone(),
                source: DecisionSource::Mode { mode },
                decision,
            })));
        }

        // 4) ask 规则 → 待决队列（用户显式要求逐次确认的优先于 allow）
        if matches!(matched, Some((_, RuleEffect::Ask))) {
            return Ok(PipelineOutcome::Queue);
        }

        // 5) allow 规则 → 放行（agent 未提供 allow 选项则降级询问）
        if let Some((pattern, RuleEffect::Allow)) = &matched {
            return match self.rule_decision(request, pattern, RuleEffect::Allow)? {
                Some(decision) => Ok(PipelineOutcome::Decision(Box::new(DecisionRecord {
                    request: request.clone(),
                    source: DecisionSource::Rule {
                        pattern: pattern.clone(),
                        effect: RuleEffect::Allow,
                    },
                    decision,
                }))),
                None => Ok(PipelineOutcome::Queue),
            };
        }

        // 6) autoedit ∧ edit/write 类 → 放行（bash 类不在此列）
        if mode == PermissionMode::AutoEdit && is_edit_class_request(request) {
            let decision = self
                .rule_decision(request, "<autoedit>", RuleEffect::Allow)?
                .ok_or_else(|| {
                    CoreError::PermissionFailed("agent 未提供允许选项（autoedit 模式）".into())
                })?;
            return Ok(PipelineOutcome::Decision(Box::new(DecisionRecord {
                request: request.clone(),
                source: DecisionSource::Mode { mode },
                decision,
            })));
        }

        // 7) 兜底：无审批 UI 宿主 fail-closed 拒绝；否则待决队列
        if fallback_deny {
            let decision = self
                .rule_decision(request, "<default-deny>", RuleEffect::Deny)?
                .ok_or_else(|| CoreError::PermissionFailed("agent 未提供拒绝选项".into()))?;
            Ok(PipelineOutcome::Decision(Box::new(DecisionRecord {
                request: request.clone(),
                source: DecisionSource::Mode { mode },
                decision,
            })))
        } else {
            Ok(PipelineOutcome::Queue)
        }
    }

    /// 记录并返回裁决
    /// 登记待决队列并广播，等待用户应答（resolve/resolve_fail_closed 共用）
    async fn enqueue_and_wait(&self, request: PermissionRequest) -> Result<PermissionDecision> {
        let id = Uuid::new_v4();
        let (decision_tx, decision_rx) = oneshot::channel();
        {
            let mut waiting = self.waiting.lock().await;
            waiting.entries.insert(id, decision_tx);
            // 无订阅方不视为错误：请求留在待决表，driver 侧挂起等待
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

    /// driver 权限回调入口（模式化管线 §4.3 v2，兜底走待决队列）。
    pub async fn resolve(&self, request: PermissionRequest) -> Result<PermissionDecision> {
        match self.decide(&request, false)? {
            PipelineOutcome::Decision(record) => {
                let _ = self.decisions_tx.send(*record.clone());
                Ok(record.decision)
            }
            PipelineOutcome::Queue => self.enqueue_and_wait(request).await,
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
            // ask 规则不产生自动裁决（管线第 4 步直接入待决队列）；占位防御
            RuleEffect::Ask => None,
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

    /// fail-closed 解析变体：管线兜底改为**直接选拒绝 option**，不进待决队列。
    /// 供无审批 UI 的宿主使用；模式化管线与 `resolve` 完全一致。
    ///
    /// 注意：不要用追加通配 deny（`"*"`）实现兜底——求值是 deny 优先，
    /// 通配 deny 会连 allow 规则一并压掉，全部请求被拒。
    pub async fn resolve_fail_closed(
        &self,
        request: PermissionRequest,
    ) -> Result<PermissionDecision> {
        match self.decide(&request, true)? {
            PipelineOutcome::Decision(record) => {
                let _ = self.decisions_tx.send(*record.clone());
                Ok(record.decision)
            }
            // 管线在 fail-closed 下不会产生 Queue（兜底已改为拒绝）；
            // ask 规则命中仍走队列——显式 ask 语义优先于宿主兜底
            PipelineOutcome::Queue => self.enqueue_and_wait(request).await,
        }
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
            kind: None,
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

    /// P1-2 桌面壳场景：allow 命中放行、未命中直接拒绝（不进待决队列）
    #[tokio::test]
    async fn fail_closed_allow命中放行_未命中直接拒绝() {
        // sample_request 带 command 字段 → 按 bash(git status) 语义匹配（裸模式只匹配工具名）
        let broker = ApprovalBroker::with_rules(PermissionRules::new(
            vec!["bash(git status)".into()],
            vec![],
        ));

        // 命中 allow → 选 allow 选项
        let allowed = broker.resolve_fail_closed(sample_request()).await.unwrap();
        assert_eq!(allowed.option_id, "allow-once");

        // 未命中 → 直接拒绝，且不产生待决请求
        let mut requests = broker.subscribe();
        let mut unmatched = sample_request();
        unmatched.tool_name = "rm -rf /".into();
        unmatched.raw_input = Some(serde_json::json!({"command": "rm -rf /"}));
        let rejected = broker.resolve_fail_closed(unmatched).await.unwrap();
        assert_eq!(rejected.option_id, "reject-once");
        assert!(
            requests.try_recv().is_err(),
            "fail-closed 不应把未命中请求放入待决队列"
        );
    }

    /// 用通配 deny 兜底是错误用法：deny 优先求值会压掉 allow 规则（P1-2 踩坑回归锁）
    #[tokio::test]
    async fn 通配deny兜底会压掉allow规则() {
        let broker = ApprovalBroker::with_rules(PermissionRules::new(
            vec!["git status".into()],
            vec!["*".into()],
        ));
        let rejected = broker.resolve_fail_closed(sample_request()).await.unwrap();
        assert_eq!(
            rejected.option_id, "reject-once",
            "deny(*) 优先于 allow(git status)——这正是不能用它做兜底的原因"
        );
    }

    /// edit/write 类请求样例（AutoEdit 放行范围）
    fn edit_class_request() -> PermissionRequest {
        PermissionRequest {
            session_id: "ses_1".into(),
            tool_call_id: "call_e1".into(),
            tool_name: "write".into(),
            kind: Some("edit".into()),
            raw_input: Some(serde_json::json!({"filePath": "/tmp/a.txt", "content": "hi\n"})),
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

    /// P1-5 管线位次 1+2：plan 模式未匹配请求直接拒绝，allow 规则不再考察
    #[tokio::test]
    async fn plan模式拒绝且压过allow规则() {
        let broker = ApprovalBroker::with_rules(PermissionRules::new(
            vec!["bash(git status)".into()],
            vec![],
        ));
        broker.set_mode(PermissionMode::Plan);
        let rejected = broker.resolve_fail_closed(sample_request()).await.unwrap();
        assert_eq!(rejected.option_id, "reject-once");
    }

    /// P1-5 管线位次 1+3：full 模式放行，但 deny 规则仍最硬
    #[tokio::test]
    async fn full模式放行但deny规则仍拒绝() {
        let broker =
            ApprovalBroker::with_rules(PermissionRules::new(vec![], vec!["bash(rm *)".into()]));
        broker.set_mode(PermissionMode::FullAccess);

        let allowed = broker.resolve_fail_closed(sample_request()).await.unwrap();
        assert_eq!(allowed.option_id, "allow-once");

        let mut denied = sample_request();
        denied.raw_input = Some(serde_json::json!({"command": "rm -rf /"}));
        let rejected = broker.resolve_fail_closed(denied).await.unwrap();
        assert_eq!(rejected.option_id, "reject-once");
    }

    /// P1-5 管线位次 4+6：autoedit 放行 edit 类、bash 类仍入待决队列
    #[tokio::test]
    async fn autoedit放行edit类bash类进队列() {
        let broker = ApprovalBroker::new();
        broker.set_mode(PermissionMode::AutoEdit);

        let allowed = broker
            .resolve_fail_closed(edit_class_request())
            .await
            .unwrap();
        assert_eq!(allowed.option_id, "allow-once");

        let mut requests = broker.subscribe();
        let queued = broker.resolve_fail_closed(sample_request()).await.unwrap();
        assert_eq!(queued.option_id, "reject-once");
        assert!(
            requests.try_recv().is_err(),
            "bash 类在 autoedit 下走 fail-closed，不进队列"
        );
    }

    /// P1-5 管线位次 4>5：ask 规则压过 allow 规则（AutoEdit 下 write 请求本应放行，
    /// 但 ask 规则命中 → 待决队列）
    #[tokio::test]
    async fn ask规则压过allow规则进队列() {
        let broker = ApprovalBroker::with_rules(
            PermissionRules::new(vec!["write".into()], vec![]).with_ask(vec!["write".into()]),
        );
        broker.set_mode(PermissionMode::AutoEdit);

        let mut requests = broker.subscribe();
        let resolver = tokio::spawn({
            let broker = broker.clone();
            async move { broker.resolve(edit_class_request()).await }
        });
        let pending = tokio::time::timeout(std::time::Duration::from_secs(2), requests.recv())
            .await
            .expect("ask 规则应命中待决队列（位次 4 先于 allow 的位次 5）")
            .unwrap();
        broker
            .respond(pending.id, decision("allow-once"))
            .await
            .unwrap();
        let resolved = resolver.await.unwrap().unwrap();
        assert_eq!(resolved.option_id, "allow-once");
    }

    /// P1-5：set_mode 热切换立即生效（同一 broker 先拒后放）
    #[tokio::test]
    async fn 模式热切换立即生效() {
        let broker = ApprovalBroker::new();
        broker.set_mode(PermissionMode::Plan);
        let rejected = broker.resolve_fail_closed(sample_request()).await.unwrap();
        assert_eq!(rejected.option_id, "reject-once");

        broker.set_mode(PermissionMode::FullAccess);
        let allowed = broker.resolve_fail_closed(sample_request()).await.unwrap();
        assert_eq!(allowed.option_id, "allow-once");
        assert_eq!(broker.mode(), PermissionMode::FullAccess);
    }
}
