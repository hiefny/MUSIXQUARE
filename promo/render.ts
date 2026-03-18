/**
 * MUSIXQUARE Promo Video Renderer
 *
 * Captures CSS-animated HTML scenes frame-by-frame using Playwright,
 * then encodes to MP4 via ffmpeg.
 *
 * Usage:  npx tsx promo/render.ts
 */

import { chromium, type Browser, type Page } from 'playwright';
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ffmpeg installed via winget — may not be on PATH in current shell
const FFMPEG_BIN = process.env.FFMPEG_PATH ||
  path.join(
    process.env.LOCALAPPDATA || '',
    'Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.0.1-full_build/bin/ffmpeg.exe',
  );

// ─── Configuration ───────────────────────────────────────────────

interface SceneConfig {
  name: string;
  htmlFile: string;
  /** Total animation duration in milliseconds */
  durationMs: number;
  fps: number;
}

interface Orientation {
  name: string;
  width: number;
  height: number;
}

const SCENES: SceneConfig[] = [
  { name: 'ui-showcase',     htmlFile: 'scenes/ui-showcase.html',    durationMs: 40000, fps: 60 },
  { name: 'logo-animation',  htmlFile: 'scenes/logo-animation.html', durationMs: 5000,  fps: 60 },
];

const ORIENTATIONS: Orientation[] = [
  { name: 'portrait',  width: 1080, height: 1920 },
];

const ROOT       = path.resolve(__dirname);
const FRAMES_DIR = path.join(ROOT, 'frames');
const OUTPUT_DIR = path.join(ROOT, 'output');

// ─── Helpers ─────────────────────────────────────────────────────

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function cleanDir(dir: string) {
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      fs.unlinkSync(path.join(dir, f));
    }
  }
}

function padNum(n: number, len = 5): string {
  return String(n).padStart(len, '0');
}

// ─── Frame Capture ───────────────────────────────────────────────

async function captureFrames(
  browser: Browser,
  scene: SceneConfig,
  orient: Orientation,
): Promise<string> {
  const frameDir = path.join(FRAMES_DIR, `${scene.name}-${orient.name}`);
  ensureDir(frameDir);
  cleanDir(frameDir);

  const ctx = await browser.newContext({
    viewport: { width: orient.width, height: orient.height },
    deviceScaleFactor: 1,
  });
  const page: Page = await ctx.newPage();

  const htmlPath = path.resolve(ROOT, scene.htmlFile);
  const fileUrl  = `file:///${htmlPath.replace(/\\/g, '/')}?orientation=${orient.name}`;

  console.log(`  Loading: ${fileUrl}`);
  await page.goto(fileUrl, { waitUntil: 'networkidle' });

  // Wait for fonts to load
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);

  // If scene has an iframe (ui-showcase), wait for it to load
  const hasIframe = await page.evaluate(() => !!document.getElementById('app-frame'));
  if (hasIframe) {
    console.log('  Waiting for iframe to load...');
    // Wait for the iframe's load event and app setup
    await page.waitForFunction(() => (window as any).appReady === true, { timeout: 30000 });
    // Extra wait for iframe CSS to fully render
    await page.waitForTimeout(500);
    // Also wait for fonts inside iframe
    await page.evaluate(() => {
      const iframe = document.getElementById('app-frame') as HTMLIFrameElement;
      if (iframe?.contentDocument) {
        return iframe.contentDocument.fonts.ready;
      }
    });
    await page.waitForTimeout(300);
    console.log('  Iframe ready.');
  }

  // Kill any CSS animations (we drive everything via JS __promoSetTime)
  await page.evaluate(() => {
    document.getAnimations().forEach(a => a.cancel());
    // Also cancel animations inside iframe if present
    const iframe = document.getElementById('app-frame') as HTMLIFrameElement;
    if (iframe?.contentDocument) {
      iframe.contentDocument.getAnimations().forEach(a => a.cancel());
    }
    // Init promo timeline at t=0
    if (typeof (window as any).__promoSetTime === 'function') {
      (window as any).__promoSetTime(0);
    }
  });

  const totalFrames = Math.ceil((scene.durationMs / 1000) * scene.fps);
  const msPerFrame  = 1000 / scene.fps;

  console.log(`  Capturing ${totalFrames} frames @ ${scene.fps}fps...`);

  for (let i = 0; i <= totalFrames; i++) {
    const timeMs = i * msPerFrame;

    // Advance the JS-driven promo timeline (all animation is JS-controlled)
    await page.evaluate((t) => {
      if (typeof (window as any).__promoSetTime === 'function') {
        (window as any).__promoSetTime(t);
      }
    }, timeMs);

    const framePath = path.join(frameDir, `frame_${padNum(i)}.jpeg`);
    await page.screenshot({
      path: framePath,
      type: 'jpeg',
      quality: 95,
    });

    // Progress indicator every 60 frames (1 second)
    if (i > 0 && i % 60 === 0) {
      const pct = Math.round((i / totalFrames) * 100);
      process.stdout.write(`  ${pct}%  `);
    }
  }

  console.log(`\n  Done: ${totalFrames + 1} frames captured.`);

  await ctx.close();
  return frameDir;
}

// ─── ffmpeg Encoding ─────────────────────────────────────────────

function encodeToMp4(frameDir: string, outputFile: string, fps: number) {
  ensureDir(path.dirname(outputFile));

  const inputPattern = path.join(frameDir, 'frame_%05d.jpeg');

  const cmd = [
    `"${FFMPEG_BIN}"`, '-y',
    '-framerate', String(fps),
    '-i', `"${inputPattern}"`,
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    `"${outputFile}"`,
  ].join(' ');

  console.log(`  Encoding: ${path.basename(outputFile)}`);
  execSync(cmd, { stdio: 'pipe' });
  console.log(`  Done: ${outputFile}`);
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  console.log('MUSIXQUARE Promo Renderer');
  console.log('========================\n');

  // Check ffmpeg
  try {
    execSync(`"${FFMPEG_BIN}" -version`, { stdio: 'pipe' });
  } catch {
    console.error('ERROR: ffmpeg not found. Install with: winget install Gyan.FFmpeg');
    process.exit(1);
  }

  ensureDir(FRAMES_DIR);
  ensureDir(OUTPUT_DIR);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-gpu',
      '--no-sandbox',
      '--allow-file-access-from-files',  // Allow iframe file:// access
      '--disable-web-security',           // Cross-origin iframe access
    ],
  });

  const results: string[] = [];

  for (const scene of SCENES) {
    for (const orient of ORIENTATIONS) {
      const label = `${scene.name} (${orient.name} ${orient.width}x${orient.height})`;
      console.log(`\n[${label}]`);

      const frameDir = await captureFrames(browser, scene, orient);

      const outputFile = path.join(OUTPUT_DIR,
        `${scene.name}-${orient.name}-${orient.width}x${orient.height}.mp4`);

      encodeToMp4(frameDir, outputFile, scene.fps);
      results.push(outputFile);

      // Clean up frames to save disk space
      cleanDir(frameDir);
      fs.rmdirSync(frameDir);
    }
  }

  await browser.close();

  console.log('\n========================');
  console.log('All videos rendered!\n');
  results.forEach(r => console.log(`  ${r}`));
  console.log('');
}

main().catch(err => {
  console.error('Render failed:', err);
  process.exit(1);
});
