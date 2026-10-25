// Captures README/site screenshots and a short walkthrough video from the demo memory.
// Usage: node scripts/demo/screenshots.mjs  (after npm run build; needs Playwright's Chromium and ffmpeg for the GIF).
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, rm, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const repo = process.cwd(), out = path.join(repo, 'media', 'screenshots'), port = Number(process.env.DEMO_PORT || 4397);
await mkdir(out, { recursive: true });
const server = spawn(process.execPath, ['dist/preview.cjs'], { cwd: repo, env: { ...process.env, PORT: String(port), RESEARCH_MEMORY_ROOT: path.join(repo, 'examples', 'demo-memory') }, stdio: 'ignore' });
const browser = await chromium.launch();
try {
  const videoDir = path.join(out, '.video');
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: videoDir, size: { width: 1440, height: 900 } } });
  const page = await context.newPage();
  for (let i = 0; i < 60; i++) { try { await page.goto(`http://127.0.0.1:${port}`); break; } catch { await page.waitForTimeout(250); } }
  const shot = async (name, clip) => { await page.waitForTimeout(700); await page.screenshot({ path: path.join(out, `${name}.png`), ...(clip ? { clip } : {}) }); };
  const pause = ms => page.waitForTimeout(ms);
  await page.waitForSelector('.research-health', { timeout: 30000 });
  await pause(900);
  await page.locator('.research-health summary', { hasText: 'awaiting you' }).click();
  await shot('overview');
  await page.locator('.health-row').first().click();
  await page.waitForSelector('.details-panel');
  await shot('claim-proposal', { x: 0, y: 440, width: 1440, height: 460 });
  await page.locator('.details-panel [aria-label="Close details"], .details-panel button[title="Close"]').first().click().catch(() => page.keyboard.press('Escape'));
  await page.locator('.section-nav button', { hasText: 'Experiments' }).click();
  await page.waitForSelector('.react-flow__node', { timeout: 15000 });
  await shot('experiment-map');
  await page.locator('.react-flow__node', { hasText: 'Do chunked critics beat' }).first().click();
  await page.waitForSelector('.quick-review', { timeout: 15000 });
  await pause(1200);
  await shot('experiment-review');
  await page.locator('.details-panel [role="tab"]', { hasText: 'Results' }).click();
  await page.waitForSelector('.details-panel img', { timeout: 15000 });
  await page.locator('.details-panel img').first().scrollIntoViewIfNeeded();
  await shot('experiment-figures');
  await page.locator('.section-nav button', { hasText: 'Related work' }).click();
  await page.waitForSelector('.paper-row');
  await page.locator('.paper-row', { hasText: 'TD-MPC2' }).click();
  await page.waitForSelector('.details-panel');
  await shot('related-work');
  await page.locator('.section-nav button', { hasText: 'Experiments' }).click();
  await page.locator('button', { hasText: 'Back burner' }).first().click();
  await shot('back-burner');
  await context.close();
  const [video] = (await readdir(videoDir)).filter(name => name.endsWith('.webm'));
  await rename(path.join(videoDir, video), path.join(out, 'walkthrough.webm'));
  await rm(videoDir, { recursive: true, force: true });
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '2', '-i', path.join(out, 'walkthrough.webm'), '-vf', 'fps=8,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4', path.join(out, 'walkthrough.gif')]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '2', '-i', path.join(out, 'walkthrough.webm'), '-movflags', '+faststart', '-pix_fmt', 'yuv420p', '-vf', 'scale=1280:-2', path.join(out, 'walkthrough.mp4')]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '2', '-i', path.join(out, 'walkthrough.webm'), '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '40', '-vf', 'scale=1280:-2', path.join(out, 'walkthrough-small.webm')]);
  await rename(path.join(out, 'walkthrough-small.webm'), path.join(out, 'walkthrough.webm'));
} finally { await browser.close(); server.kill(); }
console.log('screenshots written to', out);
