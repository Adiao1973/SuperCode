import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { Dialog } from "radix-ui";
import { Search, X } from "lucide-react";
import { EmptyState } from "./FeedbackState";
import { searchPalette, composingKey, type PaletteChoice } from "@/lib/command-palette";
export function CommandPalette({ open, onOpenChange, onChoose, returnFocus, items, tasksLoaded }: {
  open: boolean; onOpenChange: (open: boolean) => void; onChoose: (choice: PaletteChoice) => void;
  returnFocus: RefObject<HTMLElement | null>; items: PaletteChoice[]; tasksLoaded: boolean;
}) {
  const [query, setQuery] = useState(""); const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null); const composing = useRef(false);
  const ended = useRef(-Infinity); const navigating = useRef(false); const listId = useId();
  const results = searchPalette(items, query); const selected = Math.min(active, Math.max(0, results.length - 1));
  useEffect(() => { if (open) { setQuery(""); setActive(0); composing.current = false; ended.current = -Infinity; navigating.current = false; } }, [open]);
  useEffect(() => { if (open) document.getElementById(`${listId}-${selected}`)?.scrollIntoView?.({ block: "nearest" }); }, [open, selected, query, listId]);
  const choose = (item: PaletteChoice) => {
    if (navigating.current || composing.current || performance.now() - ended.current < 50) return;
    navigating.current = true; onChoose(item); onOpenChange(false);
  };
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
    <Dialog.Content className="bg-background fixed left-1/2 top-[10dvh] z-50 flex max-h-[80dvh] w-[calc(100vw-3rem)] max-w-2xl -translate-x-1/2 flex-col rounded-lg border shadow-lg"
      onOpenAutoFocus={(event) => { event.preventDefault(); input.current?.focus(); }}
      onCloseAutoFocus={(event) => { event.preventDefault(); if (!navigating.current && returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true }); }}
      onEscapeKeyDown={(event) => { if (composing.current || composingKey(event) || performance.now() - ended.current < 50) event.preventDefault(); }}>
      <div className="flex items-center justify-between gap-3 px-4 pt-4"><Dialog.Title className="font-semibold">搜索与快捷键</Dialog.Title><Dialog.Close asChild><button aria-label="关闭搜索" className="rounded p-1 focus-visible:ring-2 focus-visible:ring-ring"><X className="size-4" /></button></Dialog.Close></div>
      <Dialog.Description className="px-4 pt-2 text-xs text-muted-foreground">仅搜索已加载的标题与分组，最多显示 80 项；不搜索文件、正文或密钥。</Dialog.Description>
      <div className="m-4 flex items-center gap-2 rounded-md border px-3 focus-within:ring-2 focus-within:ring-ring"><Search aria-hidden="true" className="size-4 text-muted-foreground" /><input ref={input} role="combobox" aria-label="搜索模块、会话或任务" aria-autocomplete="list" aria-expanded="true" aria-controls={listId} aria-activedescendant={results.length ? `${listId}-${selected}` : undefined} className="min-w-0 flex-1 bg-transparent py-3 text-sm outline-none command-palette-input" placeholder="搜索模块、会话或任务…" value={query}
        onChange={(e) => { setQuery(e.target.value); setActive(0); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; ended.current = performance.now(); }}
        onKeyDown={(event) => {
          if (composing.current || composingKey(event.nativeEvent)) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setActive((value) => results.length ? (Math.min(value, results.length - 1) + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length : 0); }
          if (event.key === "Enter") { event.preventDefault(); if (!event.repeat && results[selected]) choose(results[selected]); }
        }} /></div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2"><div id={listId} role="listbox" aria-label="搜索结果">{results.map((item, index) => <div key={item.id} id={`${listId}-${index}`} role="option" aria-selected={index === selected} onMouseMove={() => setActive(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(item)} className={`mx-1 cursor-pointer rounded-md px-3 py-2 ${index === selected ? "bg-accent text-accent-foreground" : "hover:bg-muted"}`}><p className="text-sm font-medium [overflow-wrap:anywhere]">{item.title}</p><p className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">{item.scope}</p></div>)}</div>
        {results.length === 0 && <div className="px-3"><EmptyState title="没有匹配结果" description="试试其他标题或先进入会话、看板加载列表。" /></div>}
      </div>
      <div className="shrink-0 space-y-2 border-t px-4 py-3 text-xs text-muted-foreground">
        {!tasksLoaded && <p>打开任务看板后，可搜索已加载任务。</p>}
        <p aria-live="polite">{results.length} 项结果 · ↑↓ 选择 · Enter 打开 · Esc 返回</p>
        <details><summary className="cursor-pointer rounded focus-visible:ring-2 focus-visible:ring-ring">快捷键与作用范围</summary><dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2"><dt>⌘/Ctrl K</dt><dd>打开搜索；终端内请用侧栏入口。</dd><dt>⌘/Ctrl N</dt><dd>新建默认空间会话草稿。</dd><dt>⌘/Ctrl 1～8</dt><dd>切换已加载的前八个会话。</dd><dt>⌘/Ctrl R · ⌘/Ctrl .</dt><dd>当前会话运行 / 停止，沿用原权限流程。</dd><dt>Enter · Shift Enter</dt><dd>会话输入区运行 / 换行。</dd></dl><p className="mt-3">组合输入、其他弹层与终端拥有自己的按键；命令面板不提供运行、删除、裁决或派单。</p></details>
      </div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}
