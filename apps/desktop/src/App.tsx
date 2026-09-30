import { useEffect, useReducer, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { ApprovalsView } from "@/components/ApprovalsView";
import { KanbanView } from "@/components/KanbanView";
import { SessionsWorkspace } from "@/components/SessionsWorkspace";
import { SettingsView } from "@/components/SettingsView";
import { listHistorySessions } from "@/lib/agent";
import { permissionCenter } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { initialSessionsState, sessionsReducer } from "@/lib/sessions";
import {
  LayoutGrid,
  MessageSquare,
  Settings,
  ShieldCheck,
  Terminal,
} from "lucide-react";

/** 导航项：id 对应 Phase 1 各视图，hint 标注接入任务号 */
const NAV_ITEMS = [
  { id: "sessions", label: "会话", icon: MessageSquare, hint: "P1-3" },
  { id: "kanban", label: "任务看板", icon: LayoutGrid, hint: "P1-9" },
  { id: "approvals", label: "审批中心", icon: ShieldCheck, hint: "P1-5" },
  { id: "settings", label: "设置", icon: Settings, hint: "P1-5" },
] as const;

type NavId = (typeof NAV_ITEMS)[number]["id"];

function App() {
  const [nav, setNav] = useState<NavId>("sessions");
  const [sessions, dispatch] = useReducer(
    sessionsReducer,
    undefined,
    () => initialSessionsState(),
  );
  const activeNav = NAV_ITEMS.find((item) => item.id === nav) ?? NAV_ITEMS[0];

  // P1-6：启动时注入 SQLite 历史会话（重启后仍可续聊）
  useEffect(() => {
    void listHistorySessions()
      .then((sessions) => dispatch({ type: "hydrate", sessions }))
      .catch(() => {}); // 历史加载失败不阻塞新会话
  }, []);

  // 审批事件订阅（应用级一次）：待决请求按 ACP session id 路由进对应会话（内联卡片）
  useEffect(() => {
    void permissionCenter.setup();
    const offAdd = permissionCenter.onPendingAdded((pending) =>
      dispatch({
        type: "approvalAdd",
        acpSessionId: pending.request.session_id,
        pending,
      }),
    );
    const offArrived = permissionCenter.onDecisionArrived((record) =>
      dispatch({
        type: "approvalRemoveByTool",
        acpSessionId: record.request.session_id,
        toolCallId: record.request.tool_call_id,
      }),
    );
    return () => {
      offAdd();
      offArrived();
    };
  }, []);

  // 全局快捷键：⌘N 新建会话、⌘1..8 切换会话（配合详情页 ⌘R 运行 / ⌘. 停止）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
    <div className="bg-background text-foreground flex h-dvh">
      {/* 侧栏：品牌 + 模块导航 + agent 状态（多 agent 注册表为 Phase 2） */}
      <aside className="bg-sidebar flex w-56 shrink-0 flex-col border-r">
        <div className="flex items-center gap-2 px-4 py-4">
          <Terminal className="text-primary size-5" />
          <span className="font-heading text-base font-semibold tracking-tight">
            SuperCode
          </span>
          <Badge variant="secondary" className="ml-auto text-[10px]">
            v0.2 dev
          </Badge>
        </div>
        <div className="border-t" />
        <nav className="flex flex-col gap-1 p-2">
          {NAV_ITEMS.map(({ id, label, icon: Icon, hint }) => (
            <button
              key={id}
              type="button"
              onClick={() => setNav(id)}
              className={cn(
                "hover:bg-sidebar-accent flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                nav === id
                  ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                  : "text-sidebar-foreground/80",
              )}
            >
              <Icon className="size-4" />
              {label}
              <Badge variant="outline" className="ml-auto text-[10px] tabular-nums">
                {hint}
              </Badge>
            </button>
          ))}
        </nav>
        <div className="mt-auto p-4">
          <div className="border-t py-3" />
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="size-2 rounded-full bg-emerald-500" />
            ACP Agents · 在会话中选择（管理与环境见设置）
          </div>
        </div>
      </aside>

      {/* 主区 */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-13 shrink-0 items-center gap-3 border-b px-5">
          <h1 className="text-sm font-semibold">{activeNav.label}</h1>
          <Badge variant="outline" className="text-[10px]">
            {nav === "sessions"
              ? `多会话 · ${activeNav.hint}`
              : nav === "kanban"
                ? `按空间组织 · ${activeNav.hint}`
                : activeNav.hint}
          </Badge>
        </header>
        {nav === "sessions" && <SessionsWorkspace state={sessions} dispatch={dispatch} />}
        {nav === "approvals" && <ApprovalsView />}
        {nav === "settings" && <SettingsView />}
        {nav === "kanban" && (
          <KanbanView
            onWorktreeSession={(workspace, task, worktree) => {
              const existing = sessions.items.find((entry) => entry.taskId === task.id);
              setNav("sessions");
              if (existing) dispatch({ type: "activate", key: existing.key });
              else dispatch({ type: "new", workspace, taskId: task.id, cwd: worktree.path, prompt: task.title });
            }}
            bindableSessions={sessions.items.map((it) => ({
              key: it.key,
              title: it.title,
              acpSessionId: it.acpSessionId,
            }))}
            onOpenSession={(agentSessionId) => {
              const target = sessions.items.find((it) => it.acpSessionId === agentSessionId);
              if (target) {
                setNav("sessions");
                dispatch({ type: "activate", key: target.key });
              }
            }}
          />
        )}
      </main>
    </div>
  );
}

export default App;
