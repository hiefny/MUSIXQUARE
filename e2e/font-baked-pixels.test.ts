/**
 * The baked app faces draw exactly as their inputs where the overrides apply
 * (owner decision 2026-11-01).
 *
 * Chromium and Firefox apply the app sheets' metric overrides, and those
 * equal the line box baked into the files in fonts/app/, so baking must
 * change no pixel there. Context A is the build as it is; context B answers
 * every request for a baked face with its input file (fonts/app-faces.json),
 * which is what the app served before. Every screen must be the same PNG in
 * both:
 * - in the Korean and the English UI at 390 × 844: the start screen, the
 *   Playlist tab with tracks (one a decomposed Korean file name) and more
 *   than one playlist, the Connect, Settings and Help tabs, and the full chat
 *   with the font-identity fixture;
 * - on a 1280 × 800 desktop: Home with that track and the Playlist tab.
 *
 * What differs between two sessions anyway (the room code, the QR code, the
 * room password, the device list and the visualizer) is replaced by fixed
 * text or covered in both contexts, and the hint toast, which leaves on a
 * timer, is hidden.
 *
 * A local verification spec, not part of the critical set.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';

import { E2E_APP_ORIGIN } from './config.ts';
import { waitForBootstrapReady } from './helpers/bootstrap.ts';
import { injectPeerServer } from './helpers/peer-server.ts';
import { setupHostAndStart } from './helpers/setup-flow.ts';
import {
  navigateToTab,
  openChatDrawer,
  waitForAppFonts,
  waitForChatMessage,
} from './helpers/wait.ts';

type UiLanguage = 'ko' | 'en';

interface AppFacesRecord {
  readonly families: readonly {
    readonly input: string;
    readonly faces: readonly { readonly file: string }[];
  }[];
}

/** The input file of every baked face, by file stem (the copies keep their input's name). */
const INPUT_BY_STEM: ReadonlyMap<string, string> = (() => {
  const record = JSON.parse(
    readFileSync(new URL('../fonts/app-faces.json', import.meta.url), 'utf8'),
  ) as AppFacesRecord;
  const inputs = new Map<string, string>();
  for (const family of record.families) {
    for (const { file } of family.faces) {
      inputs.set(file.slice(0, -'.woff2'.length), `${family.input}/${file}`);
    }
  }
  return inputs;
})();

/** The font-identity chat fixture: Korean, Japanese, Chinese, Han, Cyrillic, Greek, Thai, Arabic and marks. */
const CHAT = [
  '안녕하세요 오늘 Night Drive 틀어요',
  'こんにちは、今日は良い天気ですね',
  '你好，今天我们听什么歌？',
  '漢字 海 返 曜 花 雪',
  'Привет! Как дела? Καλησπέρα',
  'สวัสดีครับ',
  'مرحبا بالجميع',
  '※ 공지 ― 아‥ 100‰ 정말‼ 왜⁉',
  'Intro -> Outro 3x4 1:30 → ≈ ♪ ★',
  '㈜카카오 ㉠ ㅋ 한',
  'Night Drive 밤의 드라이브 夜のドライブ 夜间驾驶 Ночная поездка ※ Live 2026 ‼ one long title that wraps',
  'City Pop 1984 좋아요',
] as const;

/** A file track whose name arrived decomposed, as macOS hands file names over. */
const FILE_TITLE = '밤의 드라이브 (2026 Remaster) 夜';
const TRACKS = [
  `${FILE_TITLE}.mp3`.normalize('NFD'),
  'Night Drive.mp3',
  'City Pop 1984.flac',
  'Ночная поездка.m4a',
] as const;
const ROOM_CODE = '135792';
/** Covered in every capture: they differ between any two sessions. */
const SESSION_VALUES = [
  '#qr-container',
  '#room-password-code',
  '#connect-device-list',
  '#visualizerCanvas',
];

/** A built asset's name without Vite's content hash. */
function assetStem(url: string): string {
  const name = new URL(url).pathname.split('/').pop() ?? '';
  return name.replace(/-[\w-]{8}\.woff2$/u, '');
}

interface Opened {
  readonly page: Page;
  /** The baked faces the page fetched, by stem. */
  readonly fetched: Set<string>;
  readonly close: () => Promise<void>;
}

