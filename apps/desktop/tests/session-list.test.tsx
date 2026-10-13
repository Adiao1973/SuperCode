import { useReducer } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { VirtuosoMockContext } from "react-virtuoso";
import { SessionsWorkspace } from "../src/components/SessionsWorkspace";
import { DEFAULT_LAYOUT, LayoutProvider } from "../src/lib/layout";
import { AppearanceProvider } from "../src/lib/appearance";
import { MotionProvider } from "../src/lib/motion";
import {
  filterSessionTitle,
  initialSessionsState,
  sessionsReducer,
  sessionStatus,
  type SessionsState,
} from "../src/lib/sessions";
import type { AgentEvent } from "../src/lib/events";
import { calls, Channel, handle } from "./fixtures/tauri";

it("filters only titles with trimmed case-insensitive Chinese substrings and preserves historical states", () => {
  expect(filterSessionTitle("中文 API 调试", " api ")).toBe(true);
  expect(filterSessionTitle("中文 API 调试", "中文")).toBe(true);
  expect(filterSessionTitle("中文 API 调试", " ")).toBe(true);
  expect(filterSessionTitle("中文 API 调试", "/fixture")).toBe(false);
  for (const [status, label] of [
    ["completed", "已完成"],
    ["failed", "出错"],
    ["cancelled", "已取消"],
    ["interrupted", "已中断"],
  ]) {
    const state = sessionsReducer(initialSessionsState(), {
      type: "hydrate",
      sessions: [
        {
          agent_id: "mimo",
          local_id: `local-${status}`,
          agent_session_id: status,
          title: "历史",
          cwd: "/fixture",
          workspace_id: "project",
          status,
          updated_at: "",
        },
      ],
    });
    expect(sessionStatus(state.items[0]).label).toBe(label);
  }
  const e = initialSessionsState().items[0];
  expect(sessionStatus({ ...e, invokeError: "failure" }).tone).toBe("failed");
});

