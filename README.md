# SuperCode

多 Agent 桌面工作台：在一个 macOS App 中管理本机 coding agent 的会话、计划、审批、任务与终端。通过 ACP 接入 OpenCode、Claude Code、Codex 和 MiMo，沿用各 CLI 的安装与认证。

## 版本与安装

**v2.0.0 正在进行发布验收，尚未发布。** 当前公开下载为 [v1.0.0](https://github.com/Adiao1973/SuperCode/releases/tag/v1.0.0)。2.0 的功能、升级与性能证据见 [Phase 4 验收](docs/acceptance/phase4.md)，发布进度见 [路线图](docs/roadmap.md)。

本轮交付范围为 **macOS Apple Silicon**，实测系统 macOS 26.5.2；不声明 Intel 或 Windows 支持。安装时将 DMG 中的 App 复制到 Applications，校验和随 Release 提供。安装包没有 Apple Developer ID 签名或公证；本地安装测试不代表下载隔离状态下的 Gatekeeper 验收，详见 [安装发布记录](docs/acceptance/p4-24.md)。

## 工作台能力

| 能力 | 用法与边界 |
|---|---|
| 工作区与会话 | 按项目目录组织，多会话并行；可折叠导航、调整列表和终端尺寸 |
| 消息阅读 | 流式 Markdown、代码复制、思考与工具折叠、文件变更详情；向上阅读保留位置 |
| AI 指挥官 | 输入目标，选择目录和 Agent，生成计划；审阅并显式确认后才执行 |
| 执行监控 | 查看依赖批次、进度、审批和结果，跳转对应会话；重启只恢复历史，不自动重跑 |
| 权限审批 | 会话内处理请求，审批中心统一汇总；支持权限模式与预授权规则 |
| 任务看板 | 拖拽或键盘移动，查看绑定会话与 worktree；跨空间移动仅调整分组，不改变执行目录 |
| 外观与操作 | 系统/浅色/深色主题、减少动态、Cmd-K 搜索、键盘导航与读屏名称 |
| 内嵌终端 | 使用会话实际 cwd；切换模块或收起终端保留进程，关闭终端或切换会话结束 shell |

审批只能处理 Agent 转交的请求。CLI 自身的白名单可能提前放行操作；会话配置中的权限提示和收紧引导用于说明这一边界，见 [权限决策](docs/adr/0006-permission-modes.md)。

Windows、ZCode 接入延期；NativeDriver 仅限核心库，产品中的 Codex 仍使用 ACP。具体范围以 [路线图](docs/roadmap.md) 为准。

## 开始使用

1. 安装并认证至少一个 Agent CLI。设置页提供安装命令和版本检测；版本检测成功不等于模型认证成功。需要通过 npx 启动的适配器还需 Node.js。
2. 添加项目空间，选择已存在的项目目录；新建会话，确认 Agent、实际目录和权限模式。
3. 在底部输入任务，Enter 或 ⌘R 运行，Shift-Enter 换行，⌘. 停止；需要授权时在请求卡片中处理。
4. 需要多任务规划时，在设置中配置指挥官模型，再进入「指挥官」生成、审阅并确认计划。普通 Agent 会话不要求配置指挥官 API。

OpenCode 建议在自己的配置中显式选择可用模型，避免默认免费模型限流。各 Agent CLI 的模型和登录状态与指挥官 API 独立配置；App 不会把 CLI 登录自动转换成直连 API 凭据。

### 本机数据

数据库位于 `~/Library/Application Support/SuperCode/supercode.db`，可用 `SUPERCODE_DB` 指定其他路径。历史会话、计划、规则、外观和布局偏好保存在本机。

指挥官的连接参数与 key 在设置中分别保存到本机 SQLite；保存 key 后无需每次启动前设置终端变量。环境变量仍可作为备用来源。SQLite、密钥和真实连接配置不提交 GitHub；本机数据库仍应作为敏感文件保管。保存成功与模型验证是两个状态，验证会显式调用 API，但不会执行生成的任务。

### CLI

```bash
# 仅校验计划，不执行任务
cargo run -p supercode-cli -- plan validate docs/examples/commander-plan.json
# 使用本机已保存配置生成计划
cargo run -p supercode-cli -- plan generate '为待办应用提出开发计划，不执行任务'
```

构建 CLI 后，可创建执行草稿、审阅，再显式执行和读取报告：

```bash
supercode plan run '任务目标' --cwd /absolute/project --agents opencode,codex
supercode plan execute <run-id> --yes --jobs 2
supercode plan report <run-id>
```

目录须已存在且为绝对路径。`execute` 没有 `--yes` 不运行；未预授权操作默认拒绝，可用 `--allow` / `--deny` 设置规则。报告读取不重跑任务。配置示例只含占位值，见 [文档入口](docs/README.md)。

## 本地开发

需要 Rust ≥ 1.88、Node.js ≥ 22.12、pnpm，以及 macOS Tauri 构建工具；一键命令使用 [just](https://github.com/casey/just)。真实运行还需对应 CLI 和可用认证。

```bash
git clone https://github.com/Adiao1973/SuperCode.git
cd SuperCode
pnpm install
just verify    # 文档链接、版本一致性、前端类型/测试/构建、Rust fmt/clippy/test
just dev       # 桌面开发
just build     # 原始 App 和 DMG，位于 target/release/bundle/
just smoke     # 本机真实 OpenCode 冒烟，需要认证
```

从 `dev` 切任务分支，预写验收、实现、验证、归档后 `--no-ff` 合回。发布前完成阶段验收，再打 tag、合 main、发布资产。唯一流程规范见 [开发流程](docs/development-process.md)。

- [文档导航](docs/README.md)：架构、设计、ADR、验收与历史入口。
- [路线图](docs/roadmap.md)：当前状态、下一任务及延期项。
- [架构](docs/architecture.md)：现行接口、数据和行为约束。

核心代码位于 `crates/core`，CLI 位于 `crates/cli`，Tauri + React 桌面端位于 `apps/desktop`。

[MIT License](LICENSE)
