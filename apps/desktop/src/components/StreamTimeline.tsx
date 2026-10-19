import { memo } from "react";
import { MessageTimeline, TimelineDisclosure, TimelineCopy } from "./MessageTimeline";
import { MessageMarkdown } from "./MessageMarkdown";
import { ToolDetails } from "./ToolDetails";
import { Separator } from "@/components/ui/separator";
import type { StreamItem } from "@/lib/stream";
import type { ReadingMemory } from "@/lib/reading";
const STOP_LABELS: Record<string, string> = {
  end_turn: "本轮完成",
  cancelled: "已取消",
  max_tokens: "达到 token 上限",
  max_turn_requests: "达到审批次数上限",
  refusal: "模型拒绝",
};

export default function StreamTimeline({ items, memory, visible }: { items: StreamItem[]; memory: ReadingMemory; visible: boolean }) {
  return <MessageTimeline items={items} memory={memory} visible={visible} renderItem={renderStreamItem} />;
}
const renderStreamItem = (item: StreamItem) => <StreamItemView item={item} />;

const StreamItemView = memo(function StreamItemView({
  item,
}: {
  item: StreamItem;
}) {
  switch (item.kind) {
    case "thought":
      return (
        <div className="border-l-2 py-1 pl-3 text-muted-foreground">
          <TimelineDisclosure
            itemKey={item.key}
            summary={
              <span className="min-w-0 truncate text-xs">
                思考 · {item.active ? "生成中" : "完成"} ·{" "}
                {item.text.split("\n", 1)[0].slice(0, 120)}
              </span>
            }
          >
            <p className="whitespace-pre-wrap break-words text-sm italic">
              {item.text}
            </p>
            <TimelineCopy text={item.text} label="复制思考" />
          </TimelineDisclosure>
        </div>
      );
    case "message":
      return <MessageMarkdown text={item.text} active={item.active} />;
    case "user_message":
      return (
        <div className="flex justify-end">
          <p className="bg-primary/10 text-foreground max-w-[85%] rounded-lg px-3 py-1.5 text-sm whitespace-pre-wrap">
            {item.text}
          </p>
        </div>
      );
    case "tool":
      return <ToolDetails item={item} />;
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
