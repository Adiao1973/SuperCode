import { useRef } from "react";
import { Dialog } from "radix-ui";
import { Button } from "@/components/ui/button";
export function ConfirmPlanDialog({
  open,
  onOpenChange,
  onConfirm,
  disabled,
  count,
  cwd,
  jobs,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  disabled: boolean;
  count: number;
  cwd: string;
  jobs: number;
}) {
  const submitted = useRef(false);
  const back = useRef<HTMLButtonElement>(null);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (next) submitted.current = false;
        onOpenChange(next);
      }}
    >
      <Dialog.Trigger asChild>
        <Button disabled={disabled}>审阅并执行</Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          className="bg-background text-foreground fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-3rem)] w-[calc(100vw-3rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border p-6 shadow-lg"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            back.current?.focus();
          }}
        >
          <Dialog.Title className="text-lg font-semibold">
            确认执行计划
          </Dialog.Title>
          <Dialog.Description className="mt-3 text-sm text-muted-foreground">
            将启动 {count}{" "}
            个任务，按照依赖顺序执行。请确认已查看各任务的完整提示词。
          </Dialog.Description>
          <p className="mt-3 break-all text-sm">目录：{cwd}</p>
          <p className="mt-2 text-sm">
            并发：{jobs} · 工作空间：默认 · 权限：变更前确认
          </p>
          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button ref={back} variant="outline">
                返回审阅
              </Button>
            </Dialog.Close>
            <Button
              disabled={disabled}
              onClick={() => {
                if (disabled || submitted.current) return;
                submitted.current = true;
                onConfirm();
              }}
            >
              确认执行
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
