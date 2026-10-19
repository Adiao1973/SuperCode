import type { StateSnapshot, FlatIndexLocationWithAlign } from "react-virtuoso";
import type { StreamItem } from "./stream";
export interface ReadingAnchor {
  key: string;
  offset: number;
}
export interface ReadingMemory {
  following: boolean;
  unread: boolean;
  anchor: ReadingAnchor | null;
  scrollTop: number;
  snapshot: StateSnapshot | null;
  expanded: Set<string>;
  items: StreamItem[] | null;
}
export function createReadingMemory(): ReadingMemory {
  return {
    following: true,
    unread: false,
    anchor: null,
    scrollTop: 0,
    snapshot: null,
    expanded: new Set(),
    items: null,
  };
}
export function nearBottom(
  top: number,
  height: number,
  viewport: number,
): boolean {
  return height - viewport - top <= 24;
}
export function noteTimelineUpdate(
  memory: ReadingMemory,
  items: StreamItem[],
): void {
  if (memory.items === items) return;
  if (
    !items.length ||
    (memory.items?.length && memory.items[0].key !== items[0].key)
  ) {
    Object.assign(memory, createReadingMemory());
  } else if (memory.items && !memory.following) memory.unread = true;
  memory.items = items;
}
export function initialLocation(
  memory: ReadingMemory,
  items: StreamItem[],
): FlatIndexLocationWithAlign {
  const index = memory.anchor
    ? items.findIndex((item) => item.key === memory.anchor!.key)
    : -1;
  return !memory.following && index >= 0
    ? { index, align: "start", offset: -memory.anchor!.offset }
    : { index: Math.max(0, items.length - 1), align: "end" };
}
/** Only visible virtual rows are inspected, never the complete message history. */
export function captureReadingAnchor(
  scroller: HTMLElement,
): ReadingAnchor | null {
  const top = scroller.getBoundingClientRect().top;
  for (const row of scroller.querySelectorAll<HTMLElement>(
    "[data-timeline-key]",
  )) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > top + 1 && rect.top < top + scroller.clientHeight)
      return { key: row.dataset.timelineKey!, offset: rect.top - top };
  }
  return null;
}
