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
    onEvents: channel,
  });
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
