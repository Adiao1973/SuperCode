import { useState } from "react";
import { copyText } from "@/lib/clipboard";
export function TimelineCopy({ text, label }: { text: string; label: string }) {
  const [feedback, setFeedback] = useState("");
  return (
    <div className="mt-1 flex gap-2 text-[11px] text-muted-foreground">
      <button
        type="button"
        onClick={() =>
          void copyText(text)
            .then(() => setFeedback("已复制"))
            .catch(() => setFeedback("复制失败，请选择文本复制"))
        }
      >
        {label}
      </button>
      <span role={feedback.includes("失败") ? "alert" : "status"} aria-live={feedback.includes("失败") ? "assertive" : "off"}>{feedback}</span>
    </div>
  );
}
