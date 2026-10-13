import { createContext, useContext, useRef, useState } from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Dialog } from "radix-ui";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { canHighlight, codeSource, safeExternalUrl } from "@/lib/markdown";
import { copyText } from "@/lib/clipboard";
import type { HighlightToken } from "@/lib/code-highlight";
const plugins = [remarkGfm];

function ExternalLink({
  url,
  children,
}: {
  url: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button type="button" className="markdown-link">
          {children}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-3rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-background p-5 shadow-lg"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancel.current?.focus();
          }}
        >
          <Dialog.Title className="font-semibold">打开外部链接</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-muted-foreground">
            确认后将在默认浏览器中打开此地址。
          </Dialog.Description>
          <p className="my-4 max-h-48 overflow-auto break-all font-mono text-xs">
            {url}
          </p>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button ref={cancel} variant="outline">
                取消
              </Button>
            </Dialog.Close>
            <Button
              onClick={() => {
                setError("");
                void openUrl(url)
                  .then(() => setOpen(false))
                  .catch(() => setError("打开失败，请复制地址后手动打开"));
              }}
            >
              在浏览器打开
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
function CodeBlock({
  text,
  language,
  active,
}: {
  text: string;
  language: string;
  active: boolean;
}) {
  const [feedback, setFeedback] = useState("");
  const [tokens, setTokens] = useState<{
    source: string;
    lines: HighlightToken[][];
  } | null>(null);
  const [loading, setLoading] = useState(false);
  async function highlight() {
    setLoading(true);
    try {
      const { highlightCode } = await import("@/lib/code-highlight");
      setTokens({ source: text, lines: await highlightCode(text, language) });
      setFeedback("");
    } catch {
      setFeedback("高亮不可用，保留原文");
    } finally {
      setLoading(false);
    }
  }
  async function copy() {
    try {
      await copyText(text);
      setFeedback("已复制代码");
    } catch {
      setFeedback("复制失败，请选择代码复制");
    }
  }
  const lines = tokens?.source === text ? tokens.lines : null;
  return (
    <div className="markdown-code">
      <div className="flex items-center gap-3 border-b px-3 py-1.5 text-[11px] text-muted-foreground">
        <span className="mr-auto truncate">{language || "代码"}</span>
        {!active && canHighlight(text, language) && !lines && (
          <button
            type="button"
            disabled={loading}
            onClick={() => void highlight()}
          >
            {loading ? "高亮中…" : "高亮代码"}
          </button>
        )}
        <button type="button" onClick={() => void copy()}>
          复制代码
        </button>
      </div>
      <pre>
        <code data-highlighted={lines ? "true" : undefined}>
          {lines
            ? lines.map((line, i) => (
                <span key={i}>
                  {line.map((token, j) => (
                    <span
                      className="syntax-token"
                      key={j}
                      style={
                        {
                          "--syntax-light": token.light,
                          "--syntax-dark": token.dark,
                        } as React.CSSProperties
                      }
                    >
                      {token.content}
                    </span>
                  ))}
                  {i < lines.length - 1 ? "\n" : ""}
                </span>
              ))
            : text}
        </code>
      </pre>
      {feedback && (
        <p
          role={feedback.includes("失败") ? "alert" : "status"}
          aria-live={feedback.includes("失败") ? "assertive" : "off"}
          className="px-3 pb-1 text-[11px] text-muted-foreground"
        >
          {feedback}
        </p>
      )}
    </div>
  );
}
const MarkdownContext = createContext({ text: "", active: false });
function MarkdownPre({
  node,
  children,
}: React.ComponentPropsWithoutRef<"pre"> & ExtraProps) {
  const { text, active } = useContext(MarkdownContext);
  const child = node?.children[0];
  const language =
    child?.type === "element"
      ? String(child.properties.className ?? "")
          .replace(/^language-/, "")
          .toLowerCase()
      : "";
  const content =
    codeSource(text, node?.position) ??
    (child?.type === "element"
      ? child.children
          .filter((n) => n.type === "text")
          .map((n) => (n.type === "text" ? n.value : ""))
          .join("")
      : "");
  return content ? (
    <CodeBlock text={content} language={language} active={active} />
  ) : (
    <pre>{children}</pre>
  );
}
const components: Components = {
  a: ({ href, children }) => {
    const url = href ? safeExternalUrl(href) : null;
    return url ? (
      <ExternalLink key={url} url={url}>
        {children}
      </ExternalLink>
    ) : (
      <span>{children}</span>
    );
  },
  img: ({ alt }) => (
    <span className="text-muted-foreground">
      [图片：{alt || "未提供说明"} · 未加载]
    </span>
  ),
  table: ({ children }) => (
    <div className="markdown-table">
      <table>{children}</table>
    </div>
  ),
  pre: MarkdownPre,
};
export default function MarkdownBody({
  text,
  active,
}: {
  text: string;
  active: boolean;
}) {
  return (
    <MarkdownContext.Provider value={{ text, active }}>
      <div className="message-markdown">
        <Markdown
          skipHtml
          remarkPlugins={plugins}
          components={components}
          urlTransform={(url) => safeExternalUrl(url) ?? ""}
        >
          {text}
        </Markdown>
      </div>
    </MarkdownContext.Provider>
  );
}
