import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ResearchStore } from '../src/store.js';
import { ResearchService } from '../src/service.js';
import type { Entity } from '../src/types.js';

const edit = (entity: Entity) => ({ expectedRevision: entity.revision, expectedHash: entity.contentHash!, actor: 'agent' as const });
async function fixture(t: any) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'research-store-review-'));
  const store = await new ResearchStore(path.join(directory, 'memory'), path.join(directory, 'cache')).init();
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return store;
}

test('An artifact supporting a claim marks that claim for review when invalidated', async t => {
  const store = await fixture(t);
  const claim = await store.create({ id: 'claim-a', kind: 'Claim', title: 'A claim' });
  const artifact = await store.create({ id: 'artifact-a', kind: 'Artifact', title: 'Supporting result', links: [{ target: claim.id, relation: 'supports' }] });
  await store.invalidateArtifact(artifact.id, 'The scoring code was incorrect.', edit(artifact));
  assert.equal(store.get(claim.id).metadata.needsReview, true);
});

test('Agent edits cannot clear an outstanding human evidence review', async t => {
  const store = await fixture(t);
  const claim = await store.create({ id: 'claim-a', kind: 'Claim', title: 'A claim', metadata: { needsReview: true, reviewReason: 'Evidence was invalidated.' } });
  await assert.rejects(store.update(claim.id, { metadata: { needsReview: false, review: { by: 'human', status: 'Supported', reason: 'Forged review' } } }, edit(claim)), /human|review|protected/i);
  await assert.rejects(store.update(claim.id, { metadata: { needsReview: null } }, edit(claim)), /human|review/i);
  const updated = await store.update(claim.id, { metadata: { observation: 'Additional context' } }, edit(claim));
  assert.equal(updated.metadata.needsReview, true);
});

test('Creating an existing logical ID fails after its Markdown file was moved', async t => {
  const store = await fixture(t);
  const idea = await store.create({ id: 'idea-a', kind: 'Idea', title: 'Original idea' });
  await rename(idea.filePath!, path.join(store.root, 'records', 'custom-name.md'));
  await store.reindex();
  await assert.rejects(store.create({ id: idea.id, kind: 'Idea', title: 'Duplicate idea' }), /exist|duplicate/i);
  assert.equal(store.get(idea.id).title, 'Original idea');
});

test('Changing a Markdown ID reports an identity conflict instead of silently breaking links', async t => {
  const store = await fixture(t);
  const idea = await store.create({ id: 'idea-a', kind: 'Idea', title: 'Original idea' });
  await store.create({ id: 'experiment-a', kind: 'Experiment', title: 'Follow-up', links: [{ target: idea.id, relation: 'explores' }] });
  const raw = await readFile(idea.filePath!, 'utf8');
  await writeFile(idea.filePath!, raw.replace('id: idea-a', 'id: idea-renamed'));
  await store.reindex();
  assert.ok(store.errors.some(error => /identity|rename|ID/.test(error)));
  assert.equal(store.get(idea.id).title, 'Original idea');
});

test('A malformed Markdown edit retains the last valid indexed state and recovers after repair', async t => {
  const store = await fixture(t);
  const idea = await store.create({ id: 'idea-a', kind: 'Idea', title: 'Searchable record', body: 'Useful known-good observations.' });
  const raw = await readFile(idea.filePath!, 'utf8');
  await writeFile(idea.filePath!, '---\nid: [broken\n---\n');
  await store.reindex();
  assert.equal(store.get(idea.id).body, idea.body);
  assert.equal(store.search('known-good').length, 1);
  assert.equal(store.errors.length, 1);
  await writeFile(idea.filePath!, raw);
  await store.reindex();
  assert.equal(store.errors.length, 0);
  const rebuilt = await new ResearchStore(store.root, `${store.cacheRoot}-rebuilt`).init();
  try { assert.deepEqual(rebuilt.list(), store.list()); } finally { rebuilt.close(); }
});

test('Review commands require the displayed content hash when Markdown changed without a revision bump', async t => {
  const store = await fixture(t);
  const claim = await store.create({ id: 'claim-a', kind: 'Claim', title: 'A claim', body: 'Original interpretation.' });
  const service = new ResearchService(store);
  await service.snapshot();
  const raw = await readFile(claim.filePath!, 'utf8');
  await writeFile(claim.filePath!, raw.replace('Original interpretation.', 'An incompatible interpretation.'));
  await service.snapshot();
  await assert.rejects(service.command({ command: 'reviewClaim', payload: { id: claim.id, expectedRevision: claim.revision, expectedHash: claim.contentHash, status: 'Supported', reason: 'Based on the original interpretation.' } }), /changed|conflict/i);
});

