---
feature: p2-2-agent-settings-ui
status: delivered
updated: 2026-09-28
branch: feat/p2-2-agent-settings-ui
commits: d1b1a9c..f943fd9
---

# P2-2 设置 UI：Agent 管理页

> 项目覆盖说明：分支/验收遵循 `docs/development-process.md`（feat 分支从 dev 切出、`--no-ff` 合回）；
> 接口契约以 `docs/architecture.md` 为单一事实源（文档先行），本文档记录任务分解与交付报告。

## Report

**What was built** — 设置页新增「Agent 管理」区块：注册表合并视图列表（五内置 + 用户自定义），
安装徽标/版本（绿 ✓ 版本号 / 琥珀 — 未安装）、driver 徽标、等宽 command 行；未安装项展开
可复制安装指引（内置五条已知命令，zcode 为桌面版软链引导）；自定义条目可删除（含覆盖内置
id——删除恢复出厂）。新增表单（id/displayName/command/versionArgs/driverKind/能力位三复选）
写 `~/.supercode/agents.json`（原子写：临时文件 + rename）。core 补用户文件写路径
（load_user_entries/save/upsert/remove + `_at` 路径参数形态），`probe_installed` 并行探测。
桌面 IPC：`list_agents` / `add_agent` / `update_agent` / `delete_agent` + `AgentRow`。

**Verification** — `just verify` PASS（core 61 + desktop 2 = 63 测试 0 失败）；
`supercode detect` PASS（OpenCode 1.18.30 / Claude Code 0.81.2 / Codex 1.13.1 / MiMo — / ZCode 0.16.9）；
设置页实机截图核对列表/徽标/安装引导；独立审查 1 critical（AgentInput casing）已修复并复审 PASS。

**Journey log** —
- zcode 误报未安装：用户实机发现。根因是 ZCode.app 桌面版把 CLI 嵌在 `…/Resources/glm/zcode.cjs`，不注册 PATH 命令——探测逻辑正确，安装形态特殊。安装引导改为软链命令后 `detect` 即 ✓。与 P1-10 GUI PATH 同类问题：环境形态差异由产品引导兜底。
- Tauri v2 `#[tauri::command]` 仅映射**顶层**形参 casing；嵌套 struct 走 serde 原样匹配——`AgentInput` 需显式 `rename_all="camelCase"`。项目首个嵌套命令入参即踩坑，回归测用完整 camelCase JSON 锁定。
- `just verify` 单测不覆盖 Tauri IPC 反序列化层；IPC 入参 DTO 需补 serde JSON 级测试。
- zcode 0.16.9 实测 help 为 `--json`，与架构表 `--output-format stream-json` 不符（P2-6 预警已记 roadmap）。

## [S1] Problem

P2-1 已把注册表做成机制（五内置 + `~/.supercode/agents.json` 用户自定义 + 探测），
但桌面端设置页只有 opencode 环境面板与规则库——用户看不到全部注册 agent 的安装状态，
无法在 UI 中新增自定义 agent，未安装项也没有可复制的安装引导。多 agent 总控的产品面缺失入口。

## [S2] Design

### 视角

设置页新增「Agent 管理」区块（置于 opencode 环境面板之前）：
列表展示全部注册 agent（内置+用户），每行含安装徽标/版本、驱动种类、command（等宽）；
未安装项给出可复制安装命令；用户自定义条目可删除（含覆盖内置的条目——删除即恢复内置）。
新增自定义 agent 表单写入 `~/.supercode/agents.json`，重启后仍在。

### core 写路径（registry 模块扩展）

P2-1 只有读合并（`merge_user_file`）。补写路径，与 §4.4 用户自定义格式一致：

```rust
/// 仅用户文件中的条目（不含内置）
pub fn load_user_entries() -> Vec<AgentDefinition>;
/// 原子写回用户文件（目录自动创建；临时文件 + rename）
pub fn save_user_entries(entries: &[AgentDefinition]) -> Result<()>;
/// upsert 进用户文件（同 id 覆盖；覆盖内置 id = 用户覆盖语义）
pub fn upsert_user_agent(def: AgentDefinition) -> Result<()>;
/// 从用户文件移除；纯自定义即消失，覆盖内置则恢复内置条目。
/// 用户文件中不存在该 id → Err
pub fn remove_user_agent(id: &str) -> Result<()>;
```

