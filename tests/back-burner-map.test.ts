import assert from 'node:assert/strict';
import test from 'node:test';
import type { Entity } from '../src/types.js';
import { researchMap } from '../webview/Graph.js';

function record(id: string, kind: Entity['kind'], patch: Partial<Entity> = {}): Entity {
  return {
    id, kind, title: id, projectIds: ['project'], status: 'Open', revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    links: [], sources: [], metadata: {}, body: '', ...patch,
  };
}
const project = record('project', 'Project');
const backBurner = { active: true, reason: 'Revisit later', at: '2026-01-01T00:00:00.000Z', by: 'human' };
const nodeIds = (entities: Entity[], section = 'Experiments') => researchMap(project, entities, section).nodes.map(node => node.id).sort();

test('Experiments hides parked experiments and exclusive artifact branches without changing records', () => {
  const entities = [
    record('claim', 'Claim'),
    record('parked', 'Experiment', { status: 'Complete', metadata: { backBurner }, links: [{ target: 'claim', relation: 'tests' }, { target: 'result', relation: 'produces' }] }),
    record('result', 'Artifact', { links: [{ target: 'plot', relation: 'produces' }] }),
    record('plot', 'Artifact', { links: [{ target: 'result', relation: 'derived_from' }] }),
    record('standalone', 'Artifact'),
  ];
  const original = structuredClone(entities);
  const map = researchMap(project, entities, 'Experiments');
  assert.deepEqual(nodeIds(entities), ['claim', 'project', 'standalone']);
  assert.ok(map.edges.every(edge => map.nodes.some(node => node.id === edge.source) && map.nodes.some(node => node.id === edge.target)));
  assert.deepEqual(entities, original);
});

test('Shared artifacts stay visible through active experiments and explicit claim links in either direction', () => {
  const entities = [
    record('claim', 'Claim', { links: [{ target: 'claim-result', relation: 'supported_by' }] }),
    record('parked', 'Experiment', { metadata: { backBurner }, links: [
      { target: 'shared', relation: 'produces' }, { target: 'claim-result', relation: 'produces' },
      { target: 'reverse-claim-result', relation: 'produces' }, { target: 'exclusive', relation: 'produces' },
    ] }),
    record('also-parked', 'Experiment', { status: 'Parked', links: [{ target: 'exclusive', relation: 'produces' }] }),
    record('active', 'Experiment'),
    record('shared', 'Artifact', { links: [{ target: 'active', relation: 'from' }, { target: 'shared-plot', relation: 'produces' }] }),
    record('shared-plot', 'Artifact'),
    record('claim-result', 'Artifact'),
    record('reverse-claim-result', 'Artifact', { links: [{ target: 'claim', relation: 'supports' }] }),
    record('exclusive', 'Artifact'),
  ];
  assert.deepEqual(nodeIds(entities), ['active', 'claim', 'claim-result', 'project', 'reverse-claim-result', 'shared', 'shared-plot']);
});

test('Parking only an idea keeps its linked active experiments and their evidence', () => {
  const entities = [
    record('idea', 'Idea', { metadata: { backBurner } }),
    record('legacy-idea', 'Idea', { status: 'Parked' }),
    record('active-idea', 'Idea'),
    record('active', 'Experiment', { links: [{ target: 'idea', relation: 'explores' }, { target: 'legacy-idea', relation: 'explores' }] }),
    record('result', 'Artifact', { links: [{ target: 'active', relation: 'from' }] }),
  ];
  assert.deepEqual(nodeIds(entities), ['active', 'active-idea', 'project', 'result']);
  assert.ok(researchMap(project, entities, 'Experiments').edges.some(edge => edge.source === 'active' && edge.target === 'result'));
});

test('Overview retains parked evidence chains and labels workflow placement separately from status', () => {
  const entities = [
    record('claim', 'Claim'),
    record('parked', 'Experiment', { status: 'Complete', metadata: { backBurner, imported: true }, links: [{ target: 'claim', relation: 'tests' }] }),
    record('result', 'Artifact', { status: 'Invalid', links: [{ target: 'parked', relation: 'from' }] }),
    record('needs-review', 'Experiment', { status: 'Complete', metadata: { backBurner, needsReview: true }, links: [{ target: 'claim', relation: 'tests' }] }),
    record('legacy', 'Experiment', { status: 'Parked', links: [{ target: 'claim', relation: 'tests' }] }),
    record('legacy-result', 'Artifact', { links: [{ target: 'legacy', relation: 'from' }] }),
  ];
  const map = researchMap(project, entities, 'Overview');
  assert.deepEqual(nodeIds(entities, 'Overview'), ['claim', 'legacy', 'legacy-result', 'needs-review', 'parked', 'project', 'result']);
  assert.equal(map.nodes.find(node => node.id === 'parked')?.status, 'Complete');
  assert.equal(map.nodes.find(node => node.id === 'parked')?.subtitle, 'Experiment · Imported record · Back burner');
  assert.equal(map.nodes.find(node => node.id === 'needs-review')?.status, 'Needs review');
  assert.match(map.nodes.find(node => node.id === 'needs-review')!.subtitle!, /Back burner/);
  assert.match(map.nodes.find(node => node.id === 'legacy')!.subtitle!, /Back burner/);
  assert.equal(map.nodes.find(node => node.id === 'result')?.status, 'Invalid');
  assert.ok(map.edges.some(edge => edge.source === 'claim' && edge.target === 'parked'));
  assert.ok(map.edges.some(edge => edge.source === 'parked' && edge.target === 'result'));
});

test('Restoring placement returns the experiment and artifacts to the default map', () => {
  const experiment = record('experiment', 'Experiment', { status: 'Complete', metadata: { backBurner }, links: [{ target: 'result', relation: 'produces' }] });
  const result = record('result', 'Artifact');
  assert.deepEqual(nodeIds([experiment, result]), ['project']);
  const restored = { ...experiment, metadata: { backBurner: { ...backBurner, active: false } } };
  assert.deepEqual(nodeIds([restored, result]), ['experiment', 'project', 'result']);
  assert.equal(researchMap(project, [restored, result], 'Experiments').nodes.find(node => node.id === 'experiment')?.subtitle, 'Experiment');
});
