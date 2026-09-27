/**
 * opencode 环境探测（P1-7，architecture §4.7/§5.1）。
 * Rust 侧 envcheck 只产事实；安装/收紧/模型的引导文案集中在这里。
 */

import { invoke } from "@tauri-apps/api/core";

/** opencode permission 条目解析结果（not_configured 按 opencode 默认 = 放行） */
export type PermissionLevel =
  | "not_configured"
  | "allow"
  | "ask"
  | "deny"
  | "custom"
  | "unparseable";

export interface OpencodeEnvReport {
  installed: boolean;
  version: string | null;
  bin_path: string | null;
  probe_error: string | null;
  global_config_path: string | null;
  global_model: string | null;
  global_edit: PermissionLevel;
  global_bash: PermissionLevel;
  project_config_path: string | null;
  project_edit: PermissionLevel;
  project_bash: PermissionLevel;
  /** 有效 edit ∧ bash 均 ∈ {ask, deny, custom}（项目覆盖全局） */
  strict: boolean;
  config_error: string | null;
}

/** cwd=Some 时附检 `<cwd>/opencode.json(c)` 项目级配置 */
export function checkOpencodeEnv(cwd: string | null): Promise<OpencodeEnvReport> {
  return invoke("check_opencode_env", { cwd });
}

export const LEVEL_LABEL: Record<
  PermissionLevel,
  { text: string; ok: boolean }
> = {
  not_configured: { text: "未配置（默认放行）", ok: false },
  allow: { text: "放行", ok: false },
  ask: { text: "逐次询问", ok: true },
  deny: { text: "拒绝", ok: true },
  custom: { text: "自定义规则", ok: true },
  unparseable: { text: "无法识别", ok: false },
};

export const INSTALL_GUIDE = `# 官方安装脚本（macOS / Linux）
curl -fsSL https://opencode.ai/install | bash

# 或 Homebrew
brew install sst/tap/opencode

# 安装后重启 SuperCode 并验证
opencode --version`;

/** 严格模式配置片段：写入会话工作目录（项目级）或全局配置均可，项目级优先 */
export function strictGuideSnippet(cwd?: string | null): string {
  const target = cwd ? `${cwd}/opencode.jsonc` : "<会话工作目录>/opencode.jsonc";
  return `// ${target}
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "edit": "ask",
    "bash": "ask"
  }
}`;
}

export const MODEL_GUIDE = `// ~/.config/opencode/opencode.jsonc（全局；项目级 opencode.jsonc 同样有效）
{
  "$schema": "https://opencode.ai/config.json",
  "model": "<provider>/<model>"
}

// 例（P0-4 实证）："model": "zhipuai-coding-plan/glm-5.3-flash"`;

/** 管辖边界一句话：为什么客户端模式/规则管不住 opencode 静默放行的操作 */
export const JURISDICTION_NOTE =
  "opencode 默认 bash/edit=allow，安全命令与新建文件不发权限询问；" +
  "SuperCode 的模式与规则只能裁决 agent 主动询问的操作（ADR-0006 管辖边界）。" +
  "开启严格模式后，所有 bash/edit 都会转发到 SuperCode 审批。";
