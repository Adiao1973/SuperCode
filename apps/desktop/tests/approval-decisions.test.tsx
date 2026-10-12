import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { ApprovalsView } from "../src/components/ApprovalsView";
import { permissionCenter } from "../src/lib/permissions";
import { pending } from "./fixtures/permissions";
it("uses option kinds rather than opaque option IDs and identifies cancelled decisions", () => {
  const request = pending().request;
  permissionCenter.decisions = [{ request, source: { type: "rule", pattern: "<cancelled>", effect: "deny" }, decision: { option_id: "no", updated_input: null } }];
  render(<ApprovalsView />);
  expect(screen.getByText("取消收尾")).toBeVisible();
  expect(screen.getAllByText("拒绝").length).toBeGreaterThan(0);
  expect(screen.queryByText("放行")).toBeNull();
  permissionCenter.decisions = [];
});
