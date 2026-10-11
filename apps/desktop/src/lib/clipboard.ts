/**
 * 剪贴板写入：优先 Clipboard API；WKWebView 下不可用时退回 execCommand 兜底。
 */

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    const focused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    document.body.appendChild(textarea);
    try {
      textarea.select();
      if (!document.execCommand("copy"))
        throw new Error("Clipboard unavailable");
    } finally {
      textarea.remove();
      focused?.focus({ preventScroll: true });
    }
  }
}
