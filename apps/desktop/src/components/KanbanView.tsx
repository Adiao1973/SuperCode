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
  onOpenSession?: (agentSessionId: string) => void;
  onWorktreeSession?: (workspace: Workspace, task: TaskEntry, entry: TaskWorktree) => void;
  /** 可绑定的会话清单（key/标题/ACP id），由 App 从 sessions store 传入 */
  bindableSessions: { key: string; title: string; acpSessionId: string | null }[];
}

export function KanbanView({ onOpenSession, onWorktreeSession, bindableSessions }: KanbanViewProps) {
  const saving = useRef(false);
  const revision = useRef(0);
  const keyboardDrag = useRef(false);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const capture = (event: Event) => {
      const point = event instanceof MouseEvent ? event : (event as TouchEvent).changedTouches?.[0];
      if (point) pointer.current = { x: point.clientX, y: point.clientY };
    };
    const events = ["mousemove", "mouseup", "touchmove", "touchend"];
    events.forEach((name) => window.addEventListener(name, capture, true));
    return () => events.forEach((name) => window.removeEventListener(name, capture, true));
  }, []);
  const [activeId, setActiveId] = useState<string | null>(null);
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

  const advance = useCallback(
    async (task: TaskEntry, dir: 1 | -1) => {
      const idx = COLUMNS.findIndex((c) => c.status === task.status);
      const next = COLUMNS[idx + dir];
      if (!next) {
        return;
      }
      if (saving.current) return;
      saving.current = true; revision.current += 1; setBusy(true);
      try {
        await updateTask(task.id, { status: next.status });
        await refresh();
      } catch (e) {
        setError(String(e));
      } finally { saving.current = false; setBusy(false); }
    },
    [refresh],
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
  const drop = async ({ active, over }: DragEndEvent) => {
    setActiveId(null);
    const original = tasks.find((task) => task.id === active.id);
    const target = targetFor(over);
    if (saving.current || !original || !target || (original.workspace_id === target.workspaceId && original.status === target.status)) return;
    saving.current = true; revision.current += 1; setBusy(true); setError(null); setBindMenuFor(null); setNotice("正在保存任务位置…");
    setTasks((items) => items.map((task) => task.id === original.id ? { ...task, workspace_id: target.workspaceId, status: target.status } : task));
    try {
      const stored = await moveTask(original.id, target.workspaceId, target.status);
      setTasks((items) => items.map((task) => task.id === stored.id ? stored : task));
      setNotice(`已保存：${workspaces.find((workspace) => workspace.id === stored.workspace_id)?.name ?? "空间"} · ${COLUMNS.find((column) => column.status === stored.status)?.label}`);
    } catch (e) {
      setTasks((items) => items.map((task) => task.id === original.id ? original : task));
      setNotice(null);
      setError(String(e));
    } finally { saving.current = false; setBusy(false); }
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
      setActiveId(String(active.id)); setBindMenuFor(null); }} onDragCancel={() => setActiveId(null)} onDragEnd={(event) => void drop(event)} accessibility={{ announcements: {
      onDragStart: ({ active }) => `已拾取任务：${active.data.current?.title}`,
      onDragOver: ({ over }) => over ? `目标：${over.data.current?.label}` : "当前不在任务列内",
      onDragEnd: ({ over }) => { const label = targetLabel(over); return label ? `已放下，正在保存至 ${label}` : "已取消移动"; },
      onDragCancel: () => "已取消移动",
    }, screenReaderInstructions: { draggable: "空格拾取任务，左右切换列，上下切换空间，空格放下，Escape 取消。" } }}>
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        {notice && <p role="status" className="text-muted-foreground text-xs">{notice}</p>}
        {error && (
          <p role="alert" className="text-destructive text-xs" onClick={() => setError(null)}>
            {error}（点击清除）
          </p>
        )}
        <p className="text-muted-foreground text-xs">拖动把手跨列或跨空间；键盘：空格拾取，左右切列，上下切空间，Escape 取消。会话与执行目录保持原归属。</p>
        {groups.map(({ workspace, tasks: wsTasks }, row) => (
          <section key={workspace.id}>
            <div className="mb-2 flex items-center gap-2">
              <h2 className="text-sm font-medium">{workspace.name}</h2>
              {workspace.path && (
                <code className="text-muted-foreground truncate text-[11px]">{workspace.path}</code>
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

            <div className="grid grid-cols-4 gap-2">
              {COLUMNS.map((col, column) => {
                const cards = wsTasks.filter((t) => t.status === col.status);
                return (
                  <KanbanColumn key={col.status} workspaceId={workspace.id} status={col.status} row={row} column={column} label={`${workspace.name} · ${col.label}`} disabled={busy}>
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
                      <p className="text-muted-foreground/40 px-1 py-3 text-center text-[10px]">—</p>
                    )}
                  </KanbanColumn>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
    <DragOverlay dropAnimation={null}>{activeTask && <div className="rounded-md border bg-background px-3 py-2 text-xs shadow-lg">{activeTask.title}</div>}</DragOverlay>
    </DndContext>
  );
}
