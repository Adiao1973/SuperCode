# 前端测试基础

```sh
pnpm --filter @supercode/desktop test
pnpm --filter @supercode/desktop test:watch
pnpm --filter @supercode/desktop test:typecheck
just verify
```

`vitest.config.ts` 使用 jsdom，包含 `tests/**/*.test.ts(x)`，无测试默认失败；测试单独做严格 TypeScript 检查，生产入口不导入测试。开发环境需 Node ≥22.12（本轮 24.12），安装沿用仓库锁文件与现有 pnpm/store，不升级生产 React/Vite。

## 分层和 fixture 边界

- `replay.test.ts` / `sessions.test.ts` 测试真实 reducer，所有 ID/目录/文本为合成值；不硬编码自动生成的 key。`fixtures/replay.ts` 以显式毫秒推进，保持整批事件及顺序；`stop()` 对应取消/卸载后禁止投递。它不代表后端取消已完成。
- `setup.ts` 在 Tauri core/event/app/opener 模块边界替换，不改产品 IPC 封装。`fixtures/tauri.ts` 默认拒绝未声明命令，显式 `handle` 才能回应；记录 camelCase 参数，嵌套 DTO 保留契约 snake_case。Channel 批直接送入真实回调；listen 返回可释放订阅。每例清空 IPC、全局替身和组件，文件间模块隔离。
- 默认拒绝 fetch、XHR、WebSocket 和外链导航。禁止测试引用真实配置、key、DB、API、Agent 进程或 PTY。此为本套测试的边界，**不是任意 Node 代码的系统沙箱**；新增 Tauri 模块也必须先声明测试替身。
- `PendingCard` 使用真实组件与 IPC 封装，验证一次请求未返回时禁用两种裁决。测试不把合成返回当作真实权限裁决。
- PermissionCenter 是 App 生命周期单例；测试验证 setup 幂等、订阅者释放及按 session/tool 双键清除，不擅自新增产品销毁协议。

## 交互方法与原生出口

`InteractionProbe.tsx` 是测试方法样例，共用现有 Textarea 与 Radix primitive；**不是产品主题 hook、正式输入框或新功能**。未来实现需把同类断言移到真实组件，不能只留样例测试。

- 主题/减少动态：`fixtures/media.ts` 控制 matchMedia 初值、change 和订阅数量。独立验证两偏好与卸载清理，不改操作系统设置；jsdom 不测 CSS、颜色对比、动画或帧率。
- IME：compositionStart → change → 组合态 Enter → compositionEnd → 普通 Enter；另验 WebKit keyCode 229、Shift-Enter。fireEvent 补 user-event 不提供的 composition，不能冒充真实输入法候选上屏；正式输入 P4-9/P4-22 必须原生输入法专项。
- 焦点：user-event 验初焦、Tab 循环、Esc 与回焦，原生 WebKit 再核对一次。未覆盖正式产品所有弹层。

从仓库根目录启动纯合成原生样例：

```sh
scratch=$(mktemp -d /tmp/sc-p43.XXXXXX)
mkdir -p "$scratch/xdg/opencode"
env -u SUPERCODE_LLM_API_KEY SUPERCODE_DB="$scratch/fixture.db" \
  XDG_CONFIG_HOME="$scratch/xdg" \
  pnpm --filter @supercode/desktop tauri dev \
  --config "$(pwd)/apps/desktop/tests/native/tauri.test.json"
```

样例只在 dev 页面 `http://127.0.0.1:1443/tests/native/index.html`，不由生产 index 引用，不进入默认 dist。构建后确认 `dist/tests` 不存在；禁止为发布配置增加该入口。退出样例 App 与 tauri dev/Vite，确认 1443 无监听。CUA 无法识别裸二进制时可用隔离 .app 包装同一 debug binary，固定上述环境，详见 [P4-3 验收](../../../docs/acceptance/p4-3.md)。

本轮负向对照曾临时把真实 `stream.ts` 的 `last.text + text` 改成 `text`，指定 replay 测试失败后在 finally 恢复，并重新全量通过。复现时先保证工作区干净，不提交破坏实现；[证据](../../../docs/acceptance/p4-3/negative-control.json)。

