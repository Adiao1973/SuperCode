import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { MotionProvider } from "../src/lib/motion";
import { PendingCard } from "../src/components/PendingCard";
import { calls, handle } from "./fixtures/tauri";
import { pending } from "./fixtures/permissions";

it("disables both decisions while one approval response is pending", async () => {
  let release!: () => void;
  handle(
    "respond_permission",
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const user = userEvent.setup();
  render(
    <MotionProvider initial={{ preferences: { motion: "full" }, error: null }}>
      <PendingCard pending={pending()} />
    </MotionProvider>,
  );
  await user.click(screen.getByRole("button", { name: "允许一次" }));
  expect(screen.getByRole("button", { name: "允许一次" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "拒绝" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "拒绝" }));
  expect(calls).toEqual([
    {
      command: "respond_permission",
      args: { requestId: "fixture-request-a", optionId: "yes" },
    },
  ]);
  await act(async () => release());
  expect(screen.getByRole("button", { name: "拒绝" })).toBeEnabled();
});
