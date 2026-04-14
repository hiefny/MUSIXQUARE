/**
 * MUSIXQUARE Logo Animation → 4K 60fps MP4
 *
 * Usage: node .workshop/promo/render-logo-4k.mjs
 * Output: .workshop/promo/logo-4k.mp4
 *
 * Requires: puppeteer (npm), ffmpeg (system)
 */

import puppeteer from 'puppeteer';
import { execSync } from 'child_process';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const WIDTH = 3840;
const HEIGHT = 2160;
const FPS = 60;
const DURATION_S = 4; // Total animation duration in seconds
const TOTAL_FRAMES = FPS * DURATION_S;
const FRAME_MS = 1000 / FPS;

const FRAMES_DIR = resolve(__dirname, '_frames');
const OUTPUT_FILE = resolve(__dirname, 'logo-4k.mp4');
const HTML_FILE = resolve(__dirname, 'logo-4k-render.html');

async function main() {
  console.log(`🎬 Rendering ${TOTAL_FRAMES} frames at ${WIDTH}x${HEIGHT} ${FPS}fps...`);

  // Clean up previous frames
  if (existsSync(FRAMES_DIR)) rmSync(FRAMES_DIR, { recursive: true });
  mkdirSync(FRAMES_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    headless: true,
    args: [`--window-size=${WIDTH},${HEIGHT}`],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });

  // Load the HTML file
  await page.goto(`file://${HTML_FILE}`, { waitUntil: 'domcontentloaded' });

  // Pause all animations at time 0
  await page.evaluate(() => {
    document.getAnimations().forEach(a => {
      a.pause();
      a.currentTime = 0;
    });
  });

  // Render each frame
  for (let i = 0; i < TOTAL_FRAMES; i++) {
    const timeMs = i * FRAME_MS;

    // Set all animations to this exact time
    await page.evaluate((t) => {
      document.getAnimations().forEach(a => {
        a.currentTime = t;
      });
    }, timeMs);

    // Screenshot
    const frameNum = String(i).padStart(5, '0');
    await page.screenshot({
      path: `${FRAMES_DIR}/frame_${frameNum}.png`,
      type: 'png',
    });

    if (i % 30 === 0) {
      console.log(`  Frame ${i}/${TOTAL_FRAMES} (${(timeMs / 1000).toFixed(1)}s)`);
    }
  }

  await browser.close();
  console.log(`✅ ${TOTAL_FRAMES} frames rendered.`);

  // Combine frames into MP4 with FFmpeg
  console.log(`🎞️ Encoding to MP4...`);
  const ffmpegCmd = [
    'ffmpeg', '-y',
    '-framerate', String(FPS),
    '-i', `${FRAMES_DIR}/frame_%05d.png`,
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-s', `${WIDTH}x${HEIGHT}`,
    OUTPUT_FILE,
  ].join(' ');

  execSync(ffmpegCmd, { stdio: 'inherit' });

  // Clean up frames
  rmSync(FRAMES_DIR, { recursive: true });

  console.log(`🎉 Done! Output: ${OUTPUT_FILE}`);
}

main().catch(e => { console.error(e); process.exit(1); });
