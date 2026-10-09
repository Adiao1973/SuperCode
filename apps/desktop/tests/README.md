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
