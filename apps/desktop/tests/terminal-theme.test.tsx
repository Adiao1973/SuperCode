import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { AppearanceProvider } from "../src/lib/appearance";
import { AppearanceSettings } from "../src/components/AppearanceSettings";
import { SessionTerminal } from "../src/components/SessionTerminal";
import { calls, handle } from "./fixtures/tauri";
const terminal = vi.hoisted(() => ({ created: 0, disposed: 0, options: {} as Record<string, unknown> }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: Record<string, unknown> = {};
    cols = 80;
    rows = 24;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      terminal.options = this.options;
      terminal.created++;
    }
    loadAddon() {}
    open() {}
    focus() {}
    attachCustomKeyEventHandler() {}
    onData() {
      return { dispose() {} };
    }
    dispose() {
      terminal.disposed++;
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
it("updates terminal appearance without recreating its PTY and closes once on unmount", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  for (const cmd of [
    "appearance_ready",
    "save_appearance_preferences",
    "open_terminal",
    "resize_terminal",
    "close_terminal",
  ])
    handle(cmd, () => undefined);
  vi.stubGlobal("getComputedStyle", () => ({
    getPropertyValue: (name: string) => `${document.documentElement.dataset.theme}:${name}`,
  }));
  terminal.created = 0;
  terminal.disposed = 0;
  const { unmount } = render(
    <AppearanceProvider
      initial={{ preferences: { theme: "light" }, error: null }}
    >
      <AppearanceSettings />
      <SessionTerminal cwd="/fixture" onClose={() => {}} />
    </AppearanceProvider>,
  );
  await act(async () => {});
  expect(terminal.options.theme).toEqual({ background: "light:--background", foreground: "light:--foreground" });
  await userEvent.setup().selectOptions(screen.getByLabelText("主题"), "dark");
  expect(terminal.options.theme).toEqual({ background: "dark:--background", foreground: "dark:--foreground" });
  expect(terminal.created).toBe(1);
  expect(terminal.disposed).toBe(0);
  expect(calls.filter((c) => c.command === "open_terminal")).toHaveLength(1);
  expect(calls.filter((c) => c.command === "close_terminal")).toHaveLength(0);
  unmount();
  await act(async () => {});
  expect(calls.filter((c) => c.command === "close_terminal")).toHaveLength(1);
});
