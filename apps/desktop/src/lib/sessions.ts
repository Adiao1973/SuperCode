/**
 * 多会话前端状态模型（P1-3）：客户端会话键 → 草稿 + 事件流 + ACP 会话 id。
 * 事件经 Channel 回调按 key 路由，活动会话之外的流在后台照常更新。
 * Rust 侧 run_prompt 天然支持并发（每运行独立进程与合帧管道）。
 */

import type { AgentEvent } from "./events";
import type { HistoryMessage, HistorySession } from "./agent";
import type { PendingPermission } from "./permissions";
import { beginRun, initialStream, streamReducer, type StreamState } from "./stream";

/** 预授权规则默认值（每行一条） */
export const DEFAULT_RULES = "read\nwrite\nedit\nbash(ls *)";

export interface SessionDraft {
  prompt: string;
  cwd: string;
  rulesText: string;
  /** 会话级权限模式（ADR-0006），运行时传入 broker，可热切换 */
  mode: string;
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
  /** 会话内联待决审批（P1-5：按 ACP session id 路由到对应会话） */
  pendingApprovals: PendingPermission[];
  /** 可续聊：历史加载的会话或跑完过一轮的会话（运行 = session/load 恢复上下文） */
  resumable: boolean;
}

export interface SessionsState {
  items: SessionEntry[];
  activeKey: string | null;
}

export type SessionsAction =
  | { type: "new"; cwd?: string }
  | { type: "activate"; key: string }
  | { type: "patchDraft"; key: string; patch: Partial<SessionDraft> }
  | { type: "batch"; key: string; batch: AgentEvent[] }
  | { type: "invokeError"; key: string; message: string | null }
  /** DEV 专用：注入合成事件（虚拟列表滚动压测，P1-4） */
  | { type: "seed"; key: string }
  /** 内联审批（P1-5）：待决请求按 ACP session id 路由；裁决后按 tool_call_id 移除 */
  | { type: "approvalAdd"; acpSessionId: string; pending: PendingPermission }
  | { type: "approvalRemoveByTool"; acpSessionId: string; toolCallId: string }
  /** 续聊开跑（P1-6）：保留事件流与 acpSessionId，只置 running */
  | { type: "begin"; key: string; resume: boolean }
  /** 历史消息加载（P1-6）：落库消息填充 items */
  | { type: "historyLoaded"; key: string; messages: HistoryMessage[] }
  /** 历史会话注入（P1-6：启动时） */
  | { type: "hydrate"; sessions: HistorySession[] };

let sessionSeq = 0;

