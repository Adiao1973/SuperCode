import { useCallback, useEffect, useState } from "react";
import { MultiFileDiff } from "@pierre/diffs/react";
import { useAppearance } from "@/lib/appearance";
import type { DiffPayload } from "@/lib/events";
export default function DiffPreview({ payload }: { payload: DiffPayload }) {
  const { resolved } = useAppearance();
  const [ready, setReady] = useState(false);
  const [expired, setExpired] = useState(false);
  const rendered = useCallback((node: HTMLElement) => {
    // The renderer populates its open shadow root asynchronously. A mounted
    // custom element alone is not evidence that its contents are ready.
    if (node.shadowRoot?.querySelector("pre code")) setReady(true);
  }, []);
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => setExpired(true), 5000);
    return () => clearTimeout(timer);
  }, [ready]);
  if (expired && !ready)
    throw new Error("Diff renderer did not produce content");
  return (
    <div
      className="max-h-72 overflow-auto rounded border"
      style={
        {
          "--diffs-font-family": "var(--font-mono)",
          "--diffs-font-size": "11px",
        } as React.CSSProperties
      }
    >
      {!ready && (
        <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
          正在生成变更对照…
        </p>
      )}
      <MultiFileDiff
        oldFile={
          payload.old_text == null
            ? null
            : { name: payload.path, contents: payload.old_text }
        }
        newFile={{ name: payload.path, contents: payload.new_text }}
        options={{
          diffStyle: "unified",
          onPostRender: rendered,
          disableErrorHandling: true,
          overflow: "scroll",
          disableFileHeader: true,
          hunkSeparators: "simple",
          themeType: resolved,
        }}
      />
    </div>
  );
}
