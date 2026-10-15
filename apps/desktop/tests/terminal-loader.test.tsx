import { act, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
const load = vi.hoisted(() => ({ release: undefined as undefined | (() => void), mounted: vi.fn(() => "terminal ready") }));
vi.mock("../src/components/SessionTerminal", async () => {
  await new Promise<void>(resolve => { load.release = resolve; });
  return { SessionTerminal: load.mounted };
});
import { SessionTerminal } from "../src/components/TerminalLoader";
it("closing during runtime loading never mounts a terminal, while reopening uses the loaded module", async () => {
  const view = render(<SessionTerminal cwd="/synthetic" onClose={() => {}} />);
  expect(screen.getByRole("status")).toHaveTextContent("正在加载终端");
  await waitFor(() => expect(load.release).toBeDefined());
  view.unmount();
  await act(async () => { load.release!(); });
  expect(load.mounted).not.toHaveBeenCalled();
  render(<SessionTerminal cwd="/synthetic" onClose={() => {}} />);
  expect(await screen.findByText("terminal ready")).toBeVisible();
});
