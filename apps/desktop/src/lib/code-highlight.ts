/** Separate lazy entry: no grammar or highlighting engine in the initial render path. */
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
export interface HighlightToken {
  content: string;
  light: string;
  dark: string;
}
const highlighter = createHighlighterCore({
  engine: createJavaScriptRegexEngine(),
  themes: [
    import("shiki/themes/github-light.mjs"),
    import("shiki/themes/github-dark.mjs"),
  ],
  langs: [
    import("shiki/langs/javascript.mjs"),
    import("shiki/langs/typescript.mjs"),
    import("shiki/langs/json.mjs"),
    import("shiki/langs/python.mjs"),
    import("shiki/langs/bash.mjs"),
    import("shiki/langs/css.mjs"),
  ],
});
export async function highlightCode(
  text: string,
  lang: string,
): Promise<HighlightToken[][]> {
  const h = await highlighter;
  return h
    .codeToTokensWithThemes(text, {
      lang,
      themes: { light: "github-light", dark: "github-dark" },
    })
    .map((line) =>
      line.map((token) => ({
        content: token.content,
        light: token.variants.light.color ?? "inherit",
        dark: token.variants.dark.color ?? "inherit",
      })),
    );
}
