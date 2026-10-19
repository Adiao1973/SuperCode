import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function anchors(markdown) {
  const counts = new Map();
  return new Set([...markdown.matchAll(/^ {0,3}#{1,6}\s+(.+?)\s*#*$/gm)].map(([, text]) => {
    const slug = text.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-');
    const count = counts.get(slug) ?? 0;
    counts.set(slug, count + 1);
    return count ? `${slug}-${count}` : slug;
  }));
}

export function withoutFences(markdown) {
  let fence;
  return markdown.split('\n').map(line => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (marker && !fence) { fence = marker[1]; return ''; }
    if (marker && fence && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
      fence = undefined;
      return '';
    }
    return fence ? '' : line;
  }).join('\n');
}

export function checkLinks(root, files) {
  const errors = [];
  let links = 0;
  const cache = new Map();
  for (const file of files) {
    const source = withoutFences(readFileSync(resolve(root, file), 'utf8'));
    // Repository docs use inline Markdown links; URI schemes are external and not requested.
    for (const match of source.matchAll(/!?\[[^\]\n]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^\n]*?["'])?\s*\)/g)) {
      const target = match[1] ?? match[2];
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) continue;
      links++;
      let decoded;
      try { decoded = decodeURIComponent(target); }
      catch { errors.push(`${file}: invalid URL encoding: ${target}`); continue; }
      const [path, fragment] = decoded.split('#');
      const absolute = path ? resolve(path.startsWith('/') ? root : dirname(resolve(root, file)), path.replace(/^\//, '')) : resolve(root, file);
      if (!existsSync(absolute)) { errors.push(`${file}: missing target: ${target}`); continue; }
      if (fragment && /\.md$/i.test(absolute)) {
        if (!cache.has(absolute)) cache.set(absolute, anchors(withoutFences(readFileSync(absolute, 'utf8'))));
        if (!cache.get(absolute).has(fragment)) errors.push(`${file}: missing heading: ${target}`);
      }
    }
  }
  return { files: files.length, links, errors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.md'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))].sort();
  const result = checkLinks(root, files);
  if (result.errors.length) {
    console.error(result.errors.join('\n'));
    process.exitCode = 1;
  } else console.log(`Documentation links: ${result.files} Markdown files, ${result.links} local links PASS`);
}