### IPC 契约（architecture §5.1 新增，蛇形→camelCase 映射沿用）

| 命令 | 参数 | 返回 | 语义 |
|---|---|---|---|
| `list_agents` | — | `Vec<AgentRow>` | 合并视图（内置顺序 + 用户新增）+ 并行探测安装版本 |
| `add_agent` / `update_agent` | `id`/`display_name`/`driver_kind`/`command`/`version_args`/`capabilities`（update 带 `id`） | `AgentRow` | 写入用户自定义文件并返回探测后的行 |
| `delete_agent` | `id` | `()` | 从用户文件移除（内置 id 恢复出厂；文件中无此 id 报错） |

`AgentRow`（前端 TS 镜像）：

```ts
interface AgentRow {
  id: string;
  display_name: string;
  driver_kind: "acp" | "stream_json" | "native";
  command: string;
  version_args: string[];
  capabilities: {
    supports_load_session: boolean;
    supports_diff: boolean;
    supports_permission: boolean;
  };
  is_user_defined: boolean;   // id 出现在用户文件（含覆盖内置）
  installed_version: string | null;
}
```

探测语义沿用 §4.4：`program + version_args`，8s 超时；`list_agents` 内并行探测避免 5×8s 串行卡顿。

### 安装引导（前端文案，不进 core）

未安装项展示可复制命令，内置五条给已知安装命令；自定义条目兜底 `确保 PATH 中存在 <command 首词>`：

| id | 可复制安装命令 |
|---|---|
| opencode | `curl -fsSL https://opencode.ai/install \| bash` |
| claude-code | `npm i -g @agentclientprotocol/claude-agent-acp`（需 Node/npx） |
| codex | `npm i -g @agentclientprotocol/codex-acp`（需 Node/npx） |
| mimo | 见 MiMo Code 官方安装说明 |
| zcode | 见 ZCode 官方安装说明 |

### UI 结构（SettingsView）

1. 「Agent 管理」列表：display_name + id、driver 徽标、安装徽标（绿 ✓ 版本 / 琥珀 —）、
   command 行、用户定义徽标 + 删除按钮（内置无删除）、未安装时展开安装命令（可复制）。
2. 「新增 Agent」表单：id / display_name / command / version_args（逗号分隔，可空→--version）/
   driver_kind 选择 / capabilities 三复选（默认全勾，zcode 场景手动取消审批勾选）。
3. 校验：id 非空且为 `[a-z0-9-]+`；command 非空；提交后刷新列表。

## [S3] Out of Scope

- 会话跑在哪个 agent 的选择器（`run_prompt` 仍固定 opencode——P2-3 接入时扩展）
- 内置条目的字段编辑 UI（文件级覆盖能力已在 core，UI 仅支持新增/删除）
- Node/npx 依赖探测引导（P2-3）
- 图标/品牌定制、agent 排序拖拽

## Tasks

- [x] T1: core 用户文件写路径（load_user_entries/save/upsert/remove + 原子写） — acceptance: 单测覆盖 upsert 覆盖内置、remove 恢复内置、remove 未知 id 报错、坏路径不 panic (covers: S2)
- [x] T2: 桌面 IPC list_agents/add_agent/update_agent/delete_agent + AgentRow — acceptance: `just verify` 全绿；TS 类型镜像齐备 (covers: S2; depends: T1)
- [x] T3: 设置页 Agent 管理 UI（列表+徽标+安装引导+新增/删除表单） — acceptance: 设置页可见全部注册 agent；未安装项可复制安装命令；新增自定义后出现在列表且重启保留；删除自定义即时消失、删除覆盖条目恢复内置 (covers: S2; depends: T2)
- [x] T4: 验收留痕 + roadmap 归档 — acceptance: `pnpm tauri dev` 人工核对预写剧本；roadmap P2-2 状态与记录更新 (covers: S2; depends: T3)
