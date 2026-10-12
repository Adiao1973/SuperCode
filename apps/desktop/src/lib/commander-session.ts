import type { HistorySession } from "./agent";
import type { RunView } from "./commander";

export function resolveCommanderSession(
  task: RunView["summary"]["tasks"][number],
  cwd: string,
  sessions: HistorySession[],
): HistorySession {
  const matches = sessions.filter((row) => row.local_id === task.session_id);
  const row = matches[0];
  if (!task.session_id || !task.agent_session_id || matches.length !== 1 ||
      !row || row.agent_session_id !== task.agent_session_id ||
      row.agent_id !== task.agent_id || row.cwd !== cwd ||
      sessions.filter((entry) => entry.agent_session_id === row.agent_session_id).length !== 1) {
    throw new Error("会话已删除或关联信息不一致，请刷新计划后重试。");
  }
  return row;
}
