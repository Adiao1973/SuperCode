# Phase 3 — macOS v1.0.0 阶段验收

> 最终本地结论：Phase 3 macOS 功能与 release 安装验收通过（2026-10-08）。v1.0.0 远端发布核对见 [P3-10B](p3-10b.md)；仅 macOS Apple Silicon。

## 范围

用户授权全力研发 macOS，Windows P3-8/P3-9 延期并排除本轮发布；ZCode P2-6 延期，Claude ACP 本机环境问题不处理。详见 [ADR-0008](../adr/0008-macos-priority.md)。仅声明 macOS Apple Silicon 实测；NativeDriver 保持核心库范围，产品入口仍用 ACP。

## 阶段证据

- [P3-1～P3-7](README.md)：契约、直连 LLM、本机凭据、持久化状态机、ACP 调度、CLI/桌面指挥官及核心 NativeDriver。
- [P3-10A 整体回归](p3-10a.md)：真实 MiMo 拆解，经审阅确认后 OpenCode/Codex 双根执行、依赖任务门禁、报告与重启恢复；审批取消、工作树/看板/终端实机回归。150 passed、1 ignored。
- [P3-10B 安装与发布](p3-10b.md)：1.0.0 版本统一、release App/DMG、校验和、从 DMG 安装副本启动/真实 ACP/重启验收、远端 Release 核对。

P3-10B 相对 P3-10A 的产品代码差异限于版本元数据及阶段标签清理；功能回归沿用 P3-10A 同源码证据，release 安装形态另行实测。真实 endpoint/model/key、SQLite 与本机日志不归档。
