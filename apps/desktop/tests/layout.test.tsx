import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import {
  DEFAULT_LAYOUT,
  LayoutNotice,
  LayoutProvider,
  loadLayout,
  useLayoutPreferences,
} from "../src/lib/layout";
import { calls, handle } from "./fixtures/tauri";
function Controls() {
  const { preferences, update } = useLayoutPreferences();
  return (
    <>
      <output>
        {preferences.session_list_width}/{preferences.terminal_height}
      </output>
      <button onClick={() => update({ session_list_width: 300 })}>宽</button>
      <button onClick={() => update({ terminal_height: 160 })}>高</button>
      <button onClick={() => update({ session_list_width: 350 })}>更宽</button>
      <LayoutNotice />
    </>
  );
}
it("serializes and coalesces latest layout without dropping other fields", async () => {
  let release!: () => void;
  handle(
    "save_layout_preferences",
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  render(
    <LayoutProvider initial={{ preferences: DEFAULT_LAYOUT, error: null }}>
      <Controls />
    </LayoutProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByText("宽"));
  await user.click(screen.getByText("高"));
  await user.click(screen.getByText("更宽"));
  expect(calls).toHaveLength(1);
  await act(async () => release());
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1].args.preferences).toEqual({
    ...DEFAULT_LAYOUT,
    session_list_width: 350,
    terminal_height: 160,
  });
  await act(async () => release());
});
it("keeps usable changes on save failure and retries latest desired state", async () => {
  handle("save_layout_preferences", () => {
    throw new Error("fixture disk full");
  });
  render(
    <LayoutProvider initial={{ preferences: DEFAULT_LAYOUT, error: null }}>
      <Controls />
    </LayoutProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByText("宽"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "fixture disk full",
  );
  expect(screen.getByRole("status")).toHaveTextContent("300/224");
  handle("save_layout_preferences", () => undefined);
  await user.click(screen.getByText("重试"));
  await waitFor(() =>
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
  );
  expect(calls[calls.length - 1]?.args.preferences).toEqual({
    ...DEFAULT_LAYOUT,
    session_list_width: 300,
  });
});
it("does not overwrite unread preferences and reloads before enabling saves", async () => {
  handle("get_layout_preferences", () => ({
    ...DEFAULT_LAYOUT,
    session_list_width: 320,
  }));
  handle("save_layout_preferences", () => undefined);
  render(
    <LayoutProvider
      initial={{ preferences: DEFAULT_LAYOUT, error: "fixture read failed" }}
    >
      <Controls />
    </LayoutProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByText("宽"));
  expect(calls).toHaveLength(0);
  await user.click(screen.getByText("重试"));
  expect(screen.getByRole("status")).toHaveTextContent("320/224");
  await user.click(screen.getByText("高"));
  expect(calls[calls.length - 1]?.args.preferences).toEqual({
    ...DEFAULT_LAYOUT,
    session_list_width: 320,
    terminal_height: 160,
  });
});
it("falls back on timeout or corrupt layout without saving defaults", async () => {
  vi.useFakeTimers();
  handle("get_layout_preferences", () => new Promise(() => {}));
  const pending = loadLayout(20);
  await vi.advanceTimersByTimeAsync(20);
  expect(await pending).toEqual({
    preferences: DEFAULT_LAYOUT,
    error: expect.stringContaining("超时"),
  });
  handle("get_layout_preferences", () => ({
    ...DEFAULT_LAYOUT,
    terminal_height: 0,
  }));
  expect((await loadLayout()).error).toContain("格式无效");
  expect(calls.every((c) => c.command === "get_layout_preferences")).toBe(true);
});
