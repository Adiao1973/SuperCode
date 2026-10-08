//! Stable Codex app-server stdio client. Authentication stays with Codex.
use super::{
    PermissionHandler, PermissionOption, PermissionOptionKind, PermissionRequest, StartMode,
};
use crate::{
    error::{CoreError, Result},
    events::{AgentEvent, ContentBlock, StopReason, ToolKind, ToolStatus},
    proc::{ProcessId, ProcessManager, ProcessSpec},
};
use futures::{FutureExt, StreamExt, future::BoxFuture, stream::FuturesUnordered};
use serde_json::{Value, json};
use std::{collections::HashSet, path::PathBuf, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::ChildStdin,
    sync::mpsc,
};
use tokio_util::sync::CancellationToken;
const MAX_FRAME: u64 = 4 * 1024 * 1024;
fn invalid(message: &str) -> CoreError {
    CoreError::Protocol(format!("Codex Native: {message}"))
}
pub struct NativeDriver {
    program: String,
    args: Vec<String>,
    rpc_timeout: Duration,
    cancel_grace: Duration,
}
impl Default for NativeDriver {
    fn default() -> Self {
        Self::new(
            "codex",
            vec!["app-server".into(), "--listen".into(), "stdio://".into()],
        )
    }
}
struct Cleanup {
    manager: Arc<ProcessManager>,
    id: ProcessId,
    armed: bool,
    reader: tokio::task::AbortHandle,
}
impl Drop for Cleanup {
    fn drop(&mut self) {
        self.reader.abort();
        if self.armed {
            let m = self.manager.clone();
            let id = self.id;
            tokio::spawn(async move {
                let _ = m.kill(id).await;
                let _ = m.wait(id).await;
            });
        }
    }
}
struct Wire {
    stdin: ChildStdin,
    rx: mpsc::Receiver<Result<Value>>,
    sequence: u64,
    buffer: Vec<Value>,
    timeout: Duration,
}
impl Wire {
    async fn send(&mut self, value: Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(&value).map_err(|_| invalid("无法编码请求"))?;
        bytes.push(b'\n');
        tokio::time::timeout(self.timeout, self.stdin.write_all(&bytes))
            .await
            .map_err(|_| invalid("写入超时"))?
            .map_err(|_| invalid("协议写入失败"))
    }
    async fn read(&mut self) -> Result<Value> {
        self.rx
            .recv()
            .await
            .ok_or_else(|| invalid("读取连接已结束"))?
    }
    async fn rpc(
        &mut self,
        method: &str,
        params: Value,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        self.sequence += 1;
        let id = self.sequence;
        let timeout = self.timeout;
        let operation = async {
            self.send(json!({"id":id,"method":method,"params":params}))
                .await?;
            loop {
                let frame = self.read().await?;
                if frame.get("method").is_some() {
                    if self.buffer.len() >= 32 {
                        return Err(invalid("启动通知超出上限"));
                    }
                    self.buffer.push(frame);
                    continue;
                }
                if frame.get("id") != Some(&json!(id)) {
                    return Err(invalid("响应关联 ID 不匹配"));
                }
                if frame.get("error").is_some() {
                    return Err(invalid(&format!(
                        "服务端拒绝 {method} (code {})",
                        frame["error"]["code"].as_i64().unwrap_or(0)
                    )));
                }
                return frame
                    .get("result")
                    .cloned()
                    .ok_or_else(|| invalid("响应缺少 result"));
            }
        };
        tokio::select! {biased;_=cancel.cancelled()=>Err(invalid("启动已取消")),r=tokio::time::timeout(timeout,operation)=>r.map_err(|_|invalid("请求超时"))?}
    }
}
struct BrokerCleanup {
    broker: crate::approval::ApprovalBroker,
    token: CancellationToken,
    armed: bool,
}
impl Drop for BrokerCleanup {
    fn drop(&mut self) {
        self.token.cancel();
        if self.armed {
            let broker = self.broker.clone();
            tokio::spawn(async move {
                broker.reject_all_pending().await;
            });
        }
    }
}
impl NativeDriver {
    /// Preferred host entry: owns pending approvals and cleans them on cancel/drop.
    #[allow(clippy::too_many_arguments)]
    pub async fn run_with_broker(
        &self,
        cwd: PathBuf,
        start: StartMode,
        prompt: String,
        events: mpsc::Sender<AgentEvent>,
        broker: crate::approval::ApprovalBroker,
        cancel: CancellationToken,
    ) -> Result<()> {
        let token = cancel.child_token();
        let mut guard = BrokerCleanup {
            broker: broker.clone(),
            token: token.clone(),
            armed: true,
        };
        let permissions: PermissionHandler = {
            let broker = broker.clone();
            let token = token.clone();
            Arc::new(move |request| {
                let broker = broker.clone();
                let token = token.clone();
                Box::pin(async move {
                    let resolution = broker.resolve(request);
                    tokio::pin!(resolution);
                    tokio::select! {biased;_=token.cancelled()=>{
                        broker.reject_all_pending().await;
                        match resolution.as_mut().now_or_never() {Some(r)=>r,None=>{broker.reject_all_pending().await;resolution.await}}
                    },r=&mut resolution=>r}
                })
            })
        };
        let result = self
            .run(cwd, start, prompt, events, permissions, token.clone())
            .await;
        token.cancel();
        broker.reject_all_pending().await;
        guard.armed = false;
        result
    }
    pub fn new(program: impl Into<String>, args: Vec<String>) -> Self {
        Self {
            program: program.into(),
            args,
            rpc_timeout: Duration::from_secs(30),
            cancel_grace: Duration::from_secs(5),
        }
    }
    pub fn with_timeouts(mut self, rpc: Duration, cancel: Duration) -> Self {
        self.rpc_timeout = rpc;
        self.cancel_grace = cancel;
        self
    }
    pub async fn run(
        &self,
        cwd: PathBuf,
        start: StartMode,
        prompt: String,
        events: mpsc::Sender<AgentEvent>,
        permissions: PermissionHandler,
        cancel: CancellationToken,
    ) -> Result<()> {
        if cancel.is_cancelled() {
            let _ = events.try_send(AgentEvent::TurnCompleted {
                stop_reason: StopReason::Cancelled,
            });
            return Ok(());
        }
        if !cwd.is_absolute() || !cwd.is_dir() || prompt.trim().is_empty() {
            return Err(invalid("工作目录或提示词无效"));
        }
        let manager = Arc::new(ProcessManager::new(
            std::env::temp_dir().join(format!("sc-native-{}", uuid::Uuid::new_v4())),
        ));
        let process = manager
            .spawn(ProcessSpec {
                program: self.program.clone(),
                args: self.args.clone(),
                cwd: Some(cwd.clone()),
                envs: vec![],
            })
            .await?;
        let (tx, rx) = mpsc::channel(32);
        let reader = tokio::spawn(async move {
            let mut stdout = BufReader::new(process.stdout);
            loop {
                let mut bytes = Vec::new();
                let n = (&mut stdout)
                    .take(MAX_FRAME + 1)
                    .read_until(b'\n', &mut bytes)
                    .await;
                let frame = match n {
                    Ok(0) => Err(invalid("服务端提前退出")),
                    Ok(_) if bytes.len() as u64 > MAX_FRAME => Err(invalid("协议帧超过上限")),
                    Ok(_) => serde_json::from_slice(&bytes).map_err(|_| invalid("无效 JSON 帧")),
                    Err(_) => Err(invalid("协议读取失败")),
                };
                let failed = frame.is_err();
                if tx.send(frame).await.is_err() || failed {
                    break;
                }
            }
        });
        let mut cleanup = Cleanup {
            manager: manager.clone(),
            id: process.id,
            armed: true,
            reader: reader.abort_handle(),
        };
        let mut wire = Wire {
            stdin: process.stdin,
            rx,
            sequence: 0,
            buffer: vec![],
            timeout: self.rpc_timeout,
        };
        let result = self
            .connected(&mut wire, cwd, start, prompt, &events, permissions, &cancel)
            .await;
        // Await group cleanup before returning; Drop also covers abandoned futures.
        let killed = manager.kill(process.id).await;
        let waited = manager.wait(process.id).await;
        cleanup.armed = false;
        reader.abort();
        let _ = reader.await;
        if result.is_err() && cancel.is_cancelled() {
            let _ = events.try_send(AgentEvent::TurnCompleted {
                stop_reason: StopReason::Cancelled,
            });
            return Ok(());
        }
        if let Err(error) = &result {
            let _ = events.try_send(AgentEvent::DriverError {
                message: error.to_string(),
            });
        }
        result?;
        killed?;
        waited?;
        Ok(())
    }
    #[allow(clippy::too_many_arguments)]
    async fn connected(
        &self,
        wire: &mut Wire,
        cwd: PathBuf,
        start: StartMode,
        prompt: String,
        events: &mpsc::Sender<AgentEvent>,
        permissions: PermissionHandler,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let hello=wire.rpc("initialize",json!({"clientInfo":{"name":"supercode","title":"SuperCode","version":crate::VERSION},"capabilities":{"experimentalApi":false}}),cancel).await?;
        if hello
            .get("userAgent")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
        {
            return Err(invalid("握手缺少服务端标识"));
        }
        wire.send(json!({"method":"initialized"})).await?;
        let mut params = json!({"cwd":cwd,"approvalPolicy":"untrusted","approvalsReviewer":"user","sandbox":"read-only"});
        let method = match &start {
            StartMode::New => "thread/start",
            StartMode::Load(id) => {
                params["threadId"] = json!(id);
                "thread/resume"
            }
        };
        let created = wire.rpc(method, params, cancel).await?;
        let thread = required(&created["thread"], "id")?.to_string();
        if created["cwd"].as_str() != cwd.to_str()
            || created["approvalPolicy"] != "untrusted"
            || created["approvalsReviewer"] != "user"
            || created["sandbox"]["type"] != "readOnly"
            || created["sandbox"]["networkAccess"] == true
        {
            return Err(invalid("服务端工作目录或审批/沙箱契约不匹配"));
        }
        if let StartMode::Load(expected) = start
            && thread != expected
        {
            return Err(invalid("恢复线程 ID 不匹配"));
        }
        emit(
            events,
            AgentEvent::SessionStarted {
                session_id: thread.clone(),
            },
            cancel,
        )
        .await?;
        let turn = wire
            .rpc(
                "turn/start",
                json!({"threadId":thread,"cwd":cwd,"input":[{"type":"text","text":prompt}]}),
                cancel,
            )
            .await?;
        let turn = required(&turn["turn"], "id")?.to_string();
        let mut approvals: FuturesUnordered<
            BoxFuture<'static, (Value, Result<super::PermissionDecision>)>,
        > = FuturesUnordered::new();
        let mut delta_ids = HashSet::new();
        let mut seen_requests = HashSet::new();
        let mut cancelling = false;
        let mut interrupt_id = None;
        let deadline = tokio::time::sleep(Duration::from_secs(365 * 24 * 3600));
        tokio::pin!(deadline);
        let mut buffered = std::mem::take(&mut wire.buffer).into_iter();
        loop {
            let frame = if let Some(frame) = buffered.next() {
                frame
            } else {
                tokio::select! {biased;
                 _=cancel.cancelled(),if !cancelling=>{
                  cancelling=true;deadline.as_mut().reset(tokio::time::Instant::now()+self.cancel_grace);
                  wire.sequence+=1;interrupt_id=Some(wire.sequence);
                  tokio::time::timeout(self.cancel_grace,wire.send(json!({"id":wire.sequence,"method":"turn/interrupt","params":{"threadId":thread,"turnId":turn}}))).await.map_err(|_|invalid("取消写入超时"))??;
                  let _=tokio::time::timeout(self.cancel_grace,async {
                    while let Some((id,_))=approvals.next().await {wire.send(json!({"id":id,"result":{"decision":"decline"}})).await?;}
                    Ok::<(),CoreError>(())
                  }).await;
                  approvals.clear();continue;
                 },
                 _=&mut deadline,if cancelling=>{let _=events.try_send(AgentEvent::TurnCompleted{stop_reason:StopReason::Cancelled});return Ok(());},
                 Some((id,decision))=approvals.next(),if !approvals.is_empty()=>{
                  let decision=decision?;
                  if decision.updated_input.is_some()||!matches!(decision.option_id.as_str(),"accept"|"decline"){return Err(invalid("审批裁决不受支持"));}
                  tokio::select!{biased;_=cancel.cancelled()=>return Err(invalid("裁决发送已取消")),r=wire.send(json!({"id":id,"result":{"decision":decision.option_id}}))=>r?};continue;
                 },
                 frame=wire.read()=>frame?,
                }
            };
            let Some(method) = frame.get("method").and_then(Value::as_str) else {
                if let Some(expected) = interrupt_id
                    && frame.get("id") == Some(&json!(expected))
                {
                    continue;
                }
                return Err(invalid("出现未关联的响应"));
            };
            if frame.get("id").is_none()
                && !matches!(
                    method,
                    "turn/started"
                        | "turn/completed"
                        | "item/started"
                        | "item/completed"
                        | "item/agentMessage/delta"
                        | "item/reasoning/summaryTextDelta"
                        | "item/reasoning/textDelta"
                )
            {
                // Codex may replay legacy notifications while resuming. They do not
                // feed the normalized event stream and must not bind the new turn.
                continue;
            }
            let p = &frame["params"];
            if let Some(id) = p.get("threadId").and_then(Value::as_str)
                && id != thread
            {
                return Err(invalid("通知线程归属错误"));
            }
            let notified_turn = p.get("turnId").and_then(Value::as_str).or_else(|| {
                p.get("turn")
                    .and_then(|t| t.get("id"))
                    .and_then(Value::as_str)
            });
            if let Some(id) = p
                .get("turn")
                .and_then(|t| t.get("id"))
                .and_then(Value::as_str)
                && id != turn
            {
                return Err(invalid("轮次对象归属错误"));
            }
            if let Some(id) = notified_turn
                && id != turn
            {
                return Err(invalid("通知轮次归属错误"));
            }
            if let Some(id) = frame.get("id") {
                if !id.is_string() && !id.is_number() {
                    return Err(invalid("服务端请求 ID 无效"));
                }
                if seen_requests.len() >= 4096 || approvals.len() >= 32 {
                    return Err(invalid("审批请求超出上限"));
                }
                if !seen_requests.insert(id.to_string()) {
                    return Err(invalid("重复服务端请求 ID"));
                }
                if !matches!(
                    method,
                    "item/commandExecution/requestApproval" | "item/fileChange/requestApproval"
                ) {
                    wire.send(json!({"id":id,"error":{"code":-32601,"message":"Unsupported server request"}})).await?;
                    return Err(invalid("不支持的服务端请求"));
                }
                if p["threadId"] != thread || p["turnId"] != turn {
                    return Err(invalid("审批归属字段缺失"));
                }
                if cancelling {
                    wire.send(json!({"id":id,"result":{"decision":"decline"}}))
                        .await?;
                    continue;
                }
                let item = required(p, "itemId")?;
                let edit = method == "item/fileChange/requestApproval";
                let request = PermissionRequest {
                    session_id: thread.clone(),
                    tool_call_id: format!("{item}:rpc:{}", id),
                    tool_name: if edit {
                        "file change".into()
                    } else {
                        p["command"].as_str().unwrap_or("command").into()
                    },
                    kind: Some(if edit { "edit" } else { "execute" }.into()),
                    raw_input: Some(p.clone()),
                    options: vec![
                        PermissionOption {
                            option_id: "accept".into(),
                            name: "Allow once".into(),
                            kind: PermissionOptionKind::AllowOnce,
                        },
                        PermissionOption {
                            option_id: "decline".into(),
                            name: "Reject once".into(),
                            kind: PermissionOptionKind::RejectOnce,
                        },
                    ],
                };
                let callback = permissions.clone();
                let id = id.clone();
                approvals.push(Box::pin(async move { (id, callback(request).await) }));
                continue;
            }
            // Terminal messages and relevant item events must identify their owning thread/turn.
            if (method.starts_with("item/") || method == "turn/completed")
                && (p["threadId"] != thread || notified_turn != Some(turn.as_str()))
            {
                return Err(invalid("事件归属字段缺失"));
            }
            if method == "turn/completed" {
                if !approvals.is_empty() && !cancelling {
                    return Err(invalid("轮次在审批完成前结束"));
                }
                approvals.clear();
                let stop = match p["turn"]["status"].as_str() {
                    Some("completed") if !cancelling => StopReason::EndTurn,
                    Some("interrupted") | Some("completed") => StopReason::Cancelled,
                    _ => return Err(invalid("轮次失败或状态无效")),
                };
                if stop == StopReason::Cancelled {
                    let _ = events.try_send(AgentEvent::TurnCompleted { stop_reason: stop });
                } else {
                    emit(
                        events,
                        AgentEvent::TurnCompleted { stop_reason: stop },
                        cancel,
                    )
                    .await?;
                }
                return Ok(());
            }
            if !cancelling {
                for event in convert(method, p, &mut delta_ids)? {
                    emit(events, event, cancel).await?;
                }
            }
        }
    }
}
fn required<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| invalid("必要字段缺失"))
}
async fn emit(
    events: &mpsc::Sender<AgentEvent>,
    event: AgentEvent,
    cancel: &CancellationToken,
) -> Result<()> {
    tokio::select! {biased;_=cancel.cancelled()=>Err(invalid("事件转发已取消")),r=events.send(event)=>r.map_err(|_|invalid("事件接收方已关闭"))}
}
fn convert(method: &str, p: &Value, deltas: &mut HashSet<String>) -> Result<Vec<AgentEvent>> {
    let mut out = Vec::new();
    match method {
        "item/agentMessage/delta"
        | "item/reasoning/summaryTextDelta"
        | "item/reasoning/textDelta" => {
            let id = required(p, "itemId")?.to_owned();
            let text = p
                .get("delta")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid("文本增量缺失"))?
                .to_owned();
            if text.is_empty() {
                return Ok(out);
            }
            if method == "item/agentMessage/delta" {
                deltas.insert(id.clone());
                out.push(AgentEvent::MessageChunk {
                    message_id: id,
                    text,
                });
            } else {
                out.push(AgentEvent::ThoughtChunk {
                    message_id: id,
                    text,
                });
            }
        }
        "item/started" | "item/completed" => {
            let item = &p["item"];
            let id = required(item, "id")?.to_owned();
            let kind = match item["type"].as_str() {
                Some("commandExecution") => ToolKind::Execute,
                Some("fileChange") => ToolKind::Edit,
                Some("agentMessage") => {
                    if method == "item/completed" && !deltas.contains(&id) {
                        out.push(AgentEvent::MessageChunk {
                            message_id: id,
                            text: item
                                .get("text")
                                .and_then(Value::as_str)
                                .ok_or_else(|| invalid("消息文本缺失"))?
                                .to_owned(),
                        });
                    }
                    return Ok(out);
                }
                _ => return Ok(out),
            };
            if method == "item/started" {
                out.push(AgentEvent::ToolCall {
                    tool_call_id: id,
                    name: Some(
                        if kind == ToolKind::Edit {
                            "file change"
                        } else {
                            "command"
                        }
                        .into(),
                    ),
                    title: item["command"].as_str().map(str::to_owned),
                    kind,
                    raw_input: Some(item.clone()),
                    diff: None,
                });
            } else {
                let status = match item["status"].as_str() {
                    Some("completed") => ToolStatus::Completed,
                    Some("failed") | Some("declined") => ToolStatus::Failed,
                    _ => return Err(invalid("工具结束状态无效")),
                };
                let content = item["aggregatedOutput"]
                    .as_str()
                    .map(|s| vec![ContentBlock::Text { text: s.into() }])
                    .unwrap_or_default();
                out.push(AgentEvent::ToolCallUpdate {
                    tool_call_id: id,
                    status: Some(status),
                    content,
                    locations: vec![],
                    diff: None,
                });
            }
        }
        _ => {}
    }
    Ok(out)
}
