import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FeedbackToast } from "../src/components/FeedbackState";
import { clearFeedback, notifySuccess } from "../src/lib/feedback";
afterEach(clearFeedback);
it("keeps one polite notice, coalesces repeats, pauses for reading and never steals input focus", () => {
  vi.useFakeTimers(); render(<><input aria-label="草稿" /><FeedbackToast /></>);
  screen.getByLabelText("草稿").focus();
  act(() => { notifySuccess("已保存设置"); notifySuccess("已保存设置"); });
  expect(screen.getAllByRole("status")).toHaveLength(1);
  expect(screen.getByLabelText("草稿")).toHaveFocus();
  act(() => notifySuccess("已复制"));
  expect(screen.queryByText("已保存设置")).toBeNull();
  fireEvent.mouseEnter(screen.getByRole("status"));
  act(() => vi.advanceTimersByTime(5000)); expect(screen.getByText("已复制")).toBeVisible();
  fireEvent.mouseLeave(screen.getByRole("status"));
  act(() => vi.advanceTimersByTime(3000)); expect(screen.queryByText("已复制")).toBeNull();
  act(() => notifySuccess("已保存设置")); fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
  expect(screen.queryByText("已保存设置")).toBeNull();
});

it("keeps clipboard failure inline and produces no false success notice", async () => {
  const { CopyableBlock } = await import("../src/components/CopyableBlock");
  const { MotionProvider } = await import("../src/lib/motion");
  const original = document.execCommand;
  document.execCommand = vi.fn(() => false);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
  try {
    render(<MotionProvider initial={{ preferences: { motion: "reduce" }, error: null }}><CopyableBlock text="synthetic" /><FeedbackToast /></MotionProvider>);
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("复制失败");
    expect(screen.queryByText("已复制")).toBeNull();
  } finally { document.execCommand = original; }
});

it("returns keyboard focus to the control preceding the toast when dismissed", () => {
  render(<><button>原操作</button><FeedbackToast /></>);
  const origin = screen.getByRole("button", { name: "原操作" }); origin.focus();
  act(() => notifySuccess("已复制"));
  screen.getByRole("button", { name: "关闭提示" }).focus();
  fireEvent.keyDown(screen.getByRole("button", { name: "关闭提示" }), { key: "Escape" });
  expect(origin).toHaveFocus(); expect(screen.queryByText("已复制")).toBeNull();
});
