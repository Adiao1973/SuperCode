# SuperCode 开发流程

> 本文档定义 SuperCode 的**闭环分步循环开发流程**与全部工程规范。与 [roadmap](roadmap.md)（做什么）、[architecture](architecture.md)（怎么设计）配套。文档入口见 [docs/README](README.md)。本文件是开发流程的唯一规范来源。

## 1. 闭环分步循环（每个任务走同一个循环）

```
① 取任务 → ② 小设计 → ③ 实现 → ④ 验证 → ⑤ 闭环归档 →（回到①）
            文档先行     小步提交    自动+手动    更新文档/roadmap
```

1. **取任务**：从 `docs/roadmap.md` 认领一个最小任务（≤2 天）。验收标准不清晰 → 先在 roadmap 补清验收命令与预期输出，再动工。
2. **小设计**：涉及接口 / 数据模型 / 协议行为变更 → **先更新 `docs/architecture.md` 对应章节**（文档先行），必要时补 ADR；纯内部实现可跳过。
3. **实现**：TDD 优先——接口契约测试先写（driver 状态机、事件转换、审批队列这类逻辑必须有单测）；小步提交；实现严格对齐文档。
4. **验证（闭环检验点）**：
   - 自动：`just verify`（= 前端构建 + `cargo fmt --check` + `cargo clippy --all-targets -- -D warnings` + `cargo test`）必须全绿；
   - 手动：执行该任务在 roadmap 预写的**验收命令并核对预期输出**；涉及 UI 的用 `pnpm tauri dev` 人工核对；
   - **不过则回到③，禁止带病前进。**
5. **闭环归档**：更新 `roadmap.md` 任务状态（有偏差写明原因）；接口变更同步回 `architecture.md`；重大取舍补 ADR；任务分支合回 `dev`。**循环结束时代码与文档一致、roadmap 反映真实进度——这就是闭环。**

### 1.1 未完成出口与任务顺序

- 自动检查通过但真实模型/平台出口未通过，任务标记“待验收”，保留任务分支，不能宣称已验收或合入 dev。fixture、目录查询、密钥保存、版本探测都不能代替真实运行验收。
- 默认完成当前任务闭环后才实现下一任务。存在阻塞时，可以整理文档、调查问题或准备设计；不要自行提前实现依赖该任务的下一阶段。
- 用户明确允许跳过、提前发布或并行实现时，在当前任务验收记录写明授权、排除范围、剩余出口与集成顺序，roadmap 同步为延期/待验收；排除项不得伪记通过。依赖分支属于例外，前置出口完成前不得合 dev。
- 新需求改变接口时更新现行设计原段；废弃约定移入历史或明确被替代，不仅在文末追加“补充”让两套规则并存。

### 1.2 文档归属与闭环检查

| 内容 | 唯一维护位置 |
|---|---|
| 执行步骤、DoD、分支与发布规则 | 本文件 |
| 当前任务状态、下一任务、延期范围 | roadmap.md |
| 现行接口、数据模型、行为约束 | architecture.md |
| 重大取舍与理由 | adr/ |
| 预写验收、执行证据、偏差与最终结论 | acceptance/任务记录 |
| 被替代设计与过程快照 | history/（仅查历史） |
| 用户使用方法及已发布/dev 差异 | 根 README.md |

归档时检查：任务表、验收顶部结论、设计、根 README 的当前状态一致；相对链接有效；历史待验收描述明确属于当时。任务验收顶部先写最终结论，过程证据放后面。不在 roadmap 或 architecture 重复抄验收日志。真实 endpoint/model/key、SQLite 及其附属文件不进入仓库。

文档整理也是独立任务：从 dev 切 docs/ 分支，写明范围和验收，执行链接/结构检查与 just verify，归档后 --no-ff 合回 dev，不借整理启动下一功能。

## 2. Definition of Done（每任务硬标准）

- [ ] `just verify` 全绿
- [ ] roadmap 预写的验收标准逐条达成并**留痕**（命令输出贴入 PR/提交说明或 `docs/acceptance/`）
- [ ] `architecture.md` 与代码接口一致（有变必更）
- [ ] 提交历史符合约定式提交
- [ ] 新增依赖在提交说明或 ADR 中说明理由

