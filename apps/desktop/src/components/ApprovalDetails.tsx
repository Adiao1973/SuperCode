import { useState } from "react";
import type { PendingPermission } from "@/lib/permissions";
import { parameterText, toolCommand } from "@/lib/tool-details";
import { TimelineCopy } from "./TimelineCopy";

const textClass = "mt-2 max-h-64 overflow-auto rounded bg-muted/40 p-3 text-xs whitespace-pre-wrap [overflow-wrap:anywhere] select-text";
export function ApprovalDetails({ pending }: { pending: PendingPermission }) {
  const [expanded, setExpanded] = useState(false);
  const { request } = pending;
  const raw = request.raw_input;
  const input = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  const command = typeof raw === "string" && request.kind !== "execute" ? null : toolCommand(raw);
  const path = input?.filePath ?? input?.path;
  const old = input?.oldString;
  const next = input?.newString ?? input?.content;
  return (
    <div className="min-w-0 space-y-2 text-sm">
      {pending.commander_run_id && <p className="[overflow-wrap:anywhere]">计划：{pending.plan_objective ?? pending.commander_run_id} · 任务：{pending.task_title ?? pending.commander_task_id ?? "未提供"}</p>}
      <p className="text-muted-foreground [overflow-wrap:anywhere]">会话：{pending.session_title ?? request.session_id}{pending.agent_id ? ` · ${pending.agent_id}` : ""}</p>
      {pending.cwd && <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">目录：{pending.cwd}</p>}
      <details className="text-muted-foreground text-xs">
        <summary className="cursor-pointer">会话与请求标识</summary>
        <dl className="mt-2 space-y-1 [overflow-wrap:anywhere]">
          <div><dt className="inline">请求 UUID：</dt><dd className="inline">{pending.id}</dd></div>
          <div><dt className="inline">ACP 会话：</dt><dd className="inline">{request.session_id}</dd></div>
          {pending.local_session_id && <div><dt className="inline">本机会话：</dt><dd className="inline">{pending.local_session_id}</dd></div>}
          <div><dt className="inline">工具调用：</dt><dd className="inline">{request.tool_call_id}</dd></div>
        </dl>
      </details>
      {command !== null && <div><p className="font-medium">请求命令</p><pre aria-label="请求命令" className={textClass}>{command}</pre><TimelineCopy text={command} label="复制完整命令" /></div>}
      <button type="button" className="text-primary text-xs underline-offset-2 hover:underline" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? "收起请求详情" : "查看完整输入与变更"}</button>
      {expanded && <div className="space-y-3">
        {typeof path === "string" && typeof next === "string" && <section aria-label="请求中的文件变更">
          <h4 className="font-medium [overflow-wrap:anywhere]">请求中的文件变更：{path}</h4>
          <p className="text-muted-foreground mt-1 text-xs">来自请求原文，不代表磁盘当前内容。</p>
          {typeof old === "string" ? <><p className="mt-2 text-xs">修改前</p><pre aria-label="修改前" className={textClass}>{old}</pre><TimelineCopy text={old} label="复制修改前" /></> : <p className="mt-2 text-xs">请求未提供修改前内容。</p>}
          <p className="mt-2 text-xs">请求内容 / 修改后</p><pre aria-label="修改后" className={textClass}>{next}</pre><TimelineCopy text={next} label="复制修改后" />
        </section>}
        <section aria-label="完整请求输入"><h4 className="font-medium">完整请求输入</h4>{raw === undefined ? <p className="text-muted-foreground mt-2 text-xs">请求未提供输入。</p> : <RawInput raw={raw} />}</section>
      </div>}
    </div>
  );
}
function RawInput({ raw }: { raw: unknown }) {
  const text = parameterText(raw) ?? "";
  return <><pre aria-label="完整请求输入" className={textClass}>{text}</pre><TimelineCopy text={text} label="复制完整输入" /></>;
}
