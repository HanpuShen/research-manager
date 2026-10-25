import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InlineMath, MarkdownText } from '../webview/Markdown.js';
import { Review } from '../webview/Review.js';
import type { Entity, PreviewRecord } from '../src/types.js';

test('A single ~ (approximate value) is not strikethrough; ~~double~~ still is', () => {
  const html = renderToStaticMarkup(createElement(MarkdownText, { text: 'success ~84% vs ~27% (~ read from Figure 3); ~~old~~' }));
  assert.match(html, /~84% vs ~27% \(~ read from Figure 3\)/);
  assert.equal((html.match(/<del>/g) || []).length, 1);
});

test('InlineMath renders $…$ with KaTeX and leaves other text alone', () => {
  const html = renderToStaticMarkup(createElement(InlineMath, { text: 'V-only $V(s_{t+n})$ vs $V_Q$, cost $5' }));
  assert.match(html, /class="katex"/);
  assert.equal((html.match(/class="inline-math"/g) || []).length, 2);
  assert.match(html, /^V-only /);
  assert.match(html, /cost \$5$/, 'an unpaired $ stays text');
});

test('Review marks a decision rule reconstructed after the run', () => {
  const entity = { id: 'e', title: 'e', kind: 'Experiment', status: 'Completed', metadata: {}, sources: [], links: [{ target: 'c', relation: 'tests' }],
    body: '## Question\nDoes it?\n\n## Decision rule (reconstructed after the run)\nSupports if it helps on most tasks.\n\n## Result\nRule met: yes — $V_Q$ 81% vs 55%.' } as unknown as Entity;
  const claim = { id: 'c', title: '1. Claim', kind: 'Claim', status: 'Open', metadata: {}, links: [], sources: [], body: '' } as unknown as Entity;
  const html = renderToStaticMarkup(createElement(Review, { entity, records: [] as PreviewRecord[], entities: [claim], send: () => {}, onSelect: () => {}, openResults: () => {} }));
  assert.match(html, /Rule met: yes/);
  assert.match(html, /Rule reconstructed after the run/);
  assert.match(html, /Decision rule \(reconstructed after the run\)/);
  assert.match(html, /class="katex"/, 'math in the banner is rendered');
});
