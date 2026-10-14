import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

export const BASELINE_GZIP_BYTES = 369794;
export function initialGraph(manifest) {
  const entries = Object.keys(manifest).filter(key => manifest[key].isEntry);
  if (entries.length !== 1) throw new Error('Expected exactly one application entry');
  const seen = new Set();
  const visit = key => {
    if (seen.has(key)) return;
    if (!manifest[key]) throw new Error(`Missing static dependency: ${key}`);
    seen.add(key);
    for (const dependency of manifest[key].imports ?? []) visit(dependency);
  };
  visit(entries[0]);
  return [...new Set([...seen].map(key => manifest[key].file))].sort();
}
export function report(dist) {
  const manifest = JSON.parse(readFileSync(resolve(dist, '.vite/manifest.json'), 'utf8'));
  const measure = files => files.map(file => {
    const raw = readFileSync(resolve(dist, file));
    return { file, rawBytes: raw.length, gzipBytes: gzipSync(raw, { level: 9 }).length };
  });
  const initial = measure(initialGraph(manifest));
  const all = measure([...new Set(Object.values(manifest).map(chunk => chunk.file))].sort());
  const gzipBytes = initial.reduce((sum, file) => sum + file.gzipBytes, 0);
  return { baselineGzipBytes: BASELINE_GZIP_BYTES, budgetGzipBytes: Math.floor(BASELINE_GZIP_BYTES * 1.2),
    gzipBytes, ratio: gzipBytes / BASELINE_GZIP_BYTES, pass: gzipBytes <= BASELINE_GZIP_BYTES * 1.2,
    initial, all };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = report(process.argv[2] ?? 'apps/desktop/dist');
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`Initial gzip JS: ${result.gzipBytes} / ${result.budgetGzipBytes} bytes (${result.initial.length} files): ${result.pass ? 'PASS' : 'FAIL'}`);
  if (!result.pass) process.exitCode = 1;
}
