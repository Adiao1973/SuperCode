/**
 * 会话详情视图：绑定单个会话条目，表单草稿与事件流都来自 sessions store。
 * 消息流用 react-virtuoso 虚拟列表（P1-4：200+ 条目滚动流畅）；
 * edit 类工具的 diff 用 @git-diff-view/react 渲染。
 */
import { memo, useCallback, useEffect, useRef, type Dispatch } from "react";
import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import { Virtuoso } from "react-virtuoso";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { cancelRun, runPrompt } from "@/lib/agent";
import type { StreamItem } from "@/lib/stream";
import type { SessionEntry, SessionsAction } from "@/lib/sessions";
import type { DiffPayload } from "@/lib/events";
import type { ToolKind, ToolStatus } from "@/lib/events";
import {
  ChevronDown,
  ChevronRight,
  CircleStop,
  FileText,
  FilePen,
  FolderInput,
  Globe,
  Loader2,
  Play,
  Search,
  SquareTerminal,
  Trash2,
  Wrench,
} from "lucide-react";
import { useState } from "react";
import "@git-diff-view/react/styles/diff-view.css";

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

  const start = useCallback(async () => {
    if (stream.running) {
      return; // ⌘R 防重入：运行中不允许同一会话再起一轮
    }
    const key = session.key;
    dispatch({ type: "begin", key });
    try {
      await runPrompt({
        prompt: draft.prompt,
        cwd: draft.cwd,
        allow: draft.rulesText
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
        deny: [],
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
  }, [session.key, draft, stream.running, dispatch]);

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
          <Input
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
        <p className="text-muted-foreground text-[11px]">
          fail-closed：未匹配预授权规则的权限请求自动拒绝（审批中心 P1-5 接管）
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
            点击「运行」驱动 opencode（ACP）执行任务，事件经 Rust 合帧 → Tauri Channel 到达这里。
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
      {item.diff && <DiffBlock diff={item.diff} />}
    </div>
  );
});

/** edit 类工具的文件修改展示（默认折叠，点开渲染 unified diff） */
const DiffBlock = memo(function DiffBlock({ diff }: { diff: DiffPayload }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-muted-foreground hover:text-foreground flex items-center gap-1 font-mono text-[11px] transition-colors"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <span className="truncate">{diff.path}</span>
        <span className="text-emerald-500">+{diff.new_text.split("\n").length}</span>
        {diff.old_text != null && (
          <span className="text-destructive">-{diff.old_text.split("\n").length}</span>
        )}
      </button>
      {open && (
        <div className="mt-1 overflow-hidden rounded border">
          <DiffView
            data={{
              oldFile: { fileName: diff.path, content: diff.old_text ?? null },
              newFile: { fileName: diff.path, content: diff.new_text },
              hunks: [],
            }}
            diffViewMode={DiffModeEnum.Unified}
            diffViewTheme="dark"
            diffViewFontSize={11}
            diffViewWrap
          />
        </div>
      )}
    </div>
  );
});
