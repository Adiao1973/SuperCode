import { expect, it, vi } from "vitest";
import { runPrompt, listWorkspaces, cancelRun } from "../src/lib/agent";
import { saveCommanderConfig } from "../src/lib/commander";
import {
  calls,
  handle,
  emit,
  listenerCount,
  listen,
  resetIpc,
} from "./fixtures/tauri";
import { conversation, replay } from "./fixtures/replay";
import { pending } from "./fixtures/permissions";

it("fails closed for undeclared IPC and network", async () => {
  await expect(listWorkspaces()).rejects.toThrow(
    "Undeclared fixture IPC: list_workspaces",
  );
  expect(() => fetch("https://example.invalid")).toThrow("forbids network");
});
it("preserves run_prompt camelCase arguments, nullable ids and whole Channel batches", async () => {
  const receive = vi.fn();
  handle("run_prompt", (args) => {
    expect(args).toMatchObject({
      agentId: "codex",
      prompt: "合成请求",
      cwd: "/fixture/project",
      allow: [],
      deny: [],
      mode: "ask",
      resumeSessionId: null,
      workspaceId: null,
      taskId: null,
    });
    const channel = args.onEvents as { onmessage: typeof receive };
    replay(conversation, (batch) => channel.onmessage(batch)).advanceTo(150);
    return { session_id: "fixture-acp-a" };
  });
  await expect(
    runPrompt({
      agentId: "codex",
      prompt: "合成请求",
      cwd: "/fixture/project",
      allow: [],
      deny: [],
      mode: "ask",
      onEvents: receive,
    }),
  ).resolves.toEqual({ session_id: "fixture-acp-a" });
  expect(receive.mock.calls.map((c) => c[0])).toEqual(
    conversation.map((f) => f.batch),
  );
  expect(calls).toHaveLength(1);
});
it("does not drop resume/workspace/task identities and targets cancellation by ACP id", async () => {
  handle("run_prompt", () => ({ session_id: "fixture-resume" }));
  handle("cancel_run", () => undefined);
  await runPrompt({
    agentId: "codex",
    prompt: "继续",
    cwd: "/fixture/project",
    allow: [],
    deny: [],
    mode: "ask",
    resumeSessionId: "fixture-resume",
    workspaceId: "fixture-space",
    taskId: "fixture-task",
    onEvents: () => {},
  });
  await cancelRun("fixture-resume");
  expect(calls[0].args).toMatchObject({
    resumeSessionId: "fixture-resume",
    workspaceId: "fixture-space",
    taskId: "fixture-task",
  });
  expect(calls[1]).toEqual({
    command: "cancel_run",
    args: { sessionId: "fixture-resume" },
  });
});
it("keeps nested commander config snake_case without saving a key", async () => {
  handle("save_commander_config", () => undefined);
  const config = {
    endpoint: "https://example.invalid/v1/chat/completions",
    model: "fixture-model",
    api_key_env: "FIXTURE_UNUSED",
    timeout_secs: 10,
  };
  await saveCommanderConfig(config);
  expect(calls).toEqual([
    { command: "save_commander_config", args: { config } },
  ]);
});
it("registers the real permission center once and isolates identical tool ids across sessions", async () => {
  const { permissionCenter } = await import("../src/lib/permissions");
  await Promise.all([permissionCenter.setup(), permissionCenter.setup()]);
  expect(listenerCount("permission-request")).toBe(1);
  const observe = vi.fn();
  const unsubscribe = permissionCenter.onPending(observe);
  emit("permission-request", pending());
  emit("permission-request", pending("fixture-acp-b", "fixture-b"));
  emit("decision-record", {
    request: pending().request,
    source: { type: "user" },
    decision: { option_id: "yes", updated_input: null },
  });
  expect(permissionCenter.pending.map((p) => p.id)).toEqual(["fixture-b"]);
  unsubscribe();
  const n = observe.mock.calls.length;
  emit("permission-request", pending("fixture-acp-c", "fixture-c"));
  expect(observe).toHaveBeenCalledTimes(n);
});

it("releases fixture event subscriptions and resets command state", async () => {
  const receive = vi.fn();
  const unlisten = await listen("fixture-event", receive);
  emit("fixture-event", { value: 1 });
  expect(receive).toHaveBeenCalledTimes(1);
  unlisten();
  emit("fixture-event", { value: 2 });
  expect(receive).toHaveBeenCalledTimes(1);
  handle("list_workspaces", () => []);
  await expect(listWorkspaces()).resolves.toEqual([]);
  resetIpc();
  expect(calls).toHaveLength(0);
  expect(listenerCount("fixture-event")).toBe(0);
  await expect(listWorkspaces()).rejects.toThrow("Undeclared fixture IPC");
});
