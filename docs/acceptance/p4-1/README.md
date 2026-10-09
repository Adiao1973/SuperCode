# P4-1 合成数据与采样复现

这里是 [P4-1 验收](../p4-1.md) 的证据与手动采样工具，不是产品功能或 P4-3 前端测试框架。没有真实密钥/模型配置或数据库；`p41-fake-not-a-real-key` 只供 loopback fixture 使用。

## 数据与进程隔离

选择一个**全新的临时目录**，建立 `bin`、`project`、`xdg/opencode`；先让当前 CLI 初始化数据库，再填合成数据：

```sh
mkdir -p /tmp/sc-p41/bin /tmp/sc-p41/project /tmp/sc-p41/xdg/opencode
chmod 700 /tmp/sc-p41
SUPERCODE_DB=/tmp/sc-p41/baseline.db ./target/debug/supercode sessions list
python3 docs/acceptance/p4-1/fixture.py seed /tmp/sc-p41
python3 docs/acceptance/p4-1/fixture.py serve /tmp/sc-p41
```

不能对原用户库执行 seed；脚本要求 sessions 为空，沿用产品的迁移元数据，不自行伪造 SQLx 迁移。重新复现时换临时目录，不能覆盖本轮证据库。固定监听 `127.0.0.1:19441`，被占用时先调查，不能结束未知进程。

仅在该验收 App 的环境中设置：`SUPERCODE_DB=<临时>/baseline.db`、`XDG_CONFIG_HOME=<临时>/xdg`、`PATH=<临时>/bin:<原 PATH>`。`bin/opencode` 是 shell 包装，执行本机 Node + 本目录 `fixture-acp.mjs` 并透传参数；不要替换全局 opencode、不要修改 HOME 或 `~/.supercode/agents.json`。App 使用独立 bundle ID 的临时副本并临时 adhoc 重签，避免与用户旧窗口混淆。

数据固定为 12 个历史会话、1022 条消息（其中一个会话 1000 条，交替中文用户文本与含 Markdown/代码/表格的 agent 文本）、一个项目和 12 个看板任务。没有伪造运行中任务/真实工具成功。交互走查会额外生成会话、审批、计划；性能复验须明确使用初始数据还是走查后的数据。

ACP fixture 的提示词：`fast` 返回固定文本；`permission` 请求一次合成 edit 审批，允许/拒绝均不会写文件；`stream` 每 50ms 发一个片段，共 900 个、约 45s。fixture 在拒绝后正常结束，因此计划成功不代表工具获准。HTTP fixture 只返回两任务契约、模型列表，或收取测量数字；不调用真实 API。

## 采样口径

- 截图使用 CUA 原生窗口截图。Retina DPR=2；内容尺寸 960×640 / 1280×800 / 1440×900 对应包含 32px 标题栏的窗口截图 1920×1344 / 2560×1664 / 2880×1864。原始截图不裁剪、不生成 UI 替身。各页顶部状态与完整滚动内容分开判断。
- 启动：普通 Release 副本通过临时启动包装固定上述环境，CUA `getApp` 自动启动；退出进程后重复 5 次，取 `Date.now()` 的调用前后差，读取到产品 AX 状态才计入。是过程冷启动、系统文件缓存温热、包含 CUA/AX 往返开销的上界，不能叫首帧或磁盘冷启动；首次控制权限/工具连接等待不计入。
- 包体：对 release `dist` 的入口 JS 及静态 import 图逐文件 `gzip.compress(bytes, mtime=0)`（Python 默认 level=9）求和，另列全部按需 JS/CSS；原始 `.app` 文件总大小不含临时包装。不是 HTTP 实际传输量，不包含字体或将按需 chunk 计成首包。
- 帧节奏：另构建 `pnpm --filter @supercode/desktop tauri build --bundles app --features tauri/devtools --config <临时 probe.json>`，config 只覆盖独立产品名/identifier；不修改 Cargo.toml。使用真实 Tauri/WebKit，Inspector Console 中粘贴 [probe.js](probe.js)，选好会话后调用 `p41.sample('long-history-scroll-1000', true)` 或 `p41.sample('stream-20hz', false)`，5 秒内关闭 Inspector。采样 30s，始终 visible，viewport=1280×800；滚动场景为每 3s 下/上行 2700px，流式场景不额外滚动。
- rAF 数据经 loopback `/metrics` 送到临时 `metrics.jsonl`，p95 用 nearest-rank。这是帧调度节奏近似值，不是合成器掉帧数、GPU 时间或主线程 Long Task 数；本机 WebKit 不支持 `longtask` observer。Inspector 关闭但探针功能/脚本仍有开销，后续要同口径比较；不能与未插桩的发行包帧率直接相减。
- 内存：`ps -p <本轮 App pid> -o rss=`，单位 KiB；记录普通 Release 与 Inspector probe 分开。仅宿主 RSS，不合并无法可靠归因的 WebContent/GPU/网络 XPC；系统有其它常用应用运行，不是独占测试机。不能据此声称整个 App 无泄漏或内存预算已通过。

结果在 [baseline.json](baseline.json)，原始帧数组在 [frames.json](frames.json)，图片索引见 [验收记录](../p4-1.md)。本地日志/SQLite、App 副本和终端 PID 不纳入 Git；结束本轮进程后保留纯合成临时库供本机复查。
