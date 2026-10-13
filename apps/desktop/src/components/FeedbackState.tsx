import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { Check, Info, X } from "lucide-react";
import { Button } from "./ui/button";
import { clearFeedback, feedbackSnapshot, pauseFeedback, resumeFeedback, subscribeFeedback } from "@/lib/feedback";

export function EmptyState({ title, description, action, compact = false }: { title: string; description?: string; action?: ReactNode; compact?: boolean }) {
  return <div className={`text-muted-foreground ${compact ? "py-4" : "py-8"}`}>
    <p className="text-sm font-medium text-foreground">{title}</p>
    {description && <p className="mt-2 text-xs leading-relaxed [overflow-wrap:anywhere]">{description}</p>}
    {action && <div className="mt-3">{action}</div>}
  </div>;
}
export function LoadingState({ label }: { label: string }) {
  return <div role="status" aria-label={label} className="space-y-3 py-4"><p className="text-xs text-muted-foreground">{label}</p><div aria-hidden="true" className="space-y-2"><div className="h-3 w-2/3 rounded bg-muted" /><div className="h-3 w-1/2 rounded bg-muted" /></div></div>;
}
export function InlineError({ title = "操作未完成", message, onRetry, retrying = false }: { title?: string; message: string; onRetry?: () => void; retrying?: boolean }) {
  return <div className="my-3 min-w-0 border-l-2 border-destructive pl-3 text-sm"><div role="alert" className="[overflow-wrap:anywhere]"><p className="flex items-center gap-2 font-medium text-destructive"><Info aria-hidden="true" className="size-4 shrink-0" />{title}</p><p className="mt-1 text-xs text-muted-foreground">{message}</p></div>{onRetry && <Button className="mt-2" type="button" size="sm" variant="outline" disabled={retrying} onClick={onRetry}>{retrying ? "正在重新读取…" : "重新读取"}</Button>}</div>;
}
export function FeedbackToast() {
  const message = useSyncExternalStore(subscribeFeedback, feedbackSnapshot);
  const root = useRef<HTMLDivElement>(null);
  const previous = useRef<HTMLElement | null>(null);
  const hovering = useRef(false);
  useEffect(() => {
    if (message && document.activeElement instanceof HTMLElement && !root.current?.contains(document.activeElement)) previous.current = document.activeElement;
  }, [message]);
  useEffect(() => clearFeedback, []);
  const close = () => { const focus = !!root.current?.contains(document.activeElement); clearFeedback(); if (focus && previous.current?.isConnected) previous.current.focus({ preventScroll: true }); };
  return message ? <div ref={root} role="status" aria-live="polite" aria-atomic="true" className="bg-background fixed right-5 bottom-5 z-[100] flex max-w-[calc(100vw-2.5rem)] items-center gap-3 rounded-md border px-4 py-3 text-sm shadow-md"
    onMouseEnter={() => { hovering.current = true; pauseFeedback(); }} onMouseLeave={() => { hovering.current = false; if (!root.current?.contains(document.activeElement)) resumeFeedback(); }}
    onFocus={(event) => { if (event.relatedTarget instanceof HTMLElement && !event.currentTarget.contains(event.relatedTarget)) previous.current = event.relatedTarget; pauseFeedback(); }} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget) && !hovering.current) resumeFeedback(); }} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}>
    <Check aria-hidden="true" className="size-4 shrink-0 text-success" /><span className="max-w-xs [overflow-wrap:anywhere]">{message}</span><button type="button" className="rounded p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" aria-label="关闭提示" onClick={close}><X aria-hidden="true" className="size-4" /></button>
  </div> : null;
}
