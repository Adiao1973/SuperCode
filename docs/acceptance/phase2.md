# Phase 2 整体验收（P2-10）

> 最终状态：用户授权排除 P2-6，按调整后的范围发布 v0.3.0。下文前半段保留原范围的预验收记录；最终出口以“最终发布范围”及其检查结果为准。

## 预写剧本（2026-10-01）

验收基线：`dev` 的 P2-9 合并提交 `9deb598`；所有新真实任务仅使用 `/tmp/sc-p210-*` 和独立 SQLite，不修改认证或日常数据库。各子任务记录是既有验收证据，本阶段新执行结果另行留痕，不混同。

1. `just verify`：前端 build、fmt、clippy、全部测试通过；真实环境 ignored 联检另行执行；真实模型冒烟用独立 cwd 的 CLI run。
2. `supercode detect`：注册表五个内置 agent 的版本/安装状态正确；自定义 CRUD 和重启证据核对 P2-2，桌面打包探测与实际运行再检查。
3. 至少 Claude Code 和另一个 ACP agent 在独立 cwd 写入/读回唯一标记；三个以上 agent 的已验收证据齐备。CLI 使用共享新 SQLite，并行输出、agent/cwd/session 归属独立；新进程 resume 仅凭上下文复述标记。审批证据核对 P2-3/4/5 的真实内联允许与持久化，不以当前预授权放行替代人工审批证明。
4. ZCode：真实消息/工具、无法外部审批的标注、禁用权限模式、取消、重启归属和新建提示均通过，P2-6 才能合入 dev。当前用户无有效 key、授权延期；本项明确待补验。
5. worktree：建/改/清扫、主目录不受影响、原项目空间归属；看板跨列跨空间/重启/绑定不变；会话终端实际 cwd、输入输出、WebKit 背景和关闭进程；核对 P2-7/8/9 自动与 macOS 证据，在 release 包再做组合核对。
6. `just build` 生成 release `.app`/`.dmg`；独立测试数据库启动打包应用，核对注册 agent、恢复历史/agent/cwd、打开 worktree 终端、任务看板及退出清理。
7. 发布出口：所有 Phase 2 行均已验收、完整剧本全过、dev 全绿后才更新版本至 0.3.0、annotated tag `v0.3.0`、`--no-ff` 合入 main 并生成对应版本安装包。无有效 key 不能把第 4 项记为通过，当前准备包仍保持 0.2.0，不冒充 v0.3.0。

## 发布门槛

- P2-6 保留 `feat/p2-6-zcode-stream-json`，未合入本验收分支；不得用协议 fixture 替代真实模型验收。
- P2-10 在发布出口未满足时保留进行中，已完成的回归/文档可归档，不创建 v0.3.0 tag，不合入 main。

## 2026-10-01 当前结果

**P2-10 尚未完成发布闭环。** 在 `feat/p2-10-phase2-acceptance` 完成以下预验收与修复，当前保留任务分支；不提前合入 dev/main，不打 tag。dev 基线仍是 P2-9 `9deb598`，代码修复提交 `e4235e0`（CLI 失败落库）和 `d0b585d`（实际版本标识）。

| 项目 | 本阶段新执行结果 | 证据范围 |
|---|---|---|
| 自动验证 | ✅ `just verify` 退出 0 | core 70 + ACP 4 + desktop 6 + CLI 回归 1 通过；1 项既有 ignored；前端/fmt/clippy 全绿 |
| 环境联检 | ✅ ignored 检查 1 passed | 这是本机 OpenCode 环境解析检查，不是模型任务；模型冒烟另见下文 |
| 注册表 | ✅ 五内置版本/安装探测 | CLI 二次探测及 release 设置页；自定义 CRUD/持久化沿用 P2-2 记录与注册表回归，没有改日常自定义配置 |
| 真实多 agent | ✅ Claude/Codex/MiMo 并行写读及并行 resume | 同一新库、三个独立 cwd，文件标记/暗号、agent/session/cwd 互不串台；真实审批专项证据仍见 P2-3/4/5 |
| OpenCode 模型冒烟 | ✅ 临时目录回复 P210-OPENCODE，EndTurn | 当前集成 CLI 真实调用；首次测试 cwd 未创建导致服务失败，后续创建目录重跑通过 |
| worktree/看板/终端 | ✅ 专项证据 + release 组合复核 | P2-7/8/9；打包历史原 cwd、终端中文/ANSI、看板拖拽保存和重启/跳转绑定、终端退出进程回收 |
| macOS 打包 | ✅ `just build` 退出 0，.app/.dmg 生成 | 版本保持 0.2.0 的验收准备包，不是已发布的 v0.3.0；大小/校验和见 phase2-artifacts.json |
| ZCode 真实支持 | ⏳ 延期补验 | P2-6 无有效 key，源码保留独立分支；当前 dev/release 选择器仍禁选尚未接入的 ZCode，不满足受限支持验收 |
| 版本/tag/main | ⏳ 未执行 | 全部 Phase 2 已验收的流程门槛未满足 |

### 可复核输出

`supercode detect`（真实调用预热后）：
```text
OpenCode 1.18.30 ✓
Claude Code 0.84.0 ✓
Codex @agentclientprotocol/codex-acp 2.1.0 ✓
MiMo 0.1.15 ✓
ZCode 0.16.9 ✓
```
首次 Claude npx 冷启动超过版本探测时限，没有取得版本；真实调用成功后重新检测返回 0.84.0。安装探测不能替代模型可用性，尤其 ZCode。

