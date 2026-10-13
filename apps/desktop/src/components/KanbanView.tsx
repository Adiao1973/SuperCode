/**
 * 任务看板（P2-8）：按工作空间分节，每节四列（待办/进行/评审/完成）。
 * 任务 = 标题 + 空间 + 绑定会话 + 状态；绑定会话可跳转，状态按流转序推进/回退。
 * 拖拽改变状态与看板空间，执行目录和会话引用保持。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  createTask,
  createTaskWorktree,
  cleanupTaskWorktrees,
  type TaskWorktree,
  deleteTask,
  listTasks,
  listWorkspaces,
  updateTask,
  moveTask,
  type TaskEntry,
  type Workspace,
} from "@/lib/agent";
import { DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { KanbanColumn, boardCollision, boardKeyboardCoordinates } from "@/components/kanban-dnd";
import { TaskDetailDialog } from "./TaskDetailDialog";
import { TaskCard } from "@/components/KanbanTaskCard";
import { Check, Plus, X } from "lucide-react";

const COLUMNS: { status: TaskEntry["status"]; label: string }[] = [
  { status: "backlog", label: "待办" },
  { status: "in_progress", label: "进行中" },
  { status: "review", label: "评审" },
  { status: "done", label: "完成" },
];

interface KanbanViewProps {
  /** 绑定会话跳转：切回会话视图并激活对应会话（找不到时提示） */
  onOpenSession?: (agentSessionId: string) => Promise<void>;
  onWorktreeSession?: (workspace: Workspace, task: TaskEntry, entry: TaskWorktree) => void;
  /** 可绑定的会话清单（key/标题/ACP id），由 App 从 sessions store 传入 */
  bindableSessions: { key: string; title: string; acpSessionId: string | null }[];
}

