import { useDraggable } from "@dnd-kit/core";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TaskEntry } from "@/lib/agent";
import { ChevronLeft, ChevronRight, GripVertical, Link2, Trash2 } from "lucide-react";

export function TaskCard({
  task,
  canBack,
  canAdvance,
  onAdvance,
  onBack,
  onBind,
  onOpenSession,
  onDelete,
  onIsolate,
  busy,
}: {
  task: TaskEntry;
  canBack: boolean;
  canAdvance: boolean;
  onAdvance: () => void;
  onBack: () => void;
  onBind: () => void;
  onOpenSession?: (agentSessionId: string) => void;
  onDelete: () => void;
  onIsolate?: () => void;
  busy: boolean;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({ id: task.id, disabled: busy, data: { workspaceId: task.workspace_id, status: task.status, title: task.title } });
  return (
    <div ref={setNodeRef} style={{ opacity: isDragging ? 0.3 : 1 }} className="group rounded-md border bg-background px-2.5 py-2 shadow-sm">
      <div className="flex items-start gap-1">
        <button ref={setActivatorNodeRef} {...attributes} {...listeners} type="button" disabled={busy} aria-label={`拖动任务：${task.title}`} title="拖动；空格拾取，左右切列，上下切空间，Escape 取消" className="text-muted-foreground shrink-0 cursor-grab touch-none active:cursor-grabbing"><GripVertical className="size-3.5" /></button>
        <p className="min-w-0 flex-1 text-[12px] leading-snug break-words">{task.title}</p>
        <button
          type="button"
          title="删除任务"
          onClick={onDelete}
          disabled={busy}
          className="text-muted-foreground/40 hover:text-destructive shrink-0 px-0.5"
        >
          <Trash2 className="size-3" />
        </button>
      </div>
      {onIsolate && <Button size="sm" variant="ghost" className="h-6 px-0 text-[10px]" disabled={busy} onClick={onIsolate}>隔离会话</Button>}
      <div className="mt-1.5 flex items-center gap-1">
        {task.session_id ? (
          <button
            type="button"
            onClick={() => onOpenSession?.(task.session_id!)}
            className="text-primary hover:underline flex min-w-0 items-center gap-1 text-[10px]"
            title="跳转到该会话"
          >
            <Link2 className="size-3 shrink-0" />
            <code className="truncate">…{task.session_id.slice(-6)}</code>
          </button>
        ) : (
          <button
            type="button"
            onClick={onBind}
            disabled={busy}
            className="text-muted-foreground/60 hover:text-foreground text-[10px]"
            title="绑定会话"
          >
            <Link2 className="size-3" />
            绑定
          </button>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={onBack}
            disabled={busy || !canBack}
            className={cn(
              "text-muted-foreground hover:text-foreground rounded px-0.5",
              !canBack && "invisible",
            )}
            title="回退一列"
          >
            <ChevronLeft className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={onAdvance}
            disabled={busy || !canAdvance}
            className={cn(
              "text-muted-foreground hover:text-foreground rounded px-0.5",
              !canAdvance && "invisible",
            )}
            title="推进一列"
          >
            <ChevronRight className="size-3.5" />
          </button>
        </span>
      </div>
    </div>
  );
}
