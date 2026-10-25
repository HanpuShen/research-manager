import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildCodeGraph } from '../src/integrations/code-map.js';

test('Generic static maps rebuild from current syntax without semantic annotations', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'static-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'main.py'), 'def original(): return 1\n');
  const original = await buildCodeGraph(root, 'data');
  await writeFile(path.join(root, 'main.py'), 'def changed(): return 2\n');
  const changed = await buildCodeGraph(root, 'data');
  assert.notEqual(changed.revision, original.revision);
  assert.equal(changed.stale, false);
  assert.ok(changed.nodes.some(node => node.label === 'changed'));
  assert.ok(changed.nodes.every(node => !node.description?.includes('Description reviewed against')));
});
