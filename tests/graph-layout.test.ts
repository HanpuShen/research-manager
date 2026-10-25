import assert from 'node:assert/strict';
import test from 'node:test';
import { layoutMap, type MapData } from '../webview/Graph.js';

function graph(prefix: string): MapData {
  return {
    nodes: [{ id: `${prefix}:root`, label: 'Research' }, { id: `${prefix}:claim`, label: 'Claim', status: 'Open' }],
    edges: [{ id: `${prefix}:edge`, source: `${prefix}:root`, target: `${prefix}:claim`, label: 'supports' }],
  };
}

test('Equivalent snapshots and content edits share pending and completed graph geometry', async () => {
  const data = graph('snapshot');
  const pending = layoutMap(data);
  assert.equal(layoutMap(structuredClone(data)), pending);
  const positions = await pending;
  assert.ok(positions.get(data.nodes[1].id)!.x > positions.get(data.nodes[0].id)!.x);
  const updated = structuredClone(data);
  updated.nodes[0].label = 'Renamed research';
  updated.nodes[1].status = 'Needs review';
  updated.nodes[1].subtitle = 'Experiment · Back burner';
  updated.edges[0].label = 'tests';
  updated.edges[0].inferred = true;
  assert.equal(layoutMap(updated), pending);
  assert.equal(await layoutMap(updated), positions);
  assert.deepEqual(data, graph('snapshot'));
});

test('Changing a visible branch or its connections computes and caches new coordinates', async () => {
  const data = graph('branch');
  const initial = layoutMap(data);
  await initial;
  const collapsed = { nodes: data.nodes.slice(0, 1), edges: [] };
  const compact = layoutMap(collapsed);
  assert.notEqual(compact, initial);
  assert.equal((await compact).size, 1);
  assert.equal(layoutMap(data), initial);
  const reversed = { ...data, edges: [{ ...data.edges[0], source: data.nodes[1].id, target: data.nodes[0].id }] };
  const reversePositions = await layoutMap(reversed);
  assert.ok(reversePositions.get(data.nodes[0].id)!.x > reversePositions.get(data.nodes[1].id)!.x);
});

test('Geometry cache retains recent maps and releases older map variants', async () => {
  const oldest = graph('oldest');
  const initial = layoutMap(oldest);
  await initial;
  let recent = oldest;
  let recentLayout = initial;
  for (let index = 0; index < 30; index++) {
    recent = graph(`bounded:${index}`);
    recentLayout = layoutMap(recent);
    await recentLayout;
  }
  assert.equal(layoutMap(recent), recentLayout);
  const recomputed = layoutMap(oldest);
  assert.notEqual(recomputed, initial);
  assert.deepEqual(await recomputed, await initial);
});
