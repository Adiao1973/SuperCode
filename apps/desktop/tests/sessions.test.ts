import { expect, it } from "vitest";
import { initialSessionsState, sessionsReducer } from "../src/lib/sessions";
import { conversation, replay } from "./fixtures/replay";
import { pending } from "./fixtures/permissions";

it("routes background streams by client key without overwriting the active draft", () => {
  let state = initialSessionsState();
  const a = state.activeKey!;
  state = sessionsReducer(state, {
    type: "patchDraft",
    key: a,
    patch: { prompt: "后台任务" },
  });
  state = sessionsReducer(state, { type: "begin", key: a, resume: false });
  state = sessionsReducer(state, {
    type: "new",
    prompt: "前台草稿",
    cwd: "/fixture/project",
  });
  const b = state.activeKey!;
  replay(conversation, (batch) => {
    state = sessionsReducer(state, { type: "batch", key: a, batch });
  }).advanceTo(150);
  expect(state.activeKey).toBe(b);
  expect(state.items.find((s) => s.key === b)?.draft.prompt).toBe("前台草稿");
  expect(state.items.find((s) => s.key === a)).toMatchObject({
    acpSessionId: "fixture-acp-a",
    resumable: true,
    title: "后台任务",
  });
  expect(
    sessionsReducer(state, {
      type: "batch",
      key: "deleted",
      batch: conversation[0].batch,
    }),
  ).toBe(state);
});
it("removes same-name approvals only from their owning ACP session", () => {
  let state = initialSessionsState();
  const a = state.activeKey!;
  state = sessionsReducer(state, {
    type: "batch",
    key: a,
    batch: [{ type: "session_started", session_id: "fixture-acp-a" }],
  });
  state = sessionsReducer(state, { type: "new" });
  const b = state.activeKey!;
  state = sessionsReducer(state, {
    type: "batch",
    key: b,
    batch: [{ type: "session_started", session_id: "fixture-acp-b" }],
  });
  for (const p of [
    pending(),
    pending("fixture-acp-b", "fixture-request-b"),
    pending(),
  ])
    state = sessionsReducer(state, {
      type: "approvalAdd",
      acpSessionId: p.request.session_id,
      pending: p,
    });
  expect(state.items.find((s) => s.key === a)?.pendingApprovals).toHaveLength(
    1,
  );
  state = sessionsReducer(state, {
    type: "approvalRemoveByTool",
    acpSessionId: "fixture-acp-a",
    toolCallId: "same-tool",
  });
  expect(state.items.find((s) => s.key === a)?.pendingApprovals).toHaveLength(
    0,
  );
  expect(state.items.find((s) => s.key === b)?.pendingApprovals).toHaveLength(
    1,
  );
});
it("hydrates history idempotently and replaces preview on resume replay", () => {
  let state = initialSessionsState();
  const sessions = [
    {
      agent_id: "codex",
      local_id: "fixture-local-uuid",
      agent_session_id: "fixture-history-123456789012",
      cwd: "/fixture/history",
      title: "历史",
      status: "completed",
      updated_at: "2026-01-01T00:00:00Z",
      workspace_id: "fixture-space",
    },
  ];
  state = sessionsReducer(state, { type: "hydrate", sessions });
  state = sessionsReducer(state, { type: "hydrate", sessions });
  expect(state.items).toHaveLength(2);
  const key = state.items[0].key;
  const messages = [
    {
      role: "assistant",
      text: "完整中文历史",
      created_at: "2026-01-01T00:00:00Z",
    },
  ];
  state = sessionsReducer(state, { type: "historyLoaded", key, messages });
  state = sessionsReducer(state, { type: "historyLoaded", key, messages });
  expect(state.items[0].stream.items).toHaveLength(1);
  state = sessionsReducer(state, { type: "begin", key, resume: true });
  expect(state.items[0].stream.items).toHaveLength(0);
  expect(state.items[0].acpSessionId).toBe(sessions[0].agent_session_id);
  expect(state.items[0].draft).toMatchObject({
    agentId: "codex",
    cwd: "/fixture/history",
  });
});
it("opens exact commander history despite colliding remote suffixes and refreshes persisted status", () => {
  let state = initialSessionsState();
  const row = { local_id: "uuid-one", agent_id: "opencode", agent_session_id: "first-123456789012", cwd: "/fixture", title: "一", status: "running", updated_at: "fixture", workspace_id: "default" };
  state = sessionsReducer(state, { type: "hydrate", sessions: [row] });
  const target = { ...row, local_id: "uuid-two", agent_session_id: "second-123456789012", title: "二", status: "completed" };
  state = sessionsReducer(state, { type: "openHistory", session: target });
  expect(state.items.find((item) => item.key === state.activeKey)?.title).toBe("二");
  expect(new Set(state.items.map((item) => item.key)).size).toBe(3);
  state = sessionsReducer(state, { type: "hydrate", sessions: [{ ...row, status: "completed" }] });
  expect(state.items.find((item) => item.acpSessionId === row.agent_session_id)?.historyStatus).toBe("completed");
});
it("syncs exact approval UUIDs after SessionStarted and removes cancelled requests", () => {
  let state = initialSessionsState();
  const key = state.activeKey!;
  const request = pending();
  state = sessionsReducer(state, { type: "approvalSync", pending: [request] });
  expect(state.items[0].pendingApprovals).toHaveLength(0);
  state = sessionsReducer(state, { type: "batch", key, batch: [{ type: "session_started", session_id: request.request.session_id }] });
  state = sessionsReducer(state, { type: "approvalSync", pending: [request, { ...request, id: "second-uuid" }] });
  state = sessionsReducer(state, { type: "approvalSync", pending: [{ ...request, id: "second-uuid" }] });
  expect(state.items[0].pendingApprovals.map((item) => item.id)).toEqual(["second-uuid"]);
  state = sessionsReducer(state, { type: "approvalSync", pending: [] });
  expect(state.items[0].pendingApprovals).toHaveLength(0);
});
