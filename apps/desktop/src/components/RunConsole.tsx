import { EmptyState, InlineError, LoadingState } from "./FeedbackState";
/**
 * 会话详情视图：绑定单个会话条目，表单草稿与事件流都来自 sessions store。
 * 消息流用 react-virtuoso 虚拟列表（P1-4：200+ 条目滚动流畅）；
 * 工具详情与文件变更由 ToolDetails 按需展示。
 */
import { Dialog } from "radix-ui";
import { MessageMarkdown } from "./MessageMarkdown";
import { ToolDetails } from "./ToolDetails";
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
} from "react";
import {
  MessageTimeline,
  TimelineDisclosure,
  TimelineCopy,
} from "./MessageTimeline";
import { createReadingMemory, type ReadingMemory } from "@/lib/reading";
import { TerminalPanels } from "@/components/WorkspacePanels";
import { useLayoutPreferences } from "@/lib/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { SessionTerminal } from "./TerminalLoader";
import { PendingCard } from "@/components/PendingCard";
import { CopyableBlock } from "@/components/CopyableBlock";
import {
  cancelRun,
  listAgentDefinitions,
  checkNodeEnv,
  type AgentRow,
  type NodeEnvReport,
  listSessionMessages,
  runPrompt,
  setPermissionMode,
} from "@/lib/agent";
import {
  INSTALL_GUIDE,
  JURISDICTION_NOTE,
  LEVEL_LABEL,
  checkOpencodeEnv,
  strictGuideSnippet,
  type OpencodeEnvReport,
} from "@/lib/opencode-env";
import type { StreamItem } from "@/lib/stream";
import type { SessionEntry, SessionsAction } from "@/lib/sessions";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Loader2,
  Play,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";

const STOP_LABELS: Record<string, string> = {
  end_turn: "本轮完成",
  cancelled: "已取消",
  max_tokens: "达到 token 上限",
  max_turn_requests: "达到审批次数上限",
  refusal: "模型拒绝",
};

interface RunConsoleProps {
  visible?: boolean;
  readingMemory?: ReadingMemory;
  session: SessionEntry;
  dispatch: Dispatch<SessionsAction>;
}

