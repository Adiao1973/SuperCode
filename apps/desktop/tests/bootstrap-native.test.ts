import { afterEach, expect, it, vi } from "vitest";
import script from "../src/bootstrap-native.js?raw";

afterEach(() => {
  sessionStorage.removeItem("supercode.ui-bootstrap");
  delete (window as any).__SUPERCODE_BOOTSTRAP;
  delete (window as any).__TAURI_INTERNALS__;
});
function snapshot() {
  return {
    appearance: { preferences: { theme: "dark" }, error: null },
    motion: { preferences: { motion: "reduce" }, error: null },
    layout: { preferences: {}, error: null },
  };
}
it("applies saved theme and reduced motion before requesting native visibility", async () => {
  const state = snapshot();
  (window as any).__SUPERCODE_BOOTSTRAP = state;
  const invoke = vi.fn(() => {
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(document.documentElement.dataset.motion).toBe("reduce");
    return Promise.resolve();
  });
  (window as any).__TAURI_INTERNALS__ = { invoke };
  window.eval(script);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("appearance_ready", { dark: true, theme: "dark" });
  await (state as any).windowReady;
  expect((state as any).windowThemeKey).toBe("dark:true");
});
it("leaves SDK fallback available when the bridge has not initialized", () => {
  const state = snapshot();
  (window as any).__SUPERCODE_BOOTSTRAP = state;
  window.eval(script);
  expect((state as any).windowReady).toBeUndefined();
  expect(document.documentElement.dataset.theme).toBe("dark");
});
it("waits for the document root before showing a document-start window", async () => {
  const state = snapshot();
  (window as any).__SUPERCODE_BOOTSTRAP = state;
  const invoke = vi.fn(() => Promise.resolve());
  (window as any).__TAURI_INTERNALS__ = { invoke };
  const root = document.documentElement;
  root.remove();
  try {
    window.eval(script);
    expect(invoke).not.toHaveBeenCalled();
    document.append(root);
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.theme).toBe("dark");
  } finally {
    if (!document.documentElement) document.append(root);
  }
});

it("uses a snapshot only once per app launch so a WebView reload rereads preferences", () => {
  const state = { ...snapshot(), bootNonce: "fixture-launch-a" };
  const invoke = vi.fn(() => Promise.resolve());
  (window as any).__TAURI_INTERNALS__ = { invoke };
  (window as any).__SUPERCODE_BOOTSTRAP = state;
  window.eval(script);
  expect(invoke).toHaveBeenCalledTimes(1);
  (window as any).__SUPERCODE_BOOTSTRAP = { ...snapshot(), bootNonce: "fixture-launch-a" };
  window.eval(script);
  expect((window as any).__SUPERCODE_BOOTSTRAP).toBeUndefined();
  expect(invoke).toHaveBeenCalledTimes(1);
  (window as any).__SUPERCODE_BOOTSTRAP = { ...snapshot(), bootNonce: "fixture-launch-b" };
  window.eval(script);
  expect(invoke).toHaveBeenCalledTimes(2);
});
