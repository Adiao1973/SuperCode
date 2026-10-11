import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
vi.mock("../src/lib/motion-features", () => {
  throw new Error("fixture optional chunk unavailable");
});
import { MotionProvider, MotionNotice } from "../src/lib/motion";
import { MotionSettings } from "../src/components/MotionSettings";
import { handle, calls } from "./fixtures/tauri";
it("keeps content visible and settings operable if optional animation features fail", async () => {
  handle("save_motion_preferences", () => undefined);
  render(
    <MotionProvider initial={{ preferences: { motion: "full" }, error: null }}>
      <MotionSettings />
      <MotionNotice visible>static fallback</MotionNotice>
    </MotionProvider>,
  );
  await act(async () => {});
  expect(screen.getByText("static fallback")).toBeVisible();
  expect(screen.getByText("static fallback").style.transform).toBe("");
  await userEvent
    .setup()
    .selectOptions(screen.getByLabelText("动效"), "reduce");
  expect(calls).toContainEqual({
    command: "save_motion_preferences",
    args: { preferences: { motion: "reduce" } },
  });
});
