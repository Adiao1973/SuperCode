# P4-5 动效基础

本文定义已接入桌面端的动效基础，任务状态与出口见 [roadmap](../roadmap.md) 和 [验收](../acceptance/p4-5.md)，持久化约定见 [architecture §6.9](../architecture.md#69-动效基础与减少动态p4-5)。

| 类型 | 完整模式 | 减少模式 |
|---|---|---|
| 控件颜色/焦点 | 120ms，cubic-bezier(0.2,0,0,1) | 立即 |
| 存在变化 / tooltip | 180ms，同一缓动 | 立即，无退出等待 |
| 非交互复制反馈 | 入场 opacity 0→1、y 8→0；退出 y 0→-4 | 静态显示/移除 |
| 运行中 spin/pulse / 终端光标 | 沿用状态指示节奏 | 静止，文字状态保留 |

偏好提供跟随系统、减少、完整；完整明确覆盖 OS 减少动态设置，系统模式订阅 OS change。SQLite 是事实源，保存成功再应用，读失败保守减少且不覆盖存储；颜色偏好与动效独立保存。没有新增密度、布局或执行配置。

仅新增已在 P4-2 核对过的开源 `motion@14.0.0`（MIT）。依据 [LazyMotion](https://motion.dev/docs/react-lazy-motion) 使用 strict + m，异步 domAnimation 独立 chunk；本任务不需要 layout/drag，暂不用 domMax。复用既有 tw-animate-css 工具，不增加第二引擎。特性加载失败保持静态反馈，主工作区、按钮和事件不会等待可选特性；失败回退有组件测试。

[MotionConfig](https://motion.dev/docs/react-motion-config) 的 reducedMotion 不会自动停止所有 opacity/CSS 动画，因此还需自身减少策略：MotionNotice 在减少模式走普通 span，即时清除已有位移/退出；根 data-motion 关闭 CSS animation/transition、smooth scroll，xterm 原实例更新 cursorBlink。退出节点 aria-hidden 且 pointer-events:none；基础只允许非交互反馈，不包执行宿主、权限卡片或取消按钮。

复制定时器只控制文案寿命，不触发业务 RPC。审批立即调用、连点禁用的既有测试放入完整 MotionProvider 后仍过；取消/事件 reducer 和后端约束保持原实现。后续 AppShell、消息与看板任务复用基础，不能以动效完结回调派单或裁决。

本轮原生只验主题兼容、模式、复制反馈、CSS spin/pulse、重启及最小窗口；2 秒 rAF 采样是行为观察，不是 P4-21 的性能预算验收。系统实时切换用受控媒体 fixture 验证，不改用户操作系统设置。详细原始读数见验收目录。
