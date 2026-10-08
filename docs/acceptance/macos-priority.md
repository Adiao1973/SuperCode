# DOC-2 macOS 优先路线调整

> 最终结论（2026-10-07）：已验收，按 --no-ff 合入 dev。仅调整文档和后续任务范围，不开发或发布产品。

## 范围与预写验收

1. 根据用户 2026-10-07 指令“目前是没有 windows 机器可以验收的，全力研发 mac 平台”，延期 P3-8/P3-9，排除当前 macOS 发布范围；不是 Windows 验收通过。
2. 从 dev 切 docs/macos-priority；保留 Windows 实现分支，不合入未经平台验收的代码。将 P3-8 过程记录带回文档入口，清楚标记原分支与未完成出口。
3. ADR、roadmap、架构、README、流程中的平台门槛和验收索引一致；P3-10 拆分 macOS 回归与构建发布，后续按任务逐项认领，不在本任务启动。
4. 相对链接、Markdown 围栏、冲突标记与 git diff --check；just verify 全绿。文档变更不重复模型/UI 验收，不读取或归档认证/数据库。
5. 归档后 --no-ff 合回 dev；不改 main/tag/Release。


## 结果与集成

- 新增 ADR-0008，Windows P3-8/P3-9 明确延期并排除当前 macOS v1.0.0 范围；P3-8 记录归档回 dev，其实现、依赖和 workflow 仍保留原分支，不随文档合入。
- 下一任务 P3-10A macOS 整体回归，随后 P3-10B macOS 构建与发布。两项均尚未启动；当前已发布版本仍是 v0.3.0。不新增 NativeDriver 产品入口或宣称 Windows 可用。
- README、架构、流程、roadmap、ADR/验收索引同步；39 个 Markdown 文件的相对链接、围栏和冲突标记检查通过，git diff --check 通过。
- just verify 退出 0：前端构建、fmt、严格 clippy、cargo test 全绿，150 passed / 1 ignored；日志仅留本机 /tmp/sc-macos-priority-verify.log。此数为 dev 代码基线，不包含 Windows 分支新增测试。
- git diff dev -- crates apps Cargo.lock .github 为空；没有将 Windows 实现混入 dev，也未追踪认证/SQLite。文档任务从 dev 独立分支 docs/macos-priority 提交，验证后 --no-ff 合回 dev，不改 main/tag/Release。