function makeEntry(cwd?: string): SessionEntry {
  sessionSeq += 1;
  return {
    key: `s-${sessionSeq}`,
    acpSessionId: null,
    title: "新会话",
    draft: {
      prompt: "",
      cwd: cwd ?? "/tmp/supercode-p13",
      rulesText: DEFAULT_RULES,
      mode: "ask",
    },
    stream: initialStream,
    invokeError: null,
    pendingApprovals: [],
    resumable: false,
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
      return updateEntry(state, action.key, (it) =>
        action.resume
          ? // 续聊：保留 acpSessionId，流清空——session/load 会重放完整历史，
            // 重放事件即渲染源（与落库预览叠加会重复，P1-6 验收实证）
            { ...it, resumable: false, stream: beginRun(), invokeError: null }
          : // 新跑：旧 id 必须清（残留会让 cancel_run 打到已结束会话），流重置
            {
              ...it,
              acpSessionId: null,
              resumable: false,
              stream: beginRun(),
              invokeError: null,
            },
      );
    case "historyLoaded": {
      // 幂等：StrictMode 双触发 effect 时不能叠加——先移除旧 hist- 条目再前置
      const hist: StreamState["items"] = action.messages.map((message, i) => ({
        key: `hist-${i}`,
        kind: message.role === "user" ? "user_message" : "message",
        id: `hist-${i}`,
        text: message.text,
        active: false,
      }));
      return updateEntry(state, action.key, (it) => ({
        ...it,
        stream: {
          ...it.stream,
          items: [...hist, ...it.stream.items.filter((item) => !item.key.startsWith("hist-"))],
        },
      }));
    }
    case "hydrate": {
      // 历史会话注入列表头部（最近在前）；已存在的 acpSessionId 跳过
      const existing = new Set(
        state.items.map((it) => it.acpSessionId).filter(Boolean),
      );
      const hydrated = action.sessions
        .filter((session) => !existing.has(session.agent_session_id))
        .map((session): SessionEntry => ({
          key: `h-${session.agent_session_id.slice(-12)}`,
          acpSessionId: session.agent_session_id,
          title: session.title || "历史会话",
          draft: { prompt: "", cwd: session.cwd, rulesText: DEFAULT_RULES, mode: "ask" },
          stream: initialStream,
          invokeError: null,
          pendingApprovals: [],
          resumable: true,
        }));
      return { ...state, items: [...hydrated, ...state.items] };
    }
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
        // P1-6：一轮跑完（或出错）后该会话可续聊——下一轮 session/load 恢复上下文
        resumable: !stream.running && acpSessionId != null ? true : it.resumable,
        invokeError: stream.running ? null : it.invokeError,
      }));
    }
    case "approvalAdd":
      // 注意按 ACP session id 匹配（事件携带的是 ACP id，非客户端 key）
      return {
        ...state,
        items: state.items.map((it) =>
          it.acpSessionId === action.acpSessionId &&
          !it.pendingApprovals.some((p) => p.id === action.pending.id)
            ? { ...it, pendingApprovals: [...it.pendingApprovals, action.pending] }
            : it,
        ),
      };
    case "approvalRemoveByTool":
      return {
        ...state,
        items: state.items.map((it) =>
          it.acpSessionId === action.acpSessionId
            ? {
                ...it,
                pendingApprovals: it.pendingApprovals.filter(
                  (p) => p.request.tool_call_id !== action.toolCallId,
                ),
              }
            : it,
        ),
      };
    case "seed":
      return updateEntry(state, action.key, (it) => ({
        ...it,
        title: it.title === "新会话" ? "压测会话" : it.title,
        stream: seededStream(),
      }));
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

/** DEV 压测数据：320 条合成条目（虚拟列表滚动性能验收用，P1-4） */
function seededStream(): StreamState {
  const items: StreamState["items"] = [];
  for (let i = 1; i <= 80; i++) {
    items.push({
      key: `seed-t-${i}`,
      kind: "thought",
      id: `seed-thought-${i}`,
      text: `（压测 ${i}）正在分析第 ${i} 个子任务……`,
      active: false,
    });
    items.push({
      key: `seed-m-${i}`,
      kind: "message",
      id: `seed-msg-${i}`,
      text: `（压测 ${i}）第 ${i} 步已完成：文件 chunk-${String(i).padStart(3, "0")}.txt 已写入并通过校验。`,
      active: false,
    });
    items.push({
      key: `seed-tool-${i}`,
      kind: "tool",
      id: `seed-call-${i}`,
      name: "write",
      title: `chunk-${String(i).padStart(3, "0")}.txt`,
      toolKind: "edit",
      status: "completed",
      content: ["Wrote file successfully."],
      locations: [{ path: `/tmp/seed/chunk-${String(i).padStart(3, "0")}.txt` }],
      diff: {
        path: `/tmp/seed/chunk-${String(i).padStart(3, "0")}.txt`,
        old_text: null,
        new_text: `line 1 of chunk ${i}\nline 2 of chunk ${i}\nline 3 of chunk ${i}\n`,
      },
    });
  }
  items.push({
    key: "seed-turn",
    kind: "turn_end",
    stopReason: "end_turn",
  });
  return { items, running: false, usage: { used: 0, size: null, cost: 0 } };
}
