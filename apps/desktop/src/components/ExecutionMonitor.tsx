import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "./ui/button";
import type { RunView } from "@/lib/commander";
import type { HistorySession } from "@/lib/agent";
import { listHistorySessions } from "@/lib/agent";
import { resolveCommanderSession } from "@/lib/commander-session";

const statuses: Record<string, string> = {
  pending: "排队中", running: "运行中", succeeded: "已完成", failed: "失败",
  skipped: "已跳过", cancelled: "已取消", interrupted: "已中断",
};
export function ExecutionMonitor({ view, onOpenSession, renderPending, active = true }: {
  view: RunView;
  active?: boolean;
  onOpenSession?: (session: HistorySession) => void;
  renderPending: (id: string) => ReactNode;
}) {
  const [error, setError] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
  const lock = useRef(false);
  const revision = useRef(0);
  useEffect(() => {
    revision.current += 1;
    return () => { revision.current += 1; };
  }, [active]);
  const tasks = view.summary.tasks;
  const openSession = async (task: typeof tasks[number]) => {
    if (!active || lock.current || task.status === "running" || !onOpenSession) return;
    const version = revision.current;
    lock.current = true;
    setOpening(task.id);
    setError("");
    try {
      const row = resolveCommanderSession(task, view.run.cwd, await listHistorySessions());
      if (version === revision.current) onOpenSession(row);
    } catch (e) {
      if (version === revision.current) setError(String(e));
    } finally {
      lock.current = false;
      setOpening(null);
    }
  };
  return (
    <section aria-label="计划执行状态" className="space-y-5">
      <dl aria-label="任务状态统计" className="flex flex-wrap gap-x-5 gap-y-2 border-y py-3 text-sm">
        {Object.entries(statuses).map(([status, label]) => (
          <div key={status} className="flex gap-2"><dt className="text-muted-foreground">{label}</dt><dd className="font-medium tabular-nums">{tasks.filter((task) => task.status === status).length}</dd></div>
        ))}
      </dl>
      {view.run.status === "running" && !view.active && <p role="status" className="text-muted-foreground text-sm">记录尚未结束，当前应用未在执行。可能来自其他进程或上次中断；不会自动恢复，也不代表任务已完成。</p>}
      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
      {view.batches.map((batch, index) => (
        <section key={index} aria-label={`第 ${index + 1} 批`}>
          <h4 className="text-muted-foreground text-sm">第 {index + 1} 批</h4>
          {batch.map((id) => {
            const task = tasks.find((item) => item.id === id);
            const plan = view.run.plan.tasks.find((item) => item.id === id);
            if (!task || !plan) return null;
            return (
              <article key={id} className="min-w-0 border-b py-4">
                <div className="flex flex-wrap justify-between gap-2">
                  <h5 className="font-medium break-words">{task.title}</h5>
                  <span className={`text-sm ${task.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}>{statuses[task.status] ?? task.status}</span>
                </div>
                <p className="text-muted-foreground mt-1 text-xs [overflow-wrap:anywhere]">{task.id} · {task.agent_id} · 依赖：{task.depends_on.join("、") || "无"}</p>
                {task.status === "pending" && <p className="text-muted-foreground mt-2 text-sm">等待前置任务全部成功及可用执行名额。</p>}
                {task.status === "skipped" && <p className="text-muted-foreground mt-2 text-sm">前置任务未成功，未执行此任务。</p>}
                <details className="mt-3 text-sm"><summary className="cursor-pointer">查看完整任务提示词</summary><pre className="bg-muted/40 mt-2 whitespace-pre-wrap [overflow-wrap:anywhere] p-3">{plan.prompt}</pre></details>
                <div className="mt-3">
                  <h6 className="text-sm font-medium">结果预览</h6>
                  {task.result ? <pre className="bg-muted/40 mt-2 whitespace-pre-wrap [overflow-wrap:anywhere] p-3 text-sm">{task.result}</pre> : <p className="text-muted-foreground mt-2 text-sm">{task.status === "running" && view.active ? "执行中，尚无已保存的结果。" : "没有已保存的结果。"}</p>}
                  {task.truncated && <p className="text-muted-foreground mt-2 text-xs">预览过长，已截断；完整内容请查看会话。</p>}
                </div>
                {task.session_id && task.agent_session_id ? <Button type="button" variant="outline" size="sm" className="mt-3 h-auto max-w-full whitespace-normal py-2 text-left [overflow-wrap:anywhere]" disabled={!onOpenSession || opening !== null || task.status === "running"} onClick={() => void openSession(task)}>{opening === task.id ? "正在定位会话…" : `查看会话：${task.title}`}</Button> : <p className="text-muted-foreground mt-3 text-xs">尚无可查看的会话（未启动、尚未建立或已删除）。</p>}
                {task.status === "running" && <p className="text-muted-foreground mt-2 text-xs">任务结束后可查看已保存会话。</p>}
                {renderPending(task.id)}
              </article>
            );
          })}
        </section>
      ))}
    </section>
  );
}
