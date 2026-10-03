# SuperCode Roadmap

> 当前任务状态的唯一入口。设计见 [architecture](architecture.md)，执行规则见 [development-process](development-process.md)，证据见 [acceptance](acceptance/README.md)。更新日期：2026-10-03。

## 当前进度与下一步

- 已发布：v0.3.0（main/tag）；日常集成：dev。
- Phase 3：P3-1～P3-6 已验收并合入 dev，尚未包含在 v0.3.0 安装包。
- 当前任务：P3-6 指挥官桌面入口已闭环；下一任务 P3-7 尚未启动。
- 文档整理：DOC-1 已验收，记录见 [记录](acceptance/docs-alignment.md)。整理后的流程已用于 P3-4 独立闭环。
- 延期项：P2-6 ZCode Start Plan CLI 路径未通过真实验收，用户批准排除 v0.3.0，发布版保持禁选；见 [P2-6](acceptance/p2-6.md)。
- 环境事项：Claude CLI 与 ACP 分开探测；用户要求暂不处理本机 ACP 未就绪。此前接入验收仍保留，不把计划中的 Claude 分配视为当前可运行证明。

## 状态与维护规则

状态统一为待办、进行中、待验收、已验收、延期。已验收须有验收记录和 dev 集成；测试通过但真实出口未完成时写待验收。任务表只写任务、验收要点与当前状态，不追加操作日志。每任务不超过两天，过大先拆分；动工前写明命令、场景和预期。延期必须指向原因及用户范围授权的记录。

## 已完成阶段

| 阶段 | 结果 | 证据 |
|---|---|---|
| Step 0 | 开发流程、基础架构、ADR 建立 | [历史任务清单](history/roadmap-through-p3-3.md) |
| Phase 0 | CLI ACP 全链路，v0.1.0 | [整体验收](acceptance/phase0.md) |
| Phase 1 | macOS 桌面 MVP，v0.2.0 | [整体验收](acceptance/phase1.md) |
| Phase 2 | 多 ACP agent、worktree、看板、终端，v0.3.0；P2-6 延期 | [最终发布范围与证据](acceptance/phase2.md) |

此前各任务表、修复日志和中间状态保存在 [历史快照](history/roadmap-through-p3-3.md)，不在当前入口重复维护。

## Phase 3 — AI 指挥官与 Windows

指挥官使用直连 LLM API 生成结构化任务计划，经本地校验和用户确认后派给现有 ACP agent，保留各 agent 审批链路。每项独立任务分支闭环；P2-6 保持延期，不混入本阶段验收。

| ID | 任务 | 验收与预期 | 状态 |
|---|---|---|---|
| P3-1 | 指挥官任务计划契约与 DAG 校验、CLI 计划检查入口 | `just verify`；合法依赖输出稳定执行批次；重复 id、空目标、未知/未接入 agent、缺失/重复/自身依赖、循环及超过 64 任务拒绝；CLI 合法文件退出 0、坏计划非 0，不启动 agent | ✅ 已验收 2026-10-01 |
| P3-2 | 直连 LLM 客户端与配置 | 独立配置模型/endpoint/key 来源；本地 HTTP fixture 验证请求、响应、超时与取消；错误不泄露 key；实际可用模型生成 P3-1 合法计划；详见 [验收记录](acceptance/p3-2.md) | ✅ 已验收 2026-10-02 |
| P3-3 | 指挥官计划持久化与执行状态机 | 新迁移；原子快照保存/转换、重启恢复、并发 CAS、依赖门禁、失败后代跳过、取消/中断及终态不可重跑；详见 [验收记录](acceptance/p3-3.md) | ✅ 已验收 2026-10-02 |
| P3-4 | ACP 派单与依赖调度 | 按批次并行、并发上限、失败阻断后代、取消回收，原 cwd/agent/审批归属不变；协议 fixture 与真实双 agent 核对；见 [验收记录](acceptance/p3-4.md) | ✅ 已验收 2026-10-02 |
| P3-5 | 结果汇总与指挥官 CLI 闭环 | 汇总明确成功/失败/跳过，输出对应会话引用，真实拆解→派单→汇总留痕；见 [验收记录](acceptance/p3-5.md) | ✅ 已验收 2026-10-03 |
| P3-6 | 指挥官桌面入口 | 配置、计划预览确认、执行进度、取消与恢复；macOS UI 核对，Windows 待平台验收；见 [验收记录](acceptance/p3-6.md) | ✅ macOS 已验收 2026-10-03；Windows 待 P3-8/9 |
| P3-7 | Codex NativeDriver 协议与运行时审批 | 先写协议设计与 fixture，能力协商、运行/取消/审批变更、真实本机任务验收 | 待办 |
| P3-8 | Windows 进程与终端适配 | Windows CI + 实机验收进程树回收、PTY、路径和 WebView2；不可用环境保留待验收 | 待办 |
| P3-9 | Windows UI 与安装包 | Windows 实机 UI、双平台构建产物和校验和，无平台假通过 | 待办 |
| P3-10 | v1.0.0 整体验收与发布 | 预写 Phase 3 剧本、指挥官真实闭环、双平台安装包、dev 全绿、annotated tag/main/GitHub Release | 待办 |

## 里程碑

| 版本 | 内容 | 状态 |
|---|---|---|
| v0.1.0 | Phase 0 CLI | 已发布 |
| v0.2.0 | Phase 1 macOS 桌面 MVP | 已发布 |
| v0.3.0 | Phase 2 多 agent 与工作区体验，排除 P2-6 | 已发布 |
| v1.0.0 | Phase 3 指挥官闭环与 Windows | 待阶段整体验收；不以 P3-1～3 完成代替发布出口 |