选型参考：[Vitest 模块替身](https://vitest.dev/guide/mocking/modules)、[Testing Library setup](https://testing-library.com/docs/user-event/setup/)。依赖均为开发依赖，精确元数据见 [验收记录](../../../docs/acceptance/p4-3.md)。

## P4-4 产品外观测试

`appearance.test.tsx` 验真实 Provider/设置组件的保存、系统变化、失败/超时和显示顺序；`terminal-theme.test.tsx` 验 xterm options 颜色更新但 PTY 生命周期不重启；`design-tokens.test.ts` 对 CSS token 的 18 对文字/表面计算 WCAG 对比度。jsdom 的颜色测试不替代原生计算样式，WebKit 深浅/重启及三尺寸证据见 [P4-4](../../../docs/acceptance/p4-4.md)。

## P4-5 产品动效测试

`motion.test.tsx` 验真实偏好 Provider、系统变化、写失败/读取超时、减少模式即时移除及复制立即执行；`motion-fallback.test.tsx` 模拟可选特性 chunk 加载失败，内容与设置保持可用。终端主题测试同时验证 cursorBlink 更新且 PTY 不重建，审批测试在完整 MotionProvider 中验证裁决 RPC 立即发出、pending 期间不重复响应。原生 CSS/Motion 对照与重启见 [P4-5](../../../docs/acceptance/p4-5.md)，jsdom 不冒充帧率验证。

## P4-6 Shell 与生命周期测试

`app-shell.test.tsx` 验真实 App/RunConsole 的跨模块草稿、挂起 Channel、隐藏页快捷键、审批徽标与终端 open/close 次数；真实 Radix Popover/Dialog 验焦点圈定、Esc 回焦和显式确认。VirtuosoMockContext 只补 jsdom 布局尺寸，不替换消息组件。xterm 渲染被替换，实际 shell 的切页保留与关闭在 [原生验收](../../../docs/acceptance/p4-6.md) 单独核对。

## P4-7 分栏与本机布局

`layout.test.tsx` 覆盖超时、读取失败防误写、串行保存/最新值与重试；`workspace-panels.test.tsx` 用受控几何和 ResizeObserver 验真实分栏库的键盘调整及自动收拢不写库。AppShell 测试核对终端收起/展开不增加 open 次数，terminal-theme 测试过滤零尺寸并在重新可见时 resize。jsdom 无真实排版和 PTY；鼠标、960×640、stty/中文/ANSI/Ctrl-C/重启/退出见 [原生记录](../../../docs/acceptance/p4-7.md)。

## P4-8 会话列表与归属

`session-list.test.tsx` 验本地标题过滤、空结果清除、历史状态与错误，真实 SessionsWorkspace/RunConsole 在两个独立 Channel 下切换、过滤、新建时保留草稿/目录/Agent/空间且不串流；过滤本身不产生 IPC。jsdom 不验证像素布局、原生焦点或真实进程，960×640、深浅/减少动态、键盘和产品 ACP 合成对端落库/重启见 [原生验收](../../../docs/acceptance/p4-8.md)。

## P4-9 底部输入与配置

`composer.test.tsx` 用真实 RunConsole 验 Enter/组合输入/229/结束保护、长多行文本、防重入、停止、Radix 焦点与回焦、规则传参、运行/托管目录锁定及模式热切换；AppShell 用终端 DOM 目标核对全局快捷键免疫。合成 composition 事件不等于真实中文输入法，原生已核对布局/粘贴/切页/运行取消，实际中文 IME 已由用户补验确认正常，见 [记录](../../../docs/acceptance/p4-9.md)。


## P4-10 流式 Markdown 与代码阅读

`markdown.test.tsx` 使用真实 renderer + streamReducer 核对中文半闭合增量、完成/历史一致、持续流合并解析、完成条目 DOM 保持、精确代码/全文复制（含 CRLF、引用、列表与尾部空行）、原文/超限回退、按需高亮长度/语言边界、危险 URL/HTML/图片、外链确认与失败、剪贴板失败反馈和焦点恢复。无网络/真实凭据；原生深浅/窄窗/复制/重开/20Hz 证据见 [P4-10](../../../docs/acceptance/p4-10.md)。该采样不替代 P4-11 阅读锚点或最终 release 性能回归。

## P4-11 阅读锚点与折叠

`reading.test.tsx` 核对阅读意图、未读与跳转、时间线重置、按 key/偏移恢复、1000 项 reducer 回放和 600 次活动文本更新、折叠跨虚拟卸载保留。可见行几何测试仅验证锚点选择契约，jsdom 不验证真实滚动/ResizeObserver；原生跟随、折叠、会话/模块恢复与帧采样见 [P4-11](../../../docs/acceptance/p4-11.md)。

## P4-12 工具与 diff 详情

`tool-details.test.tsx` 核对初始参数及首个终态接收时间、命令/参数/输出精确复制、按需磁盘读取、失败重试及过期响应丢弃、长 diff 完整原文回退、渲染失败局部恢复。`diff-preview.test.tsx` 核对异步初始化提示、5 秒无内容超时与就绪后取消计时。渲染器 mock 仅验证恢复契约；真实 WebKit 对照、系统剪贴板粘贴、深浅主题、减少动态与窄窗口证据见 [P4-12](../../../docs/acceptance/p4-12.md)。

## P4-13 指挥官目标输入

`commander-input.test.tsx` 核对严格模式首次默认 Agent、项目跟随/手改保留/显式恢复、多选与禁选、配置/密钥/查询失败状态、目录取消/选择/失败/过期结果、注册表刷新及同步防重提交。`commander-view.test.tsx` 使用真实工作区宿主验证生成 draft 的参数和确认入口，禁止任何执行/Agent 启动 IPC。Rust 目录契约测试覆盖绝对存在目录、相对/文件/缺失/删除及 Agent allowlist 限制。系统目录选择器与深浅/减少动态/窄窗、生成前后进程调用对照见 [原生验收](../../../docs/acceptance/p4-13.md)。

## P4-14 计划审阅与确认

`plan-review.test.tsx` 检查完整长提示词、任务切换、依赖/批次/Agent 与计划切换重置；`commander-view.test.tsx` 检查非法并发禁用、弹层实际并发、Esc 无执行、显式确认双击只调用一次 IPC。`app-shell.test.tsx` 检查弹层焦点约束/返回与同步防重。原生窄窗口、键盘循环及双任务各一次 ACP prompt 见 [P4-14](../../../docs/acceptance/p4-14.md)。

## P4-15 执行监控与会话定位

`execution-monitor.test.tsx` 核对七种持久化状态、截断/无结果、失活说明、会话定位失败与切模块后的过期回复；`commander-session.test.ts` 覆盖本地 UUID → ACP id 精确映射、目录/Agent/远端 id 不一致及重复记录拒绝。`commander-progress.test.tsx` 验证读取期间通知再次读取、隐藏期间不取消、旧刷新不覆盖执行终态。`sessions.test.ts` 核对历史 key 使用完整 UUID、相同 ACP 尾部不串台及刷新持久化状态。Rust 既有 `commander_scheduler` / `commander_summary` 集成测试覆盖全部前置成功、失败跳过、取消、会话归属；原生证据见 [P4-15](../../../docs/acceptance/p4-15.md)。

## P4-16 审批上下文与裁决反馈

`approval-center.test.ts` 覆盖 UUID 防重、失败重试、重复 tool id 精确移除和自动裁决不误清其他待决；`pending-card.test.tsx` 核对多处卡片共享提交状态、原文/变更/命令精确复制与持续选项隐藏；`approval-decisions.test.tsx` 验证不透明 option_id 依据 kind 显示拒绝与取消来源。`sessions.test.ts` 验证审批先到、SessionStarted 后到的集合同步及取消移除。Rust ApprovalBroker 测试保证非法选项不消费请求、取消来源和 request_id 序列化正确。原生三处一致、复制、并发及退出证据见 [P4-16](../../../docs/acceptance/p4-16.md)。

## P4-17 看板与任务详情

`kanban.test.tsx` 验证乐观移动、防重锁、失败回滚、重试和只读详情焦点；`task-detail.test.tsx` 验证换任务/关闭后的过期响应不会污染详情。Rust worktrees 测试保证非 Git 详情不创建目录，跨空间保留创建时 cwd、绑定会话与已有隔离目录。jsdom 不替代实际鼠标拖拽，原生证据和剩余出口见 [P4-17](../../../docs/acceptance/p4-17.md)。

## P4-18 分组设置与初次配置

`commander-settings.test.tsx` 覆盖保存不等于验证、同步锁防重、修改/重挂载清除验证结论、失败重试、密钥输入清空与取消状态；`project-settings.test.tsx` 覆盖目录取消、显式添加与失败不回调；`settings-groups.test.tsx` 覆盖分组可见性与模型/规则草稿保留。原生目录选择、WebKit 辅助功能及重启使用 SQLite key 见 [P4-18](../../../docs/acceptance/p4-18.md)，fixture 不代表真实模型能力验收。

## P4-19 统一状态与短反馈

`feedback.test.tsx` 覆盖 Toast 合并/超时/暂停/关闭回焦和复制失败无假成功；`kanban.test.tsx`、`commander-view.test.tsx`、`session-list.test.tsx` 验证读取失败到只读重试，不启动 Agent 或计划派单。`approval-center.test.ts` 覆盖部分监听注册失败清理与重试，权限提交失败沿用 UUID 防重契约。原生五页、故障注入、剪贴板/焦点与多尺寸证据见 [P4-19](../../../docs/acceptance/p4-19.md)。

## P4-20 命令面板与快捷键

`command-palette.test.tsx` 覆盖标题投影、白名单、作用域/上限、IME 及键盘/回焦；`app-shell.test.tsx` 验证打开搜索无 IPC、会话完整 key 定位，以及其他弹层/终端不被 Cmd-K 拦截；`kanban.test.tsx` 覆盖命令导航重新读取、已删除目标不误跳、新建只打开表单与 IME/重复 Enter 防误保存。真实 macOS IME 与多尺寸出口见 [P4-20](../../../docs/acceptance/p4-20.md)，自动测试不替代原生验收。

## P4-21 性能与资源回归

`just verify` 在生产构建后运行静态首包图预算及2项Node契约；native性能不使用jsdom计时冒充。`terminal-loader.test.tsx` 验证加载中关闭不挂载终端，重新打开可使用已加载模块；Markdown测试覆盖流式原文合并、稳定Unicode/换行块、完整复制和完成态恢复。当前原生预算与人工采样状态见 [P4-21](../../../docs/acceptance/p4-21.md)。
