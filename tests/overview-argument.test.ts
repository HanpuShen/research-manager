import assert from 'node:assert/strict';
import test from 'node:test';
import { spineLayout, CARD, type MapData } from '../webview/Graph.js';
import { argumentOf, projectSummary, stageClaims } from '../webview/Overview.js';
import type { Entity } from '../src/types.js';

const entity = (id: string, kind: string, title: string, extra: Partial<Entity> = {}) =>
  ({ id, kind, title, body: '', links: [], sources: [], metadata: {}, projectIds: ['p'], status: 'Open', revision: 1, createdAt: '', updatedAt: '', ...extra }) as Entity;

test('Spine layout: claims in one column, each test next to its claim, untested children to the right', () => {
  const data: MapData = {
    authored: true,
    nodes: [
      { id: 'p', label: 'P', kind: 'Project' }, { id: 'c1', label: 'C1', kind: 'Claim' }, { id: 'c2', label: 'C2', kind: 'Claim' },
      { id: 'e1', label: 'E1', kind: 'Experiment' }, { id: 'e2', label: 'E2', kind: 'Experiment' }, { id: 'e3', label: 'E3', kind: 'Experiment' },
    ],
    edges: [
      { id: '1', source: 'p', target: 'c1' }, { id: '2', source: 'c1', target: 'c2' }, { id: '3', source: 'c1', target: 'e1' },
      { id: '4', source: 'c2', target: 'e2' }, { id: '5', source: 'e1', target: 'e2' }, { id: '6', source: 'e1', target: 'e3' },
    ],
  };
  const pos = spineLayout(data)!;
  assert.equal(pos.get('c1')!.x, pos.get('c2')!.x, 'claims share one column');
  assert.ok(pos.get('c1')!.x > 0 && pos.get('c1')!.y > 0, 'a margin keeps cards clear of the map controls');
  assert.ok(pos.get('c2')!.y > pos.get('c1')!.y, 'claims go down in order');
  assert.equal(pos.get('e1')!.y, pos.get('c1')!.y, 'a test sits on its claim row');
  assert.equal(pos.get('e2')!.y, pos.get('c2')!.y, 'e2 is tested by c2, so it sits next to c2 although it is also e1\'s child');
  assert.equal(pos.get('e2')!.x, pos.get('e1')!.x);
  assert.ok(pos.get('e3')!.x > pos.get('e1')!.x, 'an untested child goes one column to the right of its parent');
  assert.ok(pos.get('c2')!.y >= pos.get('c1')!.y + CARD.height, 'no overlap');
  assert.equal(spineLayout({ ...data, authored: false }), undefined, 'only authored maps use the spine');
  assert.equal(spineLayout({ ...data, nodes: data.nodes.filter(n => n.id !== 'c2') }), undefined, 'needs at least two claims');
});

test('Overview argument: sections from the project body; claims in authored order; summary skips headings', () => {
  const project = entity('p', 'Project', 'P', {
    body: 'Smith et al.: a method.\n\n## Question\nDoes it work?\n\n## Why it is hard\nA trade-off.\n\n## Key idea\nDecouple.\n\n## Current answer\nPartly.\n\n## Next decision\nScale up.',
    metadata: { researchFlow: { version: 1, overviewNodeIds: ['b', 'a'], nodeIds: [], edges: [] } },
  });
  const arg = argumentOf(project)!;
  assert.equal(arg.question, 'Does it work?'); assert.equal(arg.hard, 'A trade-off.'); assert.equal(arg.idea, 'Decouple.');
  assert.equal(arg.answer, 'Partly.'); assert.equal(arg.next, 'Scale up.');
  assert.equal(projectSummary(project), 'Smith et al.: a method.');
  assert.equal(projectSummary(entity('q', 'Project', 'Q', { body: '## Question\nX?\n\nPlain paragraph.' })), 'Plain paragraph.');
  assert.equal(argumentOf(entity('v', 'Project', 'V', { body: '## 1. Stage\nText.' })), undefined, 'projects without a Question keep the map');
  const claims = [entity('a', 'Claim', '2. A'), entity('b', 'Claim', '1. B'), entity('c', 'Experiment', 'E')];
  assert.deepEqual(stageClaims(project, claims).map(c => c.id), ['b', 'a']);
  const unordered = entity('p2', 'Project', 'P2');
  assert.deepEqual(stageClaims(unordered, [entity('x', 'Claim', '10. X'), entity('y', 'Claim', '2. Y')].map(c => ({ ...c, projectIds: ['p2'] }))).map(c => c.id), ['y', 'x'], 'numeric title order as fallback');
});