async function openApp(
  browser: Browser,
  ui: UiLanguage,
  viewport: { width: number; height: number },
  deviceScaleFactor: number,
  serveInputs: boolean,
): Promise<Opened> {
  const context = await browser.newContext({
    baseURL: E2E_APP_ORIGIN,
    locale: ui === 'ko' ? 'ko-KR' : 'en-US',
    viewport,
    deviceScaleFactor,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  await context.route('**/*', (route) => {
    const { hostname } = new URL(route.request().url());
    return hostname === '127.0.0.1' || hostname === 'localhost' ? route.continue() : route.abort();
  });
  const fetched = new Set<string>();
  // Registered last, so it runs before the catch-all route above.
  await context.route(/\/assets\/[^/]+\.woff2$/u, async (route) => {
    const stem = assetStem(route.request().url());
    const input = INPUT_BY_STEM.get(stem);
    if (!input) return route.continue();
    fetched.add(stem);
    if (!serveInputs) return route.continue();
    return route.fulfill({
      status: 200,
      contentType: 'font/woff2',
      body: readFileSync(new URL(`../${input}`, import.meta.url)),
    });
  });
  const page = await context.newPage();
  await page.addInitScript((language) => {
    try {
      localStorage.setItem('musixquare-lang', language);
    } catch {
      // A blocked storage leaves the browser language in charge.
    }
  }, ui);
  await injectPeerServer(page);
  return { page, fetched, close: () => context.close() };
}

/** Waits until phase B has declared every sheet and no face is still loading. */
async function settle(page: Page): Promise<void> {
  await waitForAppFonts(page, 30_000);
  await expect
    .poll(
      () =>
        page.evaluate(() => [...document.fonts].filter((face) => face.status === 'loading').length),
      { timeout: 20_000 },
    )
    .toBe(0);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await page.waitForTimeout(400);
}

async function capture(page: Page): Promise<Buffer> {
  await page.evaluate((code) => {
    for (const element of document.querySelectorAll('.invite-code-value')) {
      element.textContent = code;
    }
    if (!document.getElementById('font-baked-pixels-style')) {
      // A hint toast leaves on a timer, so it may or may not show at a capture.
      const style = document.createElement('style');
      style.id = 'font-baked-pixels-style';
      style.textContent = '#toast { visibility: hidden !important; }';
      document.head.append(style);
    }
    (document.activeElement as HTMLElement | null)?.blur();
  }, ROOM_CODE);
  await settle(page);
  return page.screenshot({
    animations: 'disabled',
    caret: 'hide',
    mask: SESSION_VALUES.map((selector) => page.locator(selector)),
    maskColor: '#3a3a3a',
  });
}

/** A hosted room with tracks, three playlists and a fixed clock. */
async function startRoom(page: Page): Promise<void> {
  await setupHostAndStart(page);
  await page.clock.setFixedTime(new Date('2026-10-31T12:00:00Z'));
  await page.evaluate(
    ({ tracks }) => {
      const runtime = window as unknown as {
        __MUSIXQUARE_SET_STATE__: (path: string, value: unknown) => void;
      };
      const items = tracks.map((name, index) => ({
        queueItemId: `00000000-0000-4000-8000-0000000000${String(index + 1).padStart(2, '0')}`,
        type: 'file',
        name,
        videoId: null,
        playlistId: null,
      }));
      runtime.__MUSIXQUARE_SET_STATE__('playlist.items', items);
      runtime.__MUSIXQUARE_SET_STATE__('player.currentTrackMeta', { ...items[0], size: 1024 });
      runtime.__MUSIXQUARE_SET_STATE__('playlist.slots', {
        activeSlot: 0,
        slots: [
          { count: items.length, bytes: 4096 },
          { count: 2, bytes: 2048 },
          { count: 0, bytes: null },
        ],
      });
    },
    { tracks: TRACKS },
  );
  await expect(page.locator('#btn-playlist-switch')).not.toHaveAttribute('hidden');
}

async function captureChat(page: Page): Promise<Buffer> {
  await openChatDrawer(page);
  await page.waitForTimeout(500);
  if ((await page.locator('#chat-drawer').getAttribute('data-chat-snap')) !== 'full') {
    await page.locator('#chat-drawer .chat-drawer-header').focus();
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('#chat-drawer')).toHaveAttribute('data-chat-snap', 'full');
    await page.waitForTimeout(500);
  }
  await page.evaluate(() => {
    (
      window as unknown as { __MUSIXQUARE_BUS__: { emit(type: string): void } }
    ).__MUSIXQUARE_BUS__.emit('chat:clear-all');
    for (const node of document.querySelectorAll('#chat-messages > *')) node.remove();
  });
  for (const text of CHAT) {
    await page.locator('#chat-input').fill(text);
    await page.locator('#chat-input').press('Enter');
    await waitForChatMessage(page, text);
  }
  await page.locator('#chat-input').blur();
  await page.locator('#chat-messages').evaluate(async (container) => {
    await Promise.all(
      container.getAnimations({ subtree: true }).map((animation) => animation.finished),
    );
  });
  return capture(page);
}

/** The phone screens of one UI, by name. */
async function phoneScreens(
  browser: Browser,
  ui: UiLanguage,
  serveInputs: boolean,
): Promise<{ screens: Record<string, Buffer>; fetched: Set<string> }> {
  const { page, fetched, close } = await openApp(
    browser,
    ui,
    { width: 390, height: 844 },
    2,
    serveInputs,
  );
  const screens: Record<string, Buffer> = {};
  try {
    await page.goto('/');
    await waitForBootstrapReady(page);
    await expect(page.locator('#btn-setup-host')).toBeVisible({ timeout: 15_000 });
    screens.start = await capture(page);
    await startRoom(page);
    for (const tab of ['playlist', 'connect', 'settings', 'guide']) {
      await navigateToTab(page, tab);
      screens[tab] = await capture(page);
    }
    screens.chat = await captureChat(page);
  } finally {
    await close();
  }
  return { screens, fetched };
}

async function desktopScreens(
  browser: Browser,
  serveInputs: boolean,
): Promise<{ screens: Record<string, Buffer>; fetched: Set<string> }> {
  const { page, fetched, close } = await openApp(
    browser,
    'ko',
    { width: 1280, height: 800 },
    1,
    serveInputs,
  );
  const screens: Record<string, Buffer> = {};
  try {
    await startRoom(page);
    await navigateToTab(page, 'play');
    await expect(page.locator('#track-title')).toHaveText(FILE_TITLE);
    screens.home = await capture(page);
    await navigateToTab(page, 'playlist');
    screens.playlist = await capture(page);
  } finally {
    await close();
  }
  return { screens, fetched };
}

/** Screens whose PNGs differ, with both attached to the report. */
async function differing(
  baked: Record<string, Buffer>,
  inputs: Record<string, Buffer>,
  label: string,
): Promise<string[]> {
  expect(Object.keys(inputs).sort()).toEqual(Object.keys(baked).sort());
  const names: string[] = [];
  for (const [name, png] of Object.entries(baked)) {
    const other = inputs[name];
    if (other && png.equals(other)) continue;
    names.push(`${label} ${name}`);
    await test.info().attach(`${label} ${name} baked`, { body: png, contentType: 'image/png' });
    if (other) {
      await test
        .info()
        .attach(`${label} ${name} inputs`, { body: other, contentType: 'image/png' });
    }
  }
  return names;
}

test.describe('baked app faces where the overrides apply', () => {
  test.setTimeout(300_000);

  for (const ui of ['ko', 'en'] as const) {
    test(`every ${ui} phone screen is the same PNG with the baked faces and their inputs`, async ({
      browser,
    }) => {
      const baked = await phoneScreens(browser, ui, false);
      const inputs = await phoneScreens(browser, ui, true);
      // Both fetched baked faces; B answered each with its input. (Idle
      // prefetching may add shards at different moments, so the sets may differ.)
      expect(baked.fetched.size).toBeGreaterThan(0);
      expect(inputs.fetched.size).toBeGreaterThan(0);
      expect(await differing(baked.screens, inputs.screens, ui)).toEqual([]);
    });
  }

  test('desktop Home and Playlist are the same PNG with the baked faces and their inputs', async ({
    browser,
  }) => {
    const baked = await desktopScreens(browser, false);
    const inputs = await desktopScreens(browser, true);
    expect(baked.fetched.size).toBeGreaterThan(0);
    expect(inputs.fetched.size).toBeGreaterThan(0);
    expect(await differing(baked.screens, inputs.screens, 'desktop')).toEqual([]);
  });
});
