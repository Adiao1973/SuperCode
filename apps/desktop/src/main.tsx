import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
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
  const [initial, motion] = await Promise.all([loadAppearance(), loadMotion()]);
  applyMotion(
    resolveMotion(motion.preferences.motion, matchMedia(SYSTEM_REDUCE).matches),
  );
  applyTheme(
    resolveTheme(initial.preferences.theme, matchMedia(SYSTEM_DARK).matches),
  );
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <MotionProvider initial={motion}>
        <AppearanceProvider initial={initial}>
          <App />
        </AppearanceProvider>
      </MotionProvider>
    </React.StrictMode>,
  );
}
void start();
