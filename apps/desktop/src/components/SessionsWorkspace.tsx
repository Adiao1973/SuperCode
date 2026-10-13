/**
 * 会话工作区（P1-3 侧栏 + P1-8 工作空间分组，ADR-0007）：
 * 会话按工作空间分节——项目空间（绑定项目根路径）+ 默认空间（不绑项目的聊天/电脑操作）。
 * 项目空间内新建会话 cwd 预填空间路径；删除项目空间仅摘分组，会话移入默认空间。
 */
import { EmptyState, InlineError, LoadingState } from "./FeedbackState";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  filterSessionTitle,
  type SessionEntry,
  type SessionsAction,
  type SessionsState,
} from "@/lib/sessions";
import { WorkspacePanels } from "@/components/WorkspacePanels";
import { createReadingMemory, type ReadingMemory } from "@/lib/reading";
import { RunConsole } from "@/components/RunConsole";
import {
  Check,
  Folder,
  FolderPlus,
  MessageSquarePlus,
  Plus,
  Trash2,
  Search,
  X,
} from "lucide-react";

interface SessionsWorkspaceProps {
  historyState?: { loading: boolean; error: string; onRetry: () => void };
  visible?: boolean;
  onWorkspacesChange?: (workspaces: Workspace[]) => void;
  state: SessionsState;
  dispatch: React.Dispatch<SessionsAction>;
}

const STATUS_TONE: Record<string, string> = {
  running: "bg-emerald-500 animate-pulse",
  done: "bg-muted-foreground/50",
  failed: "bg-destructive",
  idle: "bg-muted-foreground/30",
};

