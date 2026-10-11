import { useState } from "react";
import type { RunView } from "@/lib/commander";

/** Draft-only review: original prompts are text, never executable markup. */
export function PlanReview({ view }: { view: RunView }) {
  const tasks = view.run.plan.tasks;
  const [selectedId, setSelectedId] = useState(tasks[0]?.id);
  const task = tasks.find((item) => item.id === selectedId) ?? tasks[0];
  if (!task) return <p>此计划没有任务。</p>;
  const batch = view.batches.findIndex((ids) => ids.includes(task.id));
  return (
    <div className="@container border-t pt-4">
      <div className="grid min-w-0 gap-5 @min-[720px]:grid-cols-[13rem_minmax(0,1fr)]">
        <nav aria-label="计划任务" className="min-w-0">
          <h4 className="text-muted-foreground mb-2 text-sm">任务（{tasks.length}）</h4>
          <div className="max-h-60 space-y-1 overflow-y-auto @min-[720px]:max-h-[32rem]">
            {tasks.map((item, index) => (
              <button key={item.id} type="button" aria-current={task.id === item.id ? "true" : undefined}
                onClick={() => setSelectedId(item.id)}
                className={`w-full rounded-md px-3 py-3 text-left text-sm break-words focus-visible:outline-2 focus-visible:outline-ring ${task.id === item.id ? "bg-accent text-accent-foreground" : "hover:bg-muted"}`}>
                <span className="block font-medium">{index + 1}. {item.title}</span>
                <span className="text-muted-foreground mt-1 block break-all text-xs">{item.id} · {item.agent_id}</span>
              </button>
            ))}
          </div>
        </nav>
        <article aria-label="任务详情" className="min-w-0">
          <h4 className="text-lg font-semibold break-words">{task.title}</h4>
          <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">任务</dt><dd className="break-all">{task.id}</dd>
            <dt className="text-muted-foreground">Agent</dt><dd className="break-all">{task.agent_id}</dd>
            <dt className="text-muted-foreground">批次</dt><dd>{batch < 0 ? "未提供" : `第 ${batch + 1} 批`}</dd>
            <dt className="text-muted-foreground">依赖</dt><dd className="break-words">{task.depends_on.length ? task.depends_on.map((id) => `${id} · ${tasks.find((item) => item.id === id)?.title ?? "未知任务"}`).join("；") : "无"}</dd>
          </dl>
          <h5 className="mt-5 text-sm font-medium">完整任务提示词</h5>
          <pre aria-label="完整任务提示词" className="bg-muted/40 mt-2 whitespace-pre-wrap [overflow-wrap:anywhere] rounded-md p-4 text-sm leading-relaxed">{task.prompt}</pre>
        </article>
      </div>
    </div>
  );
}
