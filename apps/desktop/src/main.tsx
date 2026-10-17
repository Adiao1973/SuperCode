import React from "react";
import ReactDOM from "react-dom/client";
import { flushSync } from "react-dom";
import App from "./App";
import { invoke } from "@tauri-apps/api/core";
import { FeedbackToast } from "./components/FeedbackState";
import { LayoutProvider, loadLayout } from "./lib/layout";
import {
  AppearanceProvider,
  applyTheme,
  loadAppearance,
  resolveTheme,
  SYSTEM_DARK,
} from "./lib/appearance";
import {
  MotionProvider,
  loadMotion,
  applyMotion,
  resolveMotion,
  SYSTEM_REDUCE,
} from "./lib/motion";
import "./index.css";

async function start() {
  const bootstrap = (window as Window & { __SUPERCODE_BOOTSTRAP?: {
    appearance: Awaited<ReturnType<typeof loadAppearance>>;
    motion: Awaited<ReturnType<typeof loadMotion>>;
    layout: Awaited<ReturnType<typeof loadLayout>>;
    windowReady?: Promise<void>;
    windowThemeKey?: string;
  } }).__SUPERCODE_BOOTSTRAP;
  const [initial, motion, layout] = bootstrap
    ? [bootstrap.appearance, bootstrap.motion, bootstrap.layout]
    : await Promise.all([
    loadAppearance(),
    loadMotion(),
    loadLayout(),
  ]);
  applyMotion(
    resolveMotion(motion.preferences.motion, matchMedia(SYSTEM_REDUCE).matches),
  );
  applyTheme(
    resolveTheme(initial.preferences.theme, matchMedia(SYSTEM_DARK).matches),
  );
  const dark = resolveTheme(initial.preferences.theme, matchMedia(SYSTEM_DARK).matches) === "dark";
  const windowReady = bootstrap?.windowThemeKey === `${initial.preferences.theme}:${dark}` && bootstrap.windowReady
    ? bootstrap.windowReady
    : invoke<void>("appearance_ready", {
    dark,
    theme: initial.preferences.theme,
  });
  // Observe rejection immediately; the provider presents it after mounting.
  void windowReady.catch(() => {});
  flushSync(() => ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <MotionProvider initial={motion}>
        <AppearanceProvider initial={initial} windowReady={windowReady} windowReadyKey={`${initial.preferences.theme}:${dark ? "dark" : "light"}`}>
          <LayoutProvider initial={layout}>
            <App />
            <FeedbackToast />
          </LayoutProvider>
        </AppearanceProvider>
      </MotionProvider>
    </React.StrictMode>,
  ));
}
void start();
