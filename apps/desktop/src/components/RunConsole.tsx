/**
 * 会话详情视图：绑定单个会话条目，表单草稿与事件流都来自 sessions store。
 * 消息流用 react-virtuoso 虚拟列表（P1-4：200+ 条目滚动流畅）；
 * edit 类工具的 diff 用 @git-diff-view/react 渲染。
 */
import { memo, useCallback, useEffect, useRef, useState, type Dispatch } from "react";
import { MultiFileDiff } from "@pierre/diffs/react";
import { Virtuoso } from "react-virtuoso";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { PendingCard } from "@/components/PendingCard";
import { CopyableBlock } from "@/components/CopyableBlock";
import {
  cancelRun,
  listAgents,
  checkNodeEnv,
  type AgentRow,
  type NodeEnvReport,
  listSessionMessages,
  readTextFile,
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
import type { DiffPayload } from "@/lib/events";
import type { ToolKind, ToolStatus } from "@/lib/events";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CircleStop,
  FileText,
  FilePen,
  FolderInput,
  Globe,
  Loader2,
  Play,
  RefreshCw,
  Search,
  SquareTerminal,
  Trash2,
  Wrench,
} from "lucide-react";

const TOOL_ICONS: Record<ToolKind, typeof Wrench> = {
  read: FileText,
  edit: FilePen,
  delete: Trash2,
  move: FolderInput,
  search: Search,
  execute: SquareTerminal,
  fetch: Globe,
  other: Wrench,
};

const TOOL_STATUS: Record<ToolStatus, { label: string; className: string }> = {
  pending: { label: "等待", className: "" },
  in_progress: { label: "运行中", className: "animate-pulse" },
  completed: { label: "完成", className: "" },
  failed: { label: "失败", className: "border-destructive/50 text-destructive" },
};

const STOP_LABELS: Record<string, string> = {
  end_turn: "本轮完成",
  cancelled: "已取消",
  max_tokens: "达到 token 上限",
  max_turn_requests: "达到审批次数上限",
  refusal: "模型拒绝",
};

interface RunConsoleProps {
  session: SessionEntry;
  dispatch: Dispatch<SessionsAction>;
}

