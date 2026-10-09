import { useEffect, useState } from "react";
import Markdown from "./markdown.tsx";
const sample =
  '## 中文流式对照\n\n**未闭合强调与代码**应该保持可读。\n\n```ts\nconst title = "任务管理";\nconst task = { title, done: false };\n```\n\n|任务|状态|\n|---|---|\n|中文任务|完成|\n\n[正常链接](https://example.com) [危险链接](javascript:alert(1))\n\n![禁止远端请求](https://example.com/not-requested.png)\n\n<script>window.P42_UNSAFE = true</script>\n<img src="https://example.com/raw-not-requested.png" onerror="window.P42_UNSAFE=true">\n\n未闭合代码：\n```ts\nconst next = "继续';
export default function Compare() {
  const [text, setText] = useState(sample),
    [running, setRunning] = useState(false);
  useEffect(() => {
    if (!running) return;
    let n = 0;
    setText("");
    const id = setInterval(() => {
      n += 8;
      setText(sample.slice(0, n));
      if (n >= sample.length) {
        clearInterval(id);
        setRunning(false);
      }
    }, 50);
    return () => clearInterval(id);
  }, [running]);
  return (
    <div
      className="app"
      data-theme="light"
      style={{ display: "block", overflow: "auto", padding: 30 }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: 25 }}>
        <h1>Markdown 对照验收</h1>
        <button onClick={() => setRunning(true)} disabled={running}>
          {running ? "20Hz 增量中" : "开始 20Hz 增量"}
        </button>
        <a href="/">返回工作台</a>
      </header>
      <p>
        合成样例；链接不打开，远端图片不加载，原始 HTML 不执行。此页仅用于选型。
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 40,
          marginTop: 30,
        }}
      >
        {(["streamdown", "react-markdown"] as const).map((engine) => (
          <section key={engine} style={{ minWidth: 0 }}>
            <h2>{engine}</h2>
            <Markdown text={text} engine={engine} />
          </section>
        ))}
      </div>
    </div>
  );
}
