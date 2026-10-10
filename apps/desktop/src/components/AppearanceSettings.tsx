import { useAppearance, type ThemePreference } from "@/lib/appearance";
import { Button } from "@/components/ui/button";

export function AppearanceSettings() {
  const { preferences, resolved, busy, error, choose, retry } = useAppearance();
  return (
    <section aria-labelledby="appearance-heading" className="border-b pb-5">
      <h2 id="appearance-heading" className="text-sm font-semibold">
        外观
      </h2>
      <div className="mt-3 flex items-center justify-between gap-4">
        <div>
          <label htmlFor="theme-preference" className="text-sm">
            主题
          </label>
          <p className="mt-1 text-xs text-muted-foreground">
            跟随系统，或为此 App 固定外观。
          </p>
        </div>
        <select
          id="theme-preference"
          className="h-9 rounded-md border bg-background px-3 text-sm"
          value={preferences.theme}
          disabled={busy}
          onChange={(e) => void choose(e.target.value as ThemePreference)}
        >
          <option value="system">跟随系统</option>
          <option value="light">浅色</option>
          <option value="dark">深色</option>
        </select>
      </div>
      <p role="status" className="mt-3 text-xs text-muted-foreground">
        {busy
          ? "正在读取或保存…"
          : error
            ? "外观偏好未更新"
            : `已保存到本机 · 当前${resolved === "dark" ? "深色" : "浅色"}`}
      </p>
      {error && (
        <div className="mt-2">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          <Button variant="outline" size="sm" onClick={() => void retry()}>
            重新读取
          </Button>
        </div>
      )}
    </section>
  );
}
