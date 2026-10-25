import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ResearchStore } from '../src/store.js';
import { readEntityPreview } from '../src/previews.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
async function fixture(t: any) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'research-preview-'));
  const store = await new ResearchStore(path.join(root, 'memory'), path.join(root, 'cache')).init();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const file = async (name: string, contents: string | Buffer) => {
    const location = path.join(root, name); await mkdir(path.dirname(location), { recursive: true }); await writeFile(location, contents); return location;
  };
  return { root, store, file };
}

test('experiment preview includes direct evidence and observations without inheriting another experiment through a claim', async t => {
  const { store, file } = await fixture(t);
  const csv = await file('results/summary.csv', 'seed,score\n0,0.8\n');
  const experiment = await store.create({ id: 'experiment-one', kind: 'Experiment', title: 'Comparison', body: '## Setup\nUse the fixed seed.', links: [{ target: 'claim-shared', relation: 'tests' }, { target: 'artifact-one', relation: 'produced' }] });
  await store.create({ id: 'artifact-one', kind: 'Artifact', title: 'Results', sources: [{ path: csv }] });
  await store.create({ id: 'note-one', kind: 'Note', title: 'Observation', metadata: { role: 'Observation' }, links: [{ target: experiment.id, relation: 'discusses' }] });
  await store.create({ id: 'claim-shared', kind: 'Claim', title: 'Shared claim', links: [{ target: 'artifact-other', relation: 'evidence' }] });
  await store.create({ id: 'artifact-other', kind: 'Artifact', title: 'Unrelated result' });
  const originals = await Promise.all(store.list().map(record => readFile(record.filePath!, 'utf8')));
  const result = await readEntityPreview(store, experiment.id);
  assert.deepEqual(result.records.map(record => record.entity.id), ['experiment-one', 'artifact-one', 'note-one']);
  assert.equal(result.records[0].entity.body, experiment.body);
  assert.deepEqual(result.records[1].sources[0].rows, [['0', '0.8']]);
  assert.deepEqual(await Promise.all(store.list().map(record => readFile(record.filePath!, 'utf8'))), originals);
  assert.deepEqual((await readEntityPreview(store, 'claim-shared')).records.map(record => record.entity.id), ['claim-shared']);
});

test('CSV and TSV previews preserve quoted commas, quotes, multiline cells and enforce row and column limits', async t => {
  const { store, file } = await fixture(t);
  const quoted = await file('quoted.csv', '\uFEFFseed,note,score\r\n0,"comma, and ""quote""",0.7\r\n1,"two\nlines",0.9\r\n');
  const tsv = await file('sample.tsv', 'name\tvalue\ncontrol\t2\n');
  const long = await file('long.csv', Array.from({ length: 103 }, (_, row) => Array.from({ length: 34 }, (_, col) => `r${row}c${col}`).join(',')).join('\n'));
  await store.create({ id: 'artifact-table', kind: 'Artifact', title: 'Tables', sources: [{ path: quoted }, { path: tsv }, { path: long }] });
  const sources = (await readEntityPreview(store, 'artifact-table')).records[0].sources;
  assert.deepEqual(sources.find(source => source.source.path === quoted)?.rows, [['0', 'comma, and "quote"', '0.7'], ['1', 'two\nlines', '0.9']]);
  assert.deepEqual(sources.find(source => source.source.path === tsv)?.rows, [['control', '2']]);
  const bounded = sources.find(source => source.source.path === long)!;
  assert.equal(bounded.rows?.length, 100); assert.equal(bounded.columns?.length, 30); assert.equal(bounded.truncated, true);
  assert.match(bounded.message!, /complete data/);
});

test('Markdown resolves record and document images, blocks traversal and symlink escapes, and never fetches remote images', async t => {
  const { store, file } = await fixture(t);
  const inline = await file('memory/assets/setup.png', png), document = await file('documents/result.md', '![Reference][plot]\n\n[plot]: ./result.png\n\n![Blocked](../outside.png)\n![Remote](https://example.invalid/a.png)');
  await file('documents/result.png', png); const outside = await file('outside.png', png);
  await symlink(outside, path.join(store.root, 'assets', 'escape.png'));
  const body = `## Setup\n![Setup](../assets/setup.png)\n![Absolute](${inline})\n![Escape](../assets/escape.png)\n![Traversal](../../outside.png)\n![Bad](javascript:alert)\n`;
  await store.create({ id: 'experiment-images', kind: 'Experiment', title: 'Images', body, sources: [{ path: document }] });
  const preview = (await readEntityPreview(store, 'experiment-images')).records[0];
  assert.deepEqual(Object.keys(preview.images!).sort(), ['../assets/setup.png', inline].sort());
  assert.match(preview.images!['../assets/setup.png'], /^data:image\/png;base64,/);
  assert.equal(preview.entity.body, body.trim());
  assert.match(preview.sources.find(source => source.source.label === 'Embedded images')?.message!, /outside the declared/);
  const markdown = preview.sources.find(source => source.source.path === document)!;
  assert.equal(markdown.kind, 'markdown'); assert.deepEqual(Object.keys(markdown.images!), ['./result.png']);
  assert.match(markdown.message!, /Remote images are not loaded/);
});

