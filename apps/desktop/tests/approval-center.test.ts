import { expect, it } from "vitest";
import { PermissionCenter } from "../src/lib/permissions";
import { emit, calls, handle } from "./fixtures/tauri";
import { pending } from "./fixtures/permissions";
it("shares UUID submission state, permits retry and clears exact requests", async () => {
  const center = new PermissionCenter();
  await center.setup();
  const a = pending();
  const b = { ...a, id: "other-uuid" };
  emit("permission-request", a);
  emit("permission-request", a);
  emit("permission-request", b);
  expect(center.pending).toHaveLength(2);
  let reject!: (reason: Error) => void;
  handle("respond_permission", () => new Promise<void>((_, fail) => { reject = fail; }));
  const first = center.respond(a, "yes");
  await center.respond(a, "no");
  expect(calls).toHaveLength(1);
  reject(new Error("synthetic transport failure"));
  await first;
  expect(center.response(a.id)).toMatchObject({ status: "error", error: "Error: synthetic transport failure" });
  handle("respond_permission", () => undefined);
  await center.respond(a, "no");
  expect(center.response(a.id).status).toBe("accepted");
  await center.respond(a, "yes");
  expect(calls).toHaveLength(2);
  emit("decision-record", { request_id: a.id, request: a.request, source: { type: "user" }, decision: { option_id: "no", updated_input: null } });
  expect(center.pending.map((item) => item.id)).toEqual([b.id]);
  emit("decision-record", { request: b.request, source: { type: "mode", mode: "full_access" }, decision: { option_id: "yes", updated_input: null } });
  expect(center.pending.map((item) => item.id)).toEqual([b.id]);
  emit("permission-removed", { ids: [b.id] });
  expect(center.pending).toHaveLength(0);
});

it("cleans partial listener setup and retries subscriptions without responding", async () => {
  const { vi } = await import("vitest");
  const events = await import("@tauri-apps/api/event");
  const { listenerCount } = await import("./fixtures/tauri");
  const spy = vi.spyOn(events, "listen").mockRejectedValueOnce(new Error("合成监听失败"));
  const center = new PermissionCenter();
  try {
    await expect(center.setup()).rejects.toThrow("合成监听失败");
    expect(listenerCount("permission-removed")).toBe(0);
    expect(listenerCount("decision-record")).toBe(0);
    await center.setup();
    emit("permission-request", pending());
    expect(center.pending).toHaveLength(1);
    expect(calls.some((c) => c.command === "respond_permission")).toBe(false);
  } finally { spy.mockRestore(); }
});