export function RunConsole({
  session,
  dispatch,
  visible = true,
  readingMemory,
}: RunConsoleProps) {
  const { draft, stream } = session;
  const { preferences: layout, update: updateLayout } = useLayoutPreferences();
  const localReading = useRef(createReadingMemory());

  const [configOpen, setConfigOpen] = useState(false);
  const configClose = useRef<HTMLButtonElement>(null);
  const composing = useRef(false);
  const compositionEnded = useRef(-Infinity);
  const starting = useRef(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [nodeEnv, setNodeEnv] = useState<NodeEnvReport | null>(null);
  const [nodeError, setNodeError] = useState<string | null>(null);
  const [nodeTick, setNodeTick] = useState(0);
  useEffect(() => {
    let disposed = false;
    listAgentDefinitions()
      .then((rows) => {
        if (!disposed) setAgents(rows);
      })
      .catch((error) => {
        if (!disposed) setAgentsError(String(error));
      });
    return () => {
      disposed = true;
    };
  }, [session.key]);
  useEffect(() => {
    if (draft.agentId !== "claude-code" && draft.agentId !== "codex") return;
    let disposed = false;
    setNodeEnv(null);
    setNodeError(null);
    checkNodeEnv()
      .then((report) => {
        if (!disposed) setNodeEnv(report);
      })
      .catch((error) => {
        if (!disposed) setNodeError(String(error));
      });
    return () => {
      disposed = true;
    };
  }, [draft.agentId, nodeTick]);

  const start = useCallback(async () => {
    if (
      starting.current ||
      stream.running ||
      !draft.prompt.trim() ||
      !draft.cwd.trim()
    ) {
      return; // ⌘R 防重入：运行中不允许同一会话再起一轮
    }
    starting.current = true;
    const key = session.key;
    // P1-6：resumable 会话（历史加载或跑完过一轮）→ session/load 续聊，沿用原上下文
    const resume = session.resumable && session.acpSessionId != null;
    dispatch({ type: "begin", key, resume });
    try {
      await runPrompt({
        agentId: draft.agentId,
        prompt: draft.prompt,
        cwd: draft.cwd,
        allow: draft.rulesText
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
        deny: [],
        mode: draft.mode,
        resumeSessionId: resume ? session.acpSessionId : null,
        // 归属工作空间（P1-8）：落库与侧栏分组一致
        workspaceId: session.workspaceId,
        taskId: session.taskId,
        // 事件按客户端会话键路由；acpSessionId 由 session_started 事件带入 store
        onEvents: (batch) => dispatch({ type: "batch", key, batch }),
      });
    } catch (e) {
      dispatch({ type: "invokeError", key, message: String(e) });
      dispatch({
        type: "batch",
        key,
        batch: [{ type: "driver_error", message: String(e) }],
      });
    } finally {
      starting.current = false;
    }
  }, [
    session.taskId,
    session.key,
    session.resumable,
    session.acpSessionId,
    session.workspaceId,
    draft,
    stream.running,
    dispatch,
  ]);

  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historyRevision, setHistoryRevision] = useState(0);
  // Historical reads never resume or execute an Agent.
  useEffect(() => {
    if (!session.resumable || !session.acpSessionId || session.stream.items.length > 0 || session.stream.running) { setHistoryLoading(false); setHistoryError(""); return; }
    let alive = true; setHistoryLoading(true); setHistoryError("");
    void listSessionMessages(session.acpSessionId).then((messages) => {
      if (alive) dispatch({ type: "historyLoaded", key: session.key, messages });
    }).catch((e) => { if (alive) setHistoryError(String(e)); })
      .finally(() => { if (alive) setHistoryLoading(false); });
    return () => { alive = false; };
  }, [session.resumable, session.acpSessionId, session.key, session.stream.items.length, session.stream.running, historyRevision, dispatch]);

  const stop = useCallback(async () => {
    if (!session.acpSessionId) {
      return;
    }
    try {
      await cancelRun(session.acpSessionId);
    } catch (e) {
      dispatch({ type: "invokeError", key: session.key, message: String(e) });
    }
  }, [session.acpSessionId, session.key, dispatch]);

  // 长时间无事件提示（P1-6 验收发现：模型限流时 opencode 无限重试，
  // 前端只见"运行中"零反馈——45 秒无事件给一句解释；任何活动重置计时）
  const [slowAgent, setSlowAgent] = useState(false);
  useEffect(() => {
    if (!stream.running) {
      setSlowAgent(false);
      return;
    }
    const timer = setTimeout(() => setSlowAgent(true), 45_000);
    return () => clearTimeout(timer);
  }, [stream.running, stream.items]);

  // P1-7 cwd 严格模式联检：防抖 400ms（cwd 是自由文本，逐键 invoke 太吵）；
  // 仅空闲时检测；报告与触发时的 cwd 一起存，避免旧报告错配新目录
  const [envReport, setEnvReport] = useState<OpencodeEnvReport | null>(null);
  const [envCwd, setEnvCwd] = useState<string | null>(null);
  const [envGuideOpen, setEnvGuideOpen] = useState(false);
  const [installGuideOpen, setInstallGuideOpen] = useState(false);
  const [envTick, setEnvTick] = useState(0);
  useEffect(() => {
    const cwd = draft.cwd.trim();
    if (draft.agentId !== "opencode" || stream.running || !cwd) {
      setEnvReport(null);
      setEnvCwd(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      checkOpencodeEnv(cwd)
        .then((report) => {
          if (!cancelled) {
            setEnvReport(report);
            setEnvCwd(cwd);
          }
        })
        .catch(() => {
          /* 探测失败不打扰会话流程；设置页有完整环境面板 */
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [draft.agentId, draft.cwd, stream.running, envTick]);
  const envFresh =
    draft.agentId === "opencode" &&
    envReport != null &&
    envCwd != null &&
    envCwd === draft.cwd.trim();

  // Cmd/Ctrl+R 运行、Cmd/Ctrl+. 停止：焦点免疫（仅作用于当前活动会话）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        !visible ||
        e.defaultPrevented ||
        composing.current ||
        performance.now() - compositionEnded.current < 50 ||
        e.isComposing ||
        e.keyCode === 229 ||
        document.querySelector("[role=dialog]")
      )
        return;
      if (
        (e.target as HTMLElement | null)?.closest?.("[data-session-terminal]")
      )
        return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "r") {
        e.preventDefault();
        void start();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ".") {
        e.preventDefault();
        void stop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [start, stop, visible]);

  return (
    <Dialog.Root open={configOpen} onOpenChange={setConfigOpen}>
      <div className="flex h-full min-h-0 flex-col">
        <TerminalPanels
          open={terminalOpen}
          terminal={
            terminalOpen ? (
              <SessionTerminal
                key={draft.cwd}
                cwd={draft.cwd}
                onClose={() => setTerminalOpen(false)}
              />
            ) : null
          }
        >
          {/* 事件流时间线：虚拟列表（合帧批 → 单次 dispatch → 仅活动 chunk 重渲染） */}
          <div className="min-h-0 flex-1">
            {historyLoading && <div className="px-5"><LoadingState label="正在读取历史消息…" /></div>}
            {historyError && <div className="px-5"><InlineError title="历史消息读取失败" message={historyError} onRetry={() => setHistoryRevision((value) => value + 1)} retrying={historyLoading || stream.running} /></div>}
            {stream.items.length === 0 ? (
              <div className="px-5">{historyLoading || historyError ? null : stream.running ? <LoadingState label="正在恢复上下文 / 等待 agent 响应…" /> : <EmptyState title={session.resumable ? "继续此会话" : "开始一个任务"} description={session.resumable ? "输入任务，继续对话。" : "输入任务开始。"} />}</div>
            ) : (
              <MessageTimeline
                items={stream.items}
                memory={readingMemory ?? localReading.current}
                visible={visible}
                renderItem={renderStreamItem}
              />
            )}
          </div>

          {/* 内联待决审批（P1-5，ZCode 式：在会话流内直接应答） */}
          {session.pendingApprovals.length > 0 && (
            <div className="shrink-0 space-y-2 border-t border-amber-500/30 bg-amber-500/5 px-5 py-3">
              {session.pendingApprovals.map((pending) => (
                <PendingCard key={pending.id} pending={pending} />
              ))}
            </div>
          )}

          {slowAgent && stream.running && (
            <p className="text-muted-foreground/80 shrink-0 border-t px-5 pt-2 text-center text-[11px]">
              agent 已超过 45
              秒无响应——可能是模型限流或网络问题，可点「停止」中止后稍后再试
            </p>
          )}
        </TerminalPanels>

        <div
          aria-label="会话输入区"
          className="shrink-0 border-t bg-background px-4 py-3"
        >
          <Textarea
            aria-label="任务提示词"
            aria-describedby="composer-key-hint"
            value={draft.prompt}
            onChange={(event) =>
              dispatch({
                type: "patchDraft",
                key: session.key,
                patch: { prompt: event.target.value },
              })
            }
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
              compositionEnded.current = performance.now();
            }}
            onKeyDown={(event) => {
              if (
                event.key !== "Enter" ||
                event.shiftKey ||
                event.altKey ||
                event.metaKey ||
                event.ctrlKey
              )
                return;
              if (
                composing.current ||
                event.nativeEvent.isComposing ||
                event.keyCode === 229 ||
                performance.now() - compositionEnded.current < 50
              )
                return;
              event.preventDefault();
              void start();
            }}
            rows={3}
            placeholder="任务提示词"
            className="max-h-40 min-h-16 resize-y font-mono text-[13px]"
            autoFocus={stream.items.length === 0 && !stream.running}
          />
          <div className="mt-2 flex min-w-0 items-center gap-2">
            <Dialog.Trigger asChild>
              <Button
                aria-label="配置会话"
                variant="ghost"
                size="sm"
                className="h-auto min-w-0 flex-1 justify-start px-1 py-1.5 text-left"
              >
                <SlidersHorizontal className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs">
                    {agents.find((agent) => agent.id === draft.agentId)
                      ?.display_name ?? draft.agentId}{" "}
                    ·{" "}
                    {{
                      plan: "计划",
                      ask: "确认",
                      autoedit: "自动编辑",
                      full: "完全访问",
                    }[draft.mode] ?? draft.mode}{" "}
                    ·{" "}
                    {
                      draft.rulesText.split("\n").filter((line) => line.trim())
                        .length
                    }{" "}
                    条规则
                  </span>
                  <span
                    title={draft.cwd}
                    className="text-muted-foreground block truncate font-mono text-[10px]"
                  >
                    {draft.cwd || "请选择工作目录"}
                  </span>
                </span>
              </Button>
            </Dialog.Trigger>
            {stream.running ? (
              <Button
                size="sm"
                variant="destructive"
                onClick={stop}
                disabled={!session.acpSessionId}
                title={session.acpSessionId ? undefined : "会话建立中…"}
              >
                <CircleStop className="size-4" />
                停止
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={start}
                disabled={!draft.prompt.trim() || !draft.cwd.trim()}
              >
                <Play className="size-4" />
                运行
              </Button>
            )}
          </div>
          <p
            id="composer-key-hint"
            className="text-muted-foreground mt-1 text-[10px]"
          >
            Enter 运行 · Shift-Enter 换行
          </p>
          {envFresh &&
            envReport &&
            (!envReport.installed || !envReport.strict) && (
              <button
                type="button"
                className="text-warning mt-1 text-left text-[11px]"
                onClick={() => setConfigOpen(true)}
              >
                {envReport.installed
                  ? "宽松权限：部分操作不会进入审批 · 查看配置"
                  : "未检测到 opencode · 查看配置"}
              </button>
            )}
          {session.invokeError && (
            <p
              role="alert"
              className="text-destructive mt-1 max-h-12 overflow-auto text-xs"
            >
              {session.invokeError}
            </p>
          )}
        </div>

        {/* 状态条 */}
        <div className="text-muted-foreground flex h-8 shrink-0 items-center gap-3 border-t px-5 text-[11px]">
          <button
            type="button"
            className="hover:text-primary"
            disabled={!draft.cwd.trim()}
            onClick={() =>
              terminalOpen
                ? updateLayout({
                    terminal_collapsed: !layout.terminal_collapsed,
                  })
                : setTerminalOpen(true)
            }
          >
            {terminalOpen
              ? layout.terminal_collapsed
                ? "展开终端"
                : "收起终端"
              : "打开终端"}
          </button>
          {stream.running ? (
            <>
              <Loader2 className="text-primary size-3 animate-spin" />
              <span>运行中</span>
            </>
          ) : (
            <span>{stream.items.length > 0 ? "已结束" : "空闲"}</span>
          )}
          {stream.usage.used != null && (
            <span>tokens {stream.usage.used.toLocaleString()}</span>
          )}
          {stream.usage.cost != null && (
            <span>${stream.usage.cost.toFixed(4)}</span>
          )}
        </div>
      </div>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          className="bg-background text-foreground fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-3rem)] w-[calc(100vw-3rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border p-5 shadow-lg"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            configClose.current?.focus();
          }}
        >
          <Dialog.Title className="text-lg font-semibold">
            会话配置
          </Dialog.Title>
          <Dialog.Description className="text-muted-foreground mt-1 text-xs">
            修改自动保留在当前草稿。
          </Dialog.Description>
          <div className="mt-4 space-y-2">
            <p className="text-xs font-medium">Agent</p>
            <select
              aria-label="Agent"
              value={draft.agentId}
              disabled={stream.running || session.acpSessionId != null}
              onChange={(e) =>
                dispatch({
                  type: "patchDraft",
                  key: session.key,
                  patch: { agentId: e.target.value },
                })
              }
              className="h-9 max-w-44 rounded-md border px-2 text-xs"
            >
              {!agents.some((agent) => agent.id === draft.agentId) && (
                <option value={draft.agentId}>{draft.agentId}</option>
              )}
              {agents.map((agent) => (
                <option
                  key={agent.id}
                  value={agent.id}
                  disabled={agent.driver_kind !== "acp"}
                >
                  {agent.display_name}
                  {agent.driver_kind !== "acp" ? "（尚未接入）" : ""}
                </option>
              ))}
            </select>
            <p className="text-xs font-medium">工作目录</p>
            <Input
              disabled={
                stream.running ||
                session.acpSessionId != null ||
                session.taskId != null
              }
              value={draft.cwd}
              onChange={(e) =>
                dispatch({
                  type: "patchDraft",
                  key: session.key,
                  patch: { cwd: e.target.value },
                })
              }
              className="w-full font-mono text-xs"
              aria-label="工作目录"
              placeholder="工作目录"
            />
            {(stream.running || session.acpSessionId || session.taskId) && (
              <p className="text-muted-foreground text-xs">
                {session.taskId
                  ? "托管任务目录已锁定。"
                  : "会话建立或运行后，Agent 与目录已锁定。"}
              </p>
            )}
            <p className="text-xs font-medium">权限模式</p>
            {/* 会话级权限模式选择器（ADR-0006）：运行时随 run_prompt 传入，可热切换 */}
            <select
              aria-label="权限模式"
              value={draft.mode}
              onChange={(e) => {
                dispatch({
                  type: "patchDraft",
                  key: session.key,
                  patch: { mode: e.target.value },
                });
                // 热切换仅对运行中的会话有意义；空闲会话只改 draft（下次运行传入 broker）
                if (session.acpSessionId && stream.running) {
                  void setPermissionMode(
                    session.acpSessionId,
                    e.target.value,
                  ).catch((err) =>
                    dispatch({
                      type: "invokeError",
                      key: session.key,
                      message: String(err),
                    }),
                  );
                }
              }}
              className="h-9 shrink-0 rounded-md border px-2 font-mono text-xs"
              title="权限模式：plan 计划(全拒绝) / ask 确认 / autoedit 自动编辑 / full 完全访问"
            >
              <option value="plan">计划</option>
              <option value="ask">确认</option>
              <option value="autoedit">自动编辑</option>
              <option value="full">完全访问</option>
            </select>
            <p className="text-xs font-medium">预授权规则</p>
            <p className="text-muted-foreground text-xs">
              每行一条；运行中修改用于下一轮。权限模式可在运行中切换。
            </p>
            {/* 规则必须多行：单行 Input 会被浏览器剥掉换行符，规则解析全废（P1-2 验收踩坑） */}
            <Textarea
              aria-label="预授权规则"
              value={draft.rulesText}
              onChange={(e) =>
                dispatch({
                  type: "patchDraft",
                  key: session.key,
                  patch: { rulesText: e.target.value },
                })
              }
              rows={2}
              className="min-w-48 flex-1 basis-48 resize-none py-2 font-mono text-xs leading-tight"
              placeholder="预授权规则（每行一条，如 write 或 bash(git *)）"
            />
            {agentsError && (
              <p className="text-xs text-destructive">
                Agent 列表加载失败：{agentsError}
              </p>
            )}
            {(draft.agentId === "claude-code" || draft.agentId === "codex") && (
              <div className="space-y-2 rounded-md border px-3 py-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span>
                    {nodeError
                      ? `依赖探测失败：${nodeError}`
                      : nodeEnv
                        ? `Node ${nodeEnv.node_version ?? "未检测到"} · npx ${nodeEnv.npx_version ?? "未检测到"}`
                        : "正在检测 Node / npx…"}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setNodeTick((tick) => tick + 1)}
                  >
                    重新检测
                  </Button>
                </div>
                {draft.agentId === "claude-code" &&
                  nodeEnv?.node_version &&
                  Number(nodeEnv.node_version.replace(/^v/, "").split(".")[0]) <
                    22 && (
                    <p className="text-destructive">
                      当前 Claude 适配器要求 Node.js ≥22，请升级后重启应用。
                    </p>
                  )}
                <details
                  open={
                    nodeEnv != null &&
                    (!nodeEnv.node_version || !nodeEnv.npx_version)
                  }
                >
                  <summary className="cursor-pointer">
                    {draft.agentId === "codex"
                      ? "Codex 安装与认证指引"
                      : "Claude Code 安装与认证指引"}
                  </summary>
                  <div className="mt-2 space-y-2">
                    <p>
                      {draft.agentId === "claude-code"
                        ? "缺少 Node/npx 时安装 Node.js 22 或更高版本（macOS 可使用 Homebrew），随后重启应用。"
                        : "缺少 Node/npx 时安装 Node.js（macOS 可使用 Homebrew），随后重启应用。"}
                    </p>
                    <CopyableBlock text="brew install node" />
                    {draft.agentId === "codex" ? (
                      <>
                        <p>
                          检查 Codex ACP 适配器；登录或 API Key 由 Codex 管理。
                        </p>
                        <CopyableBlock text="npx -y @agentclientprotocol/codex-acp --version" />
                        <CopyableBlock text="codex login" />
                        <p>
                          也可在启动 SuperCode 的环境中设置 CODEX_API_KEY 或
                          OPENAI_API_KEY。SuperCode 不保存密钥。
                        </p>
                      </>
                    ) : (
                      <>
                        <p>检查适配器；需要登录时在终端完成认证后重试。</p>
                        <CopyableBlock text="npx -y @agentclientprotocol/claude-agent-acp --version" />
                        <CopyableBlock text="npx -y @agentclientprotocol/claude-agent-acp --cli auth login" />
                        <p>
                          也可使用 Anthropic API Key 按量计费，无需 Pro/Max
                          订阅。在启动 SuperCode 的环境中配置
                          ANTHROPIC_API_KEY；网关还需按供应商说明配置
                          ANTHROPIC_BASE_URL 与凭证。SuperCode 不保存密钥。
                        </p>
                      </>
                    )}
                    <p>
                      从 Finder/Dock
                      启动不会继承终端临时变量；请从配置好环境的终端启动应用，或使用
                      agent 自身支持的配置方式。
                    </p>
                  </div>
                </details>
              </div>
            )}
            {draft.agentId === "mimo" && (
              <div className="space-y-2 rounded-md border px-3 py-2 text-xs">
                <details>
                  <summary className="cursor-pointer">
                    MiMo Code 安装与模型指引
                  </summary>
                  <div className="mt-2 space-y-2">
                    <p>
                      安装官方 MiMo Code CLI。SuperCode 可识别 PATH 中的
                      mimo，也可识别官方安装器的 ~/.mimocode/bin/mimo。
                    </p>
                    <CopyableBlock text="npm install -g @mimo-ai/cli" />
                    <CopyableBlock text="mimo --version" />
                    <p>
                      模型与供应商由 MiMo 自己管理。现有配置可先用 mimo run
                      验证；若 ACP 默认选择了不可用模型，可在工作目录的
                      .mimocode/mimocode.jsonc 中设置 model。MiMo Auto
                      的可用性以 MiMo 当前服务状态为准；SuperCode
                      不读取或保存凭证。
                    </p>
                    <CopyableBlock text="mimo providers login" />
                    <CopyableBlock text='{"model":"<provider>/<model>"}' />
                  </div>
                </details>
              </div>
            )}

            {/* P1-7 opencode 环境联检：未安装 → 红色引导；宽松 → 琥珀警告 + 可复制收紧片段 */}
            {!stream.running &&
              envFresh &&
              envReport &&
              !envReport.installed && (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2">
                  <div className="flex items-center gap-2 text-[11px] text-destructive">
                    <AlertTriangle className="size-3 shrink-0" />
                    <span className="min-w-0 flex-1">
                      未检测到 opencode——请先安装后再运行
                      {envReport.probe_error
                        ? `（${envReport.probe_error}）`
                        : ""}
                    </span>
                    <button
                      type="button"
                      onClick={() => setInstallGuideOpen((v) => !v)}
                      className="hover:text-foreground flex shrink-0 items-center gap-1 font-medium"
                    >
                      {installGuideOpen ? "收起" : "安装指引"}
                      {installGuideOpen ? (
                        <ChevronDown className="size-3" />
                      ) : (
                        <ChevronRight className="size-3" />
                      )}
                    </button>
                  </div>
                  {installGuideOpen && (
                    <div className="mt-2">
                      <CopyableBlock text={INSTALL_GUIDE} />
                    </div>
                  )}
                </div>
              )}
            {!stream.running &&
              envFresh &&
              envReport?.installed &&
              !envReport.strict && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2">
                  <div className="flex items-center gap-2 text-[11px] text-warning">
                    <AlertTriangle className="size-3 shrink-0" />
                    <span className="min-w-0 flex-1">
                      宽松模式（
                      {envReport.project_config_path
                        ? `项目配置 ${envReport.project_config_path}`
                        : envReport.global_config_path
                          ? `全局配置 ${envReport.global_config_path}`
                          : "无 opencode.jsonc"}
                      ：edit {LEVEL_LABEL[envReport.project_edit].text} · bash{" "}
                      {LEVEL_LABEL[envReport.project_bash].text}
                      ）——这些操作不会进 SuperCode 审批
                    </span>
                    <button
                      type="button"
                      onClick={() => setEnvGuideOpen((v) => !v)}
                      className="hover:text-foreground flex shrink-0 items-center gap-1 font-medium"
                    >
                      {envGuideOpen ? "收起" : "收紧引导"}
                      {envGuideOpen ? (
                        <ChevronDown className="size-3" />
                      ) : (
                        <ChevronRight className="size-3" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEnvTick((t) => t + 1)}
                      className="hover:text-foreground flex shrink-0 items-center gap-1 font-medium"
                      title="按当前 cwd 重新检测"
                    >
                      <RefreshCw className="size-3" />
                      重新检测
                    </button>
                  </div>
                  {envGuideOpen && (
                    <div className="mt-2 space-y-2">
                      <CopyableBlock
                        text={strictGuideSnippet(envCwd)}
                        label="写入以下位置后点「重新检测」（项目级优先于全局）"
                      />
                      <p className="text-muted-foreground text-[11px] leading-relaxed">
                        {JURISDICTION_NOTE}
                      </p>
                    </div>
                  )}
                </div>
              )}
            {!stream.running && envFresh && envReport?.strict && (
              <p className="text-[11px] text-success">
                ✓ 严格模式已开启（
                {envReport.project_config_path ?? envReport.global_config_path}
                ）—— bash/edit 全部经 SuperCode 审批
              </p>
            )}

            <p className="text-muted-foreground text-[11px]">
              Agent 发起的权限请求按当前模式与规则处理；需确认时在会话内审批。
              {session.acpSessionId && (
                <>
                  {" · 会话 "}
                  {/* opencode 会话 id 前缀是时间桶（多位相同），只展示尾部才有区分度 */}
                  <code className="text-foreground/70">
                    …{session.acpSessionId.slice(-6)}
                  </code>
                </>
              )}
              {session.invokeError && (
                <span className="text-destructive">
                  {" "}
                  · {session.invokeError}
                </span>
              )}
            </p>
          </div>
          <div className="mt-5 flex justify-end">
            <Dialog.Close asChild>
              <Button ref={configClose} variant="outline">
                完成配置
              </Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const renderStreamItem = (item: StreamItem) => <StreamItemView item={item} />;

