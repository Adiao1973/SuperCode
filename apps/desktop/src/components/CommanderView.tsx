import { useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { ConfirmPlanDialog } from "@/components/ConfirmPlanDialog";
import { Button } from "@/components/ui/button";
import { PlanReview } from "./PlanReview";
import { CommanderInput } from "./CommanderInput";
import type { Workspace } from "@/lib/agent";
import { Input } from "@/components/ui/input";
import { PendingCard } from "@/components/PendingCard";
import { permissionCenter, type PendingPermission } from "@/lib/permissions";
import {
  cancelCommanderWork,
  generateCommanderRun,
  getCommanderRun,
  listCommanderRuns,
  type RunView,
} from "@/lib/commander";
const labels: Record<string, string> = {
  draft: "等待确认",
  running: "运行中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "中断",
  pending: "等待执行",
  skipped: "已跳过",
};
export function CommanderView({
  active,
  onSettings,
  currentCwd = "",
  currentAgent = "",
  workspaces = [],
}: {
  active: boolean;
  onSettings: () => void;
  currentCwd?: string;
  currentAgent?: string;
  workspaces?: Workspace[];
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [jobs, setJobs] = useState(2);
  const [history, setHistory] = useState<RunView[]>([]);
  const [selected, setSelected] = useState<RunView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!active) setConfirm(false);
  }, [active]);
  const [pending, setPending] = useState<PendingPermission[]>([]);
  const request = useRef<string | null>(null);
  const refresh = async (id?: string) => {
    const runs = await listCommanderRuns();
    setHistory(runs);
    if (id) setSelected(await getCommanderRun(id));
  };
  useEffect(() => permissionCenter.onPending(setPending), []);
  useEffect(() => {
    if (!active) return;
    void refresh().catch((e) => setError(String(e)));
  }, [active]);
  const generate = async (objective: string, cwd: string, agents: string[]) => {
    if (request.current) return;
    const id = crypto.randomUUID();
    request.current = id;
    setBusy(true);
    setError("");
    try {
      const view = await generateCommanderRun(id, objective, cwd, agents);
      setSelected(view);
      await refresh(view.run.id);
    } catch (e) {
      setError(String(e));
    } finally {
      request.current = null;
      setBusy(false);
    }
  };
  const execute = async () => {
    if (
      !active || !confirm || request.current || !selected ||
      selected.run.status !== "draft" || selected.active ||
      history.some((v) => v.active) || !Number.isInteger(jobs) ||
      jobs < 1 || jobs > 16
    ) return;
    const id = selected.run.id;
    request.current = id;
    setConfirm(false);
    setBusy(true);
    setError("");
    const progress = new Channel<string>();
    // SQLite owns task state. Channel messages are only refresh signals.
    let refreshing = false;
    progress.onmessage = () => {
      if (refreshing) return;
      refreshing = true;
      void getCommanderRun(id)
        .then((view) => {
          if (request.current === id) setSelected(view);
        })
        .catch((e) => setError(String(e)))
        .finally(() => {
          refreshing = false;
        });
    };
    try {
      setSelected(
        await invoke<RunView>("execute_commander_run", {
          runId: id,
          confirmed: true,
          jobs,
          onProgress: progress,
        }),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      request.current = null;
      setBusy(false);
      await refresh(id).catch((e) => setError(String(e)));
    }
  };
  const cancel = async () => {
    const id = request.current ?? (selected?.active ? selected.run.id : null);
    if (!id) return;
    try {
      await cancelCommanderWork(id);
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <div className="@container h-full min-h-0">
      <div className="flex h-full min-h-0 w-full flex-col @min-[900px]:flex-row">
        <Button
          variant="ghost"
          className="shrink-0 self-start @min-[900px]:hidden"
          aria-expanded={historyOpen}
          onClick={() => setHistoryOpen((v) => !v)}
        >
          计划历史（{history.length}）
        </Button>
        <aside
          aria-label="计划历史"
          className={`${historyOpen ? "block" : "hidden"} max-h-48 shrink-0 overflow-y-auto border-b p-4 @min-[900px]:block @min-[900px]:max-h-none @min-[900px]:w-60 @min-[900px]:border-r @min-[900px]:border-b-0`}
        >
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-medium">计划历史</h2>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                void refresh(selected?.run.id).catch((e) => setError(String(e)))
              }
            >
              刷新
            </Button>
          </div>
          {history.length === 0 && (
            <p className="text-muted-foreground text-sm">
              生成的计划会保存在这里。重新打开应用不会自动执行。
            </p>
          )}
          {history.map((view) => (
            <button
              key={view.run.id}
              disabled={busy || confirm}
              onClick={() => {
                setSelected(view);
                setError("");
              }}
              className={`mb-1 w-full rounded px-3 py-3 text-left text-sm ${selected?.run.id === view.run.id ? "bg-muted" : "hover:bg-muted/50"}`}
            >
              <span className="line-clamp-2">{view.run.plan.objective}</span>
              <span className="text-muted-foreground mt-1 block text-xs">
                {labels[view.run.status]}
              </span>
            </button>
          ))}
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-4xl space-y-6">
            <CommanderInput
              active={active}
              currentCwd={currentCwd}
              currentAgent={currentAgent}
              workspaces={workspaces}
              blocked={busy || history.some((v) => v.active)}
              onSettings={onSettings}
              onGenerate={generate}
            />
            {(busy || selected?.active) && (
              <Button
                type="button"
                variant="outline"
                onClick={() => void cancel()}
              >
                取消当前操作
              </Button>
            )}
            {error && (
              <p
                role="alert"
                className="text-destructive rounded border border-destructive/30 p-3 text-sm"
              >
                {error}
              </p>
            )}
            {selected && (
              <section className="border-t pt-5">
                <label className="mb-4 block max-w-40 text-sm">
                  执行并发上限
                  <Input
                    aria-label="并发上限"
                    className="mt-2"
                    type="number"
                    min={1}
                    max={16}
                    value={jobs}
                    onChange={(e) => setJobs(Number(e.target.value))}
                    disabled={busy || confirm}
                    aria-invalid={!Number.isInteger(jobs) || jobs < 1 || jobs > 16}
                  />
                </label>
                {(!Number.isInteger(jobs) || jobs < 1 || jobs > 16) && <p role="alert" className="text-destructive mb-4 text-sm">并发上限必须是 1～16 的整数。</p>}
                <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h3 className="font-semibold">
                      {selected.run.plan.objective}
                    </h3>
                    <p className="text-muted-foreground mt-1 break-all text-sm">
                      {selected.run.cwd} · {labels[selected.run.status]}
                    </p>
                  </div>
                  {selected.run.status === "draft" && (
                    <ConfirmPlanDialog
                      open={confirm}
                      onOpenChange={setConfirm}
                      onConfirm={() => void execute()}
                      disabled={busy || selected.active || !Number.isInteger(jobs) || jobs < 1 || jobs > 16 || history.some((v) => v.active)}
                      count={selected.run.plan.tasks.length}
                      cwd={selected.run.cwd}
                      jobs={jobs}
                    />
                  )}
                </div>
                {selected.run.status === "running" &&
                  !selected.active &&
                  !busy && (
                    <p className="text-muted-foreground mb-4 text-sm">
                      此记录可能来自其他进程或已中断的执行。当前应用不会自动恢复或取消它。
                    </p>
                  )}
                {selected.run.status === "draft" ? <PlanReview key={selected.run.id} view={selected} /> : selected.batches.map((batch, index) => (
                  <div key={index} className="mb-5">
                    <h4 className="text-muted-foreground mb-2 text-xs">
                      第 {index + 1} 批 · {batch.join("、")}
                    </h4>
                    {batch.map((id) => {
                      const task = selected.summary.tasks.find(
                        (t) => t.id === id,
                      )!;
                      const plan = selected.run.plan.tasks.find(
                        (t) => t.id === id,
                      )!;
                      return (
                        <article key={id} className="border-t py-4">
                          <div className="flex justify-between gap-3">
                            <h5 className="font-medium">{task.title}</h5>
                            <span className="shrink-0 text-sm">
                              {labels[task.status]}
                            </span>
                          </div>
                          <p className="text-muted-foreground mt-1 text-xs">
                            {task.id} · {task.agent_id} · 依赖：
                            {task.depends_on.join("、") || "无"}
                          </p>
                          <details className="mt-3 text-sm">
                            <summary className="cursor-pointer">
                              查看完整任务提示词
                            </summary>
                            <pre className="bg-muted/40 mt-2 whitespace-pre-wrap break-words p-3">
                              {plan.prompt}
                            </pre>
                          </details>
                          {task.result && (
                            <pre className="bg-muted/40 mt-3 whitespace-pre-wrap break-words p-3 text-sm">
                              {task.result}
                              {task.truncated ? "\n（结果过长，已截断）" : ""}
                            </pre>
                          )}
                          {task.session_id && (
                            <p className="text-muted-foreground mt-2 break-all text-xs">
                              本机会话：{task.session_id}
                            </p>
                          )}
                          {pending
                            .filter(
                              (p) =>
                                p.commander_run_id === selected.run.id &&
                                p.commander_task_id === id,
                            )
                            .map((p) => (
                              <div key={p.id} className="mt-3">
                                <PendingCard pending={p} />
                              </div>
                            ))}
                        </article>
                      );
                    })}
                  </div>
                ))}
              </section>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
