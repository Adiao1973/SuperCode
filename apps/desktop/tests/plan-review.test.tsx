import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { PlanReview } from "../src/components/PlanReview";
import type { RunView } from "../src/lib/commander";

it("shows complete task context and changes detail without executing", () => {
  const tasks = [
    { id: "a", title: "设计", agent_id: "mimo", prompt: "完整中文提示词\n" + "长文本".repeat(1000), depends_on: [] },
    { id: "b", title: "实现", agent_id: "opencode", prompt: "第二项完整提示词", depends_on: ["a"] },
  ];
  const view = { run: { id: "one", plan: { objective: "目标", tasks } }, batches: [["a"], ["b"]] } as RunView;
  const { rerender } = render(<PlanReview key={view.run.id} view={view} />);
  expect(screen.getByLabelText("完整任务提示词").textContent).toBe(tasks[0].prompt);
  fireEvent.click(screen.getByRole("button", { name: /实现/ }));
  expect(screen.getByLabelText("完整任务提示词").textContent).toBe(tasks[1].prompt);
  expect(screen.getByText("opencode")).toBeVisible();
  expect(screen.getByText("第 2 批")).toBeVisible();
  expect(screen.getByText("a · 设计")).toBeVisible();
  rerender(<PlanReview key="two" view={{ ...view, run: { ...view.run, id: "two", plan: { ...view.run.plan, tasks: [tasks[0]] } } }} />);
  expect(screen.getByLabelText("完整任务提示词").textContent).toBe(tasks[0].prompt);
});
