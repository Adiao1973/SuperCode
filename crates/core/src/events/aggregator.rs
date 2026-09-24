//! 帧级合帧聚合器：吸收 driver 的高频事件，按帧批量输出。
//! 这是 §5 事件管道的 Rust 侧实现——桌面宿主把整批经 Tauri Channel 一次推送，
//! 前端只重渲染活动 chunk（硬性架构约束，非优化项）。

use std::time::Duration;

use tokio::sync::mpsc;

use super::AgentEvent;

pub struct EventAggregator {
    tick: Duration,
}

impl EventAggregator {
    /// `tick` 为 flush 周期：桌面宿主用 ~16ms；测试可调大以保证确定性（关闭前不合帧 flush）。
    pub fn new(tick: Duration) -> Self {
        Self { tick }
    }

    /// 消费 `input` 直到关闭；每个 flush 周期把当前批次（`Vec<AgentEvent>`）送到 `output`。
    ///
    /// 合帧规则：
    /// - 相邻且同 `message_id` 的 `MessageChunk` 合并为一条（文本拼接）；
    /// - 任何非 chunk 事件（或不同 `message_id`）切断合并并保持原序直通；
    /// - `input` 关闭时 flush 余量后结束。
    pub async fn run(
        self,
        mut input: mpsc::Receiver<AgentEvent>,
        output: mpsc::Sender<Vec<AgentEvent>>,
    ) {
        let mut batch: Vec<AgentEvent> = Vec::new();
        let mut ticker = tokio::time::interval(self.tick);
        // 错过的 tick 直接跳到下一周期，避免补帧风暴
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            tokio::select! {
                maybe_event = input.recv() => {
                    match maybe_event {
                        Some(event) => push_coalescing(&mut batch, event),
                        None => {
                            flush(&mut batch, &output).await;
                            break;
                        }
                    }
                }
                _ = ticker.tick() => {
                    flush(&mut batch, &output).await;
                }
            }
        }
    }
}

/// 入批：相邻同 message_id 的 chunk 就地拼接，其余保持原序入批。
fn push_coalescing(batch: &mut Vec<AgentEvent>, event: AgentEvent) {
    if let AgentEvent::MessageChunk { message_id, text } = &event {
        if let Some(AgentEvent::MessageChunk {
            message_id: last_id,
            text: last_text,
        }) = batch.last_mut()
        {
            if last_id == message_id {
                last_text.push_str(text);
                return;
            }
        }
    }
    batch.push(event);
}

async fn flush(batch: &mut Vec<AgentEvent>, output: &mpsc::Sender<Vec<AgentEvent>>) {
    if batch.is_empty() {
        return;
    }
    // output 关闭（消费方已退出）时丢弃余量，聚合器随之自然结束
    let _ = output.send(std::mem::take(batch)).await;
}

#[cfg(test)]
mod tests {
    use super::super::{AgentEvent, StopReason, ToolKind};
    use super::EventAggregator;
    use std::time::{Duration, Instant};

    use tokio::sync::mpsc;

    fn chunk(message_id: &str, text: &str) -> AgentEvent {
        AgentEvent::MessageChunk {
            message_id: message_id.into(),
            text: text.into(),
        }
    }

    fn tool_call(tool_call_id: &str) -> AgentEvent {
        AgentEvent::ToolCall {
            tool_call_id: tool_call_id.into(),
            name: "bash".into(),
            title: None,
            kind: ToolKind::Execute,
            raw_input: serde_json::json!({"command": "git status"}),
        }
    }

    /// 收集聚合器全部输出直到其结束（调用方需已 drop input sender）。
    async fn collect_all(mut output: mpsc::Receiver<Vec<AgentEvent>>) -> Vec<AgentEvent> {
        let mut events = Vec::new();
        while let Some(batch) = output.recv().await {
            events.extend(batch);
        }
        events
    }

