import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { AgentsSection } from "../src/components/AgentsSection";
import { calls, handle } from "./fixtures/tauri";

it("allows Agent configuration by stable accessible field names without starting the Agent", async () => {
  handle("list_agents", () => []);
  handle("add_agent", () => ({}));
  render(<AgentsSection />);
  fireEvent.click(await screen.findByRole("button", { name: "新增" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Agent 标识" }), { target: { value: "fixture-agent" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Agent 显示名" }), { target: { value: "合成 Agent" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Agent 启动命令" }), { target: { value: "fixture --acp" } });
  fireEvent.change(screen.getByRole("textbox", { name: "版本检测参数" }), { target: { value: "--version" } });
  expect(screen.getByRole("combobox", { name: "Agent 驱动协议" })).toHaveValue("acp");
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(calls.filter(c => c.command === "add_agent")).toHaveLength(1));
  expect(calls.find(c => c.command === "add_agent")?.args.input).toMatchObject({ id: "fixture-agent", command: "fixture --acp", displayName: "合成 Agent", versionArgs: ["--version"] });
  expect(calls.some(c => /run_prompt|execute|open_terminal/.test(c.command))).toBe(false);
});
