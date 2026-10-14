import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialGraph } from './bundle-budget.mjs';
test('initial graph includes shared transitive imports once, excludes lazy chunks and handles cycles', () => {
  assert.deepEqual(initialGraph({
    app: { isEntry: true, file: 'app.js', imports: ['shared', 'leaf'], dynamicImports: ['heavy'] },
    shared: { file: 'shared.js', imports: ['leaf', 'app'] }, leaf: { file: 'leaf.js' },
    heavy: { file: 'heavy.js' },
  }), ['app.js', 'leaf.js', 'shared.js']);
});
test('invalid build manifests fail closed rather than reporting an empty bundle', () => {
  assert.throws(() => initialGraph({}), /entry/);
  assert.throws(() => initialGraph({ app: { isEntry: true, file: 'app.js', imports: ['missing'] } }), /Missing/);
});