test('artifact folder and figure inventory discover composite images with captions and roles without reading panel copies or outside files', async t => {
  const { root, store, file } = await fixture(t);
  const folder = path.join(root, 'figures');
  const composite = await file('figures/oracle_setup/oracle_setup.png', png);
  const panel = await file('figures/oracle_setup/panel_a.png', png);
  const secret = await file('outside.png', png);
  const summary = await file('figures/summary.csv', 'method,score\nbaseline,0.7\n');
  const inventory = await file('figures/figure_inventory.json', JSON.stringify([
    { name: 'oracle_setup', kind: 'setup', title: 'Oracle geometry | setup', caption: 'Design only; no measured results.', readingGuide: 'Compare the input and output axes.', artifacts: [{ path: composite }, { path: panel }] },
    { name: 'outside', kind: 'result', artifacts: [{ path: secret }] },
  ]));
  await file('figures/unlisted/nested.png', png);
  await store.create({ id: 'artifact-figures', kind: 'Artifact', title: 'Shared figures', metadata: { path: folder }, sources: [{ path: inventory }] });
  const sources = (await readEntityPreview(store, 'artifact-figures')).records[0].sources;
  const figure = sources.find(source => source.source.path === composite)!;
  assert.equal(figure.readingGuide, 'Compare the input and output axes.'); assert.equal(figure.kind, 'image'); assert.equal(figure.role, 'setup'); assert.equal(figure.caption, 'Design only; no measured results.');
  assert.match(figure.group!, /Shared figure collection/); assert.equal(sources.find(source => source.source.path === summary)?.kind, 'table');
  assert.ok(!sources.some(source => source.source.path === panel || source.source.path === secret || source.source.path?.endsWith('nested.png')));
  assert.match(sources.find(source => source.source.path === inventory)?.text!, /2 entries/);
  await store.create({ id: 'artifact-explicit-figure', kind: 'Artifact', title: 'Direct image with guide', sources: [{ path: composite }, { path: inventory }] });
  const explicit = (await readEntityPreview(store, 'artifact-explicit-figure')).records[0].sources.find(source => source.source.path === composite)!;
  assert.equal(explicit.readingGuide, 'Compare the input and output axes.');
});

test('export inventory reads bounded declared artifacts and JSON data is displayed as a table when rectangular', async t => {
  const { root, store, file } = await fixture(t);
  const nested = await file('outputs/nested/summary.json', JSON.stringify([{ seed: 0, score: 0.9 }, { seed: 1, score: 0.8 }]));
  const config = await file('outputs/config.json', JSON.stringify({ seed: 0, steps: 5000 }));
  const inventory = await file('outputs/export-inventory.json', JSON.stringify({ files: [{ export: nested }, { relativePath: 'config.json' }] }));
  await store.create({ id: 'artifact-export', kind: 'Artifact', title: 'Export', sources: [{ path: inventory }], metadata: { path: path.join(root, 'outputs') } });
  const sources = (await readEntityPreview(store, 'artifact-export')).records[0].sources;
  assert.deepEqual(sources.find(source => source.source.path === nested)?.columns, ['seed', 'score']);
  assert.deepEqual(sources.find(source => source.source.path === nested)?.rows, [['0', '0.9'], ['1', '0.8']]);
  assert.deepEqual(sources.find(source => source.source.path === config)?.rows, [['seed', '0'], ['steps', '5000']]);
});

test('missing, malformed, unsupported and large files remain visible with bounded content', async t => {
  const { root, store, file } = await fixture(t);
  const bad = await file('bad.json', '{malformed');
  const svg = await file('unsafe.svg', '<svg onload="alert(1)"/>');
  const oversized = await file('large.png', Buffer.concat([png, Buffer.alloc(3 * 1024 * 1024)]));
  const text = await file('large.log', 'a'.repeat(300 * 1024));
  const binary = await file('fake.png', '<script>bad</script>');
  await store.create({ id: 'artifact-errors', kind: 'Artifact', title: 'Errors', sources: [bad, svg, oversized, text, binary, path.join(root, 'missing.csv')].map(location => ({ path: location })) });
  const sources = (await readEntityPreview(store, 'artifact-errors')).records[0].sources;
  assert.equal(sources.find(source => source.source.path === bad)?.kind, 'error');
  assert.equal(sources.find(source => source.source.path === svg)?.kind, 'unsupported');
  assert.match(sources.find(source => source.source.path === oversized)?.message!, /3 MB/);
  assert.match(sources.find(source => source.source.path === binary)?.message!, /signature/);
  assert.match(sources.find(source => source.source.path?.endsWith('missing.csv'))?.message!, /missing/);
  const limited = sources.find(source => source.source.path === text)!;
  assert.equal(limited.truncated, true); assert.equal(limited.text?.length, 256 * 1024);
});

test('a large attachment collection stops at the request limit and remains explicitly incomplete', async t => {
  const { store, file } = await fixture(t);
  const files = await Promise.all(Array.from({ length: 45 }, (_, index) => file(`attachments/${index}.csv`, 'seed,score\n0,0.8\n')));
  await store.create({ id: 'artifact-many', kind: 'Artifact', title: 'Many results', sources: files.map(location => ({ path: location })) });
  const preview = await readEntityPreview(store, 'artifact-many');
  assert.equal(preview.truncated, true); assert.equal(preview.records[0].sources.length, 30);
  assert.equal(preview.records[0].entity.sources.length, 45);
});
