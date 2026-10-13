import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { notifySuccess } from "./feedback";
import { invoke } from "@tauri-apps/api/core";
export type ThemePreference = "system" | "light" | "dark";
export interface AppearancePreferences {
  theme: ThemePreference;
}
export interface AppearanceLoad {
  preferences: AppearancePreferences;
  error: string | null;
}
export const SYSTEM_DARK = "(prefers-color-scheme: dark)";
export const getAppearance = () =>
  invoke<AppearancePreferences>("get_appearance_preferences");
export const saveAppearance = (preferences: AppearancePreferences) =>
  invoke<void>("save_appearance_preferences", { preferences }).then(() => { notifySuccess("外观偏好已保存"); });
export function resolveTheme(
  preference: ThemePreference,
  systemDark: boolean,
): "light" | "dark" {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}
export function applyTheme(theme: "light" | "dark") {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}
export async function loadAppearance(timeout = 5000): Promise<AppearanceLoad> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const preferences = await Promise.race([
      getAppearance(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("读取外观偏好超时")),
          timeout,
        );
      }),
    ]);
    return { preferences, error: null };
  } catch (e) {
    return { preferences: { theme: "system" }, error: String(e) };
  } finally {
    clearTimeout(timer);
  }
}
interface AppearanceContextValue extends AppearanceLoad {
  resolved: "light" | "dark";
  busy: boolean;
  choose: (theme: ThemePreference) => Promise<void>;
  retry: () => Promise<void>;
}
const AppearanceContext = createContext<AppearanceContextValue | null>(null);
export function AppearanceProvider({
  initial,
  children,
}: {
  initial: AppearanceLoad;
  children: ReactNode;
}) {
  const [value, setValue] = useState(initial);
  const [systemDark, setSystemDark] = useState(
    () => matchMedia(SYSTEM_DARK).matches,
  );
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const loaded = useRef(initial.error === null);
  const resolved = resolveTheme(value.preferences.theme, systemDark);
  useEffect(() => {
    const media = matchMedia(SYSTEM_DARK);
    const update = () => setSystemDark(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useLayoutEffect(() => {
    applyTheme(resolved);
  }, [resolved]);
  useEffect(() => {
    // Layout effects have applied CSS before the still-hidden native window is shown.
    // Do not await rAF: WebKit can suspend frames for an invisible window.
    let disposed = false;
    void invoke("appearance_ready", {
      dark: resolved === "dark",
      theme: value.preferences.theme,
    }).catch((e) => {
      if (!disposed) setValue((v) => ({ ...v, error: String(e) }));
    });
    return () => {
      disposed = true;
    };
  }, [resolved, value.preferences.theme]);
  const choose = async (theme: ThemePreference) => {
    if (locked.current || !loaded.current) return;
    locked.current = true;
    setBusy(true);
    try {
      const preferences = { theme };
      await saveAppearance(preferences);
      setValue({ preferences, error: null });
    } catch (e) {
      setValue((v) => ({ ...v, error: String(e) }));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  const retry = async () => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    try {
      const result = await loadAppearance();
      loaded.current = result.error === null;
      setValue(result);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  return (
    <AppearanceContext.Provider
      value={{
        ...value,
        resolved,
        busy: busy || !loaded.current,
        choose,
        retry,
      }}
    >
      {children}
    </AppearanceContext.Provider>
  );
}
export function useAppearance() {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error("AppearanceProvider missing");
  return value;
}
