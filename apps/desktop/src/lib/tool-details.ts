import type { DiffPayload } from "./events";
import type { StreamItem } from "./stream";
export type ToolItem = Extract<StreamItem, { kind: "tool" }>;
export function toolCommand(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  return typeof input.command === "string"
    ? input.command
    : typeof input.cmd === "string"
      ? input.cmd
      : null;
}
export function formatToolInterval(item: ToolItem): string {
  if (item.status === "pending" || item.status === "in_progress")
    return "尚未结束";
  if (item.startedAt == null || item.endedAt == null) return "接收间隔未知";
  const ms = Math.max(0, item.endedAt - item.startedAt);
  return `接收间隔 ${ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`}`;
}
export function parameterText(raw: unknown): string | null {
  if (raw === undefined) return null;
  return typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
}
export function largeDiff(diff: DiffPayload): boolean {
  const old = diff.old_text ?? "";
  return (
    old.length + diff.new_text.length > 128 * 1024 ||
    old.split("\n").length + diff.new_text.split("\n").length > 4000
  );
}
export function writeLazyPath(item: ToolItem): string | null {
  if (item.diff || item.locations.length === 0) return null;
  return /write|create|save/.test(
    `${item.name ?? ""} ${item.title ?? ""}`.toLowerCase(),
  )
    ? item.locations[0].path
    : null;
}
