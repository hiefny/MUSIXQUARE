/**
 * MUSIXQUARE Promo Video Renderer
 *
 * Captures CSS-animated HTML scenes frame-by-frame using Playwright,
 * then encodes to MP4 via ffmpeg.
 *
 * Usage:  npm run promo:render
 */

import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { execSync } from 'child_process';
import type { AddressInfo } from 'net';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

declare global {
  interface Window {
    appReady?: boolean;
    __promoSetTime?: (milliseconds: number) => void;
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// FFMPEG_PATH overrides the common WinGet installation used by this local
// rendering tool.
const FFMPEG_BIN =
  process.env.FFMPEG_PATH ||
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

const ALL_SCENES: SceneConfig[] = [
  { name: 'ui-showcase', htmlFile: 'scenes/ui-showcase.html', durationMs: 40000, fps: 60 },
  { name: 'ui-showcase-2', htmlFile: 'scenes/ui-showcase-2.html', durationMs: 30000, fps: 60 },
  { name: 'logo-animation', htmlFile: 'scenes/logo-animation.html', durationMs: 5000, fps: 60 },
];

const requestedScenes = new Set(process.argv.slice(2).filter((arg) => !arg.startsWith('-')));
const SCENES = requestedScenes.size
  ? ALL_SCENES.filter((scene) => requestedScenes.has(scene.name))
  : ALL_SCENES;

const ORIENTATIONS: Orientation[] = [{ name: 'portrait', width: 1080, height: 1920 }];

const ROOT = path.resolve(__dirname);
const REPO_ROOT = path.resolve(ROOT, '..', '..');
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

async function startViteServer(): Promise<{ server: ViteDevServer; origin: string }> {
  const server = await createServer({
    root: REPO_ROOT,
    configFile: path.join(REPO_ROOT, 'vite.config.ts'),
    server: {
      host: '127.0.0.1',
      port: 0,
      strictPort: false,
      open: false,
    },
  });

  await server.listen();

  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') {
    await server.close();
    throw new Error('Unable to determine Vite dev server port.');
  }

  const origin = `http://127.0.0.1:${(address as AddressInfo).port}`;
  console.log(`Vite dev server: ${origin}`);
  return { server, origin };
}

// ─── Frame Capture ───────────────────────────────────────────────

async function captureFrames(
  browser: Browser,
  scene: SceneConfig,
  orient: Orientation,
  serverOrigin: string,
): Promise<string> {
  const frameDir = path.join(FRAMES_DIR, `${scene.name}-${orient.name}`);
  ensureDir(frameDir);
  cleanDir(frameDir);

  const ctx = await browser.newContext({
    viewport: { width: orient.width, height: orient.height },
    deviceScaleFactor: 1,
  });
  const page: Page = await ctx.newPage();

  const scenePath = scene.htmlFile.replace(/\\/g, '/');
  const sceneUrl = `${serverOrigin}/.workshop/promo/${scenePath}?orientation=${orient.name}`;

  console.log(`  Loading: ${sceneUrl}`);
  await page.goto(sceneUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);

  // Wait for fonts to load
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);

  // If scene has an iframe (ui-showcase), wait for it to load
  const hasIframe = await page.evaluate(() => !!document.getElementById('app-frame'));
  if (hasIframe) {
    console.log('  Waiting for iframe to load...');
    // Wait for the iframe's load event and app setup
    await page.waitForFunction(() => window.appReady === true, undefined, {
      timeout: 30000,
    });
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

  // Cancel CSS animations because __promoSetTime drives a deterministic clock.
  await page.evaluate(() => {
    document.getAnimations().forEach((a) => a.cancel());
    // The embedded app must use the same deterministic frame clock.
    const iframe = document.getElementById('app-frame') as HTMLIFrameElement;
    if (iframe?.contentDocument) {
      iframe.contentDocument.getAnimations().forEach((a) => a.cancel());
    }
    // Initialize the scene timeline at t=0.
    if (typeof window.__promoSetTime === 'function') {
      window.__promoSetTime(0);
    }
  });

  const totalFrames = Math.ceil((scene.durationMs / 1000) * scene.fps);
  const msPerFrame = 1000 / scene.fps;

  console.log(`  Capturing ${totalFrames} frames @ ${scene.fps}fps...`);

  for (let i = 0; i <= totalFrames; i++) {
    const timeMs = i * msPerFrame;

    // Advance the JS-driven promo timeline (all animation is JS-controlled)
    await page.evaluate((t) => {
      if (typeof window.__promoSetTime === 'function') {
        window.__promoSetTime(t);
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
    `"${FFMPEG_BIN}"`,
    '-y',
    '-framerate',
    String(fps),
    '-i',
    `"${inputPattern}"`,
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
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

  if (SCENES.length === 0) {
    console.error(
      `ERROR: No matching scene. Available scenes: ${ALL_SCENES.map((s) => s.name).join(', ')}`,
    );
    process.exit(1);
  }

  // Check ffmpeg
  try {
    execSync(`"${FFMPEG_BIN}" -version`, { stdio: 'pipe' });
  } catch {
    console.error('ERROR: ffmpeg not found. Install with: winget install Gyan.FFmpeg');
    process.exit(1);
  }

  ensureDir(FRAMES_DIR);
  ensureDir(OUTPUT_DIR);

  const { server, origin } = await startViteServer();
  let browser: Browser | null = null;
  const results: string[] = [];

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-gpu', '--no-sandbox'],
    });

    for (const scene of SCENES) {
      for (const orient of ORIENTATIONS) {
        const label = `${scene.name} (${orient.name} ${orient.width}x${orient.height})`;
        console.log(`\n[${label}]`);

        const frameDir = await captureFrames(browser, scene, orient, origin);

        const outputFile = path.join(
          OUTPUT_DIR,
          `${scene.name}-${orient.name}-${orient.width}x${orient.height}.mp4`,
        );

        encodeToMp4(frameDir, outputFile, scene.fps);
        results.push(outputFile);

        // Clean up frames to save disk space
        cleanDir(frameDir);
        fs.rmdirSync(frameDir);
      }
    }
  } finally {
    if (browser) await browser.close();
    await server.close();
  }

  console.log('\n========================');
  console.log('All videos rendered!\n');
  results.forEach((r) => console.log(`  ${r}`));
  console.log('');
}

main().catch((err) => {
  console.error('Render failed:', err);
  process.exit(1);
});
