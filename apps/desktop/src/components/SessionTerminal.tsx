import { useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

type Output = { type: "data"; bytes: number[] } | { type: "exit"; code: number | null } | { type: "error"; message: string };

export function SessionTerminal({ cwd, onClose }: { cwd: string; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("正在启动…");
  useEffect(() => {
    if (!host.current) return;
    const id = crypto.randomUUID();
    let disposed = false;
    let ready = false;
    let ended = false;
    let input = Promise.resolve();
    const term = new Terminal({ allowTransparency: false, theme: { background: "#101418", foreground: "#e5e7eb" }, fontSize: 12, fontFamily: "Menlo, monospace", cursorBlink: true, scrollback: 3000, screenReaderMode: true });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    fit.fit();
    const fail = (e: unknown) => { if (!disposed) { setError(String(e)); setStatus("发生错误"); } };
    const output = new Channel<Output>();
    output.onmessage = (event) => {
      if (event.type === "data") {
        if (disposed) { void invoke("ack_terminal", { id }); return; }
        term.write(new Uint8Array(event.bytes), () => { void invoke("ack_terminal", { id }).catch(fail); });
      } else if (!disposed) {
        if (event.type === "exit") { ended = true; setStatus(`已退出（${event.code ?? "未知"}）`); }
        else { ended = true; setError(event.message); setStatus("已停止"); }
      }
    };
    const opened = invoke("open_terminal", { id, cwd, cols: term.cols, rows: term.rows, onOutput: output });
    const resize = () => {
      if (disposed || ended) return;
      fit.fit();
      if (ready) void invoke("resize_terminal", { id, cols: term.cols, rows: term.rows }).catch(fail);
    };
    void opened.then(() => {
      ready = true;
      if (!disposed && !ended) { setStatus("运行中"); resize(); term.focus(); }
    }).catch(fail);
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    const data = term.onData((value) => {
      if (!ready || ended || disposed) return;
      // Preserve keystroke order, including multi-chunk pastes.
      for (let offset = 0; offset < value.length;) {
        let end = Math.min(offset + 8192, value.length);
        if (end < value.length && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff) end -= 1;
        const chunk = value.slice(offset, end);
        offset = end;
        input = input.then(() => disposed ? undefined : invoke<void>("write_terminal", { id, data: chunk })).catch(fail);
      }
    });
    term.attachCustomKeyEventHandler((event) => {
      if (event.type === "keydown" && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c" && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection()).catch(fail);
        return false;
      }
      return true;
    });
    return () => {
      disposed = true;
      observer.disconnect(); data.dispose(); term.dispose();
      // Await spawn before close: unmount during startup must not leak its shell.
      void opened.then(() => invoke("close_terminal", { id })).catch(() => {});
    };
  }, [cwd]);
  return (
    <section data-session-terminal className="shrink-0 border-t" aria-label="会话终端" onKeyDown={(event) => event.stopPropagation()}>
      <div className="flex items-center gap-3 px-5 py-1.5 text-xs">
        <span>终端 · {status}</span>
        <code className="text-muted-foreground min-w-0 flex-1 truncate" title={cwd}>{cwd}</code>
        <button type="button" onClick={onClose} className="hover:text-primary" aria-label="关闭终端">关闭终端</button>
      </div>
      {error && <p role="alert" className="text-destructive px-5 pb-1 text-xs">{error}</p>}
      <div ref={host} className="h-56 min-h-24 max-h-[50vh] resize-y overflow-hidden p-2" style={{ background: "#101418" }} />
    </section>
  );
}