const StreamItemView = memo(function StreamItemView({
  item,
}: {
  item: StreamItem;
}) {
  switch (item.kind) {
    case "thought":
      return (
        <div className="border-l-2 py-1 pl-3 text-muted-foreground">
          <TimelineDisclosure
            itemKey={item.key}
            summary={
              <span className="min-w-0 truncate text-xs">
                思考 · {item.active ? "生成中" : "完成"} ·{" "}
                {item.text.split("\n", 1)[0].slice(0, 120)}
              </span>
            }
          >
            <p className="whitespace-pre-wrap break-words text-sm italic">
              {item.text}
            </p>
            <TimelineCopy text={item.text} label="复制思考" />
          </TimelineDisclosure>
        </div>
      );
    case "message":
      return <MessageMarkdown text={item.text} active={item.active} />;
    case "user_message":
      return (
        <div className="flex justify-end">
          <p className="bg-primary/10 text-foreground max-w-[85%] rounded-lg px-3 py-1.5 text-sm whitespace-pre-wrap">
            {item.text}
          </p>
        </div>
      );
    case "tool":
      return <ToolDetails item={item} />;
    case "plan":
      return (
        <div className="text-muted-foreground rounded-md border px-3 py-2 text-xs">
          <div className="mb-1 font-medium">计划</div>
          {item.entries.map((entry, i) => (
            <div key={i}>
              [{entry.status}] {entry.content}
            </div>
          ))}
        </div>
      );
    case "turn_end":
      return (
        <div className="flex items-center gap-2 py-1">
          <Separator className="flex-1" />
          <span className="text-muted-foreground text-[11px]">
            {STOP_LABELS[item.stopReason] ?? item.stopReason}
          </span>
          <Separator className="flex-1" />
        </div>
      );
    case "error":
      return (
        <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
          {item.message}
        </div>
      );
  }
});
