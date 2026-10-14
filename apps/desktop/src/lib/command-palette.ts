import { NAV_ITEMS, type NavId } from "@/components/AppShell";
import type { SessionEntry } from "./sessions";
import type { TaskEntry, Workspace } from "./agent";
type ChoiceBase = { id: string; title: string; scope: string };
export type PaletteChoice = ChoiceBase & ({ kind: "module"; target: NavId } | { kind: "session" | "task"; target: string } | { kind: "new-session" | "new-task"; target: null });
export function paletteItems(sessions: Pick<SessionEntry, "key" | "title" | "workspaceId">[], tasks: Pick<TaskEntry, "id" | "title" | "workspace_id">[], workspaces: Pick<Workspace, "id" | "name">[], projectName: string): PaletteChoice[] {
  const name = (id: string) => workspaces.find((w) => w.id === id)?.name ?? (id === "default" ? "默认空间" : "未加载空间");
  return [
    ...NAV_ITEMS.map((item): PaletteChoice => ({ id: `module:${item.id}`, kind: "module", target: item.id, title: item.label, scope: "模块" })),
    { id: "new-session", kind: "new-session", target: null, title: "新建会话", scope: "默认空间 · 仅创建草稿" },
    { id: "new-task", kind: "new-task", target: null, title: "新建任务表单", scope: `${projectName} · 填写后才保存` },
    ...sessions.map((s): PaletteChoice => ({ id: `session:${s.key}`, kind: "session", target: s.key, title: s.title || "未命名会话", scope: `已加载会话 · ${name(s.workspaceId)}` })),
    ...tasks.map((t): PaletteChoice => ({ id: `task:${t.id}`, kind: "task", target: t.id, title: t.title, scope: `已加载任务 · 看板分组 ${name(t.workspace_id)}` })),
  ];
}
export function searchPalette(items: PaletteChoice[], query: string): PaletteChoice[] {
  const parts = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => parts.every((part) => `${item.title} ${item.scope}`.toLocaleLowerCase().includes(part))).slice(0, 80);
}
export const composingKey = (event: { isComposing?: boolean; keyCode?: number }) => event.isComposing || event.keyCode === 229;
