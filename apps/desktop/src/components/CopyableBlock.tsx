/**
 * 可复制代码块（P1-7）：引导片段统一渲染——验收要求"可见可复制"。
 */
import { MotionNotice } from "@/lib/motion";
import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";
import { Check, Copy } from "lucide-react";

export function CopyableBlock({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    await copyText(text);
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="group relative rounded-md border bg-muted/30">
      {label && <p className="text-muted-foreground px-3 pt-2 text-[11px]">{label}</p>}
      <pre className="overflow-x-auto px-3 py-2 pr-20 font-mono text-[11px] leading-relaxed whitespace-pre">
        {text}
      </pre>
      <span role="status" className="absolute right-3 bottom-1 text-[11px] text-success"><MotionNotice visible={copied}>已复制</MotionNotice></span>
      <Button
        size="sm"
        variant="outline"
        className="absolute top-1.5 right-1.5 h-6 gap-1 px-2 text-[11px]"
        onClick={() => void copy()}
      >
        {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
        复制
      </Button>
    </div>
  );
}
