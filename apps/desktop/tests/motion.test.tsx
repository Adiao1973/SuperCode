import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import {
  MotionProvider,
  MotionNotice,
  loadMotion,
  SYSTEM_REDUCE,
} from "../src/lib/motion";
import { MotionSettings } from "../src/components/MotionSettings";
import { CopyableBlock } from "../src/components/CopyableBlock";
import { mediaFixture } from "./fixtures/media";
import { calls, handle } from "./fixtures/tauri";

it("follows system changes only in system mode and cleans its subscription", async () => {
  const media = mediaFixture();
  vi.stubGlobal("matchMedia", media.matchMedia);
  handle("save_motion_preferences", () => undefined);
  const { unmount } = render(
    <MotionProvider
      initial={{ preferences: { motion: "system" }, error: null }}
    >
      <MotionSettings />
    </MotionProvider>,
  );
  expect(document.documentElement.dataset.motion).toBe("full");
  act(() => media.set(SYSTEM_REDUCE, true));
  expect(document.documentElement.dataset.motion).toBe("reduce");
  await userEvent.setup().selectOptions(screen.getByLabelText("动效"), "full");
  act(() => media.set(SYSTEM_REDUCE, false));
  act(() => media.set(SYSTEM_REDUCE, true));
  expect(document.documentElement.dataset.motion).toBe("full");
  expect(calls).toContainEqual({
    command: "save_motion_preferences",
    args: { preferences: { motion: "full" } },
  });
  unmount();
  expect(media.count(SYSTEM_REDUCE)).toBe(0);
});
it("preserves the old mode while saving and after a write failure, then retries", async () => {
  let reject!: (error: Error) => void;
  handle(
    "save_motion_preferences",
    () =>
      new Promise<void>((_, r) => {
        reject = r;
      }),
  );
  render(
    <MotionProvider
      initial={{ preferences: { motion: "reduce" }, error: null }}
    >
      <MotionSettings />
    </MotionProvider>,
  );
  await userEvent.setup().selectOptions(screen.getByLabelText("动效"), "full");
  expect(screen.getByLabelText("动效")).toBeDisabled();
  expect(document.documentElement.dataset.motion).toBe("reduce");
  await act(async () => reject(new Error("fixture write failure")));
  expect(screen.getByRole("alert")).toHaveTextContent("fixture write failure");
  expect(document.documentElement.dataset.motion).toBe("reduce");
  handle("get_motion_preferences", () => ({ motion: "full" }));
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "重新读取动效" }));
  expect(document.documentElement.dataset.motion).toBe("full");
});
it("falls back conservatively on startup timeout without overwriting SQLite", async () => {
  vi.useFakeTimers();
  handle("get_motion_preferences", () => new Promise(() => {}));
  const result = loadMotion(10);
  await vi.advanceTimersByTimeAsync(10);
  expect(await result).toMatchObject({
    preferences: { motion: "reduce" },
    error: expect.stringContaining("超时"),
  });
  expect(calls.map((c) => c.command)).toEqual(["get_motion_preferences"]);
});
it("removes feedback immediately in reduced mode without transforms or exit wait", () => {
  const root = (visible: boolean) => (
    <MotionProvider
      initial={{ preferences: { motion: "reduce" }, error: null }}
    >
      <MotionNotice visible={visible}>fixture feedback</MotionNotice>
    </MotionProvider>
  );
  const { rerender } = render(root(true));
  expect(screen.getByText("fixture feedback").style.transform).toBe("");
  rerender(root(false));
  expect(screen.queryByText("fixture feedback")).toBeNull();
});
it("copies once immediately in full mode, without waiting for feedback animation", async () => {
  const user = userEvent.setup();
  const write = vi.fn(async () => {});
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: write } });
  render(
    <MotionProvider initial={{ preferences: { motion: "full" }, error: null }}>
      <CopyableBlock text="synthetic snippet" />
    </MotionProvider>,
  );
  await user.click(screen.getByRole("button", { name: "复制" }));
  expect(write).toHaveBeenCalledExactlyOnceWith("synthetic snippet");
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("已复制"),
  );
});