export function SessionsWorkspace({
  state,
  dispatch,
  visible = true,
  onWorkspacesChange,
  historyState,
}: SessionsWorkspaceProps) {
  const active = state.items.find((it) => it.key === state.activeKey) ?? null;
  const [query, setQuery] = useState("");
  const readingCache = useRef(new Map<string, ReadingMemory>());
  useEffect(() => {
    const keys = new Set(state.items.map((entry) => entry.key));
    for (const key of readingCache.current.keys())
      if (!keys.has(key)) readingCache.current.delete(key);
  }, [state.items]);
  const readingFor = (key: string) => {
    let memory = readingCache.current.get(key);
    if (!memory) {
      memory = createReadingMemory();
      readingCache.current.set(key, memory);
    }
    return memory;
  };
  const knownKeys = useRef(new Set(state.items.map((entry) => entry.key)));
  useEffect(() => {
    if (state.activeKey && !knownKeys.current.has(state.activeKey))
      setQuery("");
    knownKeys.current = new Set(state.items.map((entry) => entry.key));
  }, [state.activeKey, state.items]);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [confirmWs, setConfirmWs] = useState<string | null>(null);

  // 工作空间列表（IPC）；创建/删除后刷新
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [workspaceError, setWorkspaceError] = useState("");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [creating, setCreating] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const refreshWorkspaces = useCallback(async () => {
    setWorkspaceLoading(true); setWorkspaceError("");
    try {
      const values = await listWorkspaces();
      setWorkspaces(values);
      onWorkspacesChange?.(values);
    } catch (e) { setWorkspaceError(String(e)); }
    finally { setWorkspaceLoading(false); }
  }, [onWorkspacesChange]);

  useEffect(() => {
    void refreshWorkspaces();
  }, [refreshWorkspaces]);

  // 分组：项目空间按创建先后、默认空间恒最后（与 list_workspaces 序一致）；
  // 未知空间的会话兜底并入默认组（空间列表加载前的短暂窗口）
  const groups = useMemo(() => {
    const list: Workspace[] = workspaces.length
      ? workspaces
      : [
          {
            id: DEFAULT_WORKSPACE,
            name: "默认空间",
            path: null,
            kind: "default",
          },
        ];
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

  const filteredGroups = groups
    .map((group) => ({
      ...group,
      visibleSessions: group.sessions.filter((entry) =>
        filterSessionTitle(entry.title, query),
      ),
    }))
    .filter((group) => !query.trim() || group.visibleSessions.length > 0);
  const matchCount = filteredGroups.reduce(
    (n, group) => n + group.visibleSessions.length,
    0,
  );
  const activeWorkspace = groups.find((group) =>
    group.sessions.some((entry) => entry.key === active?.key),
  )?.workspace;
  const newSession = (workspace?: Workspace) => {
    setQuery("");
    dispatch({ type: "new", workspace });
  };

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
        dispatch({
          type: "reassignWorkspace",
          from: ws.id,
          to: DEFAULT_WORKSPACE,
        });
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
    <WorkspacePanels
      list={
        <aside className="flex h-full min-w-0 flex-col">
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
                onClick={() => newSession()}
                title="新建会话（⌘N，默认空间）"
              >
                <MessageSquarePlus className="size-4" />
              </Button>
            </div>
          </div>

          <div className="relative mx-3 mb-3">
            <Search
              aria-hidden="true"
              className="text-muted-foreground pointer-events-none absolute left-2 top-2 size-3.5"
            />
            <Input
              aria-label="按标题过滤会话"
              placeholder="过滤标题…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !event.nativeEvent.isComposing) {
                  event.stopPropagation();
                  setQuery("");
                }
              }}
              className="h-8 pl-7 pr-7 text-xs"
            />
            {query && (
              <button
                type="button"
                aria-label="清除标题过滤"
                onClick={() => setQuery("")}
                className="text-muted-foreground hover:text-foreground absolute right-1 top-1 rounded p-1 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
          {query.trim() && (
            <p
              role="status"
              className="text-muted-foreground px-3 pb-2 text-[11px]"
            >
              找到 {matchCount} 个会话
            </p>
          )}
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
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-1.5"
                  onClick={() => void createSpace()}
                  title="创建"
                >
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
            {(workspaceLoading || historyState?.loading) && <LoadingState label="正在读取会话与项目…" />}
            {workspaceError && <InlineError title="项目列表读取失败" message={workspaceError} onRetry={() => void refreshWorkspaces()} retrying={workspaceLoading} />}
            {historyState?.error && <InlineError title="历史会话读取失败" message={historyState.error} onRetry={historyState.onRetry} retrying={historyState.loading} />}
            {matchCount === 0 && query.trim() && (
              <EmptyState title="没有匹配的会话" description="试试其他标题，或清除过滤。" />
            )}
            {filteredGroups.map(({ workspace, sessions, visibleSessions }) => (
              <section key={workspace.id} className="mb-2">
                <div className="group/ws flex items-center gap-1.5 px-1.5 py-1">
                  <Folder className="text-muted-foreground size-3 shrink-0" />
                  <span
                    className="min-w-0 flex-1 truncate text-[11px] font-medium"
                    title={workspace.path ?? undefined}
                  >
                    {workspace.name}
                  </span>
                  <span className="text-muted-foreground/60 shrink-0 text-[10px] tabular-nums">
                    {query.trim()
                      ? `${visibleSessions.length}/${sessions.length}`
                      : sessions.length}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-5 w-5 shrink-0 px-0"
                    onClick={() => newSession(workspace)}
                    title={
                      workspace.kind === "project"
                        ? `在「${workspace.name}」中新建会话（cwd 预填空间路径）`
                        : "在默认空间新建会话"
                    }
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
                        "shrink-0 rounded px-0.5 opacity-0 group-hover/ws:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring",
                        confirmWs === workspace.id
                          ? "text-destructive text-[10px] font-medium"
                          : "text-muted-foreground/50 hover:text-destructive",
                      )}
                    >
                      {confirmWs === workspace.id ? (
                        "确认?"
                      ) : (
                        <Trash2 className="size-3" />
                      )}
                    </button>
                  )}
                </div>
                {workspace.path && (
                  <p
                    title={workspace.path}
                    className="text-muted-foreground truncate px-1.5 pb-2 font-mono text-[10px]"
                  >
                    {workspace.path}
                  </p>
                )}
                <div className="flex flex-col gap-0.5">
                  {visibleSessions.map((entry) => (
                    <SessionListItem
                      key={entry.key}
                      entry={entry}
                      active={entry.key === state.activeKey}
                      confirmDelete={confirmKey === entry.key}
                      onActivate={() =>
                        dispatch({ type: "activate", key: entry.key })
                      }
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
                    !workspaceLoading && !historyState?.loading && !historyState?.error && <EmptyState compact title="暂无会话" />
                  )}
                </div>
              </section>
            ))}
          </div>
        </aside>
      }
    >
      {/* 活动会话详情 */}
      <section className="flex h-full min-w-0 flex-col">
        {active && (
          <div
            aria-label="当前会话上下文"
            className="shrink-0 border-b px-4 py-2.5"
          >
            <h2 title={active.title} className="truncate text-sm font-medium">
              {active.title}
            </h2>
            <p className="text-muted-foreground flex min-w-0 items-center gap-2 text-[11px]">
              <span className="max-w-32 truncate" title={activeWorkspace?.name}>
                {activeWorkspace?.name ?? "默认空间"}
              </span>
              <span className="shrink-0">{active.draft.agentId}</span>
              <span
                title={active.draft.cwd}
                className="min-w-0 truncate font-mono"
              >
                {active.draft.cwd}
              </span>
            </p>
            {query.trim() && !filterSessionTitle(active.title, query) && (
              <p className="text-muted-foreground pt-1 text-[11px]">
                当前会话不在筛选结果中{" "}
                <button
                  type="button"
                  className="text-primary underline underline-offset-2"
                  onClick={() => setQuery("")}
                >
                  显示当前会话
                </button>
              </p>
            )}
          </div>
        )}
        {active ? (
          <div className="min-h-0 flex-1">
            <RunConsole
              key={active.key}
              readingMemory={readingFor(active.key)}
              session={active}
              dispatch={dispatch}
              visible={visible}
            />
          </div>
        ) : (
          <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 text-sm">
            <MessageSquarePlus className="size-8 opacity-40" />
            <Button size="sm" variant="outline" onClick={() => newSession()}>
              新建会话
            </Button>
          </div>
        )}
      </section>
    </WorkspacePanels>
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
    <div
      className={cn(
        "group flex items-start rounded-md transition-colors hover:bg-sidebar-accent",
        active && "bg-sidebar-accent",
        confirmDelete && "ring-1 ring-destructive/60",
      )}
    >
      <button
        type="button"
        aria-label={`选择会话 ${entry.title}`}
        aria-current={active ? "true" : undefined}
        onClick={onActivate}
        className="flex min-w-0 flex-1 flex-col gap-1 rounded-md px-2.5 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="flex w-full items-center gap-2">
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              STATUS_TONE[status.tone],
            )}
          />
          <span
            title={entry.title}
            className="truncate text-[13px] font-medium"
          >
            {entry.title}
          </span>
        </span>
        <span className="text-muted-foreground flex w-full items-center gap-2 pl-3.5 text-[10px]">
          <span>{status.label}</span>
          <span className="truncate">{entry.draft.agentId}</span>
          {entry.pendingApprovals.length > 0 && (
            <span className="text-warning shrink-0">
              {entry.pendingApprovals.length} 待审批
            </span>
          )}
        </span>
        <span
          title={entry.draft.cwd}
          className="text-muted-foreground w-full truncate pl-3.5 font-mono text-[10px]"
        >
          {entry.draft.cwd}
        </span>
      </button>
      <button
        type="button"
        disabled={entry.stream.running}
        aria-label={`删除会话 ${entry.title}`}
        title={
          entry.stream.running
            ? "运行中不可删除"
            : confirmDelete
              ? "再点一次确认删除"
              : "删除会话"
        }
        onClick={onDelete}
        className={cn(
          "mr-1 mt-2 shrink-0 rounded p-1 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed",
          confirmDelete
            ? "text-destructive opacity-100 text-[10px]"
            : "text-muted-foreground hover:text-destructive",
        )}
      >
        {confirmDelete ? "确认?" : <Trash2 className="size-3.5" />}
      </button>
    </div>
  );
}
