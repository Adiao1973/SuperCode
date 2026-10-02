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
