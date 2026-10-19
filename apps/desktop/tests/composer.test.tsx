import { useReducer } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { RunConsole } from "../src/components/RunConsole";
import { LayoutProvider, DEFAULT_LAYOUT } from "../src/lib/layout";
import { AppearanceProvider } from "../src/lib/appearance";
import { MotionProvider } from "../src/lib/motion";
import {
  initialSessionsState,
  sessionsReducer,
  type SessionsState,
} from "../src/lib/sessions";
import type { AgentEvent } from "../src/lib/events";
import { Channel, calls, handle } from "./fixtures/tauri";

function setup(initial = initialSessionsState()) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  handle("list_agent_definitions", () => []);
  handle("check_opencode_env", () => null);
  const channels: Channel<AgentEvent[]>[] = [];
  const finishes: Array<() => void> = [];
  handle("run_prompt", (args) => {
    channels.push(args.onEvents as Channel<AgentEvent[]>);
    return new Promise<void>((resolve) => finishes.push(resolve));
  });
  handle("cancel_run", () => undefined);
  handle("set_permission_mode", () => undefined);
  let latest: SessionsState = initial;
  function Host() {
    const [state, dispatch] = useReducer(sessionsReducer, initial);
    latest = state;
    return (
      <MotionProvider
        initial={{ preferences: { motion: "reduce" }, error: null }}
      >
        <AppearanceProvider
          initial={{ preferences: { theme: "light" }, error: null }}
        >
          <LayoutProvider
            initial={{ preferences: DEFAULT_LAYOUT, error: null }}
          >
            <RunConsole session={state.items[0]} dispatch={dispatch} />
          </LayoutProvider>
        </AppearanceProvider>
      </MotionProvider>
    );
  }
  render(<Host />);
  return { channels, finishes, state: () => latest };
}

it("guards IME/229/end composition, preserves multiline paste, and synchronously deduplicates Enter/click", async () => {
  const host = setup();
  const input = screen.getByPlaceholderText("任务提示词");
  const text = "中文长粘贴\n第二行".repeat(300);
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
  fireEvent.compositionStart(input);
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.compositionEnd(input);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(host.channels).toHaveLength(0);
  expect(input).toHaveValue(text);
  await new Promise((resolve) => setTimeout(resolve, 60));
  act(() => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(host.channels).toHaveLength(1);
    screen.getByRole("button", { name: "运行" }).click();
  });
  await waitFor(() => expect(host.channels).toHaveLength(1));
  expect(calls.find((c) => c.command === "run_prompt")!.args.prompt).toBe(text);
  act(() =>
    host.channels[0].onmessage([
      { type: "session_started", session_id: "composer-a" },
    ]),
  );
  fireEvent.keyDown(input, { key: "Enter" });
  expect(host.channels).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "停止" }));
  await waitFor(() =>
    expect(calls.filter((c) => c.command === "cancel_run")).toHaveLength(1),
  );
  await act(async () => host.finishes.forEach((f) => f()));
});

it("traps configuration focus, returns on Esc, keeps multiline rules and locks execution context", async () => {
  const host = setup();
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "配置会话" });
  await user.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "会话配置" });
  const close = within(dialog).getByRole("button", { name: "完成配置" });
  await waitFor(() => expect(close).toHaveFocus());
  await user.tab();
  expect(within(dialog).getByLabelText("Agent")).toHaveFocus();
  await user.tab({ shift: true });
  expect(close).toHaveFocus();
  fireEvent.change(within(dialog).getByPlaceholderText("工作目录"), {
    target: { value: "/fixture/custom" },
  });
  const rules = "read\nwrite\nbash(git *)";
  fireEvent.change(within(dialog).getByLabelText("预授权规则"), {
    target: { value: rules },
  });
  fireEvent.keyDown(window, { key: "r", metaKey: true });
  expect(host.channels).toHaveLength(0);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(trigger).toHaveFocus());
  fireEvent.change(screen.getByPlaceholderText("任务提示词"), {
    target: { value: "合成目标" },
  });
  fireEvent.click(screen.getByRole("button", { name: "运行" }));
  await waitFor(() => expect(host.channels).toHaveLength(1));
  act(() =>
    host.channels[0].onmessage([
      { type: "session_started", session_id: "composer-locked" },
    ]),
  );
  await user.click(trigger);
  expect(screen.getByLabelText("Agent")).toBeDisabled();
  expect(screen.getByPlaceholderText("工作目录")).toBeDisabled();
  fireEvent.change(screen.getByLabelText("权限模式"), {
    target: { value: "plan" },
  });
  await waitFor(() =>
    expect(
      calls.find((c) => c.command === "set_permission_mode")?.args,
    ).toEqual({ sessionId: "composer-locked", mode: "plan" }),
  );
  expect(calls.find((c) => c.command === "run_prompt")?.args).toMatchObject({
    cwd: "/fixture/custom",
    allow: ["read", "write", "bash(git *)"],
    mode: "ask",
  });
  expect(host.state().items[0].draft.rulesText).toBe(rules);
  await act(async () => host.finishes.forEach((f) => f()));
});

it("keeps managed task cwd locked before a session exists and preserves the draft while configuring", async () => {
  const initial = initialSessionsState();
  initial.items[0].taskId = "fixture-task";
  initial.items[0].draft.cwd = "/fixture/worktree";
  setup(initial);
  fireEvent.change(screen.getByPlaceholderText("任务提示词"), {
    target: { value: "托管草稿" },
  });
  fireEvent.click(screen.getByRole("button", { name: "配置会话" }));
  expect(screen.getByLabelText("工作目录")).toBeDisabled();
  expect(screen.getByLabelText("Agent")).toBeEnabled();
  expect(screen.getByText("托管任务目录已锁定。")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "完成配置" }));
  expect(screen.getByPlaceholderText("任务提示词")).toHaveValue("托管草稿");
});
