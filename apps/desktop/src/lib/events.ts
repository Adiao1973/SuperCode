/**
 * AgentEvent 的 TypeScript 镜像（architecture §4.1 / §5.1 前端契约）。
 * 序列化格式由 crates/core/src/events/mod.rs 单测锁死：tag=type、snake_case。
 * 两端字段必须逐一对齐，Rust 侧 Option 序列化为 null。
 */

export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "fetch"
  | "other";

export type ToolStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed";

export type StopReason =
  | "end_turn"
  | "cancelled"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal";

export type PlanEntryStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mime_type: string }
  | { type: "resource_link"; uri: string };

export interface FileLocation {
  path: string;
  line?: number | null;
}

export interface PlanEntry {
  content: string;
  status: PlanEntryStatus;
}

export type AgentEvent =
  | { type: "session_started"; session_id: string }
  | { type: "message_chunk"; message_id: string; text: string }
  | { type: "thought_chunk"; message_id: string; text: string }
  | {
      type: "tool_call";
      tool_call_id: string;
      name?: string | null;
      title?: string | null;
      kind: ToolKind;
      raw_input?: unknown;
    }
  | {
      type: "tool_call_update";
      tool_call_id: string;
      status?: ToolStatus | null;
      content: ContentBlock[];
      locations: FileLocation[];
      diff?: string | null;
    }
  | { type: "plan"; entries: PlanEntry[] }
  | { type: "usage_update"; used?: number | null; size?: number | null; cost?: number | null }
  | { type: "turn_completed"; stop_reason: StopReason }
  | { type: "driver_error"; message: string };
