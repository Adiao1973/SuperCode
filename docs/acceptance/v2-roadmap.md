# DOC-3 — v2.0.0 体验路线规划

> 最终结论（2026-10-08）：已验收，按流程 --no-ff 合入 dev。仅研究与文档；不实现 P4、不安装依赖、不修改产品版本/main/tag/Release。

## 预写验收（2026-10-08）

1. 核对 v1.0.0 发布范围、延期项、现有 React/Tauri 栈和关键 UI；区分源码观察、体验假设与尚未测量的指标。
2. 只引用官方文档/源仓库调研组件、动画及消息渲染方案，列出用途、许可证依据、兼容/性能风险和替代方案；不因视觉效果默认引入全部库。
3. 新 roadmap 定义 2.0 目标、范围、顺序、依赖与逐项验收；每个可执行任务 ≤2 天，较大项拆分。明确下一任务，全部产品任务仍为待办。
4. 保留 v1.0.0 路线历史；当前进度只由 roadmap 维护。分析/选型放 design，现行 architecture 不提前改成未实现接口。同步 docs/README、根 README 与验收/历史索引。
5. 相对链接/Markdown 结构检查、git diff --check、just verify 全绿；仅文档变更，不重复真实模型或发布。归档后 --no-ff 合 dev。

## 结果与依据

- 核对 v1.0.0 发布/验收记录与当前前端源码：批准的 macOS 范围完成；Windows/ZCode 继续延期，Claude 本机问题不纳入本轮，NativeDriver 产品接入仍未开展。现有布局、消息渲染、指挥官、审批和设置的问题分别列在 design；体验影响和性能预算明确为待验证判断。
- 新建 `design/desktop-v2.md`，给出信息布局、交互重点、主题/动效原则、量化预算和候选库。只核对官方文档/仓库，原始链接在该文档表中；Motion/cmdk/分栏/Sonner 为建议，Streamdown 须先对照测量。Animate UI 当前许可证含 Commons Clause，未当作纯 MIT 默认依赖；未安装或声称兼容测试通过。
- 现行 roadmap 更新为 Phase 4 / v2.0.0，共 24 项最小任务，顺序、依赖、估计和验收出口明确；单项 1～2 天、合计粗估 39 个开发日，原型后重估。下一项 P4-1 尚未开工。开发流程仍只有 development-process 一个规范入口。
- v1.0.0 原 roadmap 内容保留到 `history/roadmap-v1.0.0.md`，只调整相对链接并加历史说明；同步根 README、文档导航和历史/验收索引。architecture 不提前写入未实现接口；涉及偏好持久化等变化时各任务再先行设计。

## 执行验证

- Python 标准库检查：8 个新增/修改 Markdown 文件，109 个本地文件/锚点链接存在、围栏配对、无冲突标记；任务 ID 连续 P4-1～24、全部待办、逐项依赖前项、估计合计一致。`git diff --check` 通过。
- `just verify` 退出 0：前端 TypeScript/Vite 构建、fmt、严格 clippy、cargo test 全部通过，150 passed / 1 ignored。完整日志仅留本机 `/tmp/sc-v2-roadmap-verify.log`。构建仍有既有 Vite native config 与大 chunk 提示；本任务不改构建配置，体积基线/治理已列入 P4-1/P4-21。
- 变更仅 README/docs；没有代码、依赖、产品版本或已发布产物改动，没有读取/归档真实连接配置、密钥或 SQLite。无模型调用/UI 实现，故不重复真实推理或桌面验收；新预算是将来的出口，不是此次测试结果。

## 集成与后续

- 从 dev `1102714` 创建 `docs/v2-experience-roadmap`，先提交预写验收 `caa0ef6`，再完成分析、任务拆分和验证；归档后 `git merge --no-ff docs/v2-experience-roadmap` 合入 dev。
- 本轮授权为分析和制定路线，未启动 P4-1 或其它产品任务，未更新 main/tag/Release。后续从现行 roadmap 认领 P4-1，再按既有闭环执行。
