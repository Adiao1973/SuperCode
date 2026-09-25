/**
 * P1-2 事件管道验收控制台：驱动真实 opencode 会话，流式渲染 AgentEvent 批。
 * P1-3/P1-4 将演进为多会话管理 + 完整会话视图（虚拟列表/diff），此处刻意保持最小。
 */

import {
  memo,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { cancelRun, runPrompt } from "@/lib/agent";
import type { StreamItem } from "@/lib/stream";
import { initialStream, streamReducer } from "@/lib/stream";
import type { ToolKind, ToolStatus } from "@/lib/events";
import {
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

const DEFAULT_PROMPT = "在当前目录创建 hello.txt 内容为 hi，然后读出来";
const DEFAULT_CWD = "/tmp/supercode-p12";
const DEFAULT_ALLOW = "read\nwrite\nedit\nbash(ls *)";

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

export function RunConsole() {
  const [state, dispatch] = useReducer(streamReducer, initialStream);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [cwd, setCwd] = useState(DEFAULT_CWD);
  const [allowText, setAllowText] = useState(DEFAULT_ALLOW);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [invokeError, setInvokeError] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = transcriptRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [state.items]);

  const start = useCallback(async () => {
    setInvokeError(null);
    setSessionId(null);
    dispatch({ type: "begin" });
    try {
      const info = await runPrompt({
        prompt,
        cwd,
        allow: allowText
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
        deny: [],
        onEvents: (batch) => dispatch({ type: "batch", batch }),
      });
      setSessionId(info.session_id);
    } catch (e) {
      setInvokeError(String(e));
      dispatch({
        type: "batch",
        batch: [{ type: "driver_error", message: String(e) }],
      });
    }
  }, [prompt, cwd, allowText]);

  const stop = useCallback(async () => {
    if (!sessionId) {
      return;
    }
    try {
      await cancelRun(sessionId);
    } catch (e) {
      setInvokeError(String(e));
    }
  }, [sessionId]);

  // Cmd/Ctrl+R 运行、Cmd/Ctrl+. 停止：焦点免疫的快捷键（验收脚本可驱动）
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
      {/* 运行控制（P1-3 演进为多会话管理） */}
      <div className="shrink-0 space-y-2.5 border-b px-5 py-3">
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={2}
          placeholder="任务提示词"
          className="resize-none font-mono text-[13px]"
        />
        <div className="flex gap-2">
          <Input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            className="w-64 font-mono text-xs"
            placeholder="工作目录"
          />
          {/* 规则必须多行：单行 Input 会被浏览器剥掉换行符，规则解析全废（P1-2 验收踩坑） */}
          <Textarea
            value={allowText}
            onChange={(e) => setAllowText(e.target.value)}
            rows={2}
            className="min-w-0 flex-1 resize-none py-2 font-mono text-xs leading-tight"
            placeholder="预授权规则（每行一条，如 write 或 bash(git *)）"
          />
          {state.running ? (
            <Button size="sm" variant="destructive" onClick={stop}>
              <CircleStop className="size-4" />
              停止
            </Button>
          ) : (
            <Button size="sm" onClick={start} disabled={!prompt.trim() || !cwd.trim()}>
              <Play className="size-4" />
              运行
            </Button>
          )}
        </div>
        <p className="text-muted-foreground text-[11px]">
          fail-closed：未匹配预授权规则的权限请求自动拒绝（审批中心 P1-5 接管）
          {sessionId && (
            <>
              {" · 会话 "}
              <code className="text-foreground/70">{sessionId.slice(0, 8)}</code>
            </>
          )}
          {invokeError && <span className="text-destructive"> · {invokeError}</span>}
        </p>
      </div>

      {/* 事件流时间线（合帧批 → 单次 dispatch → 仅活动 chunk 重渲染） */}
      <div ref={transcriptRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {state.items.length === 0 && (
            <p className="text-muted-foreground py-8 text-center text-sm">
              点击「运行」驱动 opencode（ACP）执行任务，事件经 Rust 合帧 → Tauri Channel 到达这里。
            </p>
          )}
          {state.items.map((item) => (
            <StreamItemView key={item.key} item={item} />
          ))}
        </div>
      </div>

      {/* 状态条 */}
      <div className="text-muted-foreground flex h-8 shrink-0 items-center gap-3 border-t px-5 text-[11px]">
        {state.running ? (
          <>
            <Loader2 className="text-primary size-3 animate-spin" />
            <span>运行中</span>
          </>
        ) : (
          <span>{state.items.length > 0 ? "已结束" : "空闲"}</span>
        )}
        {state.usage.used != null && (
          <span>tokens {state.usage.used.toLocaleString()}</span>
        )}
        {state.usage.cost != null && <span>${state.usage.cost.toFixed(4)}</span>}
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
    </div>
  );
});
