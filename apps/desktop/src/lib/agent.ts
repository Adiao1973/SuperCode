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
  agentId: string;
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
    agentId: options.agentId,
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

/** 任务条目（P1-9 简版看板：标题+空间+绑定会话+状态） */
export interface TaskEntry {
  id: string;
  workspace_id: string;
  title: string;
  /** 绑定的 agent 会话 id（None=未指派） */
  session_id: string | null;
  status: "backlog" | "in_progress" | "review" | "done";
}

export function listTasks(): Promise<TaskEntry[]> {
  return invoke("list_tasks");
}

export function createTask(title: string, workspaceId: string): Promise<TaskEntry> {
  return invoke("create_task", { title, workspaceId });
}

/** 更新任务：session_id 空串=解绑（IPC 无法传 SQL NULL 的约定） */
export function updateTask(
  id: string,
  patch: { status?: TaskEntry["status"]; sessionId?: string },
): Promise<TaskEntry> {
  return invoke("update_task", {
    id,
    status: patch.status ?? null,
    sessionId: patch.sessionId ?? null,
  });
}

export function deleteTask(id: string): Promise<void> {
  return invoke("delete_task", { id });
}

export interface HistorySession {
  agent_id: string;
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

/** Agent 注册表行（P2-2，§5.1 AgentRow） */
export interface AgentRow {
  id: string;
  display_name: string;
  driver_kind: "acp" | "stream_json" | "native";
  command: string;
  version_args: string[];
  acp_process_cwd: boolean;
  capabilities: {
    supports_load_session: boolean;
    supports_diff: boolean;
    supports_permission: boolean;
  };
  /** id 出现在用户自定义文件（含覆盖内置） */
  is_user_defined: boolean;
  installed_version: string | null;
}

/** 新增/更新自定义 agent 入参（能力位扁平化） */
export interface AgentInput {
  id: string;
  displayName: string;
  driverKind: "acp" | "stream_json" | "native";
  command: string;
  versionArgs: string[];
  acpProcessCwd: boolean;
  supportsLoadSession: boolean;
  supportsDiff: boolean;
  supportsPermission: boolean;
}

/** 注册表合并视图 + 并行安装探测 */
export function listAgents(): Promise<AgentRow[]> {
  return invoke("list_agents");
}

/** 会话选择器只读定义，不启动 npx 版本探测 */
export function listAgentDefinitions(): Promise<AgentRow[]> {
  return invoke("list_agent_definitions");
}

/** 新增（或同 id 覆盖）用户自定义 agent → ~/.supercode/agents.json */
export function addAgent(input: AgentInput): Promise<AgentRow> {
  return invoke("add_agent", { input });
}

export function updateAgent(input: AgentInput): Promise<AgentRow> {
  return invoke("update_agent", { input });
}

/** 删除用户自定义条目；覆盖内置时恢复出厂定义 */
export function deleteAgent(id: string): Promise<void> {
  return invoke("delete_agent", { id });
}

export interface NodeEnvReport {
  node_version: string | null;
  npx_version: string | null;
}
export function checkNodeEnv(): Promise<NodeEnvReport> {
  return invoke("check_node_env");
}
