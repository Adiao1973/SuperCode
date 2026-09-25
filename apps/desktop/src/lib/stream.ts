/**
 * 事件流前端状态模型：AgentEvent 批 → 可渲染的 StreamItem 时间线。
 * 纪律（architecture §5）：每个 Channel 批只 dispatch 一次；
 * 已完成条目保持引用不变（配合 React.memo，只有活动 chunk 重渲染）。
 */

import type {
  AgentEvent,
  DiffPayload,
  FileLocation,
  PlanEntry,
  StopReason,
  ToolKind,
  ToolStatus,
} from "./events";

export type StreamItem =
  | { key: string; kind: "thought"; id: string; text: string; active: boolean }
  | { key: string; kind: "message"; id: string; text: string; active: boolean }
  | {
      key: string;
      kind: "tool";
      id: string;
      name: string | null;
      title: string | null;
      toolKind: ToolKind;
      status: ToolStatus;
      content: string[];
      locations: FileLocation[];
      diff: DiffPayload | null;
    }
  | { key: string; kind: "plan"; entries: PlanEntry[] }
  | { key: string; kind: "turn_end"; stopReason: StopReason }
  | { key: string; kind: "error"; message: string };

export interface StreamState {
  items: StreamItem[];
  running: boolean;
  usage: { used: number | null; size: number | null; cost: number | null };
}

export const initialStream: StreamState = {
  items: [],
  running: false,
  usage: { used: null, size: null, cost: null },
};

/** React key 生成：agent 侧 message_id 可能跨轮重复（如合成的 agent-message），不能直接当 key */
let keySeq = 0;
function nextKey(prefix: string): string {
  keySeq += 1;
  return `${prefix}-${keySeq}`;
}

export function beginRun(): StreamState {
  return { items: [], running: true, usage: initialStream.usage };
}

export type StreamAction =
  | { type: "begin" }
  | { type: "batch"; batch: AgentEvent[] };

export function streamReducer(
  state: StreamState,
  action: StreamAction,
): StreamState {
  if (action.type === "begin") {
    return beginRun();
  }
  return applyBatch(state, action.batch);
}

function applyBatch(state: StreamState, batch: AgentEvent[]): StreamState {
  let items = state.items;
  let usage = state.usage;
  let running = state.running;

  for (const ev of batch) {
    switch (ev.type) {
      case "session_started":
        break;
      case "message_chunk":
        items = appendChunk(items, "message", ev.message_id, ev.text);
        break;
      case "thought_chunk":
        items = appendChunk(items, "thought", ev.message_id, ev.text);
        break;
      case "tool_call":
        items = [
          ...items,
          {
            key: nextKey("tool"),
            kind: "tool",
            id: ev.tool_call_id,
            name: ev.name ?? null,
            title: ev.title ?? null,
            toolKind: ev.kind,
            status: "pending",
            content: [],
            locations: [],
            diff: ev.diff ?? null,
          },
        ];
        break;
      case "tool_call_update": {
        items = items.slice();
        for (let i = items.length - 1; i >= 0; i--) {
          const it = items[i];
          if (it.kind === "tool" && it.id === ev.tool_call_id) {
            items[i] = {
              ...it,
              status: ev.status ?? it.status,
              content: [
                ...it.content,
                ...ev.content
                  .filter((b): b is { type: "text"; text: string } => b.type === "text")
                  .map((b) => b.text),
              ],
              locations: ev.locations.length > 0 ? ev.locations : it.locations,
              diff: ev.diff ?? it.diff,
            };
            break;
          }
        }
        break;
      }
      case "plan":
        items = [
          ...items,
          { key: nextKey("plan"), kind: "plan", entries: ev.entries },
        ];
        break;
      case "usage_update":
        usage = { used: ev.used ?? null, size: ev.size ?? null, cost: ev.cost ?? null };
        break;
      case "turn_completed":
        items = [
          ...closeActive(items),
          { key: nextKey("turn"), kind: "turn_end", stopReason: ev.stop_reason },
        ];
        running = false;
        break;
      case "driver_error":
        items = [
          ...closeActive(items),
          { key: nextKey("err"), kind: "error", message: ev.message },
        ];
        running = false;
        break;
    }
  }

  return { items, usage, running };
}

/** 相邻同 id 且活动的 chunk 原位追加；否则新起一条（跨工具调用断续可接受） */
function appendChunk(
  items: StreamItem[],
  kind: "message" | "thought",
  id: string,
  text: string,
): StreamItem[] {
  const last = items[items.length - 1];
  if (last && last.kind === kind && last.id === id && last.active) {
    const next = items.slice();
    next[next.length - 1] = { ...last, text: last.text + text };
    return next;
  }
  return [
    ...items,
    { key: nextKey(kind), kind, id, text, active: true },
  ];
}

/** 结束流：只拷贝仍在活动的条目，已完成条目引用不变 */
function closeActive(items: StreamItem[]): StreamItem[] {
  return items.map((it) =>
    "active" in it && it.active ? { ...it, active: false } : it,
  );
}
