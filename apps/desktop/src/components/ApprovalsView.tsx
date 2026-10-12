/**
 * 审批中心（P1-5）：全部会话的待决权限请求聚合视图 + 近期裁决留痕。
 * 会话内联的待决卡片见 RunConsole（同一数据源 permissionCenter）。
 */
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { PendingCard } from "@/components/PendingCard";
import {
  permissionCenter,
  type DecisionRecord,
  type PendingPermission,
} from "@/lib/permissions";
import { ApprovalDetails } from "./ApprovalDetails";
import { ShieldQuestion } from "lucide-react";

export function ApprovalsView() {
  const [pending, setPending] = useState<PendingPermission[]>([]);
  const [decisions, setDecisions] = useState<DecisionRecord[]>([]);

  useEffect(() => {
    void permissionCenter.setup();
    const offPending = permissionCenter.onPending(setPending);
    const offDecisions = permissionCenter.onDecisions(setDecisions);
    return () => {
      offPending();
      offDecisions();
    };
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="text-muted-foreground shrink-0 border-b px-5 py-3 text-[11px]">
        待决请求也会内联显示在对应会话中；此处为跨会话聚合视图。
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {pending.length === 0 && (
            <p className="text-muted-foreground py-10 text-center text-sm">
              <ShieldQuestion className="mx-auto mb-2 size-8 opacity-40" />
              暂无待决权限请求
            </p>
          )}
          {pending.map((pendingItem) => (
            <PendingCard key={pendingItem.id} pending={pendingItem} />
          ))}

          {decisions.length > 0 && (
            <>
              <h2 className="text-muted-foreground mt-4 text-xs font-medium">近期裁决</h2>
              {decisions.map((record, i) => (
                <DecisionRow key={i} record={record} />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function sourceLabel(record: DecisionRecord): string {
  if (record.source.type === "rule") {
    return record.source.pattern === "<cancelled>" ? "取消收尾" : `规则 ${record.source.pattern}`;
  }
  if (record.source.type === "mode") {
    const modeLabel: Record<string, string> = {
      plan: "计划",
      ask: "确认",
      autoedit: "自动编辑", auto_edit: "自动编辑",
      full: "完全访问", full_access: "完全访问",
    };
    return `模式·${modeLabel[record.source.mode] ?? record.source.mode}`;
  }
  return "用户";
}

function DecisionRow({ record }: { record: DecisionRecord }) {
  const option = record.request.options.find((item) => item.option_id === record.decision.option_id);
  const outcome = !option ? "未识别的裁决" : option.kind.startsWith("allow") ? "放行" : "拒绝";
  return (
    <section className="min-w-0 border-t py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="text-[10px]">{sourceLabel(record)}</Badge>
        <span className="font-medium [overflow-wrap:anywhere]">{record.request.tool_name}</span>
        <span className={outcome === "放行" ? "text-success" : "text-destructive"}>{outcome}</span>
        {option && <span className="text-muted-foreground text-xs">{option.name}</span>}
      </div>
      <details className="mt-2"><summary className="text-muted-foreground cursor-pointer text-xs">查看裁决上下文</summary>
        <div className="mt-3"><ApprovalDetails pending={record.context ?? { id: record.request_id ?? "自动裁决", request: record.request }} /></div>
      </details>
    </section>
  );
}
