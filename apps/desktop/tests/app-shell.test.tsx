import { useState } from "react";
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
import { AppShell, type NavId } from "../src/components/AppShell";
import { ConfirmPlanDialog } from "../src/components/ConfirmPlanDialog";
import { VirtuosoMockContext } from "react-virtuoso";
import App from "../src/App";
import { LayoutProvider, DEFAULT_LAYOUT } from "../src/lib/layout";
import { AppearanceProvider } from "../src/lib/appearance";
import { MotionProvider } from "../src/lib/motion";
import type { AgentEvent } from "../src/lib/events";
import { calls, Channel, emit, handle } from "./fixtures/tauri";
import { pending } from "./fixtures/permissions";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options = {};
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    focus() {}
    attachCustomKeyEventHandler() {}
    onData() {
      return { dispose() {} };
    }
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

it("keeps navigation semantics and traps project focus, returning to trigger or destination heading", async () => {
  function Host() {
    const [nav, setNav] = useState<NavId>("commander");
    return (
      <AppShell
        nav={nav}
        onNavigate={setNav}
        pendingCount={3}
        project={{ name: "合成项目", cwd: "/fixture", agent: "opencode" }}
        version="fixture"
      >
        <button>页面动作</button>
      </AppShell>
    );
  }
  render(<Host />);
  const user = userEvent.setup();
  expect(screen.getByRole("button", { name: "指挥官" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await user.click(screen.getByRole("button", { name: "折叠导航" }));
  expect(screen.getByRole("button", { name: "展开导航" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(
    screen.getByRole("button", { name: "审批中心，3 项待审批" }),
  ).toBeVisible();
  const trigger = screen.getByRole("button", { name: "当前项目：合成项目" });
  await user.click(trigger);
  const close = screen.getByRole("button", { name: "关闭项目定位" });
  const enter = screen.getByRole("button", { name: "进入会话" });
  await waitFor(() => expect(close).toHaveFocus());
  await user.tab({ shift: true });
  expect(enter).toHaveFocus();
  await user.tab();
  expect(close).toHaveFocus();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(trigger).toHaveFocus());
  await user.click(trigger);
  await user.click(screen.getByRole("button", { name: "进入会话" }));
  await waitFor(() =>
    expect(
      screen.getByRole("heading", { level: 1, name: "会话" }),
    ).toHaveFocus(),
  );
});

it("requires explicit confirmation; Esc and back restore focus without executing", async () => {
  const confirm = vi.fn();
  function Host() {
    const [open, setOpen] = useState(false);
    return (
      <ConfirmPlanDialog
        open={open}
        onOpenChange={setOpen}
        onConfirm={confirm}
        disabled={false}
        count={2}
        cwd="/fixture"
        jobs={1}
      />
    );
  }
  render(<Host />);
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "审阅并执行" });
  await user.click(trigger);
  const back = screen.getByRole("button", { name: "返回审阅" });
  await waitFor(() => expect(back).toHaveFocus());
  await user.tab({ shift: true });
  expect(screen.getByRole("button", { name: "确认执行" })).toHaveFocus();
  await user.tab();
  expect(back).toHaveFocus();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(confirm).not.toHaveBeenCalled();
  await user.click(trigger);
  await user.click(screen.getByRole("button", { name: "返回审阅" }));
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(confirm).not.toHaveBeenCalled();
  await user.click(trigger);
  await user.click(screen.getByRole("button", { name: "确认执行" }));
  expect(confirm).toHaveBeenCalledTimes(1);
});

it("preserves the real session host, draft, running Channel and PTY across module navigation", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  for (const cmd of [
    "list_history_sessions",
    "list_workspaces",
    "list_agent_definitions",
    "list_rules",
    "list_agents",
    "list_commander_run_views",
  ])
    handle(cmd, () => []);
  handle("check_opencode_env", () => null);
  for (const cmd of [
    "appearance_ready",
    "open_terminal",
    "resize_terminal",
    "close_terminal",
    "cancel_run",
  ])
    handle(cmd, () => undefined);
  let channel: Channel<AgentEvent[]> | undefined;
  let finish!: () => void;
  handle("run_prompt", (args) => {
    channel = args.onEvents as Channel<AgentEvent[]>;
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const { unmount } = render(
    <MotionProvider
      initial={{ preferences: { motion: "reduce" }, error: null }}
    >
      <AppearanceProvider
        initial={{ preferences: { theme: "light" }, error: null }}
      >
        <VirtuosoMockContext.Provider
          value={{ viewportHeight: 1000, itemHeight: 100 }}
        >
          <LayoutProvider
            initial={{ preferences: DEFAULT_LAYOUT, error: null }}
          >
            <App />
          </LayoutProvider>
        </VirtuosoMockContext.Provider>
      </AppearanceProvider>
    </MotionProvider>,
  );
  const user = userEvent.setup();
  const prompt = screen.getByPlaceholderText("任务提示词");
  fireEvent.change(prompt, { target: { value: "合成草稿，不连接真实模型" } });
  await user.click(screen.getByRole("button", { name: "打开终端" }));
  await waitFor(() =>
    expect(calls.filter((c) => c.command === "open_terminal")).toHaveLength(1),
  );
  const terminalHost = document.querySelector("[data-session-terminal]")!;
  for (const key of ["r", ".", "n", "1"])
    fireEvent.keyDown(terminalHost, { key, metaKey: true });
  expect(calls.filter((c) => c.command === "run_prompt")).toHaveLength(0);
  expect(calls.filter((c) => c.command === "cancel_run")).toHaveLength(0);
  expect(calls.filter((c) => c.command === "close_terminal")).toHaveLength(0);
  expect(prompt).toHaveValue("合成草稿，不连接真实模型");
  handle("save_layout_preferences", () => undefined);
  fireEvent.keyDown(screen.getByRole("separator", { name: "调整终端高度" }), {
    key: "Enter",
  });
  expect(screen.getByRole("button", { name: "展开终端" })).toBeVisible();
  expect(calls.filter((c) => c.command === "close_terminal")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "展开终端" }));
  expect(calls.filter((c) => c.command === "open_terminal")).toHaveLength(1);
  const nav = screen.getByRole("navigation", { name: "模块" });
  await user.click(within(nav).getByRole("button", { name: "审批中心" }));
  fireEvent.keyDown(window, { key: "r", metaKey: true });
  expect(calls.filter((c) => c.command === "run_prompt")).toHaveLength(0);
  await user.click(within(nav).getByRole("button", { name: "会话" }));
  expect(screen.getByPlaceholderText("任务提示词")).toBe(prompt);
  expect(prompt).toHaveValue("合成草稿，不连接真实模型");
  fireEvent.keyDown(window, { key: "r", metaKey: true, isComposing: true });
  expect(calls.filter((c) => c.command === "run_prompt")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: /当前项目/ }));
  fireEvent.keyDown(window, { key: "r", metaKey: true });
  fireEvent.keyDown(window, { key: "n", metaKey: true });
  expect(calls.filter((c) => c.command === "run_prompt")).toHaveLength(0);
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "运行" }));
  await waitFor(() => expect(channel).toBeDefined());
  act(() =>
    channel!.onmessage([
      { type: "session_started", session_id: "fixture-acp-a" },
    ]),
  );
  await user.click(within(nav).getByRole("button", { name: "审批中心" }));
  fireEvent.keyDown(window, { key: ".", metaKey: true });
  expect(calls.filter((c) => c.command === "cancel_run")).toHaveLength(0);
  act(() => {
    channel!.onmessage([
      {
        type: "message_chunk",
        message_id: "fixture-message",
        text: "隐藏时收到的合成回复",
      },
      { type: "turn_completed", stop_reason: "end_turn" },
    ]);
    emit("permission-request", pending());
  });
  expect(
    within(nav).getByRole("button", { name: "审批中心，1 项待审批" }),
  ).toBeVisible();
  const request = pending().request;
  act(() =>
    emit("decision-record", {
      request,
      source: { type: "user" },
      decision: { option_id: "no", updated_input: null },
    }),
  );
  expect(within(nav).getByRole("button", { name: "审批中心" })).toBeVisible();
  await act(async () => finish());
  await user.click(within(nav).getByRole("button", { name: "会话" }));
  expect(screen.getByRole("button", { name: "运行" })).toBeEnabled();
  expect(screen.getByText(/本轮完成/)).toBeVisible();
  expect(calls.filter((c) => c.command === "run_prompt")).toHaveLength(1);
  expect(calls.filter((c) => c.command === "open_terminal")).toHaveLength(1);
  expect(calls.filter((c) => c.command === "close_terminal")).toHaveLength(0);
  unmount();
  await act(async () => {});
  expect(calls.filter((c) => c.command === "close_terminal")).toHaveLength(1);
});
