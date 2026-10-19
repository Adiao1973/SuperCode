import { act, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { TaskDetailDialog } from "../src/components/TaskDetailDialog";
import { handle } from "./fixtures/tauri";
import type { TaskContext, TaskEntry } from "../src/lib/agent";
it("ignores context responses after close or task change", async () => {
  const a: TaskEntry = { id: "a", title: "A", workspace_id: "default", status: "backlog", session_id: null };
  const responses: ((value: TaskContext) => void)[] = [];
  handle("get_task_context", () => new Promise<TaskContext>((resolve) => { responses.push(resolve); }));
  const props = { workspaces: [], onClose: () => {}, returnFocus: { current: null } };
  const host = render(<TaskDetailDialog {...props} task={a} />);
  host.rerender(<TaskDetailDialog {...props} task={{ ...a, id: "b", title: "B" }} />);
  await act(async () => responses[0]({ task: a, stored_cwd: "/old", worktree: null, session: null }));
  expect(screen.queryByText("创建时目录：/old")).toBeNull();
  host.rerender(<TaskDetailDialog {...props} task={null} />);
  await act(async () => responses[1]({ task: { ...a, id: "b" }, stored_cwd: "/late", worktree: null, session: null }));
  expect(screen.queryByRole("dialog")).toBeNull();
});
