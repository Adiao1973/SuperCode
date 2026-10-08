# SuperCode 文档导航

先看当前进度，再按开发流程执行；这里不另设一套流程。更新：2026-10-08。

| 要解决的问题 | 入口 | 内容边界 |
|---|---|---|
| 现在做到哪、下一步做什么？ | [Roadmap](roadmap.md) | 当前任务表、延期项、里程碑 |
| 开发如何闭环？ | [开发流程](development-process.md) | 文档先行、实现、自动/真实验收、归档、dev 集成 |
| 接口和数据怎么设计？ | [架构](architecture.md) | 现行契约与实现边界，含已集成 dev 的 P3-1～7 |
| 为什么这样选？ | [ADR 索引](adr/README.md) | 重大决策及理由 |
| 验收到底通过了吗？ | [验收索引](acceptance/README.md) | 最终结论、预写步骤、过程证据与偏差 |
| 怎么使用产品？ | [项目 README](../README.md) | 使用方式、安装版本与 dev 差异 |
| 查以前的设计和进度？ | [历史索引](history/README.md) | 只读历史，不代表当前规则或状态 |
| 需要计划/配置样例？ | [计划](examples/commander-plan.json)、[配置](examples/commander-config.json) | 虚构示例；真实信息只留本机 |

当前发布版本 v1.0.0，包含 P3-1～7；[Phase 3 验收](acceptance/phase3.md)汇总功能与安装证据。P3-6 已完成 macOS 桌面闭环，CLI 与桌面均支持计划预览、确认执行、取消及结果读取；Windows 实机验收留待 P3-8/9。P3-7 核心 Codex NativeDriver 已完成真实恢复、审批与取消验收，产品入口仍使用 ACP。用户授权全力开发 macOS，P3-8/P3-9 延期，Windows 实现保留独立分支；[P3-10A macOS 整体回归](acceptance/p3-10a.md)已通过；P3-10B 安装包本地验收已通过，远端发布核对见其[记录](acceptance/p3-10b.md)。P2-6 延期，Claude ACP 本机问题按用户要求暂不处理。

每类信息只在对应入口维护：roadmap 不写操作流水账，architecture 不保存过时实现约定，验收历史不冒充当前状态。存量记录保留，历史段落由顶部最终结论限定。
