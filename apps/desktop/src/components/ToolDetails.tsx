import {
  Component,
  lazy,
  memo,
  Suspense,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  FileText,
  FilePen,
  FolderInput,
  Globe,
  Search,
  SquareTerminal,
  Trash2,
  Wrench,
} from "lucide-react";
import type { DiffPayload, ToolKind, ToolStatus } from "@/lib/events";
import { readTextFile } from "@/lib/agent";
import {
  formatToolInterval,
  largeDiff,
  parameterText,
  toolCommand,
  writeLazyPath,
  type ToolItem,
} from "@/lib/tool-details";
import { TimelineCopy, TimelineDisclosure } from "./MessageTimeline";
const DiffPreview = lazy(() => import("./DiffPreview"));
const icons: Record<ToolKind, typeof Wrench> = {
  read: FileText,
  edit: FilePen,
  delete: Trash2,
  move: FolderInput,
  search: Search,
  execute: SquareTerminal,
  fetch: Globe,
  other: Wrench,
};
const kinds: Record<ToolKind, string> = {
  read: "读取",
  edit: "编辑",
  delete: "删除",
  move: "移动",
  search: "搜索",
  execute: "执行",
  fetch: "网络",
  other: "工具",
};
const statuses: Record<ToolStatus, string> = {
  pending: "等待",
  in_progress: "运行中",
  completed: "完成",
  failed: "失败",
};
const sourceClass =
  "max-h-64 overflow-auto rounded bg-muted/40 px-3 py-2 font-mono text-xs whitespace-pre-wrap break-all select-text";
