/**
 * 审批中心（P1-5）：待决权限请求卡片队列 + 近期裁决留痕。
 * 待决请求经 Tauri 全局事件到达（permission-request），应答走 respond_permission。
 */
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { respondPermission } from "@/lib/agent";
import type { PermissionOption } from "@/lib/permissions";
import {
  permissionCenter,
  type DecisionRecord,
  type PendingPermission,
} from "@/lib/permissions";
import { Check, Loader2, ShieldQuestion, X } from "lucide-react";

export function ApprovalsView() {
  const [pending, setPending] = useState<PendingPermission[]>([]);
  const [decisions, setDecisions] = useState<DecisionRecord[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    void permissionCenter.setup();
    const offPending = permissionCenter.onPending(setPending);
    const offDecisions = permissionCenter.onDecisions(setDecisions);
    return () => {
      offPending();
      offDecisions();
    };
  }, []);

  const respond = async (id: string, optionId: string) => {
    setBusyId(id);
    try {
      await respondPermission(id, optionId);
    } finally {
      setBusyId(null);
      permissionCenter.removePending(id);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="text-muted-foreground shrink-0 border-b px-5 py-3 text-[11px]">
        待决请求来自运行中的会话（ask 规则命中、ask 模式、autoedit 下非 edit 类）；
        规则与模式命中的裁决直接生效并记入下方留痕。
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
            <PendingCard
              key={pendingItem.id}
              pending={pendingItem}
              busy={busyId === pendingItem.id}
              onRespond={respond}
            />
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

function PendingCard({
  pending,
  busy,
  onRespond,
}: {
  pending: PendingPermission;
  busy: boolean;
  onRespond: (id: string, optionId: string) => Promise<void>;
}) {
  const { request } = pending;
  const allows = request.options.filter((o) => o.kind.startsWith("allow"));
  const rejects = request.options.filter((o) => o.kind.startsWith("reject"));

  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-4 py-3">
      <div className="flex items-center gap-2">
        <ShieldQuestion className="size-4 text-amber-400" />
        <span className="text-sm font-medium">{request.tool_name}</span>
        <code className="text-muted-foreground truncate text-[11px]">
          {request.session_id.slice(-6)}
        </code>
        {busy && <Loader2 className="text-muted-foreground size-3 animate-spin" />}
      </div>
      {request.raw_input != null && Object.keys(request.raw_input).length > 0 && (
        <pre className="text-muted-foreground mt-2 max-h-24 overflow-y-auto rounded bg-muted/30 p-2 font-mono text-[11px] whitespace-pre-wrap break-all">
          {JSON.stringify(request.raw_input, null, 2)}
        </pre>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {allows.map((option) => (
          <OptionButton
            key={option.option_id}
            option={option}
            disabled={busy}
            tone="allow"
            onRespond={onRespond}
            requestId={pending.id}
          />
        ))}
        {rejects.map((option) => (
          <OptionButton
            key={option.option_id}
            option={option}
            disabled={busy}
            tone="reject"
            onRespond={onRespond}
            requestId={pending.id}
          />
        ))}
      </div>
    </div>
  );
}

function OptionButton({
  option,
  disabled,
  tone,
  requestId,
  onRespond,
}: {
  option: PermissionOption;
  disabled: boolean;
  tone: "allow" | "reject";
  requestId: string;
  onRespond: (id: string, optionId: string) => Promise<void>;
}) {
  const persistent = option.kind.endsWith("_always");
  return (
    <Button
      size="sm"
      variant={tone === "allow" ? "default" : "outline"}
      disabled={disabled}
      onClick={() => void onRespond(requestId, option.option_id)}
      className={tone === "allow" ? "" : "border-destructive/50 text-destructive hover:bg-destructive/10"}
    >
      {tone === "allow" ? <Check className="size-4" /> : <X className="size-4" />}
      {option.name}
      {persistent && "（持续）"}
    </Button>
  );
}

function sourceLabel(record: DecisionRecord): string {
  if (record.source.type === "rule") {
    return `规则 ${record.source.pattern}`;
  }
  if (record.source.type === "mode") {
    const modeLabel: Record<string, string> = {
      plan: "计划",
      ask: "确认",
      autoedit: "自动编辑",
      full: "完全访问",
    };
    return `模式·${modeLabel[record.source.mode] ?? record.source.mode}`;
  }
  return "用户";
}

function DecisionRow({ record }: { record: DecisionRecord }) {
  const allowed = !record.decision.option_id.startsWith("reject");
  return (
    <div className="text-muted-foreground flex items-center gap-2 rounded-md border px-3 py-2 text-xs">
      <Badge variant="outline" className="text-[10px]">
        {sourceLabel(record)}
      </Badge>
      <span className="truncate font-medium">{record.request.tool_name}</span>
      <span className={allowed ? "text-emerald-500" : "text-destructive"}>
        {allowed ? "放行" : "拒绝"}
      </span>
    </div>
  );
}
