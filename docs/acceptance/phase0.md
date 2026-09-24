# Phase 0 验收记录（v0.1.0）

> 执行日期：2026-09-24 · 环境：macOS arm64 · opencode 1.18.30（zhipuai-coding-plan/glm-5.3-flash）
> 执行分支：feat/p0-10-phase0-release（基于 dev @ 8e95071）

## 剧本 ①：detect 版本报告 ✅

```
$ supercode detect
OpenCode 1.18.30 ✓
```

## 剧本 ②：真实任务——工具事件 + 权限 y 应答 + 文件落盘 ✅

场景：`/tmp/sc-test`（项目级 `permission: {edit: ask, bash: ask}`），管道喂 `y`。

```
$ printf 'y\n' | supercode run '在当前目录创建 hello.txt 文件，内容为 hi-supercode，然后把文件内容读出来告诉我' --cwd /tmp/sc-test

⚡ 权限请求: /private/tmp/sc-test/hello.txt
   输入: {"filepath":"/private/tmp/sc-test/hello.txt","diff":"@@ -0,0 +1,1 @@\n+hi-supercode\n"}
允许吗？(y/n/a): · 用户裁决 /private/tmp/sc-test/hello.txt → once

🔧 [Edit] tool — write  → InProgress → Completed
🔧 [Read] tool — read   → InProgress → Completed
文件已创建，内容为：`hi-supercode`
—— 轮次结束: EndTurn ——

$ cat /tmp/sc-test/hello.txt
hi-supercode
```

要点：权限请求携带完整 diff 可见；y 应答后工具执行；最终消息复述内容与磁盘一致。

## 剧本 ③：权限拒绝路径 n ✅

同任务管道喂 `n`：

```
⚡ 权限请求: /private/tmp/sc-test/hello.txt
允许吗？: · 用户裁决 → reject
   ↳ call_xxx: Failed
—— 轮次结束: EndTurn ——
$ ls /tmp/sc-test/hello.txt → No such file or directory
```

要点：agent 收到拒绝（工具 Failed），文件未创建。

## 剧本 ④：Ctrl-C 取消无残留 ✅

场景：长任务 `sleep 120`（`--allow 'bash(sleep *)'` 预授权），12s 后 SIGINT。

```
长任务运行中 ✓
· 收到 Ctrl-C，正在取消当前任务…
—— 轮次结束: Cancelled ——
supercode exit: 0
sleep 无残留 ✓ / opencode 无残留 ✓
```

执行注记：首轮使用精确规则 `bash(sleep 120)` 失败——agent 把命令改写为
`sleep 120 && echo ...`，精确规则不匹配（符合设计语义），改用通配规则后通过。
经验：面向 agent 的预授权规则建议使用通配（`bash(sleep *)`），agent 常自行拼接命令。

## 剧本 ⑤：sessions list / resume 上下文恢复 ✅

```
$ supercode run '我们的暗号是：芒果777。只回复：收到' --cwd /tmp/sc-p10-5
收到 —— 轮次结束: EndTurn ——

$ supercode sessions list
2d724ba1-3dab-49b0-ae19-3ce1fa89a4e3  completed  我们的暗号是：芒果777。只回复：收到  /tmp/sc-p10-5
2ff9bde3-…  cancelled  运行 shell 命令 sleep 120…  /tmp/sc-test     ← 剧本④的取消会话
1ec879e5-…  completed  运行命令 sleep 120…  /tmp/sc-test

$ supercode resume 2d724ba1-… '我们的暗号是什么？只回答暗号本身'
· 恢复会话（历史将重放）…
芒果777 —— 轮次结束: EndTurn ——
```

要点：新 agent 进程经 session/load 重放历史后正确找回上下文；
会话状态（completed/cancelled）与标题、目录均正确落库。

## 结论

Phase 0 目标达成：**ACP 全链路（事件流 / 工具调用 / 权限审批三路径 / 取消 / 会话恢复 / SQLite 存档）
在真实 opencode + GLM 5.3 flash 下验收通过**。`just verify` 全绿（28 测试）。
同意发布 v0.1.0（tag 于 dev，合并回 main）。
