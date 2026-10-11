import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { CommanderView } from "../src/components/CommanderView";
import { calls, handle } from "./fixtures/tauri";
it("generates a draft through the real workspace host without dispatch or startup", async () => {
  const task = {
    id: "one",
    title: "合成任务",
    agent_id: "mimo",
    prompt: "先审阅，不执行",
    depends_on: [],
  };
  const view = {
    run: {
      id: "fixture-run",
      cwd: "/fixture/project",
      status: "draft",
      plan: { objective: "中文目标", tasks: [task] },
    },
    summary: {
      tasks: [
        {
          ...task,
          status: "pending",
          result: null,
          session_id: null,
          agent_session_id: null,
          truncated: false,
        },
      ],
    },
    batches: [["one"]],
    active: false,
  };
  let generated = false;
  handle("get_commander_config", () => ({ model: "fixture-model" }));
  handle("commander_credential_source", () => "sqlite");
  handle("list_agent_definitions", () => [
    { id: "mimo", display_name: "MiMo", driver_kind: "acp" },
  ]);
  handle("validate_commander_directory", () => null);
  handle("list_commander_run_views", () => (generated ? [view] : []));
  handle("get_commander_run_view", () => view);
  handle("generate_commander_run", (args) => {
    expect(args).toMatchObject({
      objective: "中文目标",
      cwd: "/fixture/project",
      agents: ["mimo"],
    });
    generated = true;
    return view;
  });
  render(
    <CommanderView
      active
      onSettings={() => {}}
      currentCwd="/fixture/project"
      currentAgent="mimo"
    />,
  );
  await screen.findByText("fixture-model · 配置可用");
  fireEvent.change(screen.getByLabelText("任务目标"), {
    target: { value: "中文目标" },
  });
  fireEvent.click(screen.getByRole("button", { name: "生成计划" }));
  await screen.findByText("合成任务");
  await waitFor(() =>
    expect(
      calls.filter((c) => c.command === "generate_commander_run"),
    ).toHaveLength(1),
  );
  expect(screen.getByRole("button", { name: "审阅并执行" })).toBeEnabled();
  expect(
    calls.filter((c) =>
      /execute_commander_run|run_prompt|list_agents/.test(c.command),
    ),
  ).toHaveLength(0);
});
