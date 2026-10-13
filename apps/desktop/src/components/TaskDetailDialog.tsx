import { useEffect, useRef, useState, type RefObject } from "react";
import { Dialog } from "radix-ui";
import { Button } from "./ui/button";
import { getTaskContext, type TaskContext, type TaskEntry, type Workspace } from "@/lib/agent";

const statuses = { backlog: "待办", in_progress: "进行中", review: "评审", done: "完成" };
export function TaskDetailDialog({ task, workspaces, onClose, returnFocus, onOpenSession }: {
  task: TaskEntry | null;
  workspaces: Workspace[];
  onClose: () => void;
  returnFocus: RefObject<HTMLElement | null>;
  onOpenSession?: (id: string) => Promise<void>;
}) {
  const [context, setContext] = useState<TaskContext | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [opening, setOpening] = useState(false);
  const closed = useRef<HTMLButtonElement>(null);
  const navigating = useRef(false);
  const openingLock = useRef(false);
  useEffect(() => {
    if (!task) return;
    let current = true;
    navigating.current = false;
    setLoading(true); setError(""); setContext(null);
    void getTaskContext(task.id).then((value) => {
      if (current) setContext(value);
    }).catch((reason) => { if (current) setError(String(reason)); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [task?.id, retry]);
  const workspaceName = (id: string) => workspaces.find((item) => item.id === id)?.name ?? id;
  const openSession = async () => {
    if (!context?.session || !onOpenSession || openingLock.current) return;
    openingLock.current = true; setOpening(true); setError(""); navigating.current = true;
    try { await onOpenSession(context.session.agent_session_id); onClose(); }
    catch (reason) { navigating.current = false; setError(String(reason)); }
    finally { openingLock.current = false; setOpening(false); }
  };
  return <Dialog.Root open={task !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
      <Dialog.Content className="bg-background fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-3rem)] w-[calc(100vw-3rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border p-6 shadow-lg"
        onOpenAutoFocus={(event) => { event.preventDefault(); closed.current?.focus(); }}
        onCloseAutoFocus={(event) => { event.preventDefault(); if (!navigating.current && returnFocus.current?.isConnected) returnFocus.current.focus(); }}>
        <div className="flex items-start justify-between gap-4"><Dialog.Title className="min-w-0 text-lg font-semibold break-words">任务详情</Dialog.Title><Dialog.Close asChild><Button ref={closed} type="button" variant="ghost" size="sm">关闭详情</Button></Dialog.Close></div>
        <Dialog.Description className="text-muted-foreground mt-2 text-sm">看板移动只改变组织空间与状态，执行目录和已有会话保持原归属。</Dialog.Description>
        {loading && <p role="status" className="mt-4 text-sm">正在读取任务上下文…</p>}
        {error && <div className="mt-4 space-y-2"><p role="alert" className="text-destructive text-sm [overflow-wrap:anywhere]">{error}</p><Button type="button" variant="outline" size="sm" disabled={loading || opening} onClick={() => setRetry((value) => value + 1)}>重新读取详情</Button></div>}
        {context && context.task.id === task?.id && <div className="mt-5 space-y-5 text-sm [overflow-wrap:anywhere]">
          <section><h3 className="font-semibold">{context.task.title}</h3><p className="text-muted-foreground mt-1 text-xs">任务 UUID：{context.task.id}</p>
            <p className="mt-3">看板空间：{workspaceName(context.task.workspace_id)} · {statuses[context.task.status]}</p>
            <p className="text-muted-foreground mt-2">创建时目录：{context.stored_cwd || "未设置"}</p></section>
          <section className="border-t pt-4"><h3 className="font-medium">隔离 worktree</h3>{context.worktree ? <dl className="mt-2 space-y-2"><div><dt>原项目</dt><dd className="text-muted-foreground">{context.worktree.project}</dd></div><div><dt>原空间</dt><dd className="text-muted-foreground">{workspaceName(context.worktree.workspace_id)}</dd></div><div><dt>隔离目录</dt><dd className="text-muted-foreground">{context.worktree.path}</dd></div><div><dt>分支</dt><dd className="text-muted-foreground">{context.worktree.branch}</dd></div></dl> : <p className="text-muted-foreground mt-2">未发现已有的托管 worktree。查看详情不会创建隔离目录。</p>}</section>
          <section className="border-t pt-4"><h3 className="font-medium">绑定会话</h3>{context.session ? <><dl className="mt-2 space-y-2"><div><dt>会话</dt><dd>{context.session.title}</dd></div><div><dt>ACP ID / 本地 UUID</dt><dd className="text-muted-foreground">{context.session.agent_session_id}<br />{context.session.id}</dd></div><div><dt>原空间 / Agent</dt><dd className="text-muted-foreground">{workspaceName(context.session.workspace_id)} · {context.session.agent_id}</dd></div><div><dt>实际会话目录</dt><dd className="text-muted-foreground">{context.session.cwd}</dd></div></dl><Button type="button" className="mt-3" variant="outline" disabled={!onOpenSession || opening} onClick={() => void openSession()}>{opening ? "正在定位会话…" : "查看绑定会话"}</Button></> : <p className="text-muted-foreground mt-2">{context.task.session_id ? "绑定会话已不存在，请重新核对绑定。" : "尚未绑定会话。"}</p>}</section>
        </div>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
