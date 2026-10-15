import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { ChevronRight, ChevronDown, ArrowDown } from "lucide-react";
import type { StreamItem } from "@/lib/stream";
import {
  captureReadingAnchor,
  initialLocation,
  nearBottom,
  noteTimelineUpdate,
  type ReadingMemory,
} from "@/lib/reading";
import { copyText } from "@/lib/clipboard";
const DisclosureContext = createContext<{
  expanded: Set<string>;
  toggle: (key: string) => void;
} | null>(null);

export function MessageTimeline({
  items,
  memory,
  visible,
  renderItem,
}: {
  items: StreamItem[];
  memory: ReadingMemory;
  visible: boolean;
  renderItem: (item: StreamItem) => ReactNode;
}) {
  const list = useRef<VirtuosoHandle>(null);
  const scroller = useRef<HTMLElement | null>(null);
  const shown = useRef(visible);
  shown.current = visible;
  const previousItemCount = useRef(items.length);
  const currentItems = useRef(items);
  currentItems.current = items;
  const adjusting = useRef(false);
  const frame = useRef<number | null>(null);
  const followFrame = useRef<number | null>(null);
  const userIntent = useRef(false);
  const intentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [revision, setRevision] = useState(0);
  const [unread, setUnread] = useState(memory.unread);
  const [initial] = useState(() => {
    const snapshot =
      memory.items?.length === items.length &&
      memory.items?.[0]?.key === items[0]?.key
        ? memory.snapshot
        : undefined;
    noteTimelineUpdate(memory, items);
    return {
      location: initialLocation(memory, items),
      snapshot,
      following: memory.following,
    };
  });
  const remember = useCallback(() => {
    const el = scroller.current;
    if (!shown.current || !el || !el.clientHeight) return;
    memory.anchor = captureReadingAnchor(el) ?? memory.anchor;
    memory.scrollTop = el.scrollTop;
    list.current?.getState((snapshot) => {
      if (shown.current && scroller.current?.clientHeight)
        memory.snapshot = snapshot;
    });
  }, [memory]);
  const adjust = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const el = scroller.current;
      if (!shown.current || !el?.clientHeight) return;
      adjusting.current = true;
      if (memory.following) {
        if (el.scrollHeight - el.clientHeight - el.scrollTop > 2)
          list.current?.scrollToIndex({
            index: currentItems.current.length - 1,
            align: "end",
            behavior: "auto",
          });
      } else if (memory.anchor) {
        const row = Array.from(
          el.querySelectorAll<HTMLElement>("[data-timeline-key]"),
        ).find((n) => n.dataset.timelineKey === memory.anchor!.key);
        if (row) {
          const offset =
            row.getBoundingClientRect().top - el.getBoundingClientRect().top;
          const wanted = Math.max(
            memory.anchor.offset,
            -Math.max(0, row.getBoundingClientRect().height - 24),
          );
          if (Math.abs(offset - wanted) > 1) el.scrollTop += offset - wanted;
        }
      }
      if (followFrame.current !== null)
        cancelAnimationFrame(followFrame.current);
      followFrame.current = requestAnimationFrame(() => {
        adjusting.current = false;
        followFrame.current = null;
      });
    });
  }, [memory]);
  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (
      !shown.current ||
      (adjusting.current && !userIntent.current) ||
      !el?.clientHeight
    )
      return;
    if (nearBottom(el.scrollTop, el.scrollHeight, el.clientHeight)) {
      memory.following = true;
      memory.unread = false;
      setUnread(false);
    } else if (userIntent.current || el.scrollTop < memory.scrollTop - 1)
      memory.following = false;
    remember();
  }, [memory, remember]);
  const intent = useCallback(() => {
    userIntent.current = true;
    if (intentTimer.current) clearTimeout(intentTimer.current);
    intentTimer.current = setTimeout(() => {
      userIntent.current = false;
    }, 250);
  }, []);
  const bindScroller = useCallback(
    (node: HTMLElement | Window | null) => {
      const previous = scroller.current;
      previous?.removeEventListener("scroll", onScroll);
      scroller.current = node instanceof HTMLElement ? node : null;
      scroller.current?.addEventListener("scroll", onScroll, { passive: true });
    },
    [onScroll],
  );
  useLayoutEffect(() => {
    const expanded = memory.expanded;
    noteTimelineUpdate(memory, items);
    if (expanded !== memory.expanded) setRevision((n) => n + 1);
    setUnread(memory.unread);
    // Text growth is observed below; avoid forced layout for unchanged display batches.
    if (previousItemCount.current !== items.length) adjust();
    previousItemCount.current = items.length;
  }, [items, memory, adjust]);
  useLayoutEffect(() => {
    if (!visible) return;
    if (!memory.following && memory.anchor)
      list.current?.scrollToIndex(initialLocation(memory, items));
    adjust();
    // Restore only on visibility changes, not every streaming batch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, adjust, memory]);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const changes = new MutationObserver(adjust);
    changes.observe(el, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    const sizes = new ResizeObserver(adjust);
    sizes.observe(el);
    return () => {
      changes.disconnect();
      sizes.disconnect();
    };
  }, [adjust, items.length === 0]);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      if (followFrame.current !== null)
        cancelAnimationFrame(followFrame.current);
      if (intentTimer.current) clearTimeout(intentTimer.current);
      scroller.current?.removeEventListener("scroll", onScroll);
    },
    [onScroll],
  );
  const toggle = useCallback(
    (key: string) => {
      remember();
      const expanded = new Set(memory.expanded);
      if (expanded.has(key)) expanded.delete(key);
      else expanded.add(key);
      memory.expanded = expanded;
      setRevision((n) => n + 1);
      adjust();
    },
    [memory, remember, adjust],
  );
  const context = useMemo(
    () => ({ expanded: memory.expanded, toggle }),
    [memory, toggle, revision],
  );
  const jump = () => {
    memory.following = true;
    memory.unread = false;
    memory.anchor = null;
    setUnread(false);
    list.current?.scrollToIndex({
      index: items.length - 1,
      align: "end",
      behavior: "auto",
    });
    adjust();
  };
  return (
    <DisclosureContext.Provider value={context}>
      <div
        className="relative h-full min-h-0"
        data-message-timeline
        onWheelCapture={(event) => {
          intent();
          if (event.deltaY < 0) memory.following = false;
        }}
        onTouchMoveCapture={intent}
        onPointerDownCapture={intent}
        onKeyDownCapture={(event) => {
          if (
            [
              "ArrowUp",
              "ArrowDown",
              "PageUp",
              "PageDown",
              "Home",
              "End",
            ].includes(event.key)
          )
            intent();
        }}
      >
        <Virtuoso
          ref={list}
          style={{ height: "100%", overflowAnchor: "none" }}
          data={items}
          computeItemKey={(_, item) => item.key}
          initialTopMostItemIndex={initial.following ? 0 : initial.location}
          restoreStateFrom={initial.snapshot ?? undefined}
          scrollerRef={bindScroller}
          followOutput={() =>
            shown.current && memory.following ? "auto" : false
          }
          totalListHeightChanged={adjust}
          increaseViewportBy={{ top: 400, bottom: 400 }}
          itemContent={(_, item) => (
            <div
              data-timeline-key={item.key}
              className="mx-auto max-w-3xl px-5 pb-3"
            >
              {renderItem(item)}
            </div>
          )}
        />
        {unread && (
          <button
            type="button"
            className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border bg-background px-3 py-1.5 text-xs text-primary shadow-sm"
            onClick={jump}
          >
            <ArrowDown className="size-3" />
            新消息 · 回到底部
          </button>
        )}
      </div>
    </DisclosureContext.Provider>
  );
}
export function TimelineDisclosure({
  itemKey,
  summary,
  children,
}: {
  itemKey: string;
  summary: ReactNode;
  children: ReactNode;
}) {
  const context = useContext(DisclosureContext);
  const [fallback, setFallback] = useState(false);
  const expanded = context ? context.expanded.has(itemKey) : fallback;
  return (
    <div className="min-w-0">
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 text-left"
        aria-expanded={expanded}
        onClick={() =>
          context ? context.toggle(itemKey) : setFallback((v) => !v)
        }
      >
        {expanded ? (
          <ChevronDown className="size-3 shrink-0" />
        ) : (
          <ChevronRight className="size-3 shrink-0" />
        )}
        {summary}
      </button>
      {expanded && <div className="mt-2">{children}</div>}
    </div>
  );
}
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
