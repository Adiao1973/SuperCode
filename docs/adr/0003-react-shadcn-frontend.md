# ADR-0003: 前端采用 React 19 + shadcn/ui

- 状态：已接受（2026-09-24，用户在选型问题中确认）

## 背景

Tauri 前端层选型，候选：React 19、Svelte 5、Vue 3、Solid、Preact。核心诉求：**好看（组件库上限）+ 性能（高频流式事件：每秒几十条 chunk、长虚拟列表、diff、看板、终端）**。

## 决策

**React 19 + React Compiler + Tailwind + shadcn/ui**，配 `@virtuoso.dev/message-list`（消息流虚拟列表）、`@git-diff-view/react`（diff）、`@xterm/xterm`（≥5.3.0）、`dnd-kit`（看板拖拽）、Zustand + TanStack Query。

## 理由

- **成品库密度决定开发速度**：与本项目 UI 形态一致的 Vibe Kanban 即此栈，其组件选型可整体照抄；消息流/diff/终端/拖拽在 React 生态全部有成熟轮子，Svelte/Vue 侧存在缺口（如无 virtuoso 等价物）。
- **好看的上限**：shadcn/ui + Radix 是当前事实标准的颜值天花板。
- **性能可控**：React Compiler 已 v1.0 stable；配合硬性架构约束——Rust 侧帧级合帧后经 Tauri Channel 推送、前端只重渲染活动 chunk——高频流式负载已被 Vibe Kanban 生产验证。
- 基准上 Svelte/Solid 原始 DOM 更新快 2-3 倍，但该差距在"Rust 合帧 + 低频批量推送"的架构下被大幅抹平，不足以抵消生态差距。

## 被否方案

| 方案 | 否决原因 |
|---|---|
| Svelte 5 | 原始性能最优，但消息流虚拟列表、拖拽、markdown 等需手写或凑合，开发量显著增加 |
| Vue 3 + Naive UI | 工程稳妥（TS 优先、内置暗色），但 Vapor 模式仍在 RC 不构成加分；关键轮子密度略逊 React |
| Solid | 性能顶级但组件生态最薄（无 MUI/AntD 级库），且 2.0 刚 RC |
| Preact | Tauri 下包体不是瓶颈，维护放缓，compat 层有坑 |

## 影响

- 必须长期坚持流式渲染纪律：活动 chunk 之外一律 memo（DoD 检查项）。
- React 原始 DOM 性能弱于 signals 系：禁止绕过合帧层直连高频事件源。
