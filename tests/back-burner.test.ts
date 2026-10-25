import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ResearchStore } from '../src/store.js';
import { ResearchService } from '../src/service.js';
import { canBackBurner, isBackBurner } from '../src/workflow.js';
import type { Entity } from '../src/types.js';

const execute = promisify(execFile);
const edit = (entity: Entity) => ({ expectedRevision: entity.revision, expectedHash: entity.contentHash!, actor: 'agent' as const });
async function fixture(t: any) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'research-back-burner-'));
  const store = await new ResearchStore(path.join(directory, 'memory'), path.join(directory, 'cache')).init();
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store };
}

test('Back burner survives reindex and cache rebuild, shares placement across projects, and preserves every cycle', async t => {
  const { store, directory } = await fixture(t);
  const original = await store.create({ id: 'idea-shared', kind: 'Idea', title: 'Shared direction', status: 'Exploring', body: 'Compare two useful approaches.', projectIds: ['project-a', 'project-b'], sources: [{ path: '/notes/discussion.md', line: 12 }], links: [{ target: 'experiment-a', relation: 'tested_by' }], metadata: { priority: 'low' } });
  const parked = await store.setBackBurner(original.id, true, 'Waiting for more compute', edit(original));
  assert.equal(parked.status, original.status);
  assert.equal(parked.body, original.body);
  assert.deepEqual(parked.sources, original.sources);
  assert.deepEqual(parked.links, original.links);
  assert.equal(parked.metadata.priority, 'low');
  for (const project of original.projectIds) {
    assert.equal(isBackBurner(store.list(project)[0]), true);
    assert.equal(store.search('two useful', project)[0].id, original.id);
    const handoff = store.fullHandoff(project).records[0];
    assert.equal(handoff.placement, 'Back burner');
    assert.equal(handoff.metadata.backBurner.reason, 'Waiting for more compute');
  }
  const restored = await store.setBackBurner(original.id, false, '', { ...edit(parked), actor: 'human' });
  assert.equal(isBackBurner(restored), false);
  assert.equal(restored.status, original.status);
  assert.equal(restored.metadata.backBurner.reason, parked.metadata.backBurner.reason);
  assert.equal(restored.metadata.backBurner.at, parked.metadata.backBurner.at);
  assert.equal(restored.metadata.backBurner.by, 'agent');
  assert.equal(restored.metadata.backBurner.restoredBy, 'human');
  const parkedAgain = await store.setBackBurner(original.id, true, 'Waiting for comparison data', edit(restored));
  assert.equal(parkedAgain.metadata.backBurner.restoredAt, undefined);
  await store.reindex();
  const rebuilt = await new ResearchStore(store.root, path.join(directory, 'rebuilt-cache')).init();
  try { assert.deepEqual(rebuilt.get(original.id), parkedAgain); } finally { rebuilt.close(); }
  const histories = await Promise.all((await readdir(path.join(store.root, 'history', original.id))).map(file => readFile(path.join(store.root, 'history', original.id, file), 'utf8')));
  assert.equal(histories.length, 3);
  assert.ok(histories.some(raw => /active: true/.test(raw) && /Waiting for more compute/.test(raw)));
  assert.ok(histories.some(raw => /active: false/.test(raw) && /restoredBy: human/.test(raw)));
});

