import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { MotionProvider } from "../src/lib/motion";
import { PendingCard } from "../src/components/PendingCard";
import { calls, handle } from "./fixtures/tauri";
import { permissionCenter } from "../src/lib/permissions";
import { pending } from "./fixtures/permissions";

it("disables both decisions while one approval response is pending", async () => {
  let release!: () => void;
  handle(
    "respond_permission",
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const user = userEvent.setup();
  render(
    <MotionProvider initial={{ preferences: { motion: "full" }, error: null }}>
      <PendingCard pending={pending()} />
    </MotionProvider>,
  );
  await user.click(screen.getByRole("button", { name: "允许一次" }));
  expect(screen.getByRole("button", { name: "允许一次" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "拒绝" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "拒绝" }));
  expect(calls).toEqual([
    {
      command: "respond_permission",
      args: { requestId: "fixture-request-a", optionId: "yes" },
    },
  ]);
  await act(async () => release());
  expect(screen.getByRole("button", { name: "拒绝" })).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent("裁决已提交");
  permissionCenter.removePending(pending().id);
});

it("shares submission and retry across inline and center cards and preserves full input", async () => {
  const { fireEvent, within, waitFor } = await import("@testing-library/react");
  const item = { ...pending("session-p416", "request-p416"), commander_run_id: "plan-p416", commander_task_id: "task-a", task_title: "中文任务", plan_objective: "中文计划", agent_id: "mimo", cwd: "/fixture/中文目录", request: { ...pending().request, session_id: "session-p416", kind: "execute", raw_input: { command: "printf '中文'\n" + "长命令".repeat(500) } } };
  let fail!: (error: Error) => void;
  handle("respond_permission", () => new Promise<void>((_, reject) => { fail = reject; }));
  render(<><PendingCard pending={item} /><PendingCard pending={item} /></>);
  const cards = screen.getAllByRole("region", { name: /待审批/ });
  const first = within(cards[0]);
  const second = within(cards[1]);
  expect(first.getByText(/中文计划.*中文任务/)).toBeVisible();
  expect(first.getByLabelText("请求命令").textContent).toBe(item.request.raw_input.command);
  const copy = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard: { writeText: copy } });
  fireEvent.click(first.getByRole("button", { name: "复制完整命令" }));
  await waitFor(() => expect(copy).toHaveBeenCalledWith(item.request.raw_input.command));
  fireEvent.click(first.getByRole("button", { name: "允许一次" }));
  fireEvent.click(second.getByRole("button", { name: "允许一次" }));
  expect(calls).toHaveLength(1);
  await act(async () => fail(new Error("合成提交失败")));
  expect(screen.getAllByRole("alert")).toHaveLength(2);
  handle("respond_permission", () => undefined);
  fireEvent.click(second.getByRole("button", { name: "拒绝" }));
  await waitFor(() => expect(second.getByRole("button", { name: "拒绝" })).toBeDisabled());
  expect(calls).toHaveLength(2);
  fireEvent.click(first.getByRole("button", { name: "查看完整输入与变更" }));
  expect(first.getByLabelText("完整请求输入", { selector: "pre" }).textContent).toBe(JSON.stringify(item.request.raw_input, null, 2));
  permissionCenter.removePending(item.id);
});

it("shows provided before/after content and hides persistent options", async () => {
  const { fireEvent } = await import("@testing-library/react");
  const item = pending("edit-session", "edit-request");
  item.request.raw_input = { filePath: "/fixture/中文.ts", oldString: "旧内容\n", newString: "新内容\n" };
  item.request.options.push({ option_id: "persistent", name: "永久放行", kind: "allow_always" });
  render(<PendingCard pending={item} />);
  fireEvent.click(screen.getByRole("button", { name: "查看完整输入与变更" }));
  expect(screen.getByLabelText("修改前")).toHaveTextContent("旧内容");
  expect(screen.getByLabelText("修改后")).toHaveTextContent("新内容");
  expect(screen.queryByRole("button", { name: "永久放行" })).toBeNull();
});
