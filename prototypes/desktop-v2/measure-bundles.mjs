// Same Vite/minifier/React fixture for candidate size comparison. No UI automation.
import { build } from "vite";
import { gzipSync } from "node:zlib";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
const root = import.meta.dirname;
const tmp = resolve(root, ".bundle-probe");
await mkdir(tmp, { recursive: true });
const results = [];
try {
  for (const engine of ["baseline", "streamdown", "react-markdown"]) {
    const extra =
      engine === "streamdown"
        ? "import {Streamdown as Renderer} from 'streamdown';"
        : engine === "react-markdown"
          ? "import Renderer from 'react-markdown';import gfm from 'remark-gfm';"
          : "";
    const component =
      engine === "baseline"
        ? "React.createElement('pre',null,text)"
        : `React.createElement(Renderer,${engine === "react-markdown" ? "{remarkPlugins:[gfm]}" : "{controls:false,animated:false}"},text)`;
    const input = resolve(tmp, "entry.jsx");
    await writeFile(
      input,
      `import React from 'react';import{createRoot}from'react-dom/client';${extra}const text='## 中文\\n\\n未闭合代码：\\n\\n'+String.fromCharCode(96).repeat(3)+'ts\\nconst ok = true';createRoot(document.getElementById('root')).render(${component});`,
    );
    const bundle = await build({
      root,
      configFile: false,
      logLevel: "silent",
      build: { write: false, rollupOptions: { input } },
    });
    const outputs = (Array.isArray(bundle) ? bundle : [bundle])
      .flatMap((x) => x.output)
      .filter((x) => x.type === "chunk");
    results.push({
      engine,
      jsFiles: outputs.length,
      rawBytes: outputs.reduce((n, x) => n + Buffer.byteLength(x.code), 0),
      gzipBytes: outputs.reduce(
        (n, x) => n + gzipSync(x.code, { level: 9, mtime: 0 }).length,
        0,
      ),
    });
  }
  console.log(
    JSON.stringify(
      {
        method:
          "Isolated static minimal React 19.3.0 renderer, Vite 8.3.1 production defaults, gzip level9, no CSS/fonts; not product entry budget",
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(tmp, { recursive: true, force: true });
}