test('Shelving experiments preserves accepted claims, artifact hashes, results, and all run files', async t => {
  const { store } = await fixture(t);
  const artifact = await store.create({ id: 'artifact-result', kind: 'Artifact', title: 'Measured result', status: 'Valid', metadata: { sha256: 'result-checksum' }, body: 'Observed accuracy: 0.93.' });
  const experiments: Entity[] = [];
  for (const status of ['Planned', 'Running', 'Completed', 'Failed']) {
    experiments.push(await store.create({ id: `experiment-${status.toLowerCase()}`, kind: 'Experiment', title: `${status} comparison`, status, body: 'A comparison with a preserved protocol.', projectIds: ['project-a'], links: [{ target: artifact.id, relation: 'produced' }, { target: 'idea-a', relation: 'explores' }], metadata: { results: { accuracy: 0.93 }, runIds: ['run-current'] } }));
  }
  let claim = await store.create({ id: 'claim-supported', kind: 'Claim', title: 'Accepted finding', links: experiments.map(experiment => ({ target: experiment.id, relation: 'evidence' })) });
  claim = await store.reviewClaim(claim.id, 'Supported', 'Results support the finding.', edit(claim));
  const claimBytes = await readFile(claim.filePath!, 'utf8'), artifactBytes = await readFile(artifact.filePath!, 'utf8');
  const runDirectory = path.join(store.root, '.runs', 'run-current');
  await mkdir(runDirectory, { recursive: true });
  const runFiles = { 'manifest.json': '{"state":"Running","jobId":"12345"}\n', 'stdout.log': 'Completed checkpoint 8\n', 'results.json': '{"accuracy":0.93}\n' };
  for (const [file, contents] of Object.entries(runFiles)) await writeFile(path.join(runDirectory, file), contents);
  for (const experiment of experiments) {
    const parked = await store.setBackBurner(experiment.id, true, 'Focus on another comparison', edit(experiment));
    assert.equal(store.get(claim.id).metadata.needsReview, false);
    assert.equal(store.get(claim.id).contentHash, claim.contentHash);
    assert.equal(store.get(artifact.id).contentHash, artifact.contentHash);
    const restored = await store.setBackBurner(experiment.id, false, '', edit(parked));
    assert.equal(restored.status, experiment.status);
    assert.equal(restored.body, experiment.body);
    assert.deepEqual(restored.links, experiment.links);
    assert.deepEqual(restored.metadata.results, experiment.metadata.results);
    assert.deepEqual(restored.metadata.runIds, experiment.metadata.runIds);
    assert.equal(store.get(claim.id).status, 'Supported');
    assert.equal(store.get(claim.id).metadata.needsReview, false);
    assert.equal(store.get(artifact.id).contentHash, artifact.contentHash);
  }
  assert.equal(await readFile(claim.filePath!, 'utf8'), claimBytes);
  assert.equal(await readFile(artifact.filePath!, 'utf8'), artifactBytes);
  assert.deepEqual((await readdir(runDirectory)).sort(), Object.keys(runFiles).sort());
  for (const [file, contents] of Object.entries(runFiles)) assert.equal(await readFile(path.join(runDirectory, file), 'utf8'), contents);
});

test('Restoring an experiment keeps research progress recorded while it was on the back burner', async t => {
  const { store } = await fixture(t);
  const experiment = await store.create({ id: 'experiment-progress', kind: 'Experiment', title: 'Ongoing work', status: 'Running' });
  const parked = await store.setBackBurner(experiment.id, true, 'Revisit the final results later', edit(experiment));
  const completed = await store.update(experiment.id, { status: 'Completed', metadata: { results: 'Execution finished successfully' } }, edit(parked));
  assert.equal(isBackBurner(completed), true);
  const restored = await store.setBackBurner(experiment.id, false, '', edit(completed));
  assert.equal(restored.status, 'Completed');
  assert.equal(restored.metadata.results, completed.metadata.results);
  assert.equal(restored.metadata.backBurner.previousStatus, 'Running');
});

