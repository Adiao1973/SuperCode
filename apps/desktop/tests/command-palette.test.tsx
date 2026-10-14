import { useRef, useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { CommandPalette } from "../src/components/CommandPalette";
import { paletteItems, searchPalette, type PaletteChoice } from "../src/lib/command-palette";
import { calls } from "./fixtures/tauri";
const sessions = [{ key: "full-session-id", title: "中文会话", workspaceId: "project", draft: { prompt: "private-token", cwd: "/secret-file" } }];
const tasks = [{ id: "full-task-id", title: "修复中文任务", workspace_id: "project" }];
const workspaces = [{ id: "project", name: "项目甲" }];
it("projects only loaded titles, labels scopes and caps after filtering without IPC", () => {
  const items = paletteItems(sessions, tasks, workspaces, "项目甲");
  expect(searchPalette(items, "中文").map((x) => x.kind)).toEqual(["session", "task"]);
  expect(searchPalette(items, "private-token")).toEqual([]);
  expect(searchPalette(items, "secret-file")).toEqual([]);
  expect(items.some((x) => /删除|运行任务|放行|确认执行/.test(x.title))).toBe(false);
  expect(items.find((x) => x.kind === "task")?.scope).toContain("已加载任务");
  const many = Array.from({ length: 120 }, (_, i) => ({ key: String(i), title: `缓存 ${i}`, workspaceId: "default" }));
  const rows = paletteItems(many, [], [], "默认空间");
  expect(searchPalette(rows, "缓存")).toHaveLength(80);
  expect(searchPalette(rows, "缓存 119")).toHaveLength(1);
  expect(calls).toHaveLength(0);
});
it("blocks IME Enter and residual Enter, supports arrows and restores focus on Escape", async () => {
  const user = userEvent.setup(); const choose = vi.fn<(choice: PaletteChoice) => void>();
  function Host() {
    const [open, setOpen] = useState(false); const origin = useRef<HTMLButtonElement>(null);
    return <><button ref={origin} onClick={() => setOpen(true)}>打开搜索</button><CommandPalette open={open} onOpenChange={setOpen} onChoose={choose} returnFocus={origin} items={paletteItems(sessions, tasks, workspaces, "项目甲")} tasksLoaded /></>;
  }
  render(<Host />); await user.click(screen.getByRole("button", { name: "打开搜索" }));
  let input = screen.getByRole("combobox"); await waitFor(() => expect(input).toHaveFocus());
  await user.keyboard("{Escape}"); await waitFor(() => expect(screen.getByRole("button", { name: "打开搜索" })).toHaveFocus());
  await user.click(screen.getByRole("button", { name: "打开搜索" })); input = screen.getByRole("combobox");
  fireEvent.compositionStart(input); fireEvent.change(input, { target: { value: "中文" } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true }); expect(choose).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Escape", isComposing: true }); expect(screen.getByRole("dialog")).toBeVisible();
  fireEvent.compositionEnd(input); fireEvent.keyDown(input, { key: "Enter" }); expect(choose).not.toHaveBeenCalled();
  await new Promise((done) => setTimeout(done, 60));
  fireEvent.keyDown(input, { key: "ArrowDown" }); fireEvent.keyDown(input, { key: "Enter" });
  expect(choose).toHaveBeenCalledWith(expect.objectContaining({ kind: "task", target: "full-task-id" }));

  expect(calls).toHaveLength(0);
});
it("shows no-result and unloaded scope clearly", () => {
  render(<CommandPalette open onOpenChange={() => {}} onChoose={() => {}} returnFocus={{ current: null }} items={paletteItems([], [], [], "默认空间")} tasksLoaded={false} />);
  expect(screen.getByText(/任务未加载/)).toBeVisible();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "不存在的中文" } });
  expect(screen.getByText("没有匹配结果")).toBeVisible();
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
  expect(calls).toHaveLength(0);
});
