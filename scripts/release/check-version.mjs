import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PACKAGES = ['supercode-core', 'supercode-cli', 'supercode-desktop'];
export function checkVersions({ workspace, manifests, desktop, tauri, lock }) {
  const section = workspace.split(/^\[workspace\.package\]\s*$/m)[1]?.split(/^\[/m)[0];
  const version = section?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('Missing or invalid workspace release version');
  }
  for (const [label, value] of [['desktop package', desktop.version], ['Tauri config', tauri.version]]) {
    if (value !== version) throw new Error(`${label} version must equal workspace ${version}`);
  }
  const packages = lock.split(/^\[\[package\]\]\s*$/m).slice(1).map(block => ({
    name: block.match(/^name\s*=\s*"([^"]+)"\s*$/m)?.[1],
    version: block.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1],
  }));
  for (const name of PACKAGES) {
    const manifest = manifests[name]?.split(/^\[package\]\s*$/m)[1]?.split(/^\[/m)[0];
    if (!manifest?.match(/^version\.workspace\s*=\s*true\s*$/m)) {
      throw new Error(`${name} must inherit workspace version`);
    }
    const entries = packages.filter(p => p.name === name);
    if (entries.length !== 1 || entries[0].version !== version) {
      throw new Error(`${name} Cargo.lock version must equal workspace ${version}`);
    }
  }
  return version;
}
export function checkRepository(root = '.') {
  const read = path => readFileSync(resolve(root, path), 'utf8');
  return checkVersions({
    workspace: read('Cargo.toml'),
    manifests: {
      'supercode-core': read('crates/core/Cargo.toml'),
      'supercode-cli': read('crates/cli/Cargo.toml'),
      'supercode-desktop': read('apps/desktop/src-tauri/Cargo.toml'),
    },
    desktop: JSON.parse(read('apps/desktop/package.json')),
    tauri: JSON.parse(read('apps/desktop/src-tauri/tauri.conf.json')),
    lock: read('Cargo.lock'),
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(`Release version consistency: ${checkRepository()} PASS`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