test('Concurrent placement edits and manual same-revision edits require exact revision and hash', async t => {
  const { store, directory } = await fixture(t);
  const idea = await store.create({ id: 'idea-cas', kind: 'Idea', title: 'Concurrent idea', body: 'Original discussion.' });
  const other = await new ResearchStore(store.root, path.join(directory, 'second-cache')).init();
  try {
    const results = await Promise.allSettled([
      store.setBackBurner(idea.id, true, 'Agent A reason', edit(idea)),
      other.setBackBurner(idea.id, true, 'Agent B reason', edit(idea)),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.equal(rejected.reason.code, 'CONFLICT');
    await store.reindex();
    const current = store.get(idea.id);
    assert.equal(current.revision, idea.revision + 1);
    assert.equal((await readdir(path.join(store.root, 'history', idea.id))).length, 1);
    await writeFile(current.filePath!, (await readFile(current.filePath!, 'utf8')).replace('Original discussion.', 'Human clarified the discussion.'));
    await assert.rejects(store.setBackBurner(idea.id, false, '', edit(current)), /changed/i);
    assert.equal(store.get(idea.id).body, 'Human clarified the discussion.');
    assert.equal(isBackBurner(store.get(idea.id)), true);
    await assert.rejects(store.setBackBurner(idea.id, false, '', { expectedRevision: current.revision, expectedHash: '' }), /changed/i);
  } finally { other.close(); }
});

test('Legacy Parked ideas and experiments restore to Open and an explicit inactive flag overrides legacy status', async t => {
  const { store } = await fixture(t);
  for (const kind of ['Idea', 'Experiment'] as const) {
    const legacy = await store.create({ id: `legacy-${kind.toLowerCase()}`, kind, title: 'Legacy parked record', status: 'Parked', body: 'Preserved old discussion.' });
    assert.equal(canBackBurner(legacy), true);
    assert.equal(isBackBurner(legacy), true);
    const restored = await store.setBackBurner(legacy.id, false, '', edit(legacy));
    assert.equal(restored.status, 'Open');
    assert.equal(restored.body, legacy.body);
    assert.equal(restored.metadata.backBurner.previousStatus, 'Parked');
    const explicit = await store.update(restored.id, { status: 'Parked' }, edit(restored));
    assert.equal(isBackBurner(explicit), false);
    assert.equal(store.fullHandoff('').records.find(record => record.id === explicit.id)!.placement, 'Active');
  }
  const note = await store.create({ id: 'note-parked', kind: 'Note', title: 'Not a shelf item', status: 'Parked' });
  assert.equal(canBackBurner(note), false);
  assert.equal(isBackBurner(note), false);
  await assert.rejects(store.setBackBurner(note.id, true, '', edit(note)), /Only ideas, experiments, and claims/);
});

test('Placement metadata is validated for generic writes and Markdown reindexing', async t => {
  const { store } = await fixture(t);
  const valid = { active: true, reason: '', at: '2026-10-02T12:00:00.000Z', by: 'agent' };
  const idea = await store.create({ id: 'idea-valid', kind: 'Idea', title: 'Validated placement', metadata: { backBurner: valid } });
  for (const invalid of [null, {}, [], { ...valid, active: 'true' }, { ...valid, reason: 7 }, { ...valid, at: '1' }, { ...valid, by: 'anyone' }, { ...valid, previousStatus: '' }, { ...valid, restoredAt: 'yesterday' }, { ...valid, restoredBy: 'someone' }]) {
    await assert.rejects(store.update(idea.id, { metadata: { backBurner: invalid } }, edit(idea)), /Invalid backBurner metadata/);
  }
  await assert.rejects(store.create({ id: 'bad-artifact', kind: 'Artifact', title: 'Wrong kind', metadata: { backBurner: valid } }), /Invalid backBurner metadata/);
  await assert.rejects(store.update(idea.id, { metadata: { backBurner: { ...valid, category: 'boring' } } }, edit(idea)), /Invalid backBurner metadata/);
  await assert.rejects(store.setBackBurner(idea.id, 'true' as any, '', edit(idea)), /boolean/);
  const original = await readFile(idea.filePath!, 'utf8');
  await writeFile(idea.filePath!, original.replace('active: true', 'active: nonsense'));
  await store.reindex();
  assert.equal(store.errors.length, 1);
  assert.match(store.errors[0], /Invalid backBurner metadata/);
  assert.equal(store.get(idea.id).contentHash, idea.contentHash);
  await writeFile(idea.filePath!, original);
  await store.reindex();
  assert.deepEqual(store.errors, []);
});

test('A superseded claim moves to the back burner with its verdict, category, and replacement intact', async t => {
  const { store } = await fixture(t);
  const replacement = await store.create({ id: 'claim-new', kind: 'Claim', title: 'Sharper claim' });
  let claim = await store.create({ id: 'claim-old', kind: 'Claim', title: 'Older claim' });
  claim = await store.reviewClaim(claim.id, 'Refuted', 'Replaced by a sharper test.', edit(claim));
  await assert.rejects(store.setBackBurner(claim.id, true, 'Replaced', edit(claim), { category: 'superseded', supersededBy: 'claim-missing' }), /Record not found/);
  await assert.rejects(store.setBackBurner(claim.id, true, 'Replaced', edit(claim), { category: 'superseded' }), /needs supersededBy/);
  await assert.rejects(store.setBackBurner(claim.id, true, 'Replaced', edit(claim), { category: 'superseded', supersededBy: claim.id }), /cannot supersede itself/);
  await assert.rejects(store.setBackBurner(claim.id, true, 'Later', edit(claim), { category: 'deprioritized', supersededBy: replacement.id }), /category superseded or merged/);
  const shelved = await store.setBackBurner(claim.id, true, 'Replaced', edit(claim), { category: 'superseded', supersededBy: replacement.id });
  assert.equal(isBackBurner(shelved), true);
  assert.equal(shelved.status, 'Refuted');
  assert.equal(shelved.metadata.review.status, 'Refuted');
  assert.deepEqual([shelved.metadata.backBurner.category, shelved.metadata.backBurner.supersededBy], ['superseded', 'claim-new']);
  const restored = await store.setBackBurner(shelved.id, false, '', edit(shelved));
  assert.equal(restored.status, 'Refuted');
  assert.equal(isBackBurner(restored), false);
});

test('Service placement uses the displayed revision/hash and records human actions', async t => {
  const { store } = await fixture(t);
  const experiment = await store.create({ id: 'experiment-ui', kind: 'Experiment', title: 'UI experiment', status: 'Running' });
  const service = new ResearchService(store);
  await service.snapshot();
  await assert.rejects(service.command({ command: 'setBackBurner', payload: { id: experiment.id, active: true } }), /displayed record version/);
  const parked = await service.command({ command: 'setBackBurner', payload: { id: experiment.id, active: true, reason: 'Use the UI later', ...edit(experiment) } });
  const entity = parked.entities.find(record => record.id === experiment.id)!;
  assert.equal(entity.status, 'Running');
  assert.equal(entity.metadata.backBurner.by, 'human');
  await assert.rejects(service.command({ command: 'setBackBurner', payload: { id: experiment.id, active: false, ...edit(experiment) } }), /changed/);
  const restored = await service.command({ command: 'setBackBurner', payload: { id: entity.id, active: false, ...edit(entity) } });
  assert.equal(isBackBurner(restored.entities.find(record => record.id === entity.id)!), false);
});

test('CLI and MCP round-trip optional reasons, restore, handoff, and stale placement conflicts', async t => {
  const { store, directory } = await fixture(t);
  const idea = await store.create({ id: 'idea-cli', kind: 'Idea', title: 'CLI shared idea', status: 'Open', projectIds: ['project-a'] });
  const cli = (...args: string[]) => execute(process.execPath, [path.resolve('dist/cli.cjs'), '--memory', store.root, '--cache', path.join(directory, 'cli-cache'), ...args]);
  const revisionArgs = (entity: Entity) => ['--revision', String(entity.revision), '--hash', entity.contentHash!];
  const parked = JSON.parse((await cli('park', idea.id, 'Need comparison data', ...revisionArgs(idea))).stdout) as Entity;
  assert.equal(parked.status, 'Open');
  assert.equal(parked.metadata.backBurner.reason, 'Need comparison data');
  const client = new Client({ name: 'back-burner-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/cli.cjs'), '--memory', store.root, '--cache', path.join(directory, 'mcp-cache'), 'mcp'], stderr: 'pipe' });
  try {
    await client.connect(transport);
    assert.ok((await client.listTools()).tools.some(tool => tool.name === 'research_set_back_burner'));
    const handoff = await client.callTool({ name: 'research_handoff', arguments: { projectId: 'project-a', detail: 'full' } });
    assert.equal(JSON.parse((handoff.content as any[])[0].text).records[0].placement, 'Back burner');
    const restoredResult = await client.callTool({ name: 'research_set_back_burner', arguments: { id: idea.id, active: false, expectedRevision: parked.revision, expectedHash: parked.contentHash } });
    assert.equal(restoredResult.isError, undefined);
    const restored = JSON.parse((restoredResult.content as any[])[0].text);
    assert.equal(restored.placement, 'Active');
    assert.equal(restored.backBurner.reason, 'Need comparison data');
    const stale = await client.callTool({ name: 'research_set_back_burner', arguments: { id: idea.id, active: true, expectedRevision: parked.revision, expectedHash: parked.contentHash } });
    assert.equal(stale.isError, true);
    const noReason = JSON.parse((await cli('park', idea.id, ...revisionArgs(restored))).stdout) as Entity;
    assert.equal(noReason.metadata.backBurner.reason, '');
    const active = JSON.parse((await cli('restore', idea.id, ...revisionArgs(noReason))).stdout) as Entity;
    assert.equal(isBackBurner(active), false);
    await assert.rejects(cli('park', idea.id, 'Missing version'));
  } finally { await client.close(); }
});
