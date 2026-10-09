# 桌面 2.0 原型与库选型决策（P4-2）

> 2026-10-09。范围是独立原型与兼容调查；发布版本仍为 1.0.0。状态和未完成出口见 [验收记录](../acceptance/p4-2.md)，不能把参考实现记成生产交付。

## 视觉与交互方案

采用石墨深色与纸白浅色，系统字体/等宽代码字体，单一靛蓝操作色；用排版、留白、细分隔线区分层次。卡片只用于可操作的看板任务与输入，不将每段正文装进卡片。五页沿用同一导航、标题、任务详情与状态语言。

- **960×640**：64px 图标导航，隐藏项目列表，底部输入常驻。正文主区优先，完整任务说明在可关闭详情层中。设置标签仍可见，内容纵向滚动；不缩小字号硬塞完整表单。
- **1280×800 / 1440×900**：176px 导航、默认 224px 可调整项目列表；最小正文宽度 460px，详情按需打开。大窗口的会话正文与输入设阅读宽度上限，不无限拉长行。
- **会话**：正文、思考摘要、文件变更、待决请求分层；输入迁到底部，Agent/权限明确可见，cwd 与终端入口在输入旁。原型未接入原生 PTY 或历史虚拟列表。
- **指挥官**：目标输入与计划列表层次分明；任务详情显示完整说明、依赖、Agent/权限/目录。执行确认先聚焦取消，Tab 圈定、Esc 关闭并回焦；确认只改变合成状态。
- **审批**：所属会话/Agent 与变更内容先于裁决按钮；允许一次和拒绝分开，不引入批量放行或永久权限。
- **设置**：模型、Agent、外观、审批规则分组；连接/密钥保存/验证状态各自解释，不用安装成功代替认证成功。例子均为合成信息。

三类过渡使用相同 easing `[.22,1,.36,1]`、220ms：工作区 opacity + 6px 进入、详情 opacity + 20px 展开、看板共享 layoutId 落位。工作区有退出/进入两个阶段，不宣称总时长仅 220ms。减少模式位移/布局动画为零，状态处理立即发生；原型跟随系统并允许主动减少。`speed=slow` 只用于十倍时长审阅录像。

## 精确候选与取舍

版本来自 2026-10-09 npm 元数据及实际安装内容，完整 peers、LICENSE 原文/摘要见 [libraries.json](../acceptance/p4-2/libraries.json) 与其同级 licenses。原型独立 [package.json](../../prototypes/desktop-v2/package.json) 与锁文件固定传递依赖；生产接入时必须保持单一 React 实例。

| 库 | 本轮版本 / 许可 | 结论和原因 |
|---|---|---|
| React / React DOM | 19.3.0 / MIT | 与当前已解析产品版本一致；原型 build 与原生显示通过 |
| radix-ui | 1.6.7 / MIT | 沿用当前 primitive 体系；Dialog/AlertDialog 实测焦点，不另外叠 UI 框架。受控详情的触发点由原型明确记录/恢复 |
| Motion（含 framer-motion） | 14.0.0 / MIT | 采用开源核心；原型用 LazyMotion + m + domMax 验证三类动画。生产 P4-5 按实际 layout 需求决定 domAnimation/domMax 并控制加载边界，不引入 Motion+ |
| react-resizable-panels | 4.14.3 / MIT | 原型 API 为 Group/Panel/Separator，键盘 resize 通过；不能照搬旧 PanelGroup 示例。鼠标人工出口尚需记录，不以无效自动化拖动判库失败或通过 |
| cmdk | 1.1.1 / MIT | 保留用于 P4-20；当前原型只检索已加载项目内内容，不实现全库搜索；中文 IME 正式专项后验收 |
| Sonner | 2.0.8 / MIT | 保留用于短反馈；错误、审批和执行确认仍在原位置显示，不借 Toast 掩盖状态 |
| react-markdown + remark-gfm | 10.1.0 + 4.0.1 / MIT | **建议生产首选的轻量组合**；本轮中文/表格/未闭合代码对照可读。生产需要流中原文回退、按需高亮及增量/虚拟列表专项 |
| Streamdown | 2.7.0 / Apache-2.0 | **仅保留对照，不默认进入生产**；较完整流式能力伴随较大依赖。原型会话展示它的排版，对照页同时展示两个方案；不把原型选用误称最终生产接入 |
| lucide-react | 1.48.0 / ISC | 继续使用当前图标体系；包内实际许可为 ISC，不能笼统记成 MIT |
| dnd-kit / react-virtuoso / xterm / diffs | 沿用产品现有锁定版本 | 本轮不替换、不复制业务宿主；看板按钮移动仅展示落位，P4-17 再与真实 dnd-kit transform 协调 |
| Animate UI / 大型第二组件体系 | 不安装 | 沿用既有许可风险判断；本轮无需第二套 primitive/动画引擎 |

包体对照：相同 React 19.3.0 / Vite 8.3.1 最小静态 renderer，gzip level9 基线 67,613B；Streamdown 219,207B（增量 151,594B），react-markdown + GFM 113,090B（增量 45,477B）。[原始结果与方法](../acceptance/p4-2/bundle-comparison.json)。这是选型成本依据，**不是产品首包、20Hz 渲染耗时或 v2.0 性能预算已通过**。原型里两方案共存仅为对照，生产必须去掉不用的 renderer。

Markdown 两者都使用原型边界：skipHtml、不实例化 img、自定义 URL 过滤/不激活外链，无 Mermaid/数学/代码高亮插件。真实产品外链确认、完整不可信输入与升级策略留到 P4-10；本轮不能宣称任意 Markdown 的安全认证。

## 已核对的官方资料

- [Motion LazyMotion](https://motion.dev/docs/react-lazy-motion) 与 [减少动态](https://motion.dev/docs/react-use-reduced-motion)：加载边界与用户偏好。
- [react-resizable-panels 官方仓库](https://github.com/bvaughn/react-resizable-panels)：当前 Group/Panel/Separator API；具体锁定实现以安装包为准。
- [Streamdown 配置](https://streamdown.ai/docs/configuration)、[链接边界](https://streamdown.ai/docs/link-safety)、[源仓库许可](https://github.com/vercel/streamdown/blob/main/LICENSE)：流式选项及 Apache 许可。
- [react-markdown 官方仓库](https://github.com/remarkjs/react-markdown)、[cmdk](https://github.com/dip/cmdk)、[Sonner](https://github.com/emilkowalski/sonner)：接口和许可证核对入口；版本证据来自安装包，不依据浮动 main 判断已锁定行为。

## 对后续任务的约束

P4-3 先接前端验证与稳定 fixture，不复制原型的演示状态充当产品模型；P4-4/5/6 才实施主题/动效/布局，P4-9/10 再接会话输入与 Markdown。现有任务执行、SQLite、审批裁决、ACP 与终端生命周期保持权威；布局切换不得 remount 执行宿主。P4-1 的 20Hz p95 29ms 仍是待优化基线，不能拿此处小样例替代长历史性能出口。
