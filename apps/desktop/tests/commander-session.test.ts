import { expect, it } from "vitest";
import { resolveCommanderSession } from "../src/lib/commander-session";
import type { RunView } from "../src/lib/commander";
import type { HistorySession } from "../src/lib/agent";
it("resolves local UUID to the exact ACP session and rejects stale or ambiguous mappings", () => {
 const task = { session_id: "local-uuid", agent_session_id: "remote-different", agent_id: "opencode" } as RunView["summary"]["tasks"][number];
 const row = { local_id: "local-uuid", agent_session_id: "remote-different", agent_id: "opencode", cwd: "/fixture" } as HistorySession;
 expect(resolveCommanderSession(task, "/fixture", [row])).toBe(row);
 for (const rows of [[], [{ ...row, local_id: "other" }], [{ ...row, cwd: "/other" }], [{ ...row, agent_id: "mimo" }], [{ ...row, agent_session_id: "other" }], [row, { ...row, local_id: "other" }]]) {
   expect(() => resolveCommanderSession(task, "/fixture", rows)).toThrow();
 }
});
