import { StrictMode } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { CommanderInput } from "../src/components/CommanderInput";
import { calls, handle } from "./fixtures/tauri";
const config = {
  endpoint: "http://fixture.invalid/v1",
  model: "fixture-model",
  api_key_env: "FIXTURE",
  timeout_secs: 30,
};
const definitions = [
  { id: "opencode", display_name: "OpenCode", driver_kind: "acp" },
  { id: "mimo", display_name: "MiMo", driver_kind: "acp" },
  { id: "zcode", display_name: "ZCode", driver_kind: "stream_json" },
];
const workspaces = [
  {
    id: "project",
    name: "中文项目",
    path: "/fixture/project",
    kind: "project" as const,
  },
];
function setup() {
  handle("get_commander_config", () => config);
  handle("commander_credential_source", () => "sqlite");
  handle("list_agent_definitions", () => definitions);
  handle("validate_commander_directory", () => null);
  handle("pick_commander_directory", () => null);
}
function props() {
  return {
    active: true,
    currentCwd: "/fixture/current",
    currentAgent: "mimo",
    workspaces,
    blocked: false,
    onSettings: vi.fn(),
    onGenerate: vi.fn(async () => {}),
  };
}
it("prefills current project, offers ACP multiselect with honest availability, and submits once without launching agents", async () => {
  setup();
  const p = props();
  let finish!: () => void;
  p.onGenerate.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  render(
    <StrictMode>
      <CommanderInput {...p} />
    </StrictMode>,
  );
  const user = userEvent.setup();
  await screen.findByText("fixture-model · 配置可用");
  expect(screen.getByLabelText("工作目录")).toHaveValue("/fixture/current");
  expect(screen.getByRole("checkbox", { name: /MiMo/ })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: /ZCode/ })).toBeDisabled();
  expect(screen.getByText(/执行前检查安装与登录/)).toBeVisible();
  await user.click(screen.getByRole("checkbox", { name: /OpenCode/ }));
  fireEvent.change(screen.getByLabelText("任务目标"), {
    target: { value: "实现中文待办\n保留已有数据" },
  });
  const button = screen.getByRole("button", { name: "生成计划" });
  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() => expect(p.onGenerate).toHaveBeenCalledTimes(1));
  expect(p.onGenerate).toHaveBeenCalledWith(
    "实现中文待办\n保留已有数据",
    "/fixture/current",
    ["opencode", "mimo"],
  );
  expect(
    calls.filter((c) =>
      /run_prompt|execute_commander|list_agents/.test(c.command),
    ),
  ).toEqual([]);
  await act(async () => finish());
});
it("follows current context until edited, preserves draft on navigation, and supports explicit reset/project selection", async () => {
  setup();
  const p = props();
  const view = render(<CommanderInput {...p} />);
  await screen.findByText("fixture-model · 配置可用");
  view.rerender(<CommanderInput {...p} currentCwd="/fixture/next" />);
  expect(screen.getByLabelText("工作目录")).toHaveValue("/fixture/next");
  fireEvent.change(screen.getByLabelText("工作目录"), {
    target: { value: "/fixture/custom" },
  });
  fireEvent.change(screen.getByLabelText("任务目标"), {
    target: { value: "草稿中文" },
  });
  view.rerender(
    <CommanderInput {...p} active={false} currentCwd="/fixture/other" />,
  );
  view.rerender(<CommanderInput {...p} currentCwd="/fixture/other" />);
  expect(screen.getByLabelText("工作目录")).toHaveValue("/fixture/custom");
  expect(screen.getByLabelText("任务目标")).toHaveValue("草稿中文");
  fireEvent.click(screen.getByRole("button", { name: "使用当前项目" }));
  expect(screen.getByLabelText("工作目录")).toHaveValue("/fixture/other");
  fireEvent.change(screen.getByLabelText("项目空间"), {
    target: { value: "project" },
  });
  expect(screen.getByLabelText("工作目录")).toHaveValue("/fixture/project");
});
it("explains missing config/key and failed queries, links settings, and refreshes safely", async () => {
  setup();
  handle("get_commander_config", () => null);
  const p = props();
  const view = render(<CommanderInput {...p} />);
  await screen.findByText(/尚未配置指挥官模型/);
  fireEvent.click(screen.getByRole("button", { name: "模型设置" }));
  expect(p.onSettings).toHaveBeenCalledTimes(1);
  handle("get_commander_config", () => config);
  handle("commander_credential_source", () => "missing");
  fireEvent.click(screen.getByRole("button", { name: "刷新配置与 Agent" }));
  await screen.findByText(/尚未保存密钥/);
  handle("get_commander_config", () => {
    throw Error("配置查询失败");
  });
  fireEvent.click(screen.getByRole("button", { name: "刷新配置与 Agent" }));
  await screen.findByText(/配置查询失败/);
  expect(screen.getByRole("button", { name: "生成计划" })).toBeDisabled();
  view.unmount();
});
it("picker cancellation preserves directory, errors recover, and invalid directory prevents generation", async () => {
  setup();
  const p = props();
  render(<CommanderInput {...p} />);
  await screen.findByText("fixture-model · 配置可用");
  fireEvent.click(screen.getByRole("button", { name: "选择目录" }));
  await waitFor(() =>
    expect(calls.some((c) => c.command === "pick_commander_directory")).toBe(
      true,
    ),
  );
  expect(screen.getByLabelText("工作目录")).toHaveValue("/fixture/current");
  handle("pick_commander_directory", () => "/fixture/chosen");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "选择目录" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "选择目录" }));
  await waitFor(() =>
    expect(screen.getByLabelText("工作目录")).toHaveValue("/fixture/chosen"),
  );
  fireEvent.change(screen.getByLabelText("任务目标"), {
    target: { value: "计划" },
  });
  handle("validate_commander_directory", () => {
    throw Error("请选择已存在的绝对工作目录");
  });
  fireEvent.click(screen.getByRole("button", { name: "生成计划" }));
  await screen.findByRole("alert");
  expect(p.onGenerate).not.toHaveBeenCalled();
  handle("validate_commander_directory", () => null);
  fireEvent.click(screen.getByRole("button", { name: "生成计划" }));
  await waitFor(() => expect(p.onGenerate).toHaveBeenCalledTimes(1));
});
it("registry refresh removes unsupported selection, empty/unavailable lists cannot submit, and late configuration cannot revive hidden state", async () => {
  setup();
  const p = props();
  const view = render(<CommanderInput {...p} />);
  await screen.findByText("fixture-model · 配置可用");
  handle("list_agent_definitions", () =>
    definitions.filter((d) => d.id === "zcode"),
  );
  fireEvent.click(screen.getByRole("button", { name: "刷新配置与 Agent" }));
  await waitFor(() =>
    expect(screen.queryByRole("checkbox", { name: /MiMo/ })).toBeNull(),
  );
  expect(screen.getByText(/至少选择一个已接入的 Agent/)).toBeVisible();
  let resolve!: (value: typeof config) => void;
  handle("get_commander_config", () => new Promise((r) => (resolve = r)));
  fireEvent.click(screen.getByRole("button", { name: "刷新配置与 Agent" }));
  view.rerender(<CommanderInput {...p} active={false} />);
  await act(async () => resolve(config));
  expect(screen.queryByText("fixture-model · 配置可用")).toBeNull();
});
it("picker failures are local, and a late selection after leaving the page cannot overwrite draft", async () => {
  setup();
  const p = props();
  const view = render(<CommanderInput {...p} />);
  await screen.findByText("fixture-model · 配置可用");
  handle("pick_commander_directory", () => {
    throw Error("目录选择失败");
  });
  fireEvent.click(screen.getByRole("button", { name: "选择目录" }));
  await screen.findByText("Error: 目录选择失败");
  let resolve!: (path: string) => void;
  handle("pick_commander_directory", () => new Promise((r) => (resolve = r)));
  fireEvent.click(screen.getByRole("button", { name: "选择目录" }));
  view.rerender(<CommanderInput {...p} active={false} />);
  await act(async () => resolve("/fixture/stale"));
  view.rerender(<CommanderInput {...p} />);
  expect(screen.getByLabelText("工作目录")).toHaveValue("/fixture/current");
});
