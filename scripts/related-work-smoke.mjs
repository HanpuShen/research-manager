// Browser smoke test of the Related work page against a COPY of a memory folder (RESEARCH_MEMORY_ROOT).
// It adds a real arXiv paper (network: export.arxiv.org and api.github.com) and uploads a tiny PDF.
// Screenshots go to test-results/related-work-*.png.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const repo = process.cwd();
const source = process.env.RESEARCH_MEMORY_ROOT;
if (!source) throw new Error('Set RESEARCH_MEMORY_ROOT to a memory folder; it is copied, never modified.');
const scratch = await mkdtemp(path.join(tmpdir(), 'research-related-work-'));
const memory = path.join(scratch, 'memory');
await cp(source, memory, { recursive: true, filter: file => path.basename(file) !== '.git' });
await mkdir(path.join(repo, 'test-results'), { recursive: true });
const port = Number(process.env.RESEARCH_UI_PORT || 4321);
const child = spawn(process.execPath, ['dist/preview.cjs'], { cwd: repo, env: { ...process.env, PORT: String(port), RESEARCH_MEMORY_ROOT: memory }, stdio: ['ignore', 'pipe', 'pipe'] });
let childError = '';
child.stderr.on('data', data => { childError += data; });
const pass = label => console.log(`PASS ${label}`);
let browser;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Preview did not start: ${childError}`)), 15000);
    child.stdout.on('data', data => { if (String(data).includes('Research Manager preview:')) { clearTimeout(timer); resolve(); } });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`Preview exited (${code}): ${childError}`)); });
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`);
  await page.getByRole('button', { name: /Related work/ }).click();
  await page.getByRole('heading', { name: 'Related work' }).waitFor();
  const rows = page.locator('.paper-row');
  const before = await rows.count();
  pass(`Related work page lists ${before} paper(s)`);
  await page.screenshot({ path: 'test-results/related-work-list.png' });

  await page.getByRole('button', { name: 'Add paper' }).first().click();
  await page.getByLabel('Paper link').fill('https://arxiv.org/abs/1707.06347');
  await page.getByLabel('Code repositories').fill('https://github.com/openai/baselines');
  await page.getByLabel('Tags').fill('baseline, policy gradient');
  await page.locator('.editor-dialog').getByRole('button', { name: 'Add paper' }).click();
  await page.locator('.details-panel h2', { hasText: 'Proximal Policy Optimization Algorithms' }).waitFor({ timeout: 30000 });
  assert.equal(await rows.count(), before + 1);
  pass('arXiv link filled title; the new paper opens in details');
  const details = page.locator('.details-panel');
  await page.screenshot({ path: 'test-results/related-work-details-top.png' });
  assert.match(await details.textContent(), /John Schulman/);
  assert.match(await details.textContent(), /openai\/baselines/);
  await details.getByText('BibTeX', { exact: true }).click();
  assert.match(await details.locator('pre').textContent(), /@misc\{schulman2017/);
  pass('authors, code repository, and BibTeX shown');
  await page.screenshot({ path: 'test-results/related-work-details.png' });

  await details.locator('input[type=file]').setInputFiles({ name: 'ppo.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% smoke\n') });
  await details.getByRole('button', { name: 'Open PDF ↗' }).waitFor({ timeout: 15000 });
  assert.match(await details.textContent(), /ppo\.pdf/);
  pass('PDF upload stored and listed');
  await details.locator('input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await details.getByRole('alert').filter({ hasText: 'Choose a PDF file.' }).waitFor();
  pass('non-PDF upload rejected in the page');

  await details.getByLabel('Reading status').selectOption('Reading');
  await page.locator('.paper-row', { hasText: 'Proximal Policy' }).locator('.badge', { hasText: 'Reading' }).waitFor({ timeout: 15000 });
  pass('reading status saved');

  await page.getByRole('button', { name: 'Add paper' }).first().click();
  await page.getByLabel('Paper link').fill('https://openreview.net/forum?id=example');
  await page.locator('.editor-dialog').getByRole('button', { name: 'Add paper' }).click();
  await page.locator('.editor-dialog .form-error').filter({ hasText: 'Enter a title' }).waitFor({ timeout: 15000 });
  pass('non-arXiv link without a title explains what to do');
  await page.screenshot({ path: 'test-results/related-work-dialog-error.png' });
  await page.getByRole('button', { name: 'Cancel' }).click();

  await page.getByPlaceholder(/Search/i).fill('policy gradient').catch(() => {});
  await page.setViewportSize({ width: 600, height: 900 });
  await page.screenshot({ path: 'test-results/related-work-narrow.png', fullPage: false });
  assert.deepEqual(errors, []);
  pass('no page errors');
} finally {
  await browser?.close();
  child.kill('SIGTERM');
}
