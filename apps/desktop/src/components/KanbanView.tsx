/**
 * 简版任务看板（P1-9）：按工作空间分节，每节四列（待办/进行/评审/完成）。
 * 任务 = 标题 + 空间 + 绑定会话 + 状态；绑定会话可跳转，状态按流转序推进/回退。
 * dnd-kit 拖拽与更丰富卡片留待 Phase 2 完整看板。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  createTask,
  deleteTask,
  listTasks,
  listWorkspaces,
  updateTask,
  type TaskEntry,
  type Workspace,
} from "@/lib/agent";
import { cn } from "@/lib/utils";
import { Check, ChevronLeft, ChevronRight, Link2, Plus, Trash2, X } from "lucide-react";

const COLUMNS: { status: TaskEntry["status"]; label: string }[] = [
  { status: "backlog", label: "待办" },
  { status: "in_progress", label: "进行中" },
  { status: "review", label: "评审" },
  { status: "done", label: "完成" },
];

interface KanbanViewProps {
  /** 绑定会话跳转：切回会话视图并激活对应会话（找不到时提示） */
  onOpenSession?: (agentSessionId: string) => void;
  /** 可绑定的会话清单（key/标题/ACP id），由 App 从 sessions store 传入 */
  bindableSessions: { key: string; title: string; acpSessionId: string | null }[];
}

export function KanbanView({ onOpenSession, bindableSessions }: KanbanViewProps) {
  const [tasks, setTasks] = useState<TaskEntry[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [bindMenuFor, setBindMenuFor] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [t, w] = await Promise.all([listTasks(), listWorkspaces()]);
      setTasks(t);
      setWorkspaces(w);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(
    async (workspaceId: string) => {
      if (!newTitle.trim()) {
        return;
      }
      try {
        await createTask(newTitle.trim(), workspaceId);
        setNewTitle("");
        setCreatingIn(null);
        await refresh();
      } catch (e) {
        setError(String(e));
      }
    },
    [newTitle, refresh],
  );

  const advance = useCallback(
    async (task: TaskEntry, dir: 1 | -1) => {
      const idx = COLUMNS.findIndex((c) => c.status === task.status);
      const next = COLUMNS[idx + dir];
      if (!next) {
        return;
      }
      try {
        await updateTask(task.id, { status: next.status });
        await refresh();
      } catch (e) {
        setError(String(e));
      }
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        await deleteTask(id);
        await refresh();
      } catch (e) {
        setError(String(e));
      }
    },
    [refresh],
  );

  const bind = useCallback(
    async (taskId: string, acpSessionId: string) => {
      setBindMenuFor(null);
      try {
        await updateTask(taskId, { sessionId: acpSessionId });
        await refresh();
      } catch (e) {
        setError(String(e));
      }
    },
    [refresh],
  );

  const groups = useMemo(() => {
    const list = workspaces.length
      ? workspaces
      : [{ id: "default", name: "默认空间", path: null, kind: "default" as const }];
    return list.map((workspace) => ({
      workspace,
      tasks: tasks.filter((t) => t.workspace_id === workspace.id),
    }));
  }, [workspaces, tasks]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        {error && (
          <p className="text-destructive text-xs" onClick={() => setError(null)}>
            {error}（点击清除）
          </p>
        )}
        {groups.map(({ workspace, tasks: wsTasks }) => (
          <section key={workspace.id}>
            <div className="mb-2 flex items-center gap-2">
              <h2 className="text-sm font-medium">{workspace.name}</h2>
              {workspace.path && (
                <code className="text-muted-foreground truncate text-[11px]">{workspace.path}</code>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground ml-auto h-6 px-2 text-[11px]"
                onClick={() => setCreatingIn(creatingIn === workspace.id ? null : workspace.id)}
              >
                <Plus className="size-3" />
                新建任务
              </Button>
            </div>

            {creatingIn === workspace.id && (
              <div className="mb-2 flex gap-1.5">
                <Input
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void create(workspace.id);
                    if (e.key === "Escape") setCreatingIn(null);
                  }}
                  placeholder="任务标题（Enter 创建）"
                  className="h-8 min-w-0 flex-1 text-xs"
                  autoFocus
                />
                <Button size="sm" variant="ghost" className="h-8 px-2" onClick={() => void create(workspace.id)}>
                  <Check className="size-3.5" />
                </Button>
                <Button size="sm" variant="ghost" className="h-8 px-2" onClick={() => setCreatingIn(null)}>
                  <X className="size-3.5" />
                </Button>
              </div>
            )}

            <div className="grid grid-cols-4 gap-2">
              {COLUMNS.map((col) => {
                const cards = wsTasks.filter((t) => t.status === col.status);
                return (
                  <div key={col.status} className="bg-muted/30 flex flex-col gap-2 rounded-lg border p-2">
                    <div className="flex items-center gap-1.5 px-1">
                      <span className="text-muted-foreground text-[11px] font-medium">{col.label}</span>
                      <span className="text-muted-foreground/60 text-[10px] tabular-nums">{cards.length}</span>
                    </div>
                    {cards.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        canBack={col.status !== "backlog"}
                        canAdvance={col.status !== "done"}
                        onAdvance={() => void advance(task, 1)}
                        onBack={() => void advance(task, -1)}
                        onBind={() => setBindMenuFor(bindMenuFor === task.id ? null : task.id)}
                        onOpenSession={onOpenSession}
                        onDelete={() => void remove(task.id)}
                      />
                    ))}
                    {bindMenuFor && cards.some((t) => t.id === bindMenuFor) && (
                      <div className="rounded-md border bg-popover p-1.5">
                        <p className="text-muted-foreground mb-1 px-1 text-[10px]">绑定会话</p>
                        {bindableSessions.filter((s) => s.acpSessionId).length === 0 ? (
                          <p className="text-muted-foreground px-1 py-1 text-[11px]">无可绑定会话（先跑一轮产生会话）</p>
                        ) : (
                          bindableSessions
                            .filter((s) => s.acpSessionId)
                            .map((s) => (
                              <button
                                key={s.key}
                                type="button"
                                className="hover:bg-sidebar-accent flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px]"
                                onClick={() => s.acpSessionId && void bind(bindMenuFor, s.acpSessionId)}
                              >
                                <span className="truncate">{s.title}</span>
                                <code className="text-muted-foreground ml-auto shrink-0">
                                  …{s.acpSessionId?.slice(-6)}
                                </code>
                              </button>
                            ))
                        )}
                      </div>
                    )}
                    {cards.length === 0 && (
                      <p className="text-muted-foreground/40 px-1 py-3 text-center text-[10px]">—</p>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function TaskCard({
  task,
  canBack,
  canAdvance,
  onAdvance,
  onBack,
  onBind,
  onOpenSession,
  onDelete,
}: {
  task: TaskEntry;
  canBack: boolean;
  canAdvance: boolean;
  onAdvance: () => void;
  onBack: () => void;
  onBind: () => void;
  onOpenSession?: (agentSessionId: string) => void;
  onDelete: () => void;
}) {
  return (
    <div className="group rounded-md border bg-background px-2.5 py-2 shadow-sm">
      <div className="flex items-start gap-1">
        <p className="min-w-0 flex-1 text-[12px] leading-snug break-words">{task.title}</p>
        <button
          type="button"
          title="删除任务"
          onClick={onDelete}
          className="text-muted-foreground/40 hover:text-destructive hidden shrink-0 px-0.5 group-hover:block"
        >
          <Trash2 className="size-3" />
        </button>
      </div>
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
            disabled={!canBack}
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
            disabled={!canAdvance}
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
