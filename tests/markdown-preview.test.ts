import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownText, markdownSource } from '../webview/Markdown.js';
import { resultSections, SourceContent } from '../webview/ExperimentPreview.js';

test('Markdown renders semantic tables, formatting, lists, and a complete code block', () => {
  const html = renderToStaticMarkup(createElement(MarkdownText, { text: '# Setup\n\n**Fixed seeds** and `alpha`.\n\n1. Train\n2. Evaluate\n\n| Seed | Accuracy |\n| --- | ---: |\n| 0 | 0.92 |\n\n```python\nseed = 0\nprint(seed)\n```' }));
  assert.match(html, /<h4>Setup<\/h4>/);
  assert.doesNotMatch(html, /<h[12]>/);
  assert.match(html, /<strong>Fixed seeds<\/strong>/);
  assert.match(html, /<ol>/);
  assert.match(html, /<table><thead><tr><th scope="col">Seed<\/th>/);
  assert.match(html, /<td[^>]*>0.92<\/td>/);
  assert.match(html, /<pre><code class="language-python">seed = 0\nprint\(seed\)\n<\/code><\/pre>/);
});

test('Markdown displays only validated local image mappings and never HTML or executable links', () => {
  const png = 'data:image/png;base64,aGVsbG8=';
  const html = renderToStaticMarkup(createElement(MarkdownText, { text: '![Local](plots/a.png)\n\n![Remote](https://example.org/image.png)\n\n![Raw](data:image/png;base64,aGVsbG8=)\n\n[Run](javascript:alert%281%29)\n\n<script>window.pwned=1</script>\n\n<img src="x" onerror="window.pwned=1">', images: { 'plots/a.png': png } }));
  assert.match(html, /src="data:image\/png;base64,aGVsbG8="/);
  assert.equal((html.match(/<img /g) || []).length, 1);
  assert.match(html, /Remote · Image preview unavailable/);
  assert.match(html, /Raw · Image preview unavailable/);
  assert.doesNotMatch(html, /<script|onerror|href="javascript:|src="https:/);
});

test('Markdown source links resolve relative to their document and reject unsafe schemes', () => {
  assert.deepEqual(markdownSource('../code/train.py#L17', '/project/notes/setup.md'), { path: '/project/code/train.py', line: 17 });
  assert.deepEqual(markdownSource('file:///project/results/data.csv'), { path: '/project/results/data.csv' });
  assert.deepEqual(markdownSource('https://example.org/paper'), { url: 'https://example.org/paper' });
  assert.equal(markdownSource('javascript:alert(1)'), undefined);
  assert.equal(markdownSource('data:text/html,hello'), undefined);
});

test('Results sections preserve measured content and exclude predictions and fenced headings', () => {
  const body = '## Setup\nFive seeds.\n## Analytical expectations, not results\nPrediction.\n## Observations\nMeasured 92%.\n```text\n## Setup\nQuoted output.\n```\n### Limits\nOnly this environment.\n## Next step\nMore seeds.\n## Completion and evidence\nSucceeded, claim still Open.';
  const result = resultSections(body);
  assert.match(result, /Measured 92%/);
  assert.match(result, /Quoted output/);
  assert.match(result, /Only this environment/);
  assert.match(result, /claim still Open/);
  assert.doesNotMatch(result, /Prediction|Five seeds|More seeds/);
});

test('CSV previews retain literal cells, headers, and truncation status', () => {
  const html = renderToStaticMarkup(createElement(SourceContent, { send: () => {}, item: { source: { path: '/results/summary.csv' }, kind: 'table', columns: ['seed', 'label', 'value'], rows: [['0', '<img onerror=bad>', '0.990099010']], truncated: true } }));
  assert.match(html, /<th scope="col">seed<\/th>/);
  assert.match(html, /<td>0.990099010<\/td>/);
  assert.match(html, /&lt;img onerror=bad&gt;/);
  assert.match(html, /1 rows shown/);
  assert.match(html, /Open the file for all rows and columns/);
  assert.doesNotMatch(html, /<img/);
});

test('Markdown renders inline and display math, including aligned equations and cases', () => {
  const text = 'Signal $\\omega^\\top z$.\n\n$$\n\\begin{aligned}B&=J_fU_s\\\\u&=Br\\end{aligned}\n$$\n\n$$\n\\omega_\\ell=\\begin{cases}\\Delta t,&\\ell=0\\\\2\\Delta t,&1\\leq\\ell\\leq15\\end{cases}\n$$';
  const html = renderToStaticMarkup(createElement(MarkdownText, { text }));
  assert.equal((html.match(/class="katex"/g) || []).length, 3);
  assert.equal((html.match(/class="katex-display"/g) || []).length, 2);
  assert.match(html, /<math[^>]*xmlns="http:\/\/www.w3.org\/1998\/Math\/MathML"/);
  assert.doesNotMatch(html, /katex-error/);
});

test('Math parsing preserves code and escaped dollars while invalid formulas remain readable', () => {
  const tick = String.fromCharCode(96);
  const text = tick + '$x^2$' + tick + '\n\n' + tick.repeat(3) + 'text\n$y^2$\n' + tick.repeat(3) + '\n\nCost: \\$5.\n\n$\\notARealMathCommand{x}$\n\n$\\frac{1}{$';
  const html = renderToStaticMarkup(createElement(MarkdownText, { text }));
  assert.match(html, /<code>\$x\^2\$<\/code>/);
  assert.match(html, /<pre><code class="language-text">\$y\^2\$\n<\/code><\/pre>/);
  assert.match(html, /Cost: \$5/);
  assert.match(html, /class="katex-error"/);
  assert.match(html, /notARealMathCommand/);
});

test('Math cannot introduce trusted HTML, executable links, or remote images', () => {
  const text = '$\\href{javascript:alert(1)}{click}$\n\n$\\includegraphics{https://example.org/private.png}$\n\n$\\htmlStyle{position:fixed}{x}$';
  const html = renderToStaticMarkup(createElement(MarkdownText, { text }));
  assert.doesNotMatch(html, /<a\b|<img\b|<script\b|style="position:fixed/);
});
