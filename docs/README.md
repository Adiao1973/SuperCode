# SuperCode 文档导航

更新：2026-10-19。先看路线图，再按开发流程执行；每类信息只在对应文档维护。

| 需要了解 | 入口 | 内容边界 |
|---|---|---|
| 安装与使用 | [项目 README](../README.md) | 用户操作、版本与平台范围 |
| 进度与下一任务 | [Roadmap](roadmap.md) | 当前任务表、延期项、里程碑 |
| 开发如何闭环 | [开发流程](development-process.md) | 文档先行、实现、自动/真实验收、归档、分支与发布 |
| 接口与数据设计 | [架构](architecture.md) | 现行实现契约，不以历史方案代替当前约束 |
| 体验设计 | [设计索引](design/README.md) | 分析、选型、主题和动效规范 |
| 决策理由 | [ADR 索引](adr/README.md) | 重大取舍及适用范围 |
| 验收证据 | [验收索引](acceptance/README.md) | 顶部最终结论、预写步骤、过程证据与偏差 |
| 历史方案与旧进度 | [历史索引](history/README.md) | 归档快照，不能作为当前待办 |
| 计划与连接示例 | [计划](examples/commander-plan.json)、[配置](examples/commander-config.json) | 虚构占位值，真实信息只留本机 |

当前已发布 **v2.0.0**，Phase 4 全部任务在批准的 macOS 范围内闭环完成，见 [阶段验收](acceptance/phase4.md)。发布前已整理 README 和文档入口、检查全部 Markdown 本地链接；后续任务仍以 roadmap 为准。

Windows、ZCode 与 Claude 本机环境问题依用户授权延期；NativeDriver 限核心库，产品使用 ACP。范围依据见 [平台决策](adr/0008-macos-priority.md)及路线图。

验收记录中的过程、旧版本号和“下一任务未启动”描述保留当时事实；读取时以任务顶部结论与当前 roadmap 为准，不把旧日志复制为现状。真实 endpoint/model/key、数据库及个人日志不进入文档或仓库。
