# DOC-2 macOS 优先路线调整

> 状态：进行中。仅调整文档和后续任务范围，不开发或发布产品。

## 范围与预写验收

1. 根据用户 2026-10-07 指令“目前是没有 windows 机器可以验收的，全力研发 mac 平台”，延期 P3-8/P3-9，排除当前 macOS 发布范围；不是 Windows 验收通过。
2. 从 dev 切 docs/macos-priority；保留 Windows 实现分支，不合入未经平台验收的代码。将 P3-8 过程记录带回文档入口，清楚标记原分支与未完成出口。
3. ADR、roadmap、架构、README、流程中的平台门槛和验收索引一致；P3-10 拆分 macOS 回归与构建发布，后续按任务逐项认领，不在本任务启动。
4. 相对链接、Markdown 围栏、冲突标记与 git diff --check；just verify 全绿。文档变更不重复模型/UI 验收，不读取或归档认证/数据库。
5. 归档后 --no-ff 合回 dev；不改 main/tag/Release。