export function RunConsole({ session, dispatch }: RunConsoleProps) {
  const { draft, stream } = session;
  const scrollRef = useRef<HTMLDivElement>(null);

  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [nodeEnv, setNodeEnv] = useState<NodeEnvReport | null>(null);
  const [nodeError, setNodeError] = useState<string | null>(null);
  const [nodeTick, setNodeTick] = useState(0);
  useEffect(() => {
    let disposed = false;
    listAgents().then((rows) => { if (!disposed) setAgents(rows); })
      .catch((error) => { if (!disposed) setAgentsError(String(error)); });
    return () => { disposed = true; };
  }, [session.key]);
  useEffect(() => {
    if (draft.agentId !== "claude-code") return;
    let disposed = false;
    setNodeEnv(null);
    setNodeError(null);
    checkNodeEnv().then((report) => { if (!disposed) setNodeEnv(report); })
      .catch((error) => { if (!disposed) setNodeError(String(error)); });
    return () => { disposed = true; };
  }, [draft.agentId, nodeTick]);

  const start = useCallback(async () => {
    if (stream.running || !draft.prompt.trim() || !draft.cwd.trim()) {
      return; // ⌘R 防重入：运行中不允许同一会话再起一轮
    }
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
    }
  }, [session.key, session.resumable, session.acpSessionId, session.workspaceId, draft, stream.running, dispatch]);

  // P1-6：历史会话首次进入时加载落库消息
  useEffect(() => {
    if (
      session.resumable &&
      session.acpSessionId &&
      session.stream.items.length === 0 &&
      !session.stream.running
    ) {
      void listSessionMessages(session.acpSessionId)
        .then((messages) =>
          dispatch({ type: "historyLoaded", key: session.key, messages }),
        )
        .catch((e) =>
          dispatch({ type: "invokeError", key: session.key, message: String(e) }),
        );
    }
  }, [
    session.resumable,
    session.acpSessionId,
    session.stream.items.length,
    session.stream.running,
    session.key,
    dispatch,
  ]);

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
  const envFresh = draft.agentId === "opencode" && envReport != null && envCwd != null && envCwd === draft.cwd.trim();

  // Cmd/Ctrl+R 运行、Cmd/Ctrl+. 停止：焦点免疫（仅作用于当前活动会话）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
  }, [start, stop]);

  return (
    <div className="flex h-full flex-col">
      {/* 运行控制 */}
      <div className="shrink-0 space-y-2.5 border-b px-5 py-3">
        <Textarea
          value={draft.prompt}
          onChange={(e) =>
            dispatch({
              type: "patchDraft",
              key: session.key,
              patch: { prompt: e.target.value },
            })
          }
          rows={2}
          placeholder="任务提示词"
          className="resize-none font-mono text-[13px]"
          autoFocus={stream.items.length === 0 && !stream.running}
        />
        <div className="flex gap-2">
          <select
            aria-label="Agent"
            value={draft.agentId}
            disabled={stream.running || session.acpSessionId != null}
            onChange={(e) => dispatch({ type: "patchDraft", key: session.key, patch: { agentId: e.target.value } })}
            className="h-9 max-w-44 rounded-md border px-2 text-xs"
          >
            {!agents.some((agent) => agent.id === draft.agentId) && (
              <option value={draft.agentId}>{draft.agentId}</option>
            )}
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id} disabled={agent.driver_kind !== "acp"}>
                {agent.display_name}{agent.driver_kind !== "acp" ? "（尚未接入）" : ""}
              </option>
            ))}
          </select>
          <Input
            disabled={stream.running || session.acpSessionId != null}
            value={draft.cwd}
            onChange={(e) =>
              dispatch({
                type: "patchDraft",
                key: session.key,
                patch: { cwd: e.target.value },
              })
            }
            className="w-64 font-mono text-xs"
            placeholder="工作目录"
          />
          {/* 会话级权限模式选择器（ADR-0006）：运行时随 run_prompt 传入，可热切换 */}
          <select
            value={draft.mode}
            onChange={(e) => {
              dispatch({
                type: "patchDraft",
                key: session.key,
                patch: { mode: e.target.value },
              });
              // 热切换仅对运行中的会话有意义；空闲会话只改 draft（下次运行传入 broker）
              if (session.acpSessionId && stream.running) {
                void setPermissionMode(session.acpSessionId, e.target.value).catch((err) =>
                  dispatch({ type: "invokeError", key: session.key, message: String(err) }),
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
          {/* 规则必须多行：单行 Input 会被浏览器剥掉换行符，规则解析全废（P1-2 验收踩坑） */}
          <Textarea
            value={draft.rulesText}
            onChange={(e) =>
              dispatch({
                type: "patchDraft",
                key: session.key,
                patch: { rulesText: e.target.value },
              })
            }
            rows={2}
            className="min-w-0 flex-1 resize-none py-2 font-mono text-xs leading-tight"
            placeholder="预授权规则（每行一条，如 write 或 bash(git *)）"
          />
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

        {agentsError && <p className="text-xs text-destructive">Agent 列表加载失败：{agentsError}</p>}
        {draft.agentId === "claude-code" && (
          <div className="space-y-2 rounded-md border px-3 py-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span>{nodeError ? `依赖探测失败：${nodeError}` : nodeEnv
                ? `Node ${nodeEnv.node_version ?? "未检测到"} · npx ${nodeEnv.npx_version ?? "未检测到"}`
                : "正在检测 Node / npx…"}</span>
              <Button variant="ghost" size="sm" onClick={() => setNodeTick((tick) => tick + 1)}>重新检测</Button>
            </div>
            {nodeEnv?.node_version && Number(nodeEnv.node_version.replace(/^v/, "").split(".")[0]) < 22 && (
              <p className="text-destructive">当前适配器要求 Node.js ≥22，请升级后重启应用。</p>
            )}
            <details open={nodeEnv != null && (!nodeEnv.node_version || !nodeEnv.npx_version)}>
              <summary className="cursor-pointer">Claude Code 安装与认证指引</summary>
              <div className="mt-2 space-y-2">
                <p>缺少 Node/npx 时安装 Node.js 22 或更高版本（macOS 可使用 Homebrew），随后重启应用。</p>
                <CopyableBlock text="brew install node" />
                <p>检查适配器；需要登录时在终端完成认证后重试。</p>
                <CopyableBlock text="npx -y @agentclientprotocol/claude-agent-acp --version" />
                <CopyableBlock text="npx -y @agentclientprotocol/claude-agent-acp --cli auth login" />
                <p>也可使用 Anthropic API Key 按量计费，无需 Pro/Max 订阅。在启动 SuperCode 的环境中配置 ANTHROPIC_API_KEY；网关还需按供应商说明配置 ANTHROPIC_BASE_URL 与凭证。SuperCode 不保存密钥。</p>
                <p>从 Finder/Dock 启动不会继承终端临时变量；请从配置好环境的终端启动应用，或使用 Claude 自身支持的配置方式。</p>
              </div>
            </details>
          </div>
        )}

        {/* P1-7 opencode 环境联检：未安装 → 红色引导；宽松 → 琥珀警告 + 可复制收紧片段 */}
        {!stream.running && envFresh && envReport && !envReport.installed && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2">
            <div className="flex items-center gap-2 text-[11px] text-destructive">
              <AlertTriangle className="size-3 shrink-0" />
              <span className="min-w-0 flex-1">
                未检测到 opencode——请先安装后再运行
                {envReport.probe_error ? `（${envReport.probe_error}）` : ""}
              </span>
              <button
                type="button"
                onClick={() => setInstallGuideOpen((v) => !v)}
                className="hover:text-foreground flex shrink-0 items-center gap-1 font-medium"
              >
                {installGuideOpen ? "收起" : "安装指引"}
                {installGuideOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              </button>
            </div>
            {installGuideOpen && (
              <div className="mt-2">
                <CopyableBlock text={INSTALL_GUIDE} />
              </div>
            )}
          </div>
        )}
        {!stream.running && envFresh && envReport?.installed && !envReport.strict && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2">
            <div className="flex items-center gap-2 text-[11px] text-amber-600 dark:text-amber-500">
              <AlertTriangle className="size-3 shrink-0" />
              <span className="min-w-0 flex-1">
                宽松模式（
                {envReport.project_config_path
                  ? `项目配置 ${envReport.project_config_path}`
                  : envReport.global_config_path
                    ? `全局配置 ${envReport.global_config_path}`
                    : "无 opencode.jsonc"}
                ：edit {LEVEL_LABEL[envReport.project_edit].text} · bash {LEVEL_LABEL[envReport.project_bash].text}
                ）——这些操作不会进 SuperCode 审批
              </span>
              <button
                type="button"
                onClick={() => setEnvGuideOpen((v) => !v)}
                className="hover:text-foreground flex shrink-0 items-center gap-1 font-medium"
              >
                {envGuideOpen ? "收起" : "收紧引导"}
                {envGuideOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
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
                <p className="text-muted-foreground text-[11px] leading-relaxed">{JURISDICTION_NOTE}</p>
              </div>
            )}
          </div>
        )}
        {!stream.running && envFresh && envReport?.strict && (
          <p className="text-[11px] text-emerald-600 dark:text-emerald-500">
            ✓ 严格模式已开启（{envReport.project_config_path ?? envReport.global_config_path}）——
            bash/edit 全部经 SuperCode 审批
          </p>
        )}

        <p className="text-muted-foreground text-[11px]">
          Agent 发起的权限请求按当前模式与规则处理；需确认时在会话内审批。
          {session.acpSessionId && (
            <>
              {" · 会话 "}
              {/* opencode 会话 id 前缀是时间桶（多位相同），只展示尾部才有区分度 */}
              <code className="text-foreground/70">…{session.acpSessionId.slice(-6)}</code>
            </>
          )}
          {session.invokeError && (
            <span className="text-destructive"> · {session.invokeError}</span>
          )}
        </p>
      </div>

      {/* 事件流时间线：虚拟列表（合帧批 → 单次 dispatch → 仅活动 chunk 重渲染） */}
      <div ref={scrollRef} className="min-h-0 flex-1">
        {stream.items.length === 0 ? (
          <p className="text-muted-foreground py-8 text-center text-sm">
            {stream.running
              ? "正在恢复上下文 / 等待 agent 响应…"
              : session.resumable
                ? "输入新提示词继续此会话（将恢复上下文），或查看下方历史。"
                : "选择 Agent 并输入任务，点击「运行」开始。"}
          </p>
        ) : (
          <Virtuoso
            style={{ height: "100%" }}
            data={stream.items}
            computeItemKey={(_, item) => item.key}
            followOutput="auto"
            increaseViewportBy={{ top: 600, bottom: 600 }}
            itemContent={(_, item) => (
              <div className="mx-auto max-w-3xl px-5 pb-3">
                <StreamItemView item={item} />
              </div>
            )}
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
          agent 已超过 45 秒无响应——可能是模型限流或网络问题，可点「停止」中止后稍后再试
        </p>
      )}

      {/* 状态条 */}
      <div className="text-muted-foreground flex h-8 shrink-0 items-center gap-3 border-t px-5 text-[11px]">
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
        {stream.usage.cost != null && <span>${stream.usage.cost.toFixed(4)}</span>}
      </div>
    </div>
  );
}

