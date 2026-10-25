import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Entity, PreviewRecord } from '../src/types.js';
import { Review, reviewSections, reviewEvidence, observationOrder } from '../webview/Review.js';
const record = (id: string, body: string, extra = {}): PreviewRecord => ({ entity: { id, title: id, kind: 'Note', body, links: [], metadata: { role: 'Observation' }, sources: [], status: 'Active', ...extra } as unknown as Entity, sources: [] });

test('Review chooses measured sections over operational history without interpreting predictions', () => {
  const feedback = record('feedback', '## Verified setup\nInputs exist.');
  const measured = record('measured', '## Paired observations\nDifference from control.\n\n| arm | delta |\n| --- | --- |\n| A | -0.1 |\n\nCondition B reverses this effect.');
  assert.equal(observationOrder([feedback, measured])[0].entity.id, 'measured');
  const result = reviewEvidence(measured.entity.body)!;
  assert.equal(result.guide, 'Difference from control.');
  assert.match(result.table!, /-0.1/);
  assert.equal(result.rest, 'Condition B reverses this effect.');
  assert.match(reviewEvidence('## Main finding\nOnly this setting.\n' + measured.entity.body)!.table, /-0.1/);
  assert.equal(reviewEvidence('## Planned readouts\nScore.\n## Analytical expectations\nShould improve.\n## Completion\nExit 0.'), undefined);
});

test('Review extraction respects code fences, full paragraphs, and Markdown tables', () => {
  const sections = reviewSections('## Question\nCompare?\n\n```md\n## Results\nFake output\n```\n## Limits\nOnly a grid. Not an optimum.');
  assert.equal(sections.length, 2);
  assert.equal(sections[1].body, 'Only a grid. Not an optimum.');
  assert.equal(reviewEvidence('## Results\nNo table. Entire statement.\n\nSecond paragraph.')?.rest, 'No table. Entire statement.\n\nSecond paragraph.');
});

test('Quick review separates completed execution from Open claims and excludes invalid observations', () => {
  const experiment = record('experiment', '## Question\nDoes it change?\n## Interpretation limits\nNo encoder trained.', { kind: 'Experiment', status: 'Completed', links: [{ target: 'claim', relation: 'tests' }] }).entity;
  const claim = record('claim', '', { kind: 'Claim', status: 'Open' }).entity;
  const invalid = record('old evidence', '## Main finding\nUNUSABLE FINDING.', { status: 'Invalid' });
  const html = renderToStaticMarkup(createElement(Review, { entity: experiment, records: [invalid], entities: [claim], send: () => {}, onSelect: () => {}, openResults: () => {} }));
  assert.match(html, />Tests</); assert.match(html, /<strong>claim<\/strong>/); assert.match(html, /· Open/);
  assert.match(html, /No encoder trained/); assert.match(html, /evidence needs review or is invalid/);
  assert.doesNotMatch(html, /UNUSABLE FINDING/);
  assert.match(html, /No measured result section recorded/);
});

test('Quick review shows the tested claim, why this comparison and the decision rule', () => {
  const experiment = record('experiment', '## Question\nDoes it change?\n## Why this comparison\nRULES OUT THE LOOKAHEAD.\n## Decision rule\nSUPPORTS IF ABOVE 50.', { kind: 'Experiment', status: 'Completed', links: [{ target: 'claim', relation: 'tests' }] }).entity;
  const claim = record('claim', '', { kind: 'Claim', status: 'Open', title: '2. Chunks help' }).entity;
  const html = renderToStaticMarkup(createElement(Review, { entity: experiment, records: [], entities: [claim], send: () => {}, onSelect: () => {}, openResults: () => {} }));
  assert.match(html, /2. Chunks help/); assert.match(html, /RULES OUT THE LOOKAHEAD/); assert.match(html, /SUPPORTS IF ABOVE 50/);
  assert.ok(html.indexOf('RULES OUT') < html.indexOf('SUPPORTS IF'));
});
