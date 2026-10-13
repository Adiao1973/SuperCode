import { clearFeedback } from "../src/lib/feedback";
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { resetIpc } from "./fixtures/tauri";
import { mediaFixture } from "./fixtures/media";

vi.mock("@tauri-apps/api/core", () => import("./fixtures/tauri"));
vi.mock("@tauri-apps/api/event", () => import("./fixtures/tauri"));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "fixture" }));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: () => {
    throw new Error("Fixture forbids external navigation");
  },
}));
beforeEach(() => {
  resetIpc();
  vi.stubGlobal("matchMedia", mediaFixture().matchMedia);
  vi.stubGlobal("fetch", () => {
    throw new Error("Fixture forbids network");
  });
  // Catch accidental XMLHttpRequest/WebSocket bypasses too.
  vi.spyOn(XMLHttpRequest.prototype, "open").mockImplementation(() => {
    throw new Error("Fixture forbids network");
  });
  vi.stubGlobal(
    "WebSocket",
    class {
      constructor() {
        throw new Error("Fixture forbids sockets");
      }
    },
  );
});
afterEach(() => {
  cleanup();
  clearFeedback();
  resetIpc();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
