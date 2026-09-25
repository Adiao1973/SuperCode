/**
 * 待决权限卡片（P1-5）：审批中心与会话内联共用。
 * 展示工具名/kind/会话短 id/raw_input 预览 + allow/reject 选项按钮组。
 */
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { respondPermission } from "@/lib/agent";
import type { PermissionOption, PendingPermission } from "@/lib/permissions";
import { Check, Loader2, ShieldQuestion, X } from "lucide-react";

export function PendingCard({
  pending,
}: {
  pending: PendingPermission;
}) {
  const [busy, setBusy] = useState(false);
  const { request } = pending;
  const allows = request.options.filter((o) => o.kind.startsWith("allow"));
  const rejects = request.options.filter((o) => o.kind.startsWith("reject"));

  const respond = async (optionId: string) => {
    setBusy(true);
    try {
      await respondPermission(pending.id, optionId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-4 py-3">
      <div className="flex items-center gap-2">
        <ShieldQuestion className="size-4 text-amber-400" />
        <span className="text-sm font-medium">{request.tool_name}</span>
        {request.kind && (
          <Badge variant="outline" className="text-[10px]">
            {request.kind}
          </Badge>
        )}
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
            onRespond={() => respond(option.option_id)}
          />
        ))}
        {rejects.map((option) => (
          <OptionButton
            key={option.option_id}
            option={option}
            disabled={busy}
            tone="reject"
            onRespond={() => respond(option.option_id)}
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
  onRespond,
}: {
  option: PermissionOption;
  disabled: boolean;
  tone: "allow" | "reject";
  onRespond: () => Promise<void>;
}) {
  const persistent = option.kind.endsWith("_always");
  return (
    <Button
      size="sm"
      variant={tone === "allow" ? "default" : "outline"}
      disabled={disabled}
      onClick={() => void onRespond()}
      className={
        tone === "allow"
          ? ""
          : "border-destructive/50 text-destructive hover:bg-destructive/10"
      }
    >
      {tone === "allow" ? <Check className="size-4" /> : <X className="size-4" />}
      {option.name}
      {persistent && "（持续）"}
    </Button>
  );
}
