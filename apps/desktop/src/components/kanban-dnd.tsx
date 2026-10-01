import type { ReactNode } from "react";
import { pointerWithin, rectIntersection, useDroppable, type CollisionDetection, type KeyboardCoordinateGetter } from "@dnd-kit/core";
import type { TaskEntry } from "@/lib/agent";
import { cn } from "@/lib/utils";

export const columnId = (workspaceId: string, status: TaskEntry["status"]) => JSON.stringify([workspaceId, status]);
export const boardCollision: CollisionDetection = (args) => args.pointerCoordinates ? pointerWithin(args) : rectIntersection(args);

/** 每次方向键移动整列；上下保留列号并切换空间，支持空列。 */
export const boardKeyboardCoordinates: KeyboardCoordinateGetter = (event, { context }) => {
  const offset = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[event.code];
  if (!offset || !context.draggingNodeRect) return;
  event.preventDefault();
  const source = context.active?.data.current;
  const current = context.over ?? context.droppableContainers.get(columnId(source?.workspaceId, source?.status));
  const position = current?.data.current;
  if (!position) return;
  const target = context.droppableContainers.getEnabled().find((container) => {
    const data = container.data.current;
    return data?.row === position.row + offset[0] && data?.column === position.column + offset[1];
  });
  const rect = target && context.droppableRects.get(target.id);
  if (!rect) return;
  return { x: rect.left + (rect.width - context.draggingNodeRect.width) / 2, y: rect.top + (rect.height - context.draggingNodeRect.height) / 2 };
};

export function KanbanColumn({ workspaceId, status, row, column, label, disabled, children }: {
  workspaceId: string; status: TaskEntry["status"]; row: number; column: number; label: string; disabled: boolean; children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: columnId(workspaceId, status), disabled, data: { workspaceId, status, row, column, label } });
  return <div ref={setNodeRef} data-kanban-column data-workspace-id={workspaceId} data-task-status={status} role="region" aria-label={label} className={cn("bg-muted/30 flex min-h-28 flex-col gap-2 rounded-lg border p-2 transition-colors", isOver && "border-primary bg-primary/10")}>{children}</div>;
}