## 3. 分支模型

```
feat/xxx ─┐
fix/xxx  ─┴─► dev（日常集成分支）──版本稳定可发布──► 打 tag vX.Y.Z ──► 合并回 main
```

- **`feat/xxx` / `fix/xxx` / `docs/xxx`**：短生命周期任务分支，**从 `dev` 切出**；闭环验收通过后合回 `dev`（`--no-ff`，保留合并记录与任务边界）。
- **`dev`**：日常集成分支，**任何时点都必须可构建且 `just verify` 全绿**；所有日常验收的合并目标。
- **`main`**：**仅存放稳定可发布的版本**。只有当 dev 达到可发布里程碑（v0.1.0 / v0.2.0 / ...）时：
  1. 在 dev 上跑完整验收剧本（Phase 级，见 roadmap）；
  2. 全过后在 dev 打 tag `vX.Y.Z`；
  3. 将 dev 合并回 main（`--no-ff`）。
  main 上任何时点 checkout 都应能构建出成品。**hotfix 例外**：main 上的紧急修复从 main 切 `fix/hotfix-xxx`，修复后同时合回 main 与 dev。
- 命名：`feat/<任务ID>-<短横线摘要>`，如 `feat/p0-4-acp-driver`。

## 4. 提交规范

约定式提交（Conventional Commits）：

```
<type>(<scope>): <摘要>

type: feat | fix | docs | refactor | test | chore | perf
scope: core | cli | desktop | docs | repo
示例：feat(core): AcpDriver 实现 session/prompt 事件转换
```

- 一个任务一个分支，分支内小步提交；合并进 dev 的粒度 = roadmap 的一个任务。
- 提交说明正文可贴验收输出片段（留痕）。

## 5. 测试分层

| 层 | 内容 | 工具 | 要求 |
|---|---|---|---|
| 单元测试 | 事件合帧、审批规则引擎、driver 状态机、数据模型 | `cargo test` | 核心逻辑必须有，随实现同提交 |
| 协议集成 | ACP 消息流回放（录制真实 opencode 交互的 stdio 流做 fixture）与本地 opencode 冒烟 | `cargo test --ignored`（冒烟需本机装 opencode，不进常规 verify） | Phase 0 P0-4 起建立 |
| UI 核对 | 桌面端人工核对清单（每 P1-x 任务验收要点） | `pnpm tauri dev` | 验收留痕 |

## 6. 发布流程（dev → main）

1. roadmap 中该 Phase 发布范围内全部任务 `已验收`；用户明确排除的延期项需在阶段验收中记录范围授权和未完成出口；
2. 在 dev 执行 Phase 级验收剧本，输出存 `docs/acceptance/phase<N>.md`；
3. 更新 `architecture.md` 变更记录、`roadmap.md` 里程碑表；
4. `git tag vX.Y.Z`（ annotated，含里程碑摘要）；
5. `git checkout main && git merge --no-ff dev`；
6. （Phase 1 起）Tauri 构建产出安装包，附于 tag。

## 7. 一键命令（justfile）

```
just verify     # 前端构建（tauri build.rs 依赖 dist/）+ fmt --check + clippy --deny warnings + cargo test
just fix        # fmt + clippy --fix
just smoke      # 需本机 opencode 的冒烟验收（对应 roadmap 当前 Phase 剧本）
just dev        # Phase 1 起：pnpm tauri dev（apps/desktop）
```

任何新增检查项先进 `just verify` 再进流程——闭环成本必须保持最低。

## 8. WebKit / Tauri 开发红线（摘自 architecture.md §10）

1. 事件流禁止 SSE/EventSource，一律 Tauri Channel / WebSocket 插件；
2. xterm.js ≥5.3.0，避免透明 canvas；
3. macOS 慎用 `backdrop-filter` + 窗口透明 / `position:fixed`（用 sticky 替代）；
4. 视觉相关验收按已批准的平台范围实测。当前 macOS 优先，Windows 经用户授权延期（[ADR-0008](adr/0008-macos-priority.md)），不阻塞本轮 macOS 工作；恢复 Windows 发布范围时必须完成 Windows 实机出口。
