# 历史快照：v1.0.0 发布时的 Roadmap

> 2026-10-08 快照，供查历史；当前任务与后续路线以 [现行 roadmap](../roadmap.md) 为准。

# SuperCode Roadmap

> 当前任务状态的唯一入口。设计见 [architecture](../architecture.md)，执行规则见 [development-process](../development-process.md)，证据见 [acceptance](../acceptance/README.md)。更新日期：2026-10-08。

## 当前进度与下一步

- 已发布：v1.0.0（macOS arm64，main/tag/Release）；日常集成：dev。
- Phase 3：P3-1～P3-7 已验收并合入 dev，纳入 v1.0.0 macOS 发布范围。
- 平台路线：当前全力开发 macOS；用户授权延期 Windows P3-8/P3-9，排除当前 v1.0.0 macOS 发布范围。P3-10A macOS 整体回归已验收；P3-10B 已验收并发布，Phase 3 闭环完成；后续任务需另行规划；见 [路线决策](../adr/0008-macos-priority.md)。P3-7 为核心库交付，产品 Codex 入口仍使用 ACP。
- 文档治理：DOC-1 整理见 [记录](../acceptance/docs-alignment.md)；DOC-2 平台路线调整见 [授权与验证](../acceptance/macos-priority.md)。开发闭环规则继续适用。
- 延期项：P2-6 ZCode Start Plan CLI 路径未通过真实验收，用户批准排除 v0.3.0，发布版保持禁选；见 [P2-6](../acceptance/p2-6.md)。
- 环境事项：Claude CLI 与 ACP 分开探测；用户要求暂不处理本机 ACP 未就绪。此前接入验收仍保留，不把计划中的 Claude 分配视为当前可运行证明。

## 状态与维护规则

状态统一为待办、进行中、待验收、已验收、延期。已验收须有验收记录和 dev 集成；测试通过但真实出口未完成时写待验收。任务表只写任务、验收要点与当前状态，不追加操作日志。每任务不超过两天，过大先拆分；动工前写明命令、场景和预期。延期必须指向原因及用户范围授权的记录。

## 已完成阶段

| 阶段 | 结果 | 证据 |
|---|---|---|
| Step 0 | 开发流程、基础架构、ADR 建立 | [历史任务清单](../history/roadmap-through-p3-3.md) |
| Phase 0 | CLI ACP 全链路，v0.1.0 | [整体验收](../acceptance/phase0.md) |
| Phase 1 | macOS 桌面 MVP，v0.2.0 | [整体验收](../acceptance/phase1.md) |
| Phase 2 | 多 ACP agent、worktree、看板、终端，v0.3.0；P2-6 延期 | [最终发布范围与证据](../acceptance/phase2.md) |

此前各任务表、修复日志和中间状态保存在 [历史快照](../history/roadmap-through-p3-3.md)，不在当前入口重复维护。

## Phase 3 — AI 指挥官与 macOS 完整交付

指挥官使用直连 LLM API 生成结构化任务计划，经本地校验和用户确认后派给现有 ACP agent，保留各 agent 审批链路。每项独立任务分支闭环；P2-6、P3-8、P3-9 保持延期，不混入当前 macOS 发布验收。Windows 没有恢复日期，具备 CI 与实机出口后另行认领；未验收代码保留原分支。

| ID | 任务 | 验收与预期 | 状态 |
|---|---|---|---|
| P3-1 | 指挥官任务计划契约与 DAG 校验、CLI 计划检查入口 | `just verify`；合法依赖输出稳定执行批次；重复 id、空目标、未知/未接入 agent、缺失/重复/自身依赖、循环及超过 64 任务拒绝；CLI 合法文件退出 0、坏计划非 0，不启动 agent | ✅ 已验收 2026-10-01 |
| P3-2 | 直连 LLM 客户端与配置 | 独立配置模型/endpoint/key 来源；本地 HTTP fixture 验证请求、响应、超时与取消；错误不泄露 key；实际可用模型生成 P3-1 合法计划；详见 [验收记录](../acceptance/p3-2.md) | ✅ 已验收 2026-10-02 |
| P3-3 | 指挥官计划持久化与执行状态机 | 新迁移；原子快照保存/转换、重启恢复、并发 CAS、依赖门禁、失败后代跳过、取消/中断及终态不可重跑；详见 [验收记录](../acceptance/p3-3.md) | ✅ 已验收 2026-10-02 |
| P3-4 | ACP 派单与依赖调度 | 按批次并行、并发上限、失败阻断后代、取消回收，原 cwd/agent/审批归属不变；协议 fixture 与真实双 agent 核对；见 [验收记录](../acceptance/p3-4.md) | ✅ 已验收 2026-10-02 |
| P3-5 | 结果汇总与指挥官 CLI 闭环 | 汇总明确成功/失败/跳过，输出对应会话引用，真实拆解→派单→汇总留痕；见 [验收记录](../acceptance/p3-5.md) | ✅ 已验收 2026-10-03 |
| P3-6 | 指挥官桌面入口 | 配置、计划预览确认、执行进度、取消与恢复；macOS UI 核对，Windows 待平台验收；见 [验收记录](../acceptance/p3-6.md) | ✅ macOS 已验收 2026-10-03；Windows 随 P3-8/9 延期 |
| P3-7 | Codex NativeDriver 协议与运行时审批 | 核心协议驱动（不替换现有 ACP/UI）；握手、运行/恢复/取消、运行时 broker 审批变更、真实本机任务；见 [验收记录](../acceptance/p3-7.md) | ✅ 核心库已验收 2026-10-07 |
| P3-8 | Windows 进程与终端适配 | 实现保留 feat/p3-8-windows-runtime，本机回归通过，Windows CI/编译/实机均未验证；见 [延期记录](../acceptance/p3-8.md) | 延期：排除当前 macOS 发布范围 |
| P3-9 | Windows UI 与安装包 | Windows 实机 UI 与安装包验收；待 P3-8 出口通过及有可用环境后恢复 | 延期：尚未启动 |
| P3-10A | macOS v1.0.0 整体回归 | 先写 Phase 3 macOS 剧本；just verify、真实指挥官拆解→确认→双 Agent 执行→审批/取消→重启恢复，回归会话/worktree/看板/终端；失败修复后复验，不发布；见 [验收记录](../acceptance/p3-10a.md) | ✅ 已验收 2026-10-07 |
| P3-10B | macOS v1.0.0 构建与发布 | 依赖 P3-10A；macOS 安装包与校验和、安装启动实测，复核延期范围与 dev 全绿，再 annotated tag/main/GitHub Release；仅声明实际验收的系统与架构；见 [验收记录](../acceptance/p3-10b.md) | ✅ 已验收并发布 2026-10-08 |

## 里程碑

| 版本 | 内容 | 状态 |
|---|---|---|
| v0.1.0 | Phase 0 CLI | 已发布 |
| v0.2.0 | Phase 1 macOS 桌面 MVP | 已发布 |
| v0.3.0 | Phase 2 多 agent 与工作区体验，排除 P2-6 | 已发布 |
| v1.0.0 | macOS 指挥官闭环与完整桌面交付；Windows 延期 | 已发布（macOS arm64）；证据见 P3-10B |
