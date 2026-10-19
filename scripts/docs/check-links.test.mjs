import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkLinks } from './check-links.mjs';

test('encoded paths, Unicode and duplicate headings work; external URLs and fenced examples are excluded', () => {
  const root = mkdtempSync(join(tmpdir(), 'sc-docs-'));
  try {
    writeFileSync(join(root, '中文 文档.md'), '# 中文 标题\n# 中文 标题\n');
    writeFileSync(join(root, 'README.md'), '[一](<中文%20文档.md#中文-标题>)\n[二](中文%20文档.md#中文-标题-1)\n[三](/中文%20文档.md)\n[x](https://example.org)\n~~~md\n[x](missing.md)\n~~~\n');
    assert.deepEqual(checkLinks(root, ['README.md']), { files: 1, links: 3, errors: [] });
  } finally { rmSync(root, { recursive: true }); }
});

test('missing files, missing headings and malformed encoding fail', () => {
  const root = mkdtempSync(join(tmpdir(), 'sc-docs-'));
  try {
    writeFileSync(join(root, 'README.md'), '# Present\n[x](missing.md)\n[y](#absent)\n[z](%ZZ.md)\n');
    const result = checkLinks(root, ['README.md']);
    assert.equal(result.links, 3);
    assert.equal(result.errors.length, 3);
  } finally { rmSync(root, { recursive: true }); }
});