共享库 `/tmp/sc-p210-real/test.sqlite`：

| agent | 本地 UUID | probe.txt | 新进程 resume 返回 | 最终状态 |
|---|---|---|---|---|
| claude-code | 5b9e66d2-cfc8-49d0-a9d0-f01d08cb3efd | P210-CLAUDE-CODE | MEMORY-CLAUDE-CODE-1001 | completed |
| codex | daad410c-0081-4a81-a31c-a443f5df7a31 | P210-CODEX | MEMORY-CODEX-1001 | completed |
| mimo | 648be676-eb44-49c2-8070-b9a0b0e03356 | P210-MIMO | MEMORY-MIMO-1001 | completed |

三轮同时启动，退出码均 0，文件内容与回复一致；三个新进程同时 resume，退出码均 0，保留原 agent/cwd/ACP id 并返回各自暗号。每个 cwd 为 `/tmp/sc-p210-real/<agent>`。MiMo 只在该临时项目设置已验证模型 `xiaomi-token-plan-cn/mimo-v2.5`，没有读取或改动 key/全局配置。日志与 JSON 摘要位于上述临时根目录。

### 本阶段修复

- OpenCode 服务错误暴露 CLI driver 返回 Err 未补发结束事件，已有档案留在 active。新增真实 CLI + Node 无网络 ACP 对端回归，先复现 `active != failed`，再在排空 recorder 前补发 DriverError；新建失败与成功后续聊失败均正确持久化，agent/cwd/ACP identity 不变。`serde_json` 仅新增为 CLI 测试依赖用于构造隔离注册表。原测试库的旧 active 行是修复前留痕，没有伪改为成功或追溯改写。
- release 界面硬编码 `v0.2 dev`，现读取 Tauri runtime app version，dev 后缀只在开发构建出现。最终 release 复测显示 `v0.2.0`，不提前宣称 0.3.0。
- README 区分稳定发布版与 dev 已实现范围，补齐 Agent/隔离任务/拖拽/终端使用说明。

### release 组合核对

实际 `tauri://localhost` release 包复制到独立测试 bundle（复用 `/tmp/SuperCode-P29.app` 的唯一测试标识并重新 ad-hoc 签名），不替换安装的日常应用。使用 `/tmp/sc-p210-release.sqlite`：保留前期隔离任务测试数据，并导入本轮三家 completed 历史。没有 Vite 服务参与 release 界面验证。

- Claude/Codex/MiMo 历史分别锁定正确 Agent，原 cwd 和消息/暗号恢复；原 OpenCode worktree 历史仍归 sc-p27-ui-project。
- 终端 `pwd` 为 `/private/tmp/sc-p27-ui-project/.git/supercode-worktrees/6be1f9bd-8d5f-44fc-83ed-529afb0c67a0`，显示绿色 ANSI `P210-RELEASE 中文`，背景无伪影；切到看板后 shell 30427 经 ps 核对不存在。
- 默认空间任务 `6be1f9bd-8d5f-44fc-83ed-529afb0c67a0` 用 Space/Right/Space 从进行中移动到评审，保存成功；重启后仍为 default/review，session_id 仍为 `ses_f0cb2247fffelDGHvbydx3mEHu`。点击绑定会话跳转后仍使用原 worktree，未改执行归属。
- 最终包以 `PATH=/usr/bin:/bin` 启动，设置页仍探测上述五个版本；验证 GUI PATH 补齐和 MiMo 官方安装目录回退。

完整自动输出：`/tmp/sc-p210-verify-final.log`；构建输出：`/tmp/sc-p210-build-final.log`；CLI 回归：`/tmp/sc-p210-regression.log`。临时日志不是长期凭证，关键结果与产物校验和已归档本文。

## 后续闭环步骤

1. 在 ZCode 自身配置有效模型，按 P2-6 剧本补真实写读/取消/桌面受限能力/重启验收；用户无需把 key 交给 SuperCode。
2. 在已更新 dev 基线上集成并复验 P2-6 和本 P2-10 分支，重跑全部自动与 Phase 2 剧本，按流程把任务合回 dev。
3. 全部出口通过后统一版本 0.3.0，再执行 annotated tag/main 合并与对应版本打包。此前不把 P2-10 标为已验收或 Phase 2 标为已发布。

### 补验重新启动（2026-10-01）

用户已在 ZCode 配置 GLM 5.3 Flash，原有效模型阻塞解除。开始重新执行 P2-6 真实验收；本节之前的未发布结论记录的是此前预验收阶段，最终发布结论以补验后记录为准。


## 最终发布范围（2026-10-01，用户授权）

用户明确要求“把这个跳过吧，提前发布”，批准将 P2-6 从 v0.3.0 出口排除。之前的待补验/禁止发布结论属于原范围的预验收阶段，本节替代该发布结论。P2-6 未通过真实验收，不合入本版，发布版 ZCode 保持禁选；不存在以 fixture 或桌面成功冒充 CLI 验收。实际账号为 Start Plan，独立分支记录了 CLI 账号路径限制和临时默认模型试验。

本版发布范围为已验收 P2-1～5、P2-7～9，以及上述 ACP 并行写读/续聊、OpenCode 冒烟、release 桌面组合检查。统一 Rust、前端和 Tauri 版本为 0.3.0；最终自动检查与安装包结果见下方归档。
