# SuperCode 桌面交互原型

P4-2 独立可运行样例，使用 React 19 与当前 Tauri/WebKit 壳。**不是已接入业务的 2.0 App**：所有任务、计划、审批和连接信息都是内存中的合成内容，刷新即还原；没有 IPC、真实 API、密钥输入/保存、文件写入、PTY 或任务执行。

生产 `apps/desktop`、Cargo 与根 pnpm 锁文件未更改。原型有自己的精确依赖和锁文件，不能把两套 React 同时打进生产应用。

## 运行与审阅

```sh
pnpm --dir prototypes/desktop-v2 install --ignore-workspace --frozen-lockfile
pnpm --dir prototypes/desktop-v2 build
pnpm --dir prototypes/desktop-v2 dev
```

浏览器审阅 `http://127.0.0.1:1442/`；浏览器不能替代原生验收。五页从左侧导航进入，主题在右上角切换，外观设置含减少动态偏好。项目列表在宽度 ≥1100 时显示，1200 以下主导航折为图标；点击任务打开详情，Esc 关闭并回到触发点。Cmd-K 搜索已加载模块/会话。看板右箭头仅演示合成任务跨列落位，不是拖拽引擎或持久化实现。

审阅场景使用 hash，不提供产品里的测试按钮：

- `/#page=sessions&theme=dark`：标准会话。
- `/#page=commander&theme=light`：浅色计划审阅。
- `page` 可为 `sessions/commander/kanban/approvals/settings`；`theme` 为 `dark/light`。
- `state=empty/loading/error`：稳定的状态样例，不代表真实请求失败。
- `motion=reduce`：减少动态；仍可完成同样的合成交互。
- `speed=slow`：**仅审阅**，将过渡从 220ms 放慢至 2200ms，便于低频原生截图记录空间关系。默认没有慢放，不以慢放录像证明正常速度的帧率。
- `/compare.html`：Streamdown 与 react-markdown + GFM 的相同中文、表格、未闭合代码、危险 URL、HTML 和远端图片样例；按钮按 20Hz 增量更新。两者都关闭外链激活和远端图片加载。不是通用安全认证或全量性能测试。

代码复制会使用系统剪贴板；其它演示动作不调用系统资源。目录与 Agent 选择器外形用于审阅，本轮不接入真实选择/检测。Toast/确认/审批只更新当前内存状态，不应当拿它们验收产品执行逻辑。

## 原生 Tauri 验证

先停止单独的 Vite 进程（防止端口冲突），再从仓库根目录运行：

```sh
# 每轮选择新的纯合成临时目录，绝不指向用户数据库。
scratch=$(mktemp -d /tmp/sc-p42.XXXXXX)
mkdir -p "$scratch/xdg/opencode"
SUPERCODE_DB="$scratch/fixture.db" XDG_CONFIG_HOME="$scratch/xdg" \
  pnpm --filter @supercode/desktop tauri dev \
  --config ../../prototypes/desktop-v2/tauri.prototype.json
```

临时壳使用独立 identifier 和标题，覆盖开发入口；产品配置文件不变。退出时停止该 dev 进程及其 Vite 子进程。CUA 不能识别裸调试二进制时，本轮用独立临时 `.app` 包装同一 debug binary，并用启动包装固定隔离环境；不是重新制作 UI 或替换宿主。

本轮原生证据见 [验收记录](../../docs/acceptance/p4-2.md)，候选版本、许可与取舍见 [设计决策](../../docs/design/desktop-v2-prototype.md)。

## 体积复现与生产接入边界

```sh
node prototypes/desktop-v2/measure-bundles.mjs
```

该脚本用相同 React/Vite 最小样例对比 renderer，临时目录结束即清理；不等于产品首包预算，也不测运行速度。实际原型同时包含候选库，Markdown 使用 `React.lazy` 分包，生产不能照搬同时打入两种 renderer。正式页面的事件、列表虚拟化、状态持久化、终端 fit/清理、安全链接确认与测试接入分别按 P4-3 之后任务实施。
