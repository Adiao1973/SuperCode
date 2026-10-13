import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { KanbanView } from "../src/components/KanbanView";
import { calls, handle } from "./fixtures/tauri";
import type { TaskEntry } from "../src/lib/agent";

it("shares optimistic moves, blocks duplicate writes and rolls back with visible failure", async () => {
  const task: TaskEntry = { id: "task-one", workspace_id: "default", title: "完整中文任务", status: "backlog", session_id: "remote-session" };
  handle("list_tasks", () => [task]);
  handle("list_workspaces", () => [{ id: "default", name: "默认空间", kind: "default", path: null }]);
  let fail!: (reason: Error) => void;
  handle("move_task", (args) => { expect(args).toMatchObject({ id: task.id, workspaceId: "default", status: "in_progress" }); return new Promise((_, reject) => { fail = reject; }); });
  render(<KanbanView bindableSessions={[]} />);
  const advance = await screen.findByRole("button", { name: "推进任务：完整中文任务" });
  fireEvent.click(advance); fireEvent.click(advance);
  expect(calls.filter((call) => call.command === "move_task")).toHaveLength(1);
  expect(within(screen.getByRole("region", { name: "默认空间 · 进行中" })).getByRole("button", { name: /查看任务详情/ })).toBeVisible();
  expect(screen.getByRole("button", { name: "刷新看板" })).toBeDisabled();
  await act(async () => fail(new Error("目标空间已不存在")));
  expect(screen.getByRole("alert")).toHaveTextContent("目标空间已不存在");
  expect(screen.getByRole("status", { name: "看板保存状态" })).toHaveTextContent("已恢复原位置");
  expect(within(screen.getByRole("region", { name: "默认空间 · 待办" })).getByRole("button", { name: /查看任务详情/ })).toBeVisible();
  handle("move_task", () => ({ ...task, status: "in_progress" }));
  fireEvent.click(screen.getByRole("button", { name: "推进任务：完整中文任务" }));
  await waitFor(() => expect(screen.getByRole("status", { name: "看板保存状态" })).toHaveTextContent("已保存"));
  expect(calls.filter((call) => /create_task_worktree|run_prompt|get_task_context/.test(call.command))).toHaveLength(0);
});

it("reads task details explicitly, retries and returns focus without task mutations", async () => {
  const task: TaskEntry = { id: "task-detail", workspace_id: "default", title: "查看原执行归属", status: "review", session_id: "remote" };
  handle("list_tasks", () => [task]);
  handle("list_workspaces", () => [{ id: "default", name: "默认空间", kind: "default", path: null }]);
  let reads = 0;
  handle("get_task_context", () => { reads += 1; if (reads === 1) throw new Error("合成读取失败"); return { task, stored_cwd: "/original", worktree: { task_id: task.id, workspace_id: "original-space", project: "/original", path: "/original/.git/worktree", branch: "task-branch" }, session: { id: "local-uuid", agent_session_id: "remote", title: "原会话", cwd: "/original/.git/worktree", agent_id: "mimo", workspace_id: "original-space", status: "completed" } }; });
  render(<KanbanView bindableSessions={[]} />);
  const trigger = await screen.findByRole("button", { name: "查看任务详情：查看原执行归属" });
  expect(reads).toBe(0);
  trigger.focus(); fireEvent.click(trigger);
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "关闭详情" })).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "重新读取详情" }));
  await screen.findByText("原会话");
  expect(screen.getByText("创建时目录：/original")).toBeVisible();
  expect(screen.getAllByText("/original/.git/worktree")).toHaveLength(2);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(trigger).toHaveFocus();
  expect(calls.filter((call) => /create_task|move_task|update_task|run_prompt/.test(call.command))).toHaveLength(0);
});
