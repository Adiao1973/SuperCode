# ADR-0005: 分支模型 feat/fix → dev → main（tag 发布）

- 状态：已接受（2026-09-24，用户指定）

## 背景

需要确定分支与发布策略。常见模型：GitHub Flow（单 main + 短分支）、Git Flow（main+develop+release+hotfix）、trunk-based。

## 决策

三层模型，**main 只存放稳定可发布版本**：

```
feat/xxx ─┐
fix/xxx  ─┴─► dev（日常集成分支）──版本稳定可发布──► 打 tag vX.Y.Z ──► 合并回 main
```

- 任务分支从 dev 切出，闭环验收通过后 `--no-ff` 合回 dev；
- dev 恒可构建、`just verify` 全绿；
- 仅当 dev 达到可发布里程碑（Phase 级验收剧本全过）才打 tag 并合并回 main；
- 例外：main 紧急 hotfix 从 main 切分支，修复后同时合回 main 与 dev。

## 理由

- 用户明确要求：验收后先合 dev，版本稳定可发布时才打 tag 合 main。
- main 与"成品"强绑定（每个 tag 对应可构建的桌面安装包/CLI 产物），发布语义干净；
- 日常开发在 dev 上自由集成，不污染发布基线。

## 被否方案

| 方案 | 否决原因 |
|---|---|
| GitHub Flow（直接合 main） | main 变成日常集成分支，与"任何时点 checkout main 即可出成品"的产品诉求冲突 |
| 完整 Git Flow（release/hotfix 常设分支） | 单人小团队流程过重 |

## 影响

- hotfix 需双向回流（main + dev），流程文档已写明；
- tag 命名 `vX.Y.Z` 与 roadmap 里程碑表对齐（v0.1.0 = Phase 0，v0.2.0 = Phase 1...）；
- 若未来引入 CI，发布产物（.dmg/.exe）应挂在 tag 上构建。
