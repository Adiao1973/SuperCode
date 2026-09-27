# ADR-0007: 工作空间模型——会话按项目分组，默认空间承载非项目任务

- 状态：已接受（2026-09-27，P1-8 开工前调研定案）

## 背景

P1-6 落库恢复后，会话是一个**平铺列表**，`cwd` 只是每条会话上的自由文本：
项目多了以后"找某个项目干过的活"只能靠肉眼扫 cwd；即将开工的 P1-8 任务看板
（任务=标题+目录+绑定会话+状态）也缺一个"任务归属哪个项目"的挂靠点。

用户在 P1-8 开工前提出（2026-09-27）：
**工作空间应该就是项目本身的路径，同一项目的会话归为一个分类；
另设一类默认任务，不区分项目——普通聊天、对电脑的笼统操作放这里。**
要求先调研市面 agent GUI 再定案。

## 调研证据（2026-09-27）

| 产品 | 会话/任务组织方式 | 与本案关系 |
|---|---|---|
| ZCode（z.ai 官方 harness） | 安装即选定**项目目录作为 workspace**；Remote Control 的任务列表**按 workspace 或时间线组织**；仓库索引/检查点也挂在 workspace 下 | 直接同构：workspace=项目根，任务按空间归堆 |
| OpenAI Codex CLI | `codex resume` **只列出当前 git 仓库/目录下的历史会话**（官方文档+社区确认）；另有 CodexFlow 等第三方工具专门做"按目录整理全部历史" | 会话按项目目录天然分组是内建假设 |
| Claude Code | 历史落盘 `~/.claude/projects/<编码后的项目路径>/<会话uuid>.jsonl`——**按项目目录分目录存储**，`--resume` 只见当前项目的会话 | 持久层就按项目组织，与我们的 SQLite 分组同构 |
| DeepSeek Harness 生态 | Cordis 系插件框架（DSH Desktop 等）共性：GUI **工作区**整合文件/Git/终端/Agent，**项目管理**+在指定项目目录新开会话 | 工作区=一等实体是生态共识 |

本仓库内部旁证：opencode 的严格模式配置（`<cwd>/opencode.jsonc`）本来就是
**项目级**的（ADR-0006 实证）——空间=项目路径后，"空间级权限收紧"是自然延伸。

## 决策

新增一等实体 **Workspace（工作空间）**，会话归属于空间：

- `Workspace { id, name, path: Option<绝对路径>, kind: project|default, created_at }`
  - **project 空间**：`path` 为项目根绝对路径（UNIQUE）；同一项目的会话归入同一空间。
  - **默认空间**：全局单例（kind=default，path 为空）——普通聊天、对电脑的笼统操作
    等不区分项目的任务；其会话的 cwd **自由编辑**（不强制绑路径）。
- `sessions.workspace_id` 外键归属空间。project 会话新建时 cwd 预填空间路径
  （仍可临时覆盖——在子目录跑任务是合法操作，不做路径校验拦截）。
- **历史回填**：迁移 0003 建表后，把既有会话按 distinct cwd 自动生成 project 空间并归类，
  用户既有的项目分界零损失保留。
- 侧栏会话列表按空间分组（空间为节，默认空间是其中一节）；新建空间=选目录（UNIQUE 去重）。
- 删除空间**只摘分组不删会话**：会话移入默认空间（避免误删工作成果）。
- P1-9 任务看板任务挂靠空间：`task.workspace_id`（看板按空间组织）。

UI/IPC 细节（命令签名、空间选择器形态、默认空间 cwd 初值）由 P1-8 任务的小设计定稿。

## 理由

- **行业收敛解**：四个独立参照系（上表）全部按"项目目录→会话分组"组织，无一平铺。
- **痛点真实**：CodexFlow / Codex History Viewer 这类第三方工具的存在，说明
  "事后按目录整理会话历史"是普遍痛点——事后文本匹配不如一等实体
  （实体可承载改名、排序、看板挂靠、后续的空间级配置）。
- **默认空间不可省**：SuperCode 是多 agent 总控客户端而不只是编码工具，
  普通聊天与电脑操作类任务没有自然项目根，硬绑项目会逼用户造假目录；
  Codex/Claude Code 们不做通用客户端故无此需求，我们的产品定位需要。
- **成本可控**：一张表 + 一个外键 + 一次回填迁移；侧栏分组是纯前端改动。

## 被否方案

| 方案 | 否决原因 |
|---|---|
| 不建实体，按会话 cwd 文本前缀动态分组 | 路径等价形式（`~`、符号链接、尾斜杠）、目录改名即碎裂；无处挂空间名/看板/后续空间级配置；恰是第三方工具在补救的形态 |
| 通用标签/文件夹系统 | 表达力过剩，Phase 1 不需要多维组织；且用户心智里"项目=目录"最直接 |
| 强制一切会话归属项目空间 | 普通聊天/电脑操作类任务无项目根可绑，违反产品定位 |

## 影响

- DB：迁移 0003（workspaces 表 + sessions.workspace_id + distinct-cwd 回填 + tasks.workspace_id）。
- IPC：空间 CRUD + 会话归属（P1-8 小设计定稿后补 §5.1 契约行）。
- 前端：侧栏按空间分组、新建会话流程选空间、默认空间视觉区分。
- P1-8 拆分重排：**新 P1-8 工作空间模型**；原看板顺延为 P1-9（按空间组织）；
  整体验收顺延为 P1-10（tag v0.2.0）。
- 后续延伸（记录不实施）：cwd 前缀推断归属（子目录会话自动归类）；
  空间级 opencode 严格模式一键收紧（现按 cwd 检测，空间=路径后天然升级）；
  Phase 2 git worktree 隔离的会话归属原项目空间。

## 参考

- ZCode install/remote-control docs：zcode.z.ai/en/docs/install、zcode.z.ai/en/docs/remote-control
- Codex CLI resume：learn.chatgpt.com/docs/codex/cli；reddit r/codex "PSA you can use codex resume"
- Claude Code sessions：code.claude.com（Manage sessions）；.claude/projects 结构见社区分析
- DeepSeek Harness 生态：deepseek.csdn.net（桌面端）、ai-bot.cn（DSH Desktop）