it("keeps active context/drafts and routes two real RunConsole Channels while filtering and switching", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  handle("list_workspaces", () => [
    {
      id: "project",
      name: "合成项目",
      path: "/fixture/project",
      kind: "project",
    },
    { id: "default", name: "默认空间", path: null, kind: "default" },
  ]);
  handle("list_agent_definitions", () => []);
  handle("check_opencode_env", () => null);
  handle("list_session_messages", () => []);
  const channels: Channel<AgentEvent[]>[] = [];
  const finishes: Array<() => void> = [];
  handle("run_prompt", (args) => {
    channels.push(args.onEvents as Channel<AgentEvent[]>);
    return new Promise<void>((resolve) => finishes.push(resolve));
  });
  let state = initialSessionsState();
  state = sessionsReducer(state, {
    type: "patchDraft",
    key: state.activeKey!,
    patch: {
      cwd: "/fixture/actual-a",
      prompt: "A 独立输出",
      agentId: "opencode",
    },
  });
  const keyA = state.activeKey!;
  state = sessionsReducer(state, {
    type: "new",
    workspace: {
      id: "project",
      name: "合成项目",
      path: "/fixture/project",
      kind: "project",
    },
  });
  const keyB = state.activeKey!;
  state = sessionsReducer(state, {
    type: "patchDraft",
    key: keyB,
    patch: { cwd: "/fixture/actual-b", prompt: "B 独立输出", agentId: "mimo" },
  });
  state.items[0].title = "Alpha 中文";
  state.items[1].title = "Beta 中文";
  state = sessionsReducer(state, { type: "activate", key: keyA });
  let latest: SessionsState = state;
  function Host() {
    const [value, dispatch] = useReducer(sessionsReducer, state);
    latest = value;
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
            <VirtuosoMockContext.Provider
              value={{ viewportHeight: 1000, itemHeight: 100 }}
            >
              <SessionsWorkspace state={value} dispatch={dispatch} />
            </VirtuosoMockContext.Provider>
          </LayoutProvider>
        </AppearanceProvider>
      </MotionProvider>
    );
  }
  render(<Host />);
  await waitFor(() => expect(screen.getByText("合成项目")).toBeVisible());
  fireEvent.click(screen.getByRole("button", { name: "运行" }));
  await waitFor(() => expect(channels).toHaveLength(1));
  act(() =>
    channels[0].onmessage([{ type: "session_started", session_id: "acp-a" }]),
  );
  const promptA = screen.getByPlaceholderText("任务提示词");
  const beforeFilter = calls.length;
  fireEvent.change(screen.getByRole("textbox", { name: "按标题过滤会话" }), {
    target: { value: "no-match" },
  });
  expect(screen.getByText("没有匹配的会话")).toBeVisible();
  expect(screen.getByText("当前会话不在筛选结果中")).toBeVisible();
  expect(screen.getByPlaceholderText("任务提示词")).toBe(promptA);
  expect(calls).toHaveLength(beforeFilter);
  fireEvent.click(screen.getByRole("button", { name: "清除标题过滤" }));
  fireEvent.click(screen.getByRole("button", { name: "选择会话 Beta 中文" }));
  expect(screen.getByLabelText("当前会话上下文")).toHaveTextContent(
    "/fixture/actual-b",
  );
  expect(screen.getByLabelText("当前会话上下文")).toHaveTextContent("mimo");
  fireEvent.click(screen.getByRole("button", { name: "运行" }));
  await waitFor(() => expect(channels).toHaveLength(2));
  act(() => {
    channels[1].onmessage([
      { type: "session_started", session_id: "acp-b" },
      { type: "message_chunk", message_id: "b", text: "ONLY-B" },
    ]);
    channels[0].onmessage([
      { type: "message_chunk", message_id: "a", text: "ONLY-A" },
    ]);
  });
  expect(screen.getByText("ONLY-B")).toBeVisible();
  expect(screen.queryByText("ONLY-A")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "选择会话 Alpha 中文" }));
  expect(screen.getByText("ONLY-A")).toBeVisible();
  expect(screen.queryByText("ONLY-B")).not.toBeInTheDocument();
  expect(screen.getByLabelText("当前会话上下文")).toHaveTextContent(
    "/fixture/actual-a",
  );
  expect(
    screen.getByRole("button", { name: "选择会话 Alpha 中文" }),
  ).toHaveAttribute("aria-current", "true");
  const requests = calls.filter((c) => c.command === "run_prompt");
  expect(
    requests.map((c) => [c.args.agentId, c.args.cwd, c.args.workspaceId]),
  ).toEqual([
    ["opencode", "/fixture/actual-a", "default"],
    ["mimo", "/fixture/actual-b", "project"],
  ]);
  expect(latest.items.find((x) => x.key === keyA)?.draft.prompt).toBe(
    "A 独立输出",
  );
  expect(latest.items.find((x) => x.key === keyB)?.workspaceId).toBe("project");
  await act(async () => finishes.forEach((f) => f()));
  fireEvent.change(screen.getByRole("textbox", { name: "按标题过滤会话" }), {
    target: { value: "missing" },
  });
  fireEvent.click(screen.getByTitle("新建会话（⌘N，默认空间）"));
  expect(screen.getByRole("textbox", { name: "按标题过滤会话" })).toHaveValue(
    "",
  );
  expect(screen.getByPlaceholderText("任务提示词")).toHaveValue("");
  expect(latest.items.find((entry) => entry.key === keyA)?.draft.cwd).toBe(
    "/fixture/actual-a",
  );
});

it("retries failed historical message reads without resuming or running the Agent", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  handle("list_workspaces", () => []); handle("list_agent_definitions", () => []);
  handle("check_opencode_env", () => null); handle("check_node_env", () => null);
  handle("list_session_messages", () => { throw new Error("合成消息读取失败"); });
  let initial = sessionsReducer(initialSessionsState(), { type: "hydrate", sessions: [{ local_id: "p419-history", agent_session_id: "p419-acp", agent_id: "opencode", title: "历史读取", cwd: "/fixture", workspace_id: "default", status: "completed", updated_at: "" }] });
  initial = { ...initial, activeKey: initial.items.find((item) => item.acpSessionId === "p419-acp")!.key };
  function Host() {
    const [value, dispatch] = useReducer(sessionsReducer, initial);
    return <MotionProvider initial={{ preferences: { motion: "reduce" }, error: null }}><AppearanceProvider initial={{ preferences: { theme: "light" }, error: null }}><LayoutProvider initial={{ preferences: DEFAULT_LAYOUT, error: null }}><SessionsWorkspace state={value} dispatch={dispatch} /></LayoutProvider></AppearanceProvider></MotionProvider>;
  }
  render(<Host />);
  expect(await screen.findByRole("alert")).toHaveTextContent("合成消息读取失败");
  handle("list_session_messages", () => []);
  fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(calls.filter((c) => c.command === "list_session_messages")).toHaveLength(2);
  expect(calls.some((c) => /run_prompt|session_load|execute/.test(c.command))).toBe(false);
});
