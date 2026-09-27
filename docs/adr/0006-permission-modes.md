# ADR-0006: 权限模式为主 UX，规则降级为高级层

- 状态：已接受（2026-09-25，P1-2 验收中确认方向；落地于 P1-5）

## 背景

P1-2 桌面壳验收暴露了两个事实：

1. **手写 glob 规则对普通用户门槛过高**。P0-10 已有先例（`sleep 120` 被 agent 改写导致精确规则失配）；P1-2 又出现裸 `write` 规则与 `bash(echo *)` 语义混淆的同类问题。规则是专家向的例外表达，不适合做主交互。
2. **客户端审批存在管辖边界**：opencode 自带安全命令白名单（echo/ls/cat 等直接放行）且对**新建文件**的 write 不发权限请求。SuperCode 的规则/审批只能裁决 agent 主动询问的操作——今天"规则不含 bash(echo *) 却写入成功"的验收现象即源于此。要全量管控必须同时收紧 agent 侧配置（opencode `permission` 设置）。

同期用户确认参考 ZCode（zai-org/ZCode，Apache-2.0）的权限模式设计：计划 / 变更前确认（build）/ 自动编辑（edit）/ 完全访问（yolo）四档一键切换。

## 决策

**权限模式（PermissionMode）作为会话级主 UX，规则库降级为高级补充层**：

| 模式 | 语义（对 agent 发来的权限请求） | 对应 ZCode |
|---|---|---|
| `plan` 计划 | 一律拒绝（只读保证） | plan / 计划模式 |
| `ask` 变更前确认 | 全部进待决队列 | build / 变更前确认 |
| `autoedit` 自动编辑 | edit/write 类放行，其余进队列 | edit / 自动编辑 |
| `full` 完全访问 | 全部放行（deny 规则仍生效） | yolo / 完全访问 |

**裁决管线**（P1-5 起在 ApprovalBroker 实现，顺序对齐 ZCode `PermissionService.checkPermission` 的关键位次）：

```
1. deny 规则命中        → 拒绝（任何模式下最硬，对齐 ZCode 硬阻断先于放行的原则）
2. plan 模式            → 拒绝（allow 规则不再考察——计划模式保证只读，对齐 ZCode plan 先于 allow 规则）
3. full 模式            → 放行
4. ask 规则命中         → 待决队列（用户显式要求逐次确认的）
5. allow 规则命中       → 放行
6. autoedit ∧ 请求推断为 edit/write 类 → 放行（bash 类不在此列，进队列）
7. 兜底                 → 待决队列（已接审批 UI）；无 UI 宿主 → 拒绝（fail-closed，P1-2 现状）
```

**管辖边界写入产品语义**：模式与规则只约束 agent 发问的操作集。P1-7 安装探测增加"严格模式引导"——检测并建议收紧 opencode `permission` 配置，把白名单放行与新建文件写入也纳入询问范围。

## 理由

- **UX 共识**：ZCode（plan/build/edit/yolo）、Claude Code（plan/acceptEdits/bypassPermissions）、opencode TUI（build/plan/full-access）语义高度重合——按改动强度分档是行业收敛解，一键切换远优于手写 glob。
- **源码佐证**（zai-org/ZCode `apps/zcode-cli/packages/core/src/permission/service.ts`）：模式是"未匹配请求的默认策略"，项目规则（deny/ask/allow）作为例外穿插在管线的固定位次；alwaysAsk 工具的阻断分支压过一切放行分支。我们的规则语法（`tool(subject)` + 通配）与 ZCode 的 toolName+ruleContent 模型同构，可直接套用该管线。
- **架构成本极低**：ApprovalBroker 已有待决队列（P0-5）与 fail-closed 变体（P1-2），模式只是"未匹配兜底行为"的枚举化，`PermissionMode` 四值 + 管线重排即可。
- **许可证允许**：ZCode 为 Apache-2.0，可借鉴实现细节（保留署名）；仅架构思路与位次为本次引用重点。

## 被否方案

| 方案 | 否决原因 |
|---|---|
| 维持纯规则引擎做主 UX | 门槛高、易错配（P0-10/P1-2 两次实证）；无法表达"我现在只想让它看代码"这类意图 |
| 只做模式、删掉规则 | 丢失精确控制（`bash(git *)` 预授权、危险命令黑名单）；ZCode 同样保留项目规则层 |
| 在客户端复刻 ZCode 的风险分级（riskLevel/sideEffectScope 能力声明） | ACP 权限请求不携带这些元数据，无法对异构 agent 通用；用"工具名推断 edit 类"的近似即可，P1-5 不引入能力模型 |

## 影响

- P1-5 验收要点重写：模式选择器（会话级）+ 规则库管理（设置页，SQLite 持久化）+ 待决队列；`PermissionMode` 进 core。
- P1-7 增加严格模式引导（opencode permission 配置检查/收紧建议），补客户端管辖边界之外的缺口。
- architecture.md §4.3 增补模式化管线（v2 设计稿）；P1-2 桌面壳沿用 fail-closed 直至 P1-5 接管。
- 语义边界（只管 agent 问的，不管 agent 不问的）写入 architecture 与用户文档，避免"规则没拦住"的误报。

## 实证记录（2026-09-25，P1-2 验收期间）

- opencode 权限默认值宽松：`bash`/`edit` 默认 **allow**（官方 docs/permissions 确认）——sleep、echo、新建文件 write 均不发询问，直接执行。
- opencode 支持项目级配置：会话 cwd 下 `opencode.jsonc` 写入 `"permission": {"edit": "ask", "bash": "ask"}` 后，bash/edit 全部转为询问转发客户端（opencode 日志 `loading path=…/opencode.jsonc` + 客户端 deny 规则命中留痕）。
- 昨天 P0 审批三路径能全部验证通过，正是因为测试目录 `/tmp/sc-test` 留有该配置；换到无配置目录后"规则失效"假象即由此而来。
- **P1-7 严格模式的落点由此明确**：SuperCode 检测会话目录的 opencode permission 配置，宽松时引导/自动写入 ask 配置（后续评估经 `OPENCODE_CONFIG` 环境变量注入托管配置，避免改动用户目录）。