    /// 验收标准：100 条同 id MessageChunk 合并为一条，文本完整拼接
    #[tokio::test]
    async fn 相邻同id的chunk合并为一条() {
        // tick 调大到 1h：关闭前不触发周期 flush，保证条数确定性
        let aggregator = EventAggregator::new(Duration::from_secs(3600));
        let (tx_in, rx_in) = mpsc::channel(1024);
        let (tx_out, rx_out) = mpsc::channel(1024);

        let task = tokio::spawn(aggregator.run(rx_in, tx_out));
        for _ in 0..100 {
            tx_in.send(chunk("m1", "x")).await.unwrap();
        }
        drop(tx_in);
        task.await.unwrap();

        let events = collect_all(rx_out).await;
        assert_eq!(events.len(), 1, "100 条同 id chunk 应合并为 1 条");
        assert_eq!(
            events[0],
            AgentEvent::MessageChunk {
                message_id: "m1".into(),
                text: "x".repeat(100),
            }
        );
    }

    /// 验收标准：混合事件切断合并，输出条数与顺序保持
    #[tokio::test]
    async fn 混合事件切断合并且顺序保持() {
        let aggregator = EventAggregator::new(Duration::from_secs(3600));
        let (tx_in, rx_in) = mpsc::channel(1024);
        let (tx_out, rx_out) = mpsc::channel(1024);

        let task = tokio::spawn(aggregator.run(rx_in, tx_out));
        for event in [
            chunk("a", "1"),
            chunk("a", "2"), // 与上一条合并 → "12"
            tool_call("t1"), // 切断合并
            chunk("a", "3"), // 不得跨工具调用回拼到 "12"
            chunk("b", "4"), // 不同 id，不合并
            AgentEvent::TurnCompleted {
                stop_reason: StopReason::EndTurn,
            },
        ] {
            tx_in.send(event).await.unwrap();
        }
        drop(tx_in);
        task.await.unwrap();

        let events = collect_all(rx_out).await;
        assert_eq!(events.len(), 5, "6 条输入 → 1+1+1+1+1 = 5 条输出");
        assert_eq!(events[0], chunk("a", "12"));
        assert!(
            matches!(&events[1], AgentEvent::ToolCall { tool_call_id, .. } if tool_call_id == "t1")
        );
        assert_eq!(events[2], chunk("a", "3"));
        assert_eq!(events[3], chunk("b", "4"));
        assert_eq!(
            events[4],
            AgentEvent::TurnCompleted {
                stop_reason: StopReason::EndTurn,
            }
        );
    }

    /// 周期 flush：输入未关闭时，到 tick 也必须输出（实时性，不能只靠关闭 flush）
    #[tokio::test]
    async fn 到tick周期即使输入未关闭也flush() {
        let aggregator = EventAggregator::new(Duration::from_millis(10));
        let (tx_in, rx_in) = mpsc::channel(1024);
        let (tx_out, mut rx_out) = mpsc::channel(1024);

        let task = tokio::spawn(aggregator.run(rx_in, tx_out));
        tx_in.send(chunk("m1", "a")).await.unwrap();
        tx_in.send(chunk("m1", "b")).await.unwrap();
        tx_in.send(chunk("m1", "c")).await.unwrap();

        let deadline = Instant::now() + Duration::from_millis(500);
        let batch = tokio::time::timeout_at(deadline.into(), rx_out.recv())
            .await
            .expect("500ms 内应收到一个批次")
            .expect("聚合器不应已退出");
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0], chunk("m1", "abc"));

        drop(tx_in);
        task.await.unwrap();
    }

    /// 不同 message_id 相邻不合并
    #[tokio::test]
    async fn 不同id相邻不合并() {
        let aggregator = EventAggregator::new(Duration::from_secs(3600));
        let (tx_in, rx_in) = mpsc::channel(1024);
        let (tx_out, rx_out) = mpsc::channel(1024);

        let task = tokio::spawn(aggregator.run(rx_in, tx_out));
        tx_in.send(chunk("a", "1")).await.unwrap();
        tx_in.send(chunk("b", "2")).await.unwrap();
        drop(tx_in);
        task.await.unwrap();

        let events = collect_all(rx_out).await;
        assert_eq!(events, vec![chunk("a", "1"), chunk("b", "2")]);
    }
}
