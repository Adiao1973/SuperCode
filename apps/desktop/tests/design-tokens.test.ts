import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const css = readFileSync("src/index.css", "utf8");
function luminance(hex: string) {
  const c = hex
    .match(/[a-f0-9]{2}/gi)!
    .map((h) => parseInt(h, 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
}
for (const selector of [":root", ".dark"]) {
  it(`${selector} semantic text tokens meet 4.5:1 on their surfaces`, () => {
    const block = css.slice(css.indexOf(`${selector} {`)).split("}")[0];
    const tokens = Object.fromEntries(
      [...block.matchAll(/--([\w-]+):\s*(#[\da-f]{6})/g)].map((m) => [
        m[1],
        m[2],
      ]),
    );
    const pairs = [
      "foreground",
      "muted-foreground",
      "success",
      "warning",
      "destructive",
    ].flatMap((text) =>
      ["background", "card", "muted"].map((background) => [text, background]),
    );
    pairs.push(
      ["primary-foreground", "primary"],
      ["accent-foreground", "accent"],
      ["sidebar-accent-foreground", "sidebar-accent"],
    );
    for (const [text, background] of pairs) {
      const a = luminance(tokens[text]),
        b = luminance(tokens[background]);
      expect(
        (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
        `${text} on ${background}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
}
