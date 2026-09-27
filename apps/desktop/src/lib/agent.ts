/**
 * supercode-desktop Tauri 命令封装（architecture §5.1 IPC 契约）。
 * invoke 参数用 camelCase，Tauri 自动映射到 Rust 侧 snake_case 形参。
 */

import { Channel, invoke } from "@tauri-apps/api/core";
import type { AgentEvent } from "./events";

export interface RunInfo {
  session_id: string;
}

export function runPrompt(options: {
  prompt: string;
  cwd: string;
  allow: string[];
  deny: string[];
  mode: string;
  /** 续聊既有会话的 agent_session_id（P1-6：session/load 恢复上下文） */
  resumeSessionId?: string | null;
  /** 归属工作空间（P1-8，ADR-0007）；缺省 → 默认空间 */
  workspaceId?: string | null;
  onEvents: (batch: AgentEvent[]) => void;
}): Promise<RunInfo> {
  const channel = new Channel<AgentEvent[]>();
  channel.onmessage = options.onEvents;
  return invoke<RunInfo>("run_prompt", {
    prompt: options.prompt,
    cwd: options.cwd,
    allow: options.allow,
    deny: options.deny,
    mode: options.mode,
    resumeSessionId: options.resumeSessionId ?? null,
    workspaceId: options.workspaceId ?? null,
    onEvents: channel,
  });
}

/** 工作空间（P1-8，ADR-0007）：project 空间绑定项目根路径；默认空间单例不绑路径 */
export interface Workspace {
  id: string;
  name: string;
  path: string | null;
  kind: "project" | "default";
}

export function listWorkspaces(): Promise<Workspace[]> {
  return invoke("list_workspaces");
}

/** 新建（或返回既有）项目空间：目录须已存在，name 取目录名 */
export function createWorkspace(path: string): Promise<Workspace> {
  return invoke("create_workspace", { path });
}

/** 删除项目空间：会话移入默认空间，不级联删 */
export function deleteWorkspace(id: string): Promise<void> {
  return invoke("delete_workspace", { id });
}

export interface HistorySession {
  agent_session_id: string;
  cwd: string;
  title: string;
  status: string;
  updated_at: string;
  workspace_id: string;
}

export function listHistorySessions(): Promise<HistorySession[]> {
  return invoke("list_history_sessions");
}

export interface HistoryMessage {
  role: string;
  text: string;
  created_at: string;
}

export function listSessionMessages(agentSessionId: string): Promise<HistoryMessage[]> {
  return invoke("list_session_messages", { agentSessionId });
}

/** 删除会话（SuperCode 侧级联删除；运行中会被拒绝） */
export function deleteSession(agentSessionId: string): Promise<void> {
  return invoke("delete_session", { agentSessionId });
}

export function cancelRun(sessionId: string): Promise<void> {
  return invoke("cancel_run", { sessionId });
}

/** 运行中热切换权限模式（plan/ask/autoedit/full，§4.3 管线） */
export function setPermissionMode(sessionId: string, mode: string): Promise<void> {
  return invoke("set_permission_mode", { sessionId, mode });
}

/** 审批中心应答待决请求 */
export function respondPermission(requestId: string, optionId: string): Promise<void> {
  return invoke("respond_permission", { requestId, optionId });
}

export interface RuleEntry {
  id: string;
  pattern: string;
  effect: "allow" | "deny" | "ask";
}

export function listRules(): Promise<RuleEntry[]> {
  return invoke("list_rules");
}

export function addRule(pattern: string, effect: string): Promise<RuleEntry> {
  return invoke("add_rule", { pattern, effect });
}

export function deleteRule(id: string): Promise<void> {
  return invoke("delete_rule", { id });
}

/** 读取文本文件（write 工具 diff 展开时从磁盘取内容，opencode ACP 事件不携带） */
export function readTextFile(path: string): Promise<string> {
  return invoke("read_text_file", { path });
}
