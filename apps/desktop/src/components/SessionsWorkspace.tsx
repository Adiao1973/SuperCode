/**
 * 会话工作区（P1-3 侧栏 + P1-8 工作空间分组，ADR-0007）：
 * 会话按工作空间分节——项目空间（绑定项目根路径）+ 默认空间（不绑项目的聊天/电脑操作）。
 * 项目空间内新建会话 cwd 预填空间路径；删除项目空间仅摘分组，会话移入默认空间。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  createWorkspace,
  deleteSession,
  deleteWorkspace,
  listWorkspaces,
  type Workspace,
} from "@/lib/agent";
import { cn } from "@/lib/utils";
import {
  DEFAULT_WORKSPACE,
  sessionStatus,
  type SessionEntry,
  type SessionsAction,
  type SessionsState,
} from "@/lib/sessions";
import { RunConsole } from "@/components/RunConsole";
import {
  Check,
  Folder,
  FolderPlus,
  MessageSquarePlus,
  Plus,
  Trash2,
  X,
} from "lucide-react";

interface SessionsWorkspaceProps {
  state: SessionsState;
  dispatch: React.Dispatch<SessionsAction>;
}

const STATUS_TONE: Record<string, string> = {
  running: "bg-emerald-500 animate-pulse",
  done: "bg-muted-foreground/50",
  failed: "bg-destructive",
  idle: "bg-muted-foreground/30",
};

export function SessionsWorkspace({ state, dispatch }: SessionsWorkspaceProps) {
  const active = state.items.find((it) => it.key === state.activeKey) ?? null;
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [confirmWs, setConfirmWs] = useState<string | null>(null);

  // 工作空间列表（IPC）；创建/删除后刷新
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [creating, setCreating] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const refreshWorkspaces = useCallback(async () => {
    try {
      setWorkspaces(await listWorkspaces());
    } catch {
      /* 空间列表加载失败不阻塞会话：按默认空间单组展示 */
    }
  }, []);

  useEffect(() => {
    void refreshWorkspaces();
  }, [refreshWorkspaces]);

  // 分组：项目空间按创建先后、默认空间恒最后（与 list_workspaces 序一致）；
  // 未知空间的会话兜底并入默认组（空间列表加载前的短暂窗口）
  const groups = useMemo(() => {
    const list: Workspace[] = workspaces.length
      ? workspaces
      : [{ id: DEFAULT_WORKSPACE, name: "默认空间", path: null, kind: "default" }];
    return list.map((workspace) => ({
      workspace,
      sessions: state.items.filter(
        (it) =>
          it.workspaceId === workspace.id ||
          (workspace.id === DEFAULT_WORKSPACE &&
            !list.some((w) => w.id === it.workspaceId)),
      ),
    }));
  }, [workspaces, state.items]);

  const createSpace = useCallback(async () => {
    if (!newPath.trim()) {
      return;
    }
    setCreateError(null);
    try {
      await createWorkspace(newPath.trim());
      setNewPath("");
      setCreating(false);
      await refreshWorkspaces();
    } catch (e) {
      setCreateError(String(e));
    }
  }, [newPath, refreshWorkspaces]);

  // 删除项目空间：Rust 侧把会话迁入默认空间，前端同步改分组（不级联删）
  const removeSpace = useCallback(
    async (ws: Workspace) => {
      setConfirmWs(null);
      try {
        await deleteWorkspace(ws.id);
        dispatch({ type: "reassignWorkspace", from: ws.id, to: DEFAULT_WORKSPACE });
        await refreshWorkspaces();
      } catch (e) {
        setCreateError(String(e));
      }
    },
    [dispatch, refreshWorkspaces],
  );

  // 删除会话：有 acpSessionId 的先调 IPC 级联删除（运行中由 Rust 侧拒绝），再移出列表
  const removeSession = useCallback(
    async (entry: SessionEntry) => {
      if (entry.acpSessionId) {
        try {
          await deleteSession(entry.acpSessionId);
        } catch (e) {
          dispatch({ type: "invokeError", key: entry.key, message: String(e) });
          return;
        }
      }
      if (state.activeKey === entry.key) {
        const rest = state.items.filter((it) => it.key !== entry.key);
        dispatch({
          type: "activate",
          key: rest[0]?.key ?? "",
        });
      }
      dispatch({ type: "remove", key: entry.key });
    },
    [state.activeKey, state.items, dispatch],
  );

  return (
    <div className="flex min-h-0 flex-1">
      {/* 会话列表：按工作空间分节（ADR-0007） */}
      <aside className="flex w-56 shrink-0 flex-col border-r">
        <div className="flex items-center justify-between px-3 py-2.5">
          <span className="text-muted-foreground text-xs font-medium">
            会话（{state.items.length}）
          </span>
          <div className="flex items-center">
            {import.meta.env.DEV && active && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[10px]"
                onClick={() => dispatch({ type: "seed", key: active.key })}
                title="向当前会话注入 320 条合成事件（虚拟列表滚动压测，仅开发模式）"
              >
                压测
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={() => setCreating((v) => !v)}
              title="新建项目空间（绑定一个项目目录）"
            >
              <FolderPlus className="size-4" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={() => dispatch({ type: "new" })}
              title="新建会话（⌘N，默认空间）"
            >
              <MessageSquarePlus className="size-4" />
            </Button>
          </div>
        </div>

        {creating && (
          <div className="space-y-1.5 px-3 pb-2">
            <div className="flex gap-1.5">
              <Input
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void createSpace()}
                placeholder="/path/to/project"
                className="h-7 min-w-0 flex-1 font-mono text-[11px]"
                autoFocus
              />
              <Button size="sm" variant="ghost" className="h-7 px-1.5" onClick={() => void createSpace()} title="创建">
                <Check className="size-3.5" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-1.5"
                onClick={() => {
                  setCreating(false);
                  setNewPath("");
                  setCreateError(null);
                }}
                title="取消"
              >
                <X className="size-3.5" />
              </Button>
            </div>
            <p className="text-muted-foreground text-[10px] leading-snug">
              {createError ? (
                <span className="text-destructive">{createError}</span>
              ) : (
                "项目根目录的绝对路径；同路径去重，目录须已存在"
              )}
            </p>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {groups.map(({ workspace, sessions }) => (
            <section key={workspace.id} className="mb-2">
              <div className="group/ws flex items-center gap-1.5 px-1.5 py-1">
                <Folder className="text-muted-foreground size-3 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-[11px] font-medium" title={workspace.path ?? undefined}>
                  {workspace.name}
                </span>
                <span className="text-muted-foreground/60 shrink-0 text-[10px] tabular-nums">
                  {sessions.length}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 w-5 shrink-0 px-0"
                  onClick={() => dispatch({ type: "new", workspace })}
                  title={workspace.kind === "project" ? `在「${workspace.name}」中新建会话（cwd 预填空间路径）` : "在默认空间新建会话"}
                >
                  <Plus className="size-3" />
                </Button>
                {workspace.kind === "project" && (
                  <button
                    type="button"
                    title={
                      confirmWs === workspace.id
                        ? "再点一次确认：会话将移入默认空间（不会删除）"
                        : "删除该空间（会话移入默认空间，不删除）"
                    }
                    onClick={() => {
                      if (confirmWs === workspace.id) {
                        void removeSpace(workspace);
                      } else {
                        setConfirmWs(workspace.id);
                      }
                    }}
                    className={cn(
                      "hidden shrink-0 px-0.5 group-hover/ws:block",
                      confirmWs === workspace.id
                        ? "text-destructive text-[10px] font-medium"
                        : "text-muted-foreground/50 hover:text-destructive",
                    )}
                  >
                    {confirmWs === workspace.id ? "确认?" : <Trash2 className="size-3" />}
                  </button>
                )}
              </div>
              <div className="flex flex-col gap-1">
                {sessions.map((entry) => (
                  <SessionListItem
                    key={entry.key}
                    entry={entry}
                    active={entry.key === state.activeKey}
                    confirmDelete={confirmKey === entry.key}
                    onActivate={() => dispatch({ type: "activate", key: entry.key })}
                    onDelete={() => {
                      if (confirmKey === entry.key) {
                        setConfirmKey(null);
                        void removeSession(entry);
                      } else {
                        setConfirmKey(entry.key);
                      }
                    }}
                  />
                ))}
                {sessions.length === 0 && (
                  <p className="text-muted-foreground/50 px-2.5 py-1 text-[10px]">暂无会话</p>
                )}
              </div>
            </section>
          ))}
        </div>
      </aside>

      {/* 活动会话详情 */}
      <section className="min-w-0 flex-1">
        {active ? (
          <RunConsole key={active.key} session={active} dispatch={dispatch} />
        ) : (
          <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 text-sm">
            <MessageSquarePlus className="size-8 opacity-40" />
            <Button size="sm" variant="outline" onClick={() => dispatch({ type: "new" })}>
              新建会话
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}

function SessionListItem({
  entry,
  active,
  confirmDelete,
  onActivate,
  onDelete,
}: {
  entry: SessionEntry;
  active: boolean;
  confirmDelete: boolean;
  onActivate: () => void;
  onDelete: () => void;
}) {
  const status = sessionStatus(entry);
  return (
    <button
      type="button"
      onClick={onActivate}
      className={cn(
        "group hover:bg-sidebar-accent flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors",
        active ? "bg-sidebar-accent" : "",
        confirmDelete && "border-destructive/60 border",
      )}
    >
      <span className="flex w-full items-center gap-2">
        <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_TONE[status.tone])} />
        <span className="truncate text-[13px]">{entry.title}</span>
        <span
          role="button"
          tabIndex={-1}
          title={
            entry.stream.running
              ? "运行中不可删除"
              : confirmDelete
                ? "再点一次确认删除"
                : "删除会话"
          }
          onClick={(e) => {
            e.stopPropagation();
            if (!entry.stream.running) {
              onDelete();
            }
          }}
          className={cn(
            "ml-auto hidden shrink-0 px-1 group-hover:block",
            confirmDelete
              ? "text-destructive text-[10px] font-medium"
              : "text-muted-foreground/50 hover:text-destructive",
          )}
        >
          {confirmDelete ? "确认?" : <Trash2 className="size-3.5" />}
        </span>
      </span>
      <span className="text-muted-foreground flex w-full items-center gap-2 pl-3.5 text-[10px]">
        {status.label}
        {entry.pendingApprovals.length > 0 ? (
          <span className="text-amber-400">{entry.pendingApprovals.length} 待审批</span>
        ) : (
          entry.acpSessionId && (
            <code className="truncate">…{entry.acpSessionId.slice(-6)}</code>
          )
        )}
      </span>
    </button>
  );
}
