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
import {
  LazyMotion,
  MotionConfig,
  AnimatePresence,
  useIsPresent,
} from "motion/react";
import * as m from "motion/react-m";

export type MotionPreference = "system" | "reduce" | "full";
export interface MotionPreferences {
  motion: MotionPreference;
}
export interface MotionLoad {
  preferences: MotionPreferences;
  error: string | null;
}
export const SYSTEM_REDUCE = "(prefers-reduced-motion: reduce)";
export const motionTokens = {
  micro: 0.12,
  presence: 0.18,
  ease: [0.2, 0, 0, 1] as [number, number, number, number],
};
export const resolveMotion = (preference: MotionPreference, system: boolean) =>
  preference === "reduce" || (preference === "system" && system);
export function applyMotion(reduced: boolean) {
  document.documentElement.dataset.motion = reduced ? "reduce" : "full";
}
export async function loadMotion(timeout = 5000): Promise<MotionLoad> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const preferences = await Promise.race([
      invoke<MotionPreferences>("get_motion_preferences"),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("读取动效偏好超时")),
          timeout,
        );
      }),
    ]);
    return { preferences, error: null };
  } catch (e) {
    return { preferences: { motion: "reduce" }, error: String(e) };
  } finally {
    clearTimeout(timer);
  }
}
interface MotionContextValue extends MotionLoad {
  reduced: boolean;
  ready: boolean;
  busy: boolean;
  choose: (motion: MotionPreference) => Promise<void>;
  retry: () => Promise<void>;
}
const Context = createContext<MotionContextValue | null>(null);
// One shared promise. A failed optional feature load leaves content static and usable.
let features:
  | Promise<(typeof import("./motion-features"))["default"]>
  | undefined;
const loadFeatures = () =>
  (features ??= import("./motion-features").then((value) => value.default));
export function MotionProvider({
  initial,
  children,
}: {
  initial: MotionLoad;
  children: ReactNode;
}) {
  const [value, setValue] = useState(initial);
  const [system, setSystem] = useState(() => matchMedia(SYSTEM_REDUCE).matches);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const locked = useRef(false);
  const loaded = useRef(initial.error === null);
  const reduced = resolveMotion(value.preferences.motion, system);
  useLayoutEffect(() => {
    applyMotion(reduced);
  }, [reduced]);
  useEffect(() => {
    const media = matchMedia(SYSTEM_REDUCE);
    const update = () => setSystem(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const lazyFeatures = useRef(async () => {
    try {
      const bundle = await loadFeatures();
      setReady(true);
      return bundle;
    } catch {
      // No feature is required to render or operate the app. Keep notices static.
      return new Promise<never>(() => {});
    }
  }).current;
  const choose = async (motion: MotionPreference) => {
    if (locked.current || !loaded.current) return;
    locked.current = true;
    setBusy(true);
    try {
      const preferences = { motion };
      await invoke("save_motion_preferences", { preferences });
      notifySuccess("动效偏好已保存");
      setValue({ preferences, error: null });
    } catch (e) {
      setValue((old) => ({ ...old, error: String(e) }));
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
      const result = await loadMotion();
      loaded.current = result.error === null;
      setValue(result);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  return (
    <Context.Provider
      value={{
        ...value,
        reduced,
        ready,
        busy: busy || !loaded.current,
        choose,
        retry,
      }}
    >
      <MotionConfig
        reducedMotion={reduced ? "always" : "never"}
        transition={{
          duration: motionTokens.presence,
          ease: motionTokens.ease,
        }}
      >
        <LazyMotion features={lazyFeatures} strict>
          {children}
        </LazyMotion>
      </MotionConfig>
    </Context.Provider>
  );
}
export function useMotionPreference() {
  const context = useContext(Context);
  if (!context) throw new Error("MotionProvider missing");
  return context;
}
function NoticeText({ children }: { children: ReactNode }) {
  const present = useIsPresent();
  return (
    <m.span
      data-motion-notice
      className="inline-block"
      aria-hidden={!present || undefined}
      style={{ pointerEvents: "none" }}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
    >
      {children}
    </m.span>
  );
}
/** Noninteractive feedback only: never wrap execution hosts, approvals or cancel controls. */
export function MotionNotice({
  visible,
  children,
}: {
  visible: boolean;
  children: ReactNode;
}) {
  const { reduced, ready } = useMotionPreference();
  if (reduced || !ready)
    return visible ? (
      <span
        data-motion-notice
        className="inline-block"
        style={{ pointerEvents: "none" }}
      >
        {children}
      </span>
    ) : null;
  return (
    <AnimatePresence initial={false}>
      {visible && <NoticeText key="notice">{children}</NoticeText>}
    </AnimatePresence>
  );
}
