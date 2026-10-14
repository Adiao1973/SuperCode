/** Rendering policy only; original messages stay authoritative in the stream/store. */
export const ACTIVE_MARKDOWN_LIMIT = 8 * 1024;
export const MARKDOWN_LIMIT = 128 * 1024;
export const HIGHLIGHT_LANGUAGES = new Set([
  "js",
  "javascript",
  "ts",
  "typescript",
  "json",
  "py",
  "python",
  "sh",
  "bash",
  "css",
]);
export function safeExternalUrl(value: string): string | null {
  if (!/^https?:\/\//i.test(value) || /[\s\u0000-\u001f\u007f]/.test(value))
    return null;
  try {
    const url = new URL(value);
    return url.hostname && !url.username && !url.password ? value : null;
  } catch {
    return null;
  }
}

/** Use source positions rather than React child text, which normalizes fence endings. */
export function codeSource(
  source: string,
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  },
): string | null {
  if (position?.start.offset == null || position.end.offset == null)
    return null;
  const raw = source.slice(position.start.offset, position.end.offset);
  const opening = /^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/.exec(raw);
  if (!opening) return null;
  // Positions omit a surrounding quote/list indentation on the first line.
  // Remove that continuation prefix from body lines, not from code content itself.
  const lineStart = source.lastIndexOf("\n", position.start.offset - 1) + 1;
  const prefix = source
    .slice(lineStart, position.start.offset)
    .replace(/[-+*] |\d+[.)] /g, (match) => " ".repeat(match.length));
  let body = raw.slice(opening[0].length);
  if (prefix && /^[ >\t]*$/.test(prefix))
    body = body
      .split("\n")
      .map((line) =>
        line.startsWith(prefix) ? line.slice(prefix.length) : line,
      )
      .join("\n");
  const fence = opening[1];
  return body.replace(
    new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*(?:\\r?\\n)?$`, "m"),
    "",
  );
}
export function canHighlight(text: string, language: string): boolean {
  return (
    text.length <= 16 * 1024 &&
    text.split("\n").length - (text.endsWith("\n") ? 1 : 0) <= 200 &&
    HIGHLIGHT_LANGUAGES.has(language)
  );
}
