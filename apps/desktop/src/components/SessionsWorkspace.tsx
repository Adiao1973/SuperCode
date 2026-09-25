/**
 * 会话工作区（P1-3）：左侧会话列表（新建/切换/状态），右侧活动会话详情。
 * 非活动会话的事件仍按 key 路由进 store，切回时完整重放当前状态。
 */
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { sessionStatus, type SessionEntry, type SessionsAction, type SessionsState } from "@/lib/sessions";
import { RunConsole } from "@/components/RunConsole";
import { MessageSquarePlus } from "lucide-react";

interface SessionsWorkspaceProps {
  state: SessionsState;
  dispatch: React.Dispatch<SessionsAction>;
}

const STATUS_TONE: Record<string, string> = {
  running: "bg-emerald-500 animate-pulse",
  done: "bg-muted-foreground/50",
  failed: "bg-destructive",
  idle: "bg-muted-foreground/30",
};

export function SessionsWorkspace({ state, dispatch }: SessionsWorkspaceProps) {
  const active = state.items.find((it) => it.key === state.activeKey) ?? null;

  return (
    <div className="flex min-h-0 flex-1">
      {/* 会话列表 */}
      <aside className="flex w-52 shrink-0 flex-col border-r">
        <div className="flex items-center justify-between px-3 py-2.5">
          <span className="text-muted-foreground text-xs font-medium">
            会话（{state.items.length}）
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            onClick={() => dispatch({ type: "new" })}
            title="新建会话（⌘N）"
          >
            <MessageSquarePlus className="size-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          <div className="flex flex-col gap-1">
            {state.items.map((entry) => (
              <SessionListItem
                key={entry.key}
                entry={entry}
                active={entry.key === state.activeKey}
                onActivate={() => dispatch({ type: "activate", key: entry.key })}
              />
            ))}
          </div>
        </div>
      </aside>

      {/* 活动会话详情 */}
      <section className="min-w-0 flex-1">
        {active ? (
          <RunConsole key={active.key} session={active} dispatch={dispatch} />
        ) : (
          <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 text-sm">
            <MessageSquarePlus className="size-8 opacity-40" />
            <Button size="sm" variant="outline" onClick={() => dispatch({ type: "new" })}>
              新建会话
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}

function SessionListItem({
  entry,
  active,
  onActivate,
}: {
  entry: SessionEntry;
  active: boolean;
  onActivate: () => void;
}) {
  const status = sessionStatus(entry);
  return (
    <button
      type="button"
      onClick={onActivate}
      className={cn(
        "hover:bg-sidebar-accent flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors",
        active ? "bg-sidebar-accent" : "",
      )}
    >
      <span className="flex w-full items-center gap-2">
        <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_TONE[status.tone])} />
        <span className="truncate text-[13px]">{entry.title}</span>
      </span>
      <span className="text-muted-foreground flex w-full items-center gap-2 pl-3.5 text-[10px]">
        {status.label}
        {entry.acpSessionId && (
          <code className="truncate">…{entry.acpSessionId.slice(-6)}</code>
        )}
      </span>
    </button>
  );
}
