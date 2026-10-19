import { StrictMode } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import {
  AppearanceProvider,
  loadAppearance,
  SYSTEM_DARK,
} from "../src/lib/appearance";
import { AppearanceSettings } from "../src/components/AppearanceSettings";
import { mediaFixture } from "./fixtures/media";
import { calls, handle } from "./fixtures/tauri";

it("loads the SQLite preference and follows system changes only in system mode", async () => {
  handle("get_appearance_preferences", () => ({ theme: "system" }));
  handle("save_appearance_preferences", () => undefined);
  handle("appearance_ready", () => undefined);
  const media = mediaFixture();
  vi.stubGlobal("matchMedia", media.matchMedia);
  const initial = await loadAppearance();
  const { unmount } = render(
    <AppearanceProvider initial={initial}>
      <AppearanceSettings />
    </AppearanceProvider>,
  );
  expect(document.documentElement.dataset.theme).toBe("light");
  act(() => media.set(SYSTEM_DARK, true));
  expect(document.documentElement.dataset.theme).toBe("dark");
  await userEvent.setup().selectOptions(screen.getByLabelText("主题"), "light");
  expect(
    calls.find((c) => c.command === "save_appearance_preferences")?.args,
  ).toEqual({ preferences: { theme: "light" } });
  act(() => media.set(SYSTEM_DARK, false));
  act(() => media.set(SYSTEM_DARK, true));
  expect(document.documentElement.dataset.theme).toBe("light");
  unmount();
  expect(media.count(SYSTEM_DARK)).toBe(0);
});
it("retains the saved theme on write failure and can retry loading", async () => {
  handle("appearance_ready", () => undefined);
  handle("save_appearance_preferences", () => {
    throw new Error("fixture disk failure");
  });
  render(
    <AppearanceProvider
      initial={{ preferences: { theme: "dark" }, error: null }}
    >
      <AppearanceSettings />
    </AppearanceProvider>,
  );
  const user = userEvent.setup();
  await user.selectOptions(screen.getByLabelText("主题"), "light");
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(screen.getByRole("alert")).toHaveTextContent("fixture disk failure");
  handle("get_appearance_preferences", () => ({ theme: "light" }));
  await user.click(screen.getByRole("button", { name: "重新读取" }));
  expect(document.documentElement.dataset.theme).toBe("light");
});
it("falls back on timeout without saving over SQLite and retries", async () => {
  vi.useFakeTimers();
  handle("get_appearance_preferences", () => new Promise(() => {}));
  const result = loadAppearance(10);
  await vi.advanceTimersByTimeAsync(10);
  expect(await result).toMatchObject({
    preferences: { theme: "system" },
    error: expect.stringContaining("超时"),
  });
  expect(calls.map((c) => c.command)).toEqual(["get_appearance_preferences"]);
});
it("does not apply a new theme while its save is still pending", async () => {
  handle("appearance_ready", () => undefined);
  let release!: () => void;
  handle(
    "save_appearance_preferences",
    () =>
      new Promise<void>((r) => {
        release = r;
      }),
  );
  render(
    <AppearanceProvider
      initial={{ preferences: { theme: "light" }, error: null }}
    >
      <AppearanceSettings />
    </AppearanceProvider>,
  );
  await userEvent.setup().selectOptions(screen.getByLabelText("主题"), "dark");
  expect(screen.getByLabelText("主题")).toBeDisabled();
  expect(document.documentElement.dataset.theme).toBe("light");
  await act(async () => release());
  expect(document.documentElement.dataset.theme).toBe("dark");
});

it("applies the saved theme before asking the native window to show", async () => {
  const ready = vi.fn((args: Record<string, unknown>) => {
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(args).toEqual({ dark: true, theme: "dark" });
  });
  handle("appearance_ready", ready);
  render(
    <AppearanceProvider
      initial={{ preferences: { theme: "dark" }, error: null }}
    >
      <AppearanceSettings />
    </AppearanceProvider>,
  );
  expect(ready).toHaveBeenCalledOnce();
});

it("observes an early window failure across effect replay and still applies later theme changes", async () => {
  handle("appearance_ready", () => undefined);
  handle("save_appearance_preferences", () => undefined);
  let rejectReady!: (reason: Error) => void;
  const ready = new Promise<void>((_, reject) => { rejectReady = reject; });
  render(<StrictMode><AppearanceProvider initial={{ preferences: { theme: "light" }, error: null }} windowReady={ready}><AppearanceSettings /></AppearanceProvider></StrictMode>);
  expect(calls.filter(call => call.command === "appearance_ready")).toHaveLength(0);
  await act(async () => rejectReady(new Error("fixture window unavailable")));
  expect(screen.getByRole("alert")).toHaveTextContent("fixture window unavailable");
  await userEvent.setup().selectOptions(screen.getByLabelText("主题"), "dark");
  expect(calls.filter(call => call.command === "appearance_ready")).toHaveLength(1);
  expect(document.documentElement.dataset.theme).toBe("dark");
});

it("does not reuse an early window promise after the system theme changes before React mounts", () => {
  const media = mediaFixture();
  media.set(SYSTEM_DARK, true);
  vi.stubGlobal("matchMedia", media.matchMedia);
  handle("appearance_ready", () => undefined);
  render(<AppearanceProvider initial={{ preferences: { theme: "system" }, error: null }} windowReady={new Promise(() => {})} windowReadyKey="system:light"><AppearanceSettings /></AppearanceProvider>);
  expect(calls.find(call => call.command === "appearance_ready")?.args).toEqual({ theme: "system", dark: true });
  expect(document.documentElement.dataset.theme).toBe("dark");
});
