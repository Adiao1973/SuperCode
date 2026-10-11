import {
  Component,
  Suspense,
  lazy,
  memo,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { copyText } from "@/lib/clipboard";
import { ACTIVE_MARKDOWN_LIMIT, MARKDOWN_LIMIT } from "@/lib/markdown";

const MarkdownBody = lazy(() => import("./MarkdownBody"));
class MarkdownBoundary extends Component<
  { text: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <RawText text={this.props.text} />
    ) : (
      this.props.children
    );
  }
}
function RawText({ text }: { text: string }) {
  return (
    <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
      {text}
    </pre>
  );
}
export const MessageMarkdown = memo(function MessageMarkdown({
  text,
  active,
}: {
  text: string;
  active: boolean;
}) {
  const [raw, setRaw] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [display, setDisplay] = useState(text);
  const latest = useRef(text);
  latest.current = text;
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Fixed window throttle: sustained updates must not indefinitely debounce parsing.
  useEffect(() => {
    if (!active) {
      if (pending.current) clearTimeout(pending.current);
      pending.current = null;
      return;
    }
    if (!pending.current)
      pending.current = setTimeout(() => {
        pending.current = null;
        setDisplay(latest.current);
      }, 100);
  }, [text, active]);
  useEffect(
    () => () => {
      if (pending.current) clearTimeout(pending.current);
    },
    [],
  );
  // Active messages use immediate raw fallback if the parsing budget is exceeded.
  const tooLong =
    text.length > (active ? ACTIVE_MARKDOWN_LIMIT : MARKDOWN_LIMIT);
  const visibleText = active ? display : text;
  async function copy() {
    try {
      await copyText(text);
      setFeedback("已复制全文");
    } catch {
      setFeedback("复制失败，请选择原文复制");
    }
  }
  return (
    <div className="min-w-0 text-foreground/90" data-message-markdown>
      <div className="mb-1 flex items-center gap-3 text-[11px] text-muted-foreground">
        <button
          type="button"
          className="hover:text-foreground"
          onClick={() => setRaw((v) => !v)}
          aria-pressed={raw}
        >
          {raw ? "返回排版" : "查看原文"}
        </button>
        <button
          type="button"
          className="hover:text-foreground"
          onClick={() => void copy()}
        >
          复制全文
        </button>
        {tooLong && <span>长消息以原文显示</span>}
        <span role="status">{feedback}</span>
      </div>
      {raw || tooLong ? (
        <RawText text={text} />
      ) : (
        <MarkdownBoundary text={text}>
          <Suspense fallback={<RawText text={text} />}>
            <MarkdownBody text={visibleText} active={active} />
          </Suspense>
        </MarkdownBoundary>
      )}
      {active && (
        <span aria-label="正在生成" className="text-primary animate-pulse">
          ▍
        </span>
      )}
    </div>
  );
});
