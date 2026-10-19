import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PACKAGES, checkVersions } from './check-version.mjs';
const fixture = () => ({
  workspace: '[workspace.package]\nversion = "2.0.0"\n[workspace.dependencies]\nother = "1.0.0"',
  manifests: Object.fromEntries(PACKAGES.map(name => [name, `[package]\nname = "${name}"\nversion.workspace = true\n[dependencies]\nother = "1.0.0"`])),
  desktop: { version: '2.0.0' }, tauri: { version: '2.0.0' },
  lock: PACKAGES.map(name => `[[package]]\nname = "${name}"\nversion = "2.0.0"\n`).join('\n'),
});
test('accepts aligned workspace, desktop and lock versions while ignoring dependency versions', () => {
  assert.equal(checkVersions(fixture()), '2.0.0');
});
test('rejects drift or missing versions in either desktop metadata source', () => {
  for (const field of ['desktop', 'tauri']) for (const value of ['1.0.0', undefined]) {
    const input = fixture(); input[field].version = value;
    assert.throws(() => checkVersions(input), /version must equal/);
  }
});
test('rejects stale, missing or duplicate lock entries and independently versioned Rust packages', () => {
  for (const name of PACKAGES) {
    const old = `name = "${name}"\nversion = "2.0.0"`;
    for (const replacement of [`name = "${name}"\nversion = "1.0.0"`, 'name = "unrelated"\nversion = "2.0.0"', `${old}\n[[package]]\n${old}`]) {
      const input = fixture(); input.lock = input.lock.replace(old, replacement);
      assert.throws(() => checkVersions(input), /Cargo.lock/);
    }
    const input = fixture(); input.manifests[name] = input.manifests[name].replace('version.workspace = true', 'version = "2.0.0"');
    assert.throws(() => checkVersions(input), /inherit/);
  }
});
test('fails closed when workspace version is missing or malformed', () => {
  for (const workspace of ['[package]\nversion = "2.0.0"', '[workspace.package]\nversion = "latest"']) {
    assert.throws(() => checkVersions({ ...fixture(), workspace }), /workspace release version/);
  }
});
