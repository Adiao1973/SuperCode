// Native initialization script: UI preferences only, before the application bundle.
(() => {
  const snapshot = window.__SUPERCODE_BOOTSTRAP;
  // Full WebView reloads must reread saved preferences instead of replaying a stale snapshot.
  if (snapshot.bootNonce) {
    try {
      if (sessionStorage.getItem("supercode.ui-bootstrap") === snapshot.bootNonce) {
        delete window.__SUPERCODE_BOOTSTRAP;
        return;
      }
      sessionStorage.setItem("supercode.ui-bootstrap", snapshot.bootNonce);
    } catch {
      delete window.__SUPERCODE_BOOTSTRAP;
      return; // main.tsx can still load through the SDK if session storage is unavailable.
    }
  }
  const prepare = () => {
    const root = document.documentElement;
    if (!root) return false;
    const theme = snapshot.appearance.preferences.theme;
    const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    root.classList.toggle("dark", dark);
    root.dataset.theme = dark ? "dark" : "light";
    root.style.colorScheme = dark ? "dark" : "light";
    const motion = snapshot.motion.preferences.motion;
    root.dataset.motion = motion === "reduce" || (motion === "system" && matchMedia("(prefers-reduced-motion: reduce)").matches) ? "reduce" : "full";
    // Guard the bridge so a changed runtime can fall back to the SDK in main.tsx.
    const bridge = window.__TAURI_INTERNALS__;
    if (bridge?.invoke) {
      snapshot.windowThemeKey = `${theme}:${dark}`;
      snapshot.windowReady = bridge.invoke("appearance_ready", { dark, theme });
      void snapshot.windowReady.catch(() => {});
    }
    return true;
  };
  if (!prepare()) {
    const observer = new MutationObserver(() => { if (prepare()) observer.disconnect(); });
    observer.observe(document, { childList: true, subtree: true });
  }
})();
