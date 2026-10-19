import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { InteractionProbe, darkQuery, reduceQuery } from "./InteractionProbe";
import { mediaFixture } from "./fixtures/media";

it("reacts independently to system theme/reduced-motion changes and cleans listeners", () => {
  const media = mediaFixture();
  vi.stubGlobal("matchMedia", media.matchMedia);
  const { container, unmount } = render(<InteractionProbe />);
  expect(container.querySelector("main")).toHaveAttribute(
    "data-theme",
    "light",
  );
  act(() => media.set(darkQuery, true));
  expect(screen.getByRole("status", { name: "系统偏好" })).toHaveTextContent(
    "深色",
  );
  expect(container.querySelector("main")).toHaveAttribute(
    "data-reduced",
    "false",
  );
  act(() => media.set(reduceQuery, true));
  expect(container.querySelector("main")).toHaveAttribute(
    "data-reduced",
    "true",
  );
  act(() => media.set(darkQuery, false));
  expect(container.querySelector("main")).toHaveAttribute(
    "data-theme",
    "light",
  );
  unmount();
  expect(media.count(darkQuery)).toBe(0);
  expect(media.count(reduceQuery)).toBe(0);
});
it("does not submit composition Enter, WebKit 229 or Shift-Enter", async () => {
  const user = userEvent.setup();
  render(<InteractionProbe />);
  const input = screen.getByRole("textbox", { name: "合成输入" });
  fireEvent.compositionStart(input);
  fireEvent.change(input, { target: { value: "中文" } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  fireEvent.compositionEnd(input);
  fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
  expect(screen.getByLabelText("合成提交次数")).toHaveTextContent("0");
  await user.click(input);
  await user.keyboard("{Shift>}{Enter}{/Shift}");
  expect(input).toHaveValue("中文\n");
  expect(screen.getByLabelText("合成提交次数")).toHaveTextContent("0");
  await user.keyboard("{Enter}");
  expect(screen.getByLabelText("合成提交次数")).toHaveTextContent("1");
});
it("traps dialog focus, closes on Escape and restores the trigger", async () => {
  const user = userEvent.setup();
  render(<InteractionProbe />);
  const trigger = screen.getByRole("button", { name: "打开焦点测试" });
  await user.click(trigger);
  const cancel = screen.getByRole("button", { name: "返回" });
  expect(cancel).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "增加合成计数" })).toHaveFocus();
  await user.tab();
  expect(cancel).toHaveFocus();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  expect(screen.getByLabelText("合成提交次数")).toHaveTextContent("0");
});