const actionClass = "text-xs text-primary underline-offset-2 hover:underline";
export const ToolDetails = memo(function ToolDetails({
  item,
}: {
  item: ToolItem;
}) {
  const Icon = icons[item.toolKind];
  return (
    <div className="min-w-0 rounded-md border px-3 py-2" data-tool-details>
      <TimelineDisclosure
        itemKey={item.key}
        summary={
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
            <span
              className="min-w-0 flex-1 truncate text-sm font-medium"
              title={item.title || item.name || "工具调用"}
            >
              {item.title || item.name || "工具调用"}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {kinds[item.toolKind]}
            </span>
            <span
              className={`text-[11px] ${item.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}
            >
              {statuses[item.status]}
            </span>
            <span
              className="text-[10px] text-muted-foreground"
              title="本机收到调用至首次完成或失败事件的间隔，包含等待与通信时间。"
            >
              {formatToolInterval(item)}
            </span>
          </span>
        }
      >
        <div className="space-y-3 border-t pt-3">
          <TimelineDisclosure
            itemKey={`${item.key}:parameters`}
            summary={<span className="text-xs font-medium">参数</span>}
          >
            <Parameters
              raw={item.rawInput}
              execute={item.toolKind === "execute"}
            />
          </TimelineDisclosure>
          <TimelineDisclosure
            itemKey={`${item.key}:output`}
            summary={
              <span className="text-xs font-medium">
                输出 · {item.content.length} 段
              </span>
            }
          >
            {item.content.length ? (
              <>
                <pre className={sourceClass}>{item.content.join("\n")}</pre>
                <TimelineCopy
                  text={item.content.join("\n")}
                  label="复制工具输出"
                />
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                当前事件未提供文本输出
              </p>
            )}
          </TimelineDisclosure>
          {item.locations.length > 0 && (
            <div className="text-[11px] text-muted-foreground">
              <span>位置</span>
              {item.locations.map((loc, i) => (
                <p key={i} className="break-all font-mono select-text">
                  {loc.path}
                  {loc.line != null ? `:${loc.line}` : ""}
                </p>
              ))}
            </div>
          )}
          {(item.diff || writeLazyPath(item)) && (
            <DiffDetails
              itemKey={item.key}
              diff={item.diff}
              lazyPath={writeLazyPath(item)}
            />
          )}
        </div>
      </TimelineDisclosure>
    </div>
  );
});
function Parameters({ raw, execute }: { raw: unknown; execute: boolean }) {
  const text = parameterText(raw);
  const command = execute ? toolCommand(raw) : null;
  return text == null ? (
    <p className="text-xs text-muted-foreground">当前事件未提供参数</p>
  ) : (
    <>
      <pre className={sourceClass}>{text}</pre>
      <TimelineCopy text={text} label="复制完整参数" />
      {command != null && <TimelineCopy text={command} label="复制命令" />}
    </>
  );
}
export function DiffDetails({
  itemKey,
  diff,
  lazyPath,
}: {
  itemKey: string;
  diff: DiffPayload | null;
  lazyPath?: string | null;
}) {
  const path = diff?.path ?? lazyPath;
  if (!path) return null;
  return (
    <TimelineDisclosure
      itemKey={`${itemKey}:diff`}
      summary={
        <span className="min-w-0 text-xs font-medium">
          文件变更{" "}
          <span className="break-all font-mono font-normal text-muted-foreground">
            {path}
          </span>
        </span>
      }
    >
      <DiffContent
        key={path}
        itemKey={itemKey}
        diff={diff}
        lazyPath={lazyPath}
      />
    </TimelineDisclosure>
  );
}
function DiffContent({
  itemKey,
  diff,
  lazyPath,
}: {
  itemKey: string;
  diff: DiffPayload | null;
  lazyPath?: string | null;
}) {
  const [loaded, setLoaded] = useState<DiffPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [raw, setRaw] = useState(false);
  const [renderAttempt, setRenderAttempt] = useState(0);
  const payload = diff ?? loaded;
  useEffect(() => {
    if (diff || !lazyPath) return;
    let alive = true;
    setError(null);
    setLoaded(null);
    void readTextFile(lazyPath)
      .then((text) => {
        if (alive)
          setLoaded({ path: lazyPath, old_text: null, new_text: text });
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [diff, lazyPath, attempt]);
  return (
    <div className="space-y-2" data-diff-details>
      <p className="text-[11px] text-muted-foreground">
        {diff
          ? "Agent 提供的文件变更"
          : "当前磁盘内容 · 非调用时快照 · 仅展示新内容"}
      </p>
      {error && (
        <div>
          <p role="alert" className="break-words text-xs text-destructive">
            {error}
          </p>
          <button
            className={actionClass}
            onClick={() => setAttempt((n) => n + 1)}
          >
            重试读取
          </button>
        </div>
      )}
      {!payload && !error && (
        <p role="status" className="text-xs text-muted-foreground">
          正在读取…
        </p>
      )}
      {payload && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            {!largeDiff(payload) && (
              <button className={actionClass} onClick={() => setRaw((v) => !v)}>
                {raw ? "查看变更对照" : "查看原文对照"}
              </button>
            )}
            {!diff && (
              <button
                className={actionClass}
                onClick={() => setAttempt((n) => n + 1)}
              >
                重新读取磁盘
              </button>
            )}
          </div>
          {largeDiff(payload) && (
            <p className="text-xs text-muted-foreground">
              内容较长，使用完整原文对照；可展开或复制全部内容。
            </p>
          )}
          {raw || largeDiff(payload) ? (
            <Sources itemKey={itemKey} payload={payload} />
          ) : (
            <DiffBoundary
              key={renderAttempt}
              fallback={
                <div>
                  <p role="alert" className="text-xs text-destructive">
                    对照视图暂不可用，可重试或查看完整原文。
                  </p>
                  <div className="mt-1 flex gap-3">
                    <button
                      className={actionClass}
                      onClick={() => setRenderAttempt((n) => n + 1)}
                    >
                      重试对照
                    </button>
                    <button
                      className={actionClass}
                      onClick={() => setRaw(true)}
                    >
                      使用原文恢复
                    </button>
                  </div>
                </div>
              }
            >
              <Suspense
                fallback={
                  <p role="status" className="text-xs text-muted-foreground">
                    正在加载对照视图…
                  </p>
                }
              >
                <DiffPreview payload={payload} />
              </Suspense>
            </DiffBoundary>
          )}
          <div className="flex flex-wrap gap-x-4">
            {payload.old_text != null && (
              <TimelineCopy text={payload.old_text} label="复制旧内容" />
            )}
            <TimelineCopy text={payload.new_text} label="复制新内容" />
          </div>
        </>
      )}
    </div>
  );
}
function Sources({
  itemKey,
  payload,
}: {
  itemKey: string;
  payload: DiffPayload;
}) {
  return (
    <div className="space-y-2">
      {payload.old_text != null && (
        <TimelineDisclosure
          itemKey={`${itemKey}:old-source`}
          summary={
            <span className="text-xs">
              旧内容 · {payload.old_text.split("\n").length} 行
            </span>
          }
        >
          <pre data-testid="old-source" className={sourceClass}>
            {payload.old_text}
          </pre>
        </TimelineDisclosure>
      )}
      <TimelineDisclosure
        itemKey={`${itemKey}:new-source`}
        summary={
          <span className="text-xs">
            新内容 · {payload.new_text.split("\n").length} 行
          </span>
        }
      >
        <pre data-testid="new-source" className={sourceClass}>
          {payload.new_text}
        </pre>
      </TimelineDisclosure>
    </div>
  );
}
class DiffBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
