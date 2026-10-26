// Captures README/site screenshots and a short walkthrough video from the demo memory.
// Usage: node scripts/demo/screenshots.mjs  (after npm run build; needs Playwright's Chromium and ffmpeg for the GIF).
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const repo = process.cwd(), out = path.join(repo, 'media', 'screenshots'), port = Number(process.env.DEMO_PORT || 4397);
await mkdir(out, { recursive: true });
const server = spawn(process.execPath, ['dist/preview.cjs'], { cwd: repo, env: { ...process.env, PORT: String(port), RESEARCH_MEMORY_ROOT: path.join(repo, 'examples', 'demo-memory') }, stdio: 'ignore' });
const browser = await chromium.launch();
try {
  // The walkthrough is captured as lossless 2x frames through the DevTools screencast (Playwright's recordVideo is low bitrate).
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const frameDir = path.join(out, '.frames'), frames = [];
  await rm(frameDir, { recursive: true, force: true }); await mkdir(frameDir);
  const cdp = await context.newCDPSession(page);
  cdp.on('Page.screencastFrame', async frame => {
    const file = path.join(frameDir, `${String(frames.length).padStart(5, '0')}.png`);
    frames.push({ file, at: frame.metadata.timestamp });
    await writeFile(file, Buffer.from(frame.data, 'base64'));
    await cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
  });
  for (let i = 0; i < 60; i++) { try { await page.goto(`http://127.0.0.1:${port}`); break; } catch { await page.waitForTimeout(250); } }
  const shot = async (name, clip) => { await page.waitForTimeout(1400); await page.screenshot({ path: path.join(out, `${name}.png`), scale: 'css', ...(clip ? { clip } : {}) }); };
  const pause = ms => page.waitForTimeout(ms);
  await page.waitForSelector('.research-health', { timeout: 30000 });
  await pause(1500);
  await cdp.send('Page.startScreencast', { format: 'png', maxWidth: 2880, maxHeight: 1800, everyNthFrame: 1 });
  await pause(1500);
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
  await pause(1500);
  await cdp.send('Page.stopScreencast');
  await context.close();
  // Frames arrive only when the screen changes: give each its real on-screen duration.
  const list = frames.map((frame, i) => `file '${frame.file}'\nduration ${Math.max(0.04, (frames[i + 1]?.at ?? frame.at + 1.5) - frame.at).toFixed(3)}`).join('\n') + `\nfile '${frames.at(-1).file}'\n`;
  const listFile = path.join(frameDir, 'frames.txt');
  await writeFile(listFile, list);
  const input = ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile];
  execFileSync('ffmpeg', [...input, '-vf', 'fps=30,scale=1920:-2:flags=lanczos', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(out, 'walkthrough.mp4')]);
  execFileSync('ffmpeg', [...input, '-vf', 'fps=30,scale=1920:-2:flags=lanczos', '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '30', '-row-mt', '1', path.join(out, 'walkthrough.webm')]);
  execFileSync('ffmpeg', [...input, '-vf', 'fps=10,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle', path.join(out, 'walkthrough.gif')]);
  await rm(frameDir, { recursive: true, force: true });
} finally { await browser.close(); server.kill(); }
console.log('screenshots written to', out);