const StreamItemView = memo(function StreamItemView({ item }: { item: StreamItem }) {
  switch (item.kind) {
    case "thought":
      return (
        <p className="text-muted-foreground border-l-2 py-1 pl-3 text-sm whitespace-pre-wrap italic">
          {item.text}
        </p>
      );
    case "message":
      return (
        <p className="text-foreground/90 text-sm leading-relaxed whitespace-pre-wrap">
          {item.text}
          {item.active && <span className="text-primary animate-pulse">▍</span>}
        </p>
      );
    case "user_message":
      return (
        <div className="flex justify-end">
          <p className="bg-primary/10 text-foreground max-w-[85%] rounded-lg px-3 py-1.5 text-sm whitespace-pre-wrap">
            {item.text}
          </p>
        </div>
      );
    case "tool":
      return <ToolView item={item} />;
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

const ToolView = memo(function ToolView({
  item,
}: {
  item: Extract<StreamItem, { kind: "tool" }>;
}) {
  const Icon = TOOL_ICONS[item.toolKind];
  const status = TOOL_STATUS[item.status];
  return (
    <div className="rounded-md border px-3 py-2">
      <div className="flex items-center gap-2">
        <Icon className="text-muted-foreground size-3.5" />
        <span className="text-sm font-medium">{item.title || item.name || "工具调用"}</span>
        {item.name && item.title && (
          <code className="text-muted-foreground text-[11px]">{item.name}</code>
        )}
        <Badge variant="outline" className={`ml-auto text-[10px] ${status.className}`}>
          {status.label}
        </Badge>
      </div>
      {item.locations.length > 0 && (
        <div className="text-muted-foreground mt-1 truncate font-mono text-[11px]">
          {item.locations.map((loc, i) => (
            <span key={i}>
              {loc.path}
              {loc.line != null ? `:${loc.line}` : ""}
              {i < item.locations.length - 1 ? " · " : ""}
            </span>
          ))}
        </div>
      )}
      {item.content.length > 0 && (
        <pre className="text-muted-foreground mt-1 max-h-40 overflow-y-auto font-mono text-[11px] whitespace-pre-wrap break-all">
          {item.content.join("\n")}
        </pre>
      )}
      <DiffBlock diff={item.diff} lazyPath={writeLazyPath(item)} />
    </div>
  );
});

/** write 类工具（无结构化 diff）的磁盘懒读路径：opencode 的 ACP 事件不含新文件内容 */
function writeLazyPath(item: Extract<StreamItem, { kind: "tool" }>): string | null {
  if (item.diff || item.locations.length === 0) {
    return null;
  }
  const label = `${item.name ?? ""} ${item.title ?? ""}`.toLowerCase();
  return /write|create|save/.test(label) ? item.locations[0].path : null;
}

/**
 * 工具 diff 展示（默认折叠，展开渲染 @pierre/diffs——ZCode 同款渲染方案）。
 * 数据来源分两种：结构化 diff（opencode edit 完成事件携带）；
 * write（新建文件）ACP 事件不含内容，展开时从磁盘读（read_text_file）。
 */
const DiffBlock = memo(function DiffBlock({
  diff,
  lazyPath,
}: {
  diff: DiffPayload | null;
  lazyPath?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [lazyDiff, setLazyDiff] = useState<DiffPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const payload = diff ?? lazyDiff;

  useEffect(() => {
    if (!open || diff || !lazyPath || lazyDiff || loadError) {
      return;
    }
    let cancelled = false;
    void readTextFile(lazyPath)
      .then((content) => {
        if (!cancelled) {
          setLazyDiff({ path: lazyPath, old_text: null, new_text: content });
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setLoadError(String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, diff, lazyPath, lazyDiff, loadError]);

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-muted-foreground hover:text-foreground flex items-center gap-1 font-mono text-[11px] transition-colors"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <span className="truncate">{(diff ?? { path: lazyPath })?.path}</span>
        {payload ? (
          <>
            <span className="text-emerald-500">
              +{payload.new_text.replace(/\n$/, "").split("\n").length}
            </span>
            {payload.old_text != null && (
              <span className="text-destructive">
                -{payload.old_text.replace(/\n$/, "").split("\n").length}
              </span>
            )}
          </>
        ) : lazyPath ? (
          <span className="text-muted-foreground/60">从磁盘读取…</span>
        ) : null}
      </button>
      {open && payload && (
        <div
          className="mt-1 max-h-72 overflow-auto rounded border"
          style={
            {
              "--diffs-font-family": "var(--font-mono)",
              "--diffs-font-size": "11px",
            } as React.CSSProperties
          }
        >
          <MultiFileDiff
            oldFile={
              payload.old_text == null
                ? null
                : { name: payload.path, contents: payload.old_text }
            }
            newFile={{ name: payload.path, contents: payload.new_text }}
            options={{
              diffStyle: "unified",
              overflow: "scroll",
              disableFileHeader: true,
              hunkSeparators: "simple",
              themeType: "dark",
            }}
          />
        </div>
      )}
      {open && !payload && !lazyPath && (
        <p className="text-muted-foreground mt-1 text-[11px]">无 diff 数据</p>
      )}
      {loadError && (
        <p className="text-destructive mt-1 text-[11px]">{loadError}</p>
      )}
    </div>
  );
});
