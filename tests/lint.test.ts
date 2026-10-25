import test from 'node:test';
import assert from 'node:assert/strict';
import { lint } from '../src/lint.js';
import { claimContext } from '../src/context.js';
import { section, summarize } from '../src/workflow.js';
import type { Entity } from '../src/types.js';

const record = (id: string, kind: Entity['kind'], extra: Partial<Entity> = {}): Entity => ({ id, kind, title: id, projectIds: ['p'], status: kind === 'Claim' ? 'Open' : 'Active', revision: 1, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', links: [], sources: [], metadata: {}, body: '', ...extra });
const done = (id: string, claim: string, met: string) => record(id, 'Experiment', { status: 'Completed', links: [{ target: claim, relation: 'tests' }], body: `## Question\nQ?\n\n## Decision rule (reconstructed after the run)\nA beats B.\n\n## Result\nRule met: ${met} — 74% vs 63%.` });

test('section matches heading prefixes and stops at the next heading of the same or higher level', () => {
  const body = '## Decision rule (reconstructed after the run)\nRule.\n\n### Detail\nKept.\n\n## Result\nRule met: yes';
  assert.equal(section(body, 'Decision rule'), 'Rule.\n\n### Detail\nKept.');
  assert.equal(section(body, 'Result'), 'Rule met: yes');
  assert.equal(section(body, 'Limits'), undefined);
  assert.equal(summarize('## TL;DR\nOne line.\n\n## Why it matters here\nMore.'), 'One line.');
  assert.equal(summarize('## Current goal\nFinish the sweep.\n\n## Next\nLater.'), 'Finish the sweep.');
  assert.equal(summarize('## Main finding\n| a | b |\n|---|---|\n\nProse after the table.'), 'Prose after the table.');
});

test('lint groups issues, proposes verdicts from Rule met, and lists back-burner candidates without changing records', () => {
  const p = record('p', 'Project', { projectIds: [], metadata: { researchFlow: { version: 1, nodeIds: ['c-yes', 'c-mixed', 'c-refuted'], edges: [] } } });
  const records = [p,
    record('c-yes', 'Claim', { metadata: { answer: '74% vs 63%' } }), done('e-yes', 'c-yes', 'yes'),
    record('c-mixed', 'Claim', { metadata: { answer: 'mixed' } }), done('e-m1', 'c-mixed', 'yes'), done('e-m2', 'c-mixed', 'no'),
    record('c-refuted', 'Claim', { status: 'Refuted', metadata: { answer: 'no' } }),
    record('c-proposed', 'Claim', { metadata: { answer: 'x' } }), done('e-p', 'c-proposed', 'no'),
    record('n-proposal', 'Note', { status: 'Proposed', updatedAt: '2026-10-02T00:00:00.000Z', links: [{ target: 'c-proposed', relation: 'proposes' }] }),
    record('e-loose', 'Experiment', { status: 'Completed', title: 'An experiment title that is much longer than forty-five characters', links: [{ target: 'gone', relation: 'evidence' }] }),
    record('i-stale', 'Idea', { status: 'Inbox' }),
  ];
  const before = structuredClone(records);
  const result = lint(records, 'p', new Date('2026-12-01T00:00:00.000Z'));
  const rules = Object.fromEntries(result.issues.map(group => [group.rule, group.records.map(r => r.id)]));
  assert.deepEqual(rules['dangling-link'], ['e-loose']);
  assert.deepEqual(rules['experiment-unplaced'], ['e-loose']);
  assert.deepEqual(rules['experiment-no-rule-met'], ['e-loose']);
  assert.deepEqual(rules['title-too-long'], ['e-loose']);
  assert.equal(result.issues[0].severity, 'error');
  assert.deepEqual(result.readyForVerdict.map(v => [v.id, v.proposed]), [['c-yes', 'Supported'], ['c-mixed', 'Mixed']]);
  assert.deepEqual(result.awaitingReview.map(a => [a.id, a.noteId, a.outdated]), [['c-proposed', 'n-proposal', false]]);
  const stale = lint(records.map(r => r.id === 'n-proposal' ? { ...r, updatedAt: '2026-09-01T00:00:00.000Z' } : r), 'p', new Date('2026-12-01T00:00:00.000Z'));
  assert.deepEqual([stale.awaitingReview[0].outdated, stale.readyForVerdict.some(v => v.id === 'c-proposed')], [true, true]);
  assert.deepEqual(result.backBurnerCandidates.map(c => [c.id, c.category]).sort(), [['c-refuted', 'refuted'], ['e-loose', 'out-of-scope'], ['e-p', 'out-of-scope'], ['i-stale', 'deprioritized']]);
  assert.deepEqual(records, before);
});

test('claim context returns decision rules, results, and observation sections instead of whole bodies', () => {
  const records = [
    record('c', 'Claim', { body: '## Statement\nA beats B.', links: [{ target: 'c-next', relation: 'next_question' }] }), record('c-next', 'Claim'),
    done('e', 'c', 'partly'),
    record('o', 'Note', { metadata: { role: 'Observation' }, links: [{ target: 'e', relation: 'discusses' }], body: '## Main finding\nA wins on 4 of 6.\n\n## Measured results\n' + '| x |\n'.repeat(500) + '\n## Limits\nOne seed.' }),
    record('paper', 'Paper', { status: 'Read', links: [{ target: 'e', relation: 'baseline_for' }] }),
    record('unrelated', 'Experiment'),
  ];
  const context = claimContext(records, 'c');
  assert.deepEqual(context.experiments.map(e => [e.id, e.ruleMet, e.placement, e.decisionRule]), [['e', 'partly', 'Active', 'A beats B.']]);
  assert.deepEqual(context.observations.map(o => [o.mainFinding, o.limits]), [['A wins on 4 of 6.', 'One seed.']]);
  assert.deepEqual([context.papers.map(p => p.id), context.claims.map(c => c.id)], [['paper'], ['c-next']]);
  assert.ok(JSON.stringify(context).length < 3000);
  assert.throws(() => claimContext(records, 'e'), /Not a claim/);
});

test('only `tests` links decide a verdict; evidence-only experiments and missing decision rules do not', () => {
  const p = record('p', 'Project', { projectIds: [] });
  const negative = record('c-neg', 'Claim', { metadata: { answer: 'x' }, links: [{ target: 'e-other', relation: 'evidence' }] });
  const noRule = record('c-norule', 'Claim', { metadata: { answer: 'x' } });
  const records = [p, negative, record('c-other', 'Claim', { metadata: { answer: 'x' } }), done('e-other', 'c-other', 'no'), noRule,
    record('e-norule', 'Experiment', { status: 'Completed', links: [{ target: 'c-norule', relation: 'tests' }], body: '## Result\nRule met: yes' })];
  const result = lint(records, 'p');
  assert.deepEqual(result.readyForVerdict.map(v => [v.id, v.proposed]), [['c-other', 'Refuted']]);
  assert.deepEqual(claimContext(records, 'c-neg').experiments, []);
  assert.deepEqual(claimContext(records, 'c-neg').evidenceExperiments.map(e => e.id), ['e-other']);
  assert.throws(() => lint(records, 'missing'), /Unknown project/);
});

test('lint warns when the primary handoff discusses a claim missing from the Overview mainline', () => {
  const p = record('p', 'Project', { projectIds: [], metadata: { researchFlow: { version: 1, overviewNodeIds: ['c-old'], nodeIds: ['c-old'], edges: [] } } });
  const records = [p, record('c-old', 'Claim', { metadata: { answer: 'x' } }), record('c-new', 'Claim', { metadata: { answer: 'x' } }),
    record('n-h', 'Note', { metadata: { role: 'Handoff' }, links: [{ target: 'c-new', relation: 'discusses' }] })];
  const group = lint(records, 'p').issues.find(issue => issue.rule === 'mainline-missing-claim');
  assert.deepEqual(group?.records.map(r => r.id), ['c-new']);
});

test('lint flags a decided claim whose answer still says not tested, and runs for a project without a Project record', () => {
  const records = [record('c', 'Claim', { status: 'Mixed', metadata: { answer: 'Not tested yet — run A vs B' } }), done('e', 'c', 'partly')];
  const result = lint(records, 'p');
  assert.deepEqual(result.issues.find(issue => issue.rule === 'claim-stale-answer')?.records.map(r => r.id), ['c']);
  const proposal = record('n', 'Note', { status: 'Proposed', updatedAt: '2026-10-02T00:00:00.000Z', links: [{ target: 'c', relation: 'proposes' }] });
  assert.equal(claimContext([...records, proposal], 'c').proposals[0].outdated, false);
  const newer = { ...done('e', 'c', 'partly'), updatedAt: '2026-10-05T00:00:00.000Z' };
  assert.equal(claimContext([records[0], newer, proposal], 'c').proposals[0].outdated, true);
});
