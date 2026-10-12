/** One UUID and response state across session, commander and approvals. */
import { useSyncExternalStore } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { permissionCenter, type PendingPermission } from "@/lib/permissions";
import { ShieldQuestion } from "lucide-react";
import { ApprovalDetails } from "./ApprovalDetails";

export function PendingCard({ pending }: { pending: PendingPermission }) {
  const response = useSyncExternalStore(permissionCenter.subscribeResponses, () => permissionCenter.response(pending.id));
  const { request } = pending;
  const busy = response.status === "submitting" || response.status === "accepted";
  const options = request.options.filter((option) => option.kind === "allow_once" || option.kind === "reject_once");
  return (
    <section aria-label={`待审批：${pending.task_title ?? pending.session_title ?? request.session_id} · ${request.tool_name}`} className="min-w-0 rounded-md border border-warning/40 bg-warning/5 px-4 py-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ShieldQuestion className="text-warning size-4 shrink-0" />
        <h3 className="min-w-0 text-sm font-medium [overflow-wrap:anywhere]">{request.tool_name}</h3>
        {request.kind && <Badge variant="outline" className="text-[10px]">{request.kind}</Badge>}
      </div>
      <ApprovalDetails pending={pending} />
      <div className="mt-3 flex flex-wrap gap-2">
        {options.map((option) => <Button key={option.option_id} type="button" size="sm" variant={option.kind === "allow_once" ? "default" : "outline"} disabled={busy} className="h-auto max-w-full whitespace-normal py-2 text-left" onClick={() => void permissionCenter.respond(pending, option.option_id)}>{option.name}</Button>)}
      </div>
      {options.length === 0 && <p className="text-muted-foreground mt-3 text-xs">未提供一次性裁决选项，请停止所属任务；此处不提供持续授权。</p>}
      {response.status === "submitting" && <p role="status" className="text-muted-foreground mt-2 text-xs">正在提交裁决…</p>}
      {response.status === "accepted" && <p role="status" className="text-muted-foreground mt-2 text-xs">裁决已提交，等待任务确认。</p>}
      {response.status === "error" && <p role="alert" className="text-destructive mt-2 text-xs [overflow-wrap:anywhere]">提交失败：{response.error}。可重试原选项；不会替你选择其他裁决。</p>}
    </section>
  );
}
