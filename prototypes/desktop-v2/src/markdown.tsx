import { Streamdown } from "streamdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
const safeUrl = (url: string) => (/^(https?:\/\/|#)/i.test(url) ? url : "");
const components: Components = {
  pre: ({ children }) => <pre>{children}</pre>,
  code: ({ children, className }) => <code className={className}>{children}</code>,
  img: ({ alt }) => (
    <span className="image-placeholder">[图片未加载：{alt || "远端图片"}]</span>
  ),
  a: ({ children, href }) => (
    <span
      className="safe-link"
      title={href ? "外部链接需确认后打开" : "已阻止不安全链接"}
    >
      {children}
    </span>
  ),
};
export default function Markdown({
  text,
  engine = "streamdown",
}: {
  text: string;
  engine?: "streamdown" | "react-markdown";
}) {
  return (
    <div className="markdown" data-engine={engine}>
      {engine === "streamdown" ? (
        <Streamdown
          skipHtml
          urlTransform={safeUrl}
          components={components}
          controls={false}
          mode="streaming"
          animated={false}
        >
          {text}
        </Streamdown>
      ) : (
        <ReactMarkdown
          skipHtml
          urlTransform={safeUrl}
          components={components}
          remarkPlugins={[remarkGfm]}
        >
          {text}
        </ReactMarkdown>
      )}
    </div>
  );
}