export function KanbanView({ onOpenSession, onWorktreeSession, bindableSessions }: KanbanViewProps) {
  const saving = useRef(false);
  const revision = useRef(0);
  const keyboardDrag = useRef(false);
  const dragRef = useRef<string | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const capture = (event: Event) => {
      const point = event instanceof MouseEvent ? event : (event as TouchEvent).changedTouches?.[0];
      if (point) pointer.current = { x: point.clientX, y: point.clientY };
      if ((event.type === "mouseup" || event.type === "touchend") && !keyboardDrag.current) {
        requestAnimationFrame(() => {
          // A very fast release can precede dnd-kit's measured active rectangle.
          // In that case it resets internally without emitting onDragEnd.
          if (dragRef.current) {
            dragRef.current = null; setActiveId(null);
            setNotice("拖动过快，位置未改变，请重试。");
          }
        });
      }
    };
    const events = ["mousemove", "mouseup", "touchmove", "touchend"];
    events.forEach((name) => window.addEventListener(name, capture, true));
    return () => events.forEach((name) => window.removeEventListener(name, capture, true));
  }, []);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const detailTrigger = useRef<HTMLElement | null>(null);
  const [landed, setLanded] = useState<string | null>(null);
  const landingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(landingTimer.current), []);
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: boardKeyboardCoordinates }));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [tasks, setTasks] = useState<TaskEntry[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [bindMenuFor, setBindMenuFor] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const request = ++revision.current;
    try {
      const [t, w] = await Promise.all([listTasks(), listWorkspaces()]);
      if (request !== revision.current) return;
      setTasks(t);
      setWorkspaces(w);
    } catch (e) {
      if (request === revision.current) setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(
    async (workspaceId: string) => {
      if (saving.current || !newTitle.trim()) {
        return;
      }
      saving.current = true; revision.current += 1; setBusy(true);
      try {
        await createTask(newTitle.trim(), workspaceId);
        setNewTitle("");
        setCreatingIn(null);
        await refresh();
      } catch (e) {
        setError(String(e));
      } finally { saving.current = false; setBusy(false); }
    },
    [newTitle, refresh],
  );


  const remove = useCallback(
    async (id: string) => {
      if (saving.current) return;
      saving.current = true; revision.current += 1; setBusy(true);
      try {
        await deleteTask(id);
        await refresh();
      } catch (e) {
        setError(String(e));
      } finally { saving.current = false; setBusy(false); }
    },
    [refresh],
  );

  const bind = useCallback(
    async (taskId: string, acpSessionId: string) => {
      setBindMenuFor(null);
      if (saving.current) return;
      saving.current = true; revision.current += 1; setBusy(true);
      try {
        await updateTask(taskId, { sessionId: acpSessionId });
        await refresh();
      } catch (e) {
        setError(String(e));
      } finally { saving.current = false; setBusy(false); }
    },
    [refresh],
  );

  const isolated = async (task: TaskEntry) => {
    if (saving.current) return;
    saving.current = true; revision.current += 1; setBusy(true);
    try {
      const entry = await createTaskWorktree(task.id);
      const owner = workspaces.find((item) => item.id === entry.workspace_id);
      if (!owner) throw new Error("原项目空间不存在，请刷新看板");
      onWorktreeSession?.(owner, task, entry);
    }
    catch (e) { setError(String(e)); }
    finally { saving.current = false; setBusy(false); }
  };
  const cleanup = async (workspaceId: string) => {
    if (saving.current) return;
    saving.current = true; revision.current += 1; setBusy(true);
    try {
      const result = await cleanupTaskWorktrees(workspaceId);
      setNotice(`已清扫 ${result.removed.length} 个孤儿；保留 ${result.skipped.length} 个。${result.skipped.join("；")}`);
    } catch (e) { setError(String(e)); }
    finally { saving.current = false; setBusy(false); }
  };

  const targetFor = (over: DragEndEvent["over"]) => {
    let target = over?.data.current;
    if (!keyboardDrag.current) {
      // WebKit 原生快速松手时 over 可能仍是上一帧；以 mouseup/touchend 最终坐标命中列。
      const point = pointer.current;
      const column = point && document.elementsFromPoint(point.x, point.y)
        .map((element) => element.closest<HTMLElement>("[data-kanban-column]"))
        .find((element) => element != null);
      target = column ? { workspaceId: column.dataset.workspaceId, status: column.dataset.taskStatus } : undefined;
    }
    return target;
  };
  const targetLabel = (over: DragEndEvent["over"]) => {
    const target = targetFor(over);
    return target ? `${workspaces.find((workspace) => workspace.id === target.workspaceId)?.name ?? "空间"} · ${COLUMNS.find((column) => column.status === target.status)?.label ?? "任务列"}` : null;
  };
  const commitMove = async (original: TaskEntry, workspaceId: string, status: TaskEntry["status"], restoreKeyboardFocus = false) => {
    if (saving.current || (original.workspace_id === workspaceId && original.status === status)) return;
    saving.current = true; revision.current += 1; setBusy(true); setError(null); setBindMenuFor(null); setNotice("正在保存任务位置…");
    setTasks((items) => items.map((task) => task.id === original.id ? { ...task, workspace_id: workspaceId, status } : task));
    try {
      const stored = await moveTask(original.id, workspaceId, status);
      setTasks((items) => items.map((task) => task.id === stored.id ? stored : task));
      setLanded(stored.id); clearTimeout(landingTimer.current);
      landingTimer.current = setTimeout(() => setLanded(null), 450);
      setNotice(`已保存：${workspaces.find((workspace) => workspace.id === stored.workspace_id)?.name ?? "空间"} · ${COLUMNS.find((column) => column.status === stored.status)?.label}`);
    } catch (e) {
      setTasks((items) => items.map((task) => task.id === original.id ? original : task));
      setNotice("移动未保存，已恢复原位置。");
      setError(String(e));
    } finally {
      saving.current = false; setBusy(false);
      if (restoreKeyboardFocus) requestAnimationFrame(() => {
        const handle = Array.from(document.querySelectorAll<HTMLElement>("[data-task-drag]")).find((node) => node.dataset.taskDrag === original.id);
        handle?.focus();
      });
    }
  };
  const advance = (task: TaskEntry, direction: number) => {
    const column = COLUMNS[COLUMNS.findIndex((item) => item.status === task.status) + direction];
    if (column) void commitMove(task, task.workspace_id, column.status);
  };
  const drop = async ({ active, over }: DragEndEvent) => {
    dragRef.current = null; setActiveId(null);
    const original = tasks.find((task) => task.id === active.id);
    const target = targetFor(over);
    if (!original || !target) { setNotice("已取消移动，位置未改变。"); return; }
    if (original.workspace_id === target.workspaceId && original.status === target.status) { setNotice("位置未改变。"); return; }
    await commitMove(original, target.workspaceId, target.status, keyboardDrag.current);
  };
  const activeTask = tasks.find((task) => task.id === activeId);

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
    <DndContext sensors={sensors} collisionDetection={boardCollision} onDragStart={({ active, activatorEvent }) => {
      keyboardDrag.current = activatorEvent instanceof KeyboardEvent;
      const point = activatorEvent instanceof MouseEvent ? activatorEvent : (activatorEvent as TouchEvent).changedTouches?.[0];
      pointer.current = point ? { x: point.clientX, y: point.clientY } : null;
      dragRef.current = String(active.id); setActiveId(String(active.id)); setBindMenuFor(null); }} onDragCancel={() => { dragRef.current = null; setActiveId(null); setNotice("已取消移动，位置未改变。"); }} onDragEnd={(event) => void drop(event)} accessibility={{ announcements: {
      onDragStart: ({ active }) => `已拾取任务：${active.data.current?.title}`,
      onDragOver: ({ over }) => over ? `目标：${over.data.current?.label}` : "当前不在任务列内",
      onDragEnd: ({ active, over }) => { const target = targetFor(over); const source = active.data.current; const label = targetLabel(over); return !target || (source?.workspaceId === target.workspaceId && source?.status === target.status) ? "位置未改变" : `已放下，正在保存至 ${label}`; },
      onDragCancel: () => "已取消移动",
    }, screenReaderInstructions: { draggable: "空格拾取任务，左右切换列，上下切换空间，空格放下，Escape 取消。" } }}>
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <div className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-6">
        <div className="flex items-center justify-between gap-4"><p className="text-muted-foreground text-sm">{tasks.length} 项任务 · {groups.length} 个空间</p><Button type="button" variant="outline" size="sm" disabled={busy || activeId !== null} onClick={() => { setError(null); void refresh(); }}>刷新看板</Button></div>
        {notice && <p role="status" aria-label="看板保存状态" className="text-muted-foreground text-xs">{notice}</p>}
        {error && (
          <p role="alert" className="text-destructive text-sm [overflow-wrap:anywhere]">
            {error}
          </p>
        )}
        <p className="text-muted-foreground text-xs">拖动把手跨列或跨空间；键盘：空格拾取，左右切列，上下切空间，Escape 取消。会话与执行目录保持原归属。</p>
        {groups.map(({ workspace, tasks: wsTasks }, row) => (
          <section key={workspace.id} className="min-w-0" aria-label={`看板空间：${workspace.name}`}>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold">{workspace.name}</h2>
              <span className="text-muted-foreground text-xs tabular-nums">{wsTasks.length} 项</span>
              {workspace.path && (
                <code title={workspace.path} className="text-muted-foreground max-w-80 truncate text-xs">{workspace.path}</code>
              )}
              {workspace.kind === "project" && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void cleanup(workspace.id)}>清扫孤儿</Button>}
              <Button
                disabled={busy}
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

            <div className="overflow-x-auto pb-2"><div className="grid min-w-[800px] grid-cols-4 gap-3">
              {COLUMNS.map((col, column) => {
                const cards = wsTasks.filter((t) => t.status === col.status);
                return (
                  <KanbanColumn key={col.status} workspaceId={workspace.id} status={col.status} row={row} column={column} label={`${workspace.name} · ${col.label}`} disabled={busy}>
                    <div className="flex items-center gap-1.5 px-1">
                      <span className="text-foreground text-sm font-medium">{col.label}</span>
                      <span className="text-muted-foreground text-xs tabular-nums">{cards.length}</span>
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
                        onDetails={(trigger) => { detailTrigger.current = trigger; setDetailId(task.id); }}
                        landed={landed === task.id}
                        onOpenSession={onOpenSession ? (id) => { void onOpenSession(id).catch((reason) => setError(String(reason))); } : undefined}
                        onDelete={() => void remove(task.id)}
                        onIsolate={!task.session_id ? () => void isolated(task) : undefined}
                        busy={busy}
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
                      <p className="text-muted-foreground px-1 py-5 text-center text-xs">暂无任务</p>
                    )}
                  </KanbanColumn>
                );
              })}
            </div></div>
          </section>
        ))}
      </div>
    </div>
    <TaskDetailDialog task={tasks.find((task) => task.id === detailId) ?? null} workspaces={workspaces} onClose={() => setDetailId(null)} returnFocus={detailTrigger} onOpenSession={onOpenSession} />
    <DragOverlay dropAnimation={null}>{activeTask && <div className="rounded-md border bg-background px-3 py-2 text-xs shadow-lg">{activeTask.title}</div>}</DragOverlay>
    </DndContext>
  );
}
