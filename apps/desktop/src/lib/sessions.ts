/**
 * 多会话前端状态模型（P1-3）：客户端会话键 → 草稿 + 事件流 + ACP 会话 id。
 * 事件经 Channel 回调按 key 路由，活动会话之外的流在后台照常更新。
 * Rust 侧 run_prompt 天然支持并发（每运行独立进程与合帧管道）。
 */

import type { AgentEvent } from "./events";
import { beginRun, initialStream, streamReducer, type StreamState } from "./stream";

/** 预授权规则默认值（每行一条） */
export const DEFAULT_RULES = "read\nwrite\nedit\nbash(ls *)";

export interface SessionDraft {
  prompt: string;
  cwd: string;
  rulesText: string;
}

export interface SessionEntry {
  /** 客户端会话键：事件路由的稳定标识（ACP session_id 建立前事件就已到达） */
  key: string;
  /** ACP 侧会话 id（SessionStarted 后可用；cancel_run 需要） */
  acpSessionId: string | null;
  title: string;
  draft: SessionDraft;
  stream: StreamState;
  /** run_prompt invoke 失败信息（区别于流内 driver_error） */
  invokeError: string | null;
}

export interface SessionsState {
  items: SessionEntry[];
  activeKey: string | null;
}

export type SessionsAction =
  | { type: "new"; cwd?: string }
  | { type: "activate"; key: string }
  | { type: "patchDraft"; key: string; patch: Partial<SessionDraft> }
  /** 开跑：清空事件流并置 running（P1-3 重构时曾遗漏导致按钮/列表状态失灵） */
  | { type: "begin"; key: string }
  | { type: "batch"; key: string; batch: AgentEvent[] }
  | { type: "invokeError"; key: string; message: string | null };

let sessionSeq = 0;

function makeEntry(cwd?: string): SessionEntry {
  sessionSeq += 1;
  return {
    key: `s-${sessionSeq}`,
    acpSessionId: null,
    title: "新会话",
    draft: { prompt: "", cwd: cwd ?? "/tmp/supercode-p13", rulesText: DEFAULT_RULES },
    stream: initialStream,
    invokeError: null,
  };
}

/** 初始状态：预建一个草稿会话，省一次点击 */
export function initialSessionsState(cwd?: string): SessionsState {
  const first = makeEntry(cwd);
  return { items: [first], activeKey: first.key };
}

function updateEntry(
  state: SessionsState,
  key: string,
  fn: (entry: SessionEntry) => SessionEntry,
): SessionsState {
  return {
    ...state,
    items: state.items.map((it) => (it.key === key ? fn(it) : it)),
  };
}

export function sessionsReducer(
  state: SessionsState,
  action: SessionsAction,
): SessionsState {
  switch (action.type) {
    case "new": {
      const entry = makeEntry(action.cwd);
      return { items: [...state.items, entry], activeKey: entry.key };
    }
    case "activate":
      return { ...state, activeKey: action.key };
    case "patchDraft":
      return updateEntry(state, action.key, (it) => ({
        ...it,
        draft: { ...it.draft, ...action.patch },
      }));
    case "begin":
      return updateEntry(state, action.key, (it) => ({
        ...it,
        // 旧运行的 acpSessionId 必须清掉：新运行拿到新 id，
        // 残留旧 id 会让 cancel_run 打到已结束的会话上（"不在运行中"）
        acpSessionId: null,
        stream: beginRun(),
        invokeError: null,
      }));
    case "batch": {
      const entry = state.items.find((it) => it.key === action.key);
      if (!entry) {
        return state;
      }
      const stream = streamReducer(entry.stream, { type: "batch", batch: action.batch });
      // 首批事件到达时用提示词命名会话；session_started 顺带记录 ACP 会话 id
      const title =
        entry.title === "新会话" && entry.draft.prompt.trim()
          ? entry.draft.prompt.trim().slice(0, 24)
          : entry.title;
      const acpSessionId =
        entry.acpSessionId ??
        action.batch.find((ev) => ev.type === "session_started")?.session_id ??
        null;
      return updateEntry(state, action.key, (it) => ({
        ...it,
        title,
        acpSessionId,
        stream,
        invokeError: stream.running ? null : it.invokeError,
      }));
    }
    case "invokeError":
      return updateEntry(state, action.key, (it) => ({
        ...it,
        invokeError: action.message,
      }));
  }
}

/** 会话列表项的状态呈现 */
export function sessionStatus(entry: SessionEntry): {
  label: string;
  tone: "running" | "done" | "failed" | "idle";
} {
  if (entry.stream.running) {
    return { label: "运行中", tone: "running" };
  }
  const last = entry.stream.items[entry.stream.items.length - 1];
  if (last?.kind === "error") {
    return { label: "出错", tone: "failed" };
  }
  if (last?.kind === "turn_end") {
    return {
      label: last.stopReason === "cancelled" ? "已取消" : "已完成",
      tone: "done",
    };
  }
  return { label: "空闲", tone: "idle" };
}
