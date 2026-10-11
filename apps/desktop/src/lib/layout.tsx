import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
export interface LayoutPreferences {
  session_list_width: number;
  session_list_collapsed: boolean;
  terminal_height: number;
  terminal_collapsed: boolean;
}
export const DEFAULT_LAYOUT: LayoutPreferences = {
  session_list_width: 224,
  session_list_collapsed: false,
  terminal_height: 224,
  terminal_collapsed: false,
};
export interface LayoutLoad {
  preferences: LayoutPreferences;
  error: string | null;
}
export async function loadLayout(timeout = 5000): Promise<LayoutLoad> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const preferences = await Promise.race([
      invoke<LayoutPreferences>("get_layout_preferences"),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("读取分栏偏好超时")),
          timeout,
        );
      }),
    ]);
    if (!validLayout(preferences)) throw new Error("分栏偏好格式无效");
    return { preferences, error: null };
  } catch (e) {
    return { preferences: DEFAULT_LAYOUT, error: String(e) };
  } finally {
    clearTimeout(timer);
  }
}
export function validLayout(p: LayoutPreferences) {
  return (
    p &&
    Number.isInteger(p.session_list_width) &&
    p.session_list_width >= 180 &&
    p.session_list_width <= 400 &&
    Number.isInteger(p.terminal_height) &&
    p.terminal_height >= 96 &&
    p.terminal_height <= 360 &&
    typeof p.session_list_collapsed === "boolean" &&
    typeof p.terminal_collapsed === "boolean"
  );
}
interface LayoutContextValue extends LayoutLoad {
  busy: boolean;
  update: (patch: Partial<LayoutPreferences>) => void;
  retry: () => Promise<void>;
}
const Context = createContext<LayoutContextValue | null>(null);
export function LayoutProvider({
  initial,
  children,
}: {
  initial: LayoutLoad;
  children: ReactNode;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const desired = useRef(initial.preferences);
  const loaded = useRef(initial.error === null);
  const saving = useRef(false);
  const queued = useRef<LayoutPreferences | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const flush = async () => {
    if (saving.current || !loaded.current) return;
    saving.current = true;
    setBusy(true);
    try {
      while (queued.current) {
        const snapshot = queued.current;
        queued.current = null;
        await invoke("save_layout_preferences", { preferences: snapshot });
      }
      if (mounted.current) setValue((v) => ({ ...v, error: null }));
    } catch (e) {
      queued.current = desired.current;
      if (mounted.current) setValue((v) => ({ ...v, error: String(e) }));
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const update = (patch: Partial<LayoutPreferences>) => {
    if (!loaded.current) return;
    const next = { ...desired.current, ...patch };
    if (
      !validLayout(next) ||
      JSON.stringify(next) === JSON.stringify(desired.current)
    )
      return;
    desired.current = next;
    setValue((v) => ({ ...v, preferences: next }));
    queued.current = next;
    void flush();
  };
  const retry = async () => {
    if (saving.current) return;
    if (loaded.current) {
      queued.current = desired.current;
      await flush();
      return;
    }
    saving.current = true;
    setBusy(true);
    try {
      const next = await loadLayout();
      if (mounted.current) {
        desired.current = next.preferences;
        loaded.current = next.error === null;
        setValue(next);
      }
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <Context.Provider value={{ ...value, busy, update, retry }}>
      {children}
    </Context.Provider>
  );
}
export function useLayoutPreferences() {
  const value = useContext(Context);
  if (!value) throw new Error("LayoutProvider missing");
  return value;
}
export function LayoutNotice() {
  const { error, busy, retry } = useLayoutPreferences();
  return error ? (
    <div
      role="alert"
      className="text-destructive flex items-center gap-2 px-3 py-1 text-xs"
    >
      <span>分栏偏好未同步：{error}</span>
      <button disabled={busy} onClick={() => void retry()}>
        重试
      </button>
    </div>
  ) : null;
}
