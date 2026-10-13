import { useEffect, useReducer, useState } from "react";
import { AppShell, type NavId } from "@/components/AppShell";
import type { Workspace } from "@/lib/agent";
import { getVersion } from "@tauri-apps/api/app";
import { CommanderView } from "@/components/CommanderView";
import { ApprovalsView } from "@/components/ApprovalsView";
import { KanbanView } from "@/components/KanbanView";
import { SessionsWorkspace } from "@/components/SessionsWorkspace";
import { SettingsView } from "@/components/SettingsView";
import { listHistorySessions } from "@/lib/agent";
import { permissionCenter, type PendingPermission } from "@/lib/permissions";
import { initialSessionsState, sessionsReducer } from "@/lib/sessions";

function App() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    void getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);
  const [nav, setNav] = useState<NavId>("sessions");
  const [sessions, dispatch] = useReducer(sessionsReducer, undefined, () =>
    initialSessionsState(),
  );
  const [pendingPermissions, setPendingPermissions] = useState<PendingPermission[]>([]);
  const pendingCount = pendingPermissions.length;
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  useEffect(
    () => permissionCenter.onPending(setPendingPermissions),
    [],
  );
  const activeSession = sessions.items.find(
    (item) => item.key === sessions.activeKey,
  );
  const workspace = workspaces.find(
    (item) => item.id === activeSession?.workspaceId,
  );

  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");
  const [historyRevision, setHistoryRevision] = useState(0);

  // Refresh persisted sessions on entry, including commander-created sessions.
  useEffect(() => {
    if (nav !== "sessions") return;
    let alive = true; setHistoryLoading(true); setHistoryError("");
    void listHistorySessions()
      .then((sessions) => { if (alive) dispatch({ type: "hydrate", sessions }); })
      .catch((e) => { if (alive) setHistoryError(String(e)); })
      .finally(() => { if (alive) setHistoryLoading(false); });
    return () => { alive = false; };
  }, [nav, historyRevision]);

  // One global collection drives all inline views, even if approval arrives before SessionStarted.
  useEffect(() => { void permissionCenter.setup().catch(() => {}); }, []);
  useEffect(() => {
    dispatch({ type: "approvalSync", pending: pendingPermissions });
  }, [pendingPermissions, sessions.items]);

  // 全局快捷键：⌘N 新建会话、⌘1..8 切换会话（配合详情页 ⌘R 运行 / ⌘. 停止）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.defaultPrevented ||
        e.isComposing ||
        e.keyCode === 229 ||
        (e.target as HTMLElement | null)?.closest?.(
          "[data-session-terminal]",
        ) ||
        document.querySelector("[role=dialog]")
      )
        return;
      if (!(e.metaKey || e.ctrlKey)) {
        return;
      }
      if (e.key.toLowerCase() === "n") {
        e.preventDefault();
        setNav("sessions");
        dispatch({ type: "new" });
        return;
      }
      const digit = Number(e.key);
      if (Number.isInteger(digit) && digit >= 1 && digit <= 8) {
        const target = sessions.items[digit - 1];
        if (target) {
          e.preventDefault();
          setNav("sessions");
          dispatch({ type: "activate", key: target.key });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sessions.items]);

  return (
    <AppShell
      nav={nav}
      onNavigate={setNav}
      pendingCount={pendingCount}
      version={version}
      project={{
        name:
          workspace?.name ??
          (activeSession?.workspaceId === "default" ? "默认空间" : "项目空间"),
        cwd: activeSession?.draft.cwd ?? "",
        agent: activeSession?.draft.agentId ?? "",
      }}
    >
      <div
        hidden={nav !== "commander"}
        inert={nav !== "commander"}
        className={nav === "commander" ? "min-h-0 flex-1" : "hidden"}
      >
        <CommanderView
          active={nav === "commander"}
          currentCwd={activeSession?.draft.cwd ?? workspace?.path ?? ""}
          currentAgent={activeSession?.draft.agentId ?? ""}
          workspaces={workspaces}
          onSettings={() => setNav("settings")}
          onOpenSession={(session) => {
            dispatch({ type: "openHistory", session });
            setNav("sessions");
          }}
        />
      </div>
      <div
        hidden={nav !== "sessions"}
        inert={nav !== "sessions"}
        className={nav === "sessions" ? "flex min-h-0 flex-1" : "hidden"}
      >
        <SessionsWorkspace
          state={sessions}
          dispatch={dispatch}
          visible={nav === "sessions"}
          historyState={{ loading: historyLoading, error: historyError, onRetry: () => setHistoryRevision((value) => value + 1) }}
          onWorkspacesChange={setWorkspaces}
        />
      </div>
      {nav === "approvals" && <ApprovalsView />}
      {nav === "settings" && <SettingsView onWorkspacesChanged={setWorkspaces} />}
      {nav === "kanban" && (
        <KanbanView
          onWorktreeSession={(workspace, task, worktree) => {
            const existing = sessions.items.find(
              (entry) => entry.taskId === task.id,
            );
            setNav("sessions");
            if (existing) dispatch({ type: "activate", key: existing.key });
            else
              dispatch({
                type: "new",
                workspace,
                taskId: task.id,
                cwd: worktree.path,
                prompt: task.title,
              });
          }}
          bindableSessions={sessions.items.map((it) => ({
            key: it.key,
            title: it.title,
            acpSessionId: it.acpSessionId,
          }))}
          onOpenSession={async (agentSessionId) => {
            const rows = (await listHistorySessions()).filter((row) => row.agent_session_id === agentSessionId);
            if (rows.length !== 1) throw new Error("绑定会话不存在或关联不唯一，请刷新历史后重试。");
            dispatch({ type: "openHistory", session: rows[0] });
            setNav("sessions");
          }}
        />
      )}
    </AppShell>
  );
}

export default App;
