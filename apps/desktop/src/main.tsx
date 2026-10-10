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
import "./index.css";

async function start() {
  const initial = await loadAppearance();
  applyTheme(
    resolveTheme(initial.preferences.theme, matchMedia(SYSTEM_DARK).matches),
  );
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <AppearanceProvider initial={initial}>
        <App />
      </AppearanceProvider>
    </React.StrictMode>,
  );
}
void start();
