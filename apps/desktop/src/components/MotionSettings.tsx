import { useMotionPreference, type MotionPreference } from "@/lib/motion";
import { Button } from "@/components/ui/button";
export function MotionSettings() {
  const { preferences, reduced, busy, error, choose, retry } =
    useMotionPreference();
  return (
    <section aria-label="动效偏好" className="border-b pb-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <label htmlFor="motion-preference" className="text-sm">
            动效
          </label>
          <p className="mt-1 text-xs text-muted-foreground">
            减少动态会关闭位移、闪动与旋转效果。
          </p>
        </div>
        <select
          id="motion-preference"
          className="h-9 rounded-md border bg-background px-3 text-sm"
          value={preferences.motion}
          disabled={busy}
          onChange={(e) => void choose(e.target.value as MotionPreference)}
        >
          <option value="system">跟随系统</option>
          <option value="reduce">减少</option>
          <option value="full">完整</option>
        </select>
      </div>
      <p role="status" className="mt-3 text-xs text-muted-foreground">
        {busy
          ? "正在读取或保存…"
          : error
            ? "动效偏好未更新"
            : `已保存到本机 · 当前${reduced ? "减少动态" : "完整动效"}`}
      </p>
      {error && (
        <div className="mt-2">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          <Button variant="outline" size="sm" onClick={() => void retry()}>
            重新读取动效
          </Button>
        </div>
      )}
    </section>
  );
}
