# 验收记录索引

当前进度以 [roadmap](../roadmap.md) 为准。每份记录的顶部最终结论优先于后面的历史待验收描述；测试通过不自动等于真实出口通过，历史已验收不保证当前机器认证/安装环境可用。

| 范围 | 结论与证据 |
|---|---|
| Phase 0 / v0.1.0 | [整体验收](phase0.md) |
| Phase 1 / v0.2.0 | [整体验收](phase1.md) |
| Phase 2 / v0.3.0 | [最终范围与整体验收](phase2.md)，[构建产物记录](phase2-artifacts.json) |
| Phase 3 / v1.0.0 macOS arm64 | [阶段验收](phase3.md)，[构建产物](phase3-artifacts.json)，[P3-10B 安装与发布](p3-10b.md) |
| P4-2 原型与选型 | [已验收：独立五页原型、原生鼠标/键盘、动效证据与库选型](p4-2.md) |
| P4-1 体验基线 | [已验收：三尺寸五页、合成走查与原生 WebKit 性能采样](p4-1.md) |
| P2-2 Agent 设置 | [历史交付报告](../compose/spec/p2-2-agent-settings-ui.md) |
| P2-3 Claude ACP | [验收](p2-3.md)；本机当前适配器问题按用户要求暂不处理 |
| P2-4 Codex ACP | [验收](p2-4.md) |
| P2-5 MiMo ACP | [验收](p2-5.md) |
| P2-6 ZCode | [延期与尝试记录](p2-6.md)；未包含在 v0.3.0，不标通过 |
| P2-7 Worktree | [验收](p2-7.md) |
| P2-8 看板 | [验收](p2-8.md) |
| P2-9 终端 | [验收](p2-9.md) |
| P3-1 计划契约 | [已验收](p3-1.md) |
| P3-2 直连 LLM | [已验收，真实 MiMo App/CLI 通过](p3-2.md) |
| P3-3 持久化与状态机 | [已验收](p3-3.md) |
| P3-4 ACP 调度 | [已验收，真实 OpenCode+Codex 通过](p3-4.md) |
| P3-5 指挥官 CLI | [已验收，真实拆解→派单→报告闭环](p3-5.md) |
| P3-6 指挥官桌面入口 | [macOS 已验收，真实 MiMo 拆解/双 Agent 执行/重启结果恢复](p3-6.md)；Windows 待 P3-8/9 |
| P3-7 Codex NativeDriver | [核心协议已验收，真实恢复/审批/取消通过](p3-7.md)；产品 ACP 入口保持原状 |
| P3-8 Windows 运行时 | [延期记录](p3-8.md)；实现保留独立分支，Windows 出口未通过，排除当前 macOS 发布范围 |
| P3-10A macOS 整体回归 | [已验收，真实 MiMo/双 Agent、桌面审批取消、工作树/看板/终端通过](p3-10a.md)；安装与发布见 P3-10B |
| DOC-3 v2.0.0 体验路线规划 | [分析、任务拆分与文档验证](v2-roadmap.md)；仅文档，P4 产品任务未启动 |
| DOC-2 macOS 路线调整 | [范围授权与验证](macos-priority.md)；Windows P3-8/P3-9 延期 |
| DOC-1 文档整理 | [范围、检查与归档](docs-alignment.md) |

新任务记录按固定顺序编写：最终结论（未完成时明确待验收）→ 预写验收命令/场景/预期 → 执行结果 → 偏差与用户范围授权 → dev 集成记录。实际密钥、连接信息与数据库不得归档。
