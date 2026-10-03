import { invoke } from "@tauri-apps/api/core";

// Nested IPC config deliberately matches the core JSON contract (snake_case).
export interface CommanderConfig {
  endpoint: string;
  model: string;
  api_key_env: string;
  timeout_secs: number;
}
export function getCommanderConfig(): Promise<CommanderConfig | null> {
  return invoke("get_commander_config");
}
export function saveCommanderConfig(config: CommanderConfig): Promise<void> {
  return invoke("save_commander_config", { config });
}

export function listCommanderModels(config: CommanderConfig): Promise<string[]> {
  return invoke("list_commander_models", { config });
}

export type CredentialSource = "sqlite" | "environment" | "missing";
export function saveCommanderKey(config: CommanderConfig, key: string): Promise<void> {
  return invoke("save_commander_key", { config, key });
}
export function commanderCredentialSource(config: CommanderConfig): Promise<CredentialSource> {
  return invoke("commander_credential_source", { config });
}
export interface CommanderPlan {
  plan: { objective: string; tasks: { id: string; title: string; agent_id: string; prompt: string; depends_on: string[] }[] };
  batches: string[][];
}
export function verifyCommanderPlan(requestId: string): Promise<CommanderPlan> {
  return invoke("verify_commander_plan", { requestId });
}
export function cancelCommanderPlan(requestId: string): Promise<void> {
  return invoke("cancel_commander_plan", { requestId });
}

export type RunStatus = "draft" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
export type TaskStatus = RunStatus | "pending" | "skipped";
export interface RunView {
  run: { id: string; cwd: string; status: RunStatus; plan: CommanderPlan["plan"] };
  summary: { tasks: { id: string; title: string; agent_id: string; depends_on: string[]; status: TaskStatus; session_id: string | null; agent_session_id: string | null; result: string | null; truncated: boolean }[] };
  batches: string[][];
  active: boolean;
}
export function listCommanderRuns(): Promise<RunView[]> { return invoke("list_commander_run_views"); }
export function getCommanderRun(runId: string): Promise<RunView> { return invoke("get_commander_run_view", { runId }); }
export function generateCommanderRun(requestId: string, objective: string, cwd: string, agents: string[]): Promise<RunView> { return invoke("generate_commander_run", { requestId, objective, cwd, agents }); }
export function cancelCommanderWork(requestId: string): Promise<void> { return invoke("cancel_commander_work", { requestId }); }