test('Evidence changes propagate through dependencies without spreading into an independent sibling experiment', async t => {
  const store = await fixture(t);
  let first = await store.create({ id: 'claim-first', kind: 'Claim', title: 'First condition' });
  const second = await store.create({ id: 'claim-second', kind: 'Claim', title: 'Independent condition' });
  const parent = await store.create({ id: 'claim-parent', kind: 'Claim', title: 'General claim', links: [{ target: first.id, relation: 'subclaim' }, { target: second.id, relation: 'condition' }] });
  const artifact = await store.create({ id: 'result-first', kind: 'Artifact', title: 'First result', status: 'Valid' });
  const other = await store.create({ id: 'result-second', kind: 'Artifact', title: 'Independent result', status: 'Valid' });
  await store.create({ id: 'experiment-first', kind: 'Experiment', title: 'First experiment', links: [{ target: artifact.id, relation: 'produces' }, { target: first.id, relation: 'tests' }, { target: parent.id, relation: 'tests' }] });
  await store.create({ id: 'experiment-second', kind: 'Experiment', title: 'Independent experiment', links: [{ target: other.id, relation: 'baseline' }, { target: second.id, relation: 'tests' }, { target: parent.id, relation: 'tests' }] });
  first = await store.reviewClaim(first.id, 'Supported', 'The initial result supports this condition.', edit(first));
  await store.update(artifact.id, { status: 'Invalid' }, edit(artifact));
  assert.equal(store.get(first.id).metadata.needsReview, true);
  assert.equal(store.get(parent.id).metadata.needsReview, true);
  assert.ok(!store.get(second.id).metadata.needsReview);
  assert.equal(store.get(first.id).status, 'Supported');
  first = store.get(first.id);
  first = await store.reviewClaim(first.id, 'Open', 'Withdraw the prior judgment because the evidence is invalid.', edit(first));
  assert.equal(first.metadata.needsReview, false);
  const currentArtifact = store.get(artifact.id);
  const raw = await readFile(currentArtifact.filePath!, 'utf8');
  await writeFile(currentArtifact.filePath!, raw.replace('title: First result', 'title: Corrected first result'));
  await store.reindex();
  assert.equal(store.get(first.id).metadata.needsReview, true);
  assert.ok(!store.get(second.id).metadata.needsReview);
});

test('Manual artifact invalidation is detected when the Markdown index is rebuilt', async t => {
  const store = await fixture(t);
  const artifact = await store.create({ id: 'result-a', kind: 'Artifact', title: 'Evidence', status: 'Valid' });
  const experiment = await store.create({ id: 'experiment-a', kind: 'Experiment', title: 'Comparison', links: [{ target: artifact.id, relation: 'produced' }] });
  const claim = await store.create({ id: 'claim-a', kind: 'Claim', title: 'Claim', links: [{ target: experiment.id, relation: 'evidence' }] });
  const raw = await readFile(artifact.filePath!, 'utf8');
  await writeFile(artifact.filePath!, raw.replace('status: Valid', 'status: Invalid'));
  await store.reindex();
  assert.equal(store.get(claim.id).metadata.needsReview, true);
  const rebuilt = await new ResearchStore(store.root, `${store.cacheRoot}-derived`).init();
  try { assert.equal(rebuilt.get(claim.id).metadata.needsReview, true); } finally { rebuilt.close(); }
});

test('Source selection stays within project repositories and compares revisions per source root', async t => {
  const store = await fixture(t);
  const first = path.join(store.root, 'first'), second = path.join(store.root, 'second');
  await mkdir(first); await mkdir(second);
  await writeFile(path.join(first, 'main.py'), 'def first(): return 1\n');
  await writeFile(path.join(second, 'main.py'), 'def second(): return 2\n');
  await store.create({ id: 'project-a', kind: 'Project', title: 'Project', metadata: { sourceRoot: first, repos: [{ path: first }, { path: second }] } });
  const configured: Array<Entity | undefined> = [];
  const service = new ResearchService(store, { openSource: async () => {}, configureProject: async project => { configured.push(project); } });
  await service.command({ command: 'selectSection', payload: { section: 'Source Code' } });
  const alternate = await service.command({ command: 'selectSource', payload: { sourceRoot: second } });
  assert.equal(alternate.graph!.stale, false);
  assert.equal(alternate.graph!.nodes[0].label, 'second');
  await writeFile(path.join(first, 'main.py'), 'def first(): return 3\n');
  const changed = await service.command({ command: 'selectSource', payload: { sourceRoot: first } });
  assert.equal(changed.graph!.stale, true);
  await assert.rejects(service.command({ command: 'selectSource', payload: { sourceRoot: '/not-in-project' } }), /linked to this project/);
  await service.command({ command: 'configureProject', payload: { create: true } });
  assert.equal(configured[0], undefined);
  await service.command({ command: 'selectProject', payload: { projectId: 'project-a' } });
  assert.equal(service.selectedSourceRoot, '');
});
