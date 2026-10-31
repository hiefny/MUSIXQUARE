/**
 * Font identity across UI languages (owner decisions 2026-10-31, the app font
 * switch to Inter and Noto).
 *
 * The same content draws the same in the Korean and the English UI: the same
 * self-hosted face for every character, the same widths and the same pixels.
 * The fixture is chat in many scripts (Korean, Japanese, Chinese, Han without
 * a language marker, Russian and Greek, Thai, Arabic, the marks Inter lacks
 * ※ ― ‥ ‰ ‼ ⁉, arrows and symbols, a long wrapping line, emoji) and a file
 * track whose name arrived decomposed (NFD), in the player and the playlist.
 * It holds for a browser that lists Korean first and for one that lists
 * Japanese first, which changes the startup Han order of both UIs alike.
 *
 * The network side: each UI's start screen fetches only its first faces, the
 * app requests every app sheet once and nothing of Pretendard or the retired
 * font runtime, phase B declares the other sheets after window load, and
 * phase C prefetches the Korean UI's frequent Noto Sans KR shards within its
 * budget and nothing in the English UI.
 *
 * A local verification spec, not part of the critical set.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { APP_FONT_SHEETS } from '../src/i18n/app-font-contract.ts';
import {
  FONT_PREFETCH_MAX_BYTES,
  FONT_PREFETCH_MAX_FACES,
  FONT_PREFETCH_QUIET_MS,
} from '../src/i18n/font-loading-policy.ts';
import { FONT_PREFETCH_BY_LANGUAGE } from '../src/i18n/font-prefetch-samples.ts';
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
  // Long enough to wrap. Not the group's last row, which carries the
  // localized time beside its bubble.
  'Night Drive 밤의 드라이브 夜のドライブ 夜间驾驶 Ночная поездка ※ Live 2026 ‼ one long title that wraps',
  'City Pop 1984 좋아요 👍',
] as const;

/** A file track whose name arrived decomposed, as macOS hands file names over. */
const FILE_TITLE = '밤의 드라이브 (2026 Remaster) 夜';
const FILE_NAME = `${FILE_TITLE}.mp3`.normalize('NFD');

/** Code points no self-hosted face draws (scripts/check-app-font.mts keeps the list exact). */
const UNCOVERED: ReadonlySet<number> = new Set(
  readFileSync(new URL('../scripts/fonts/uncovered-code-points.txt', import.meta.url), 'utf8')
    .split('\n')
    .map((line) => line.replace(/#.*$/u, '').trim())
    .filter((line) => /^U\+[0-9A-F]{4,6}$/u.test(line))
    .map((line) => Number.parseInt(line.slice(2), 16)),
);

/** The family of each committed font file, by file stem. */
const FAMILY_BY_STEM: ReadonlyMap<string, string> = (() => {
  const families = new Map<string, string>();
  const add = (directory: string, family: string) => {
    for (const file of readdirSync(new URL(`../${directory}/`, import.meta.url))) {
      if (file.endsWith('.woff2')) families.set(file.slice(0, -'.woff2'.length), family);
    }
  };
  add('fonts/inter', 'Inter');
  add('fonts/noto/noto-sans-kr', 'Noto Sans KR');
  add('fonts/noto/noto-sans-jp', 'Noto Sans JP');
  add('fonts/noto/noto-sans-sc', 'Noto Sans SC');
  add('fonts/noto/noto-sans-tc', 'Noto Sans TC');
  add('fonts/noto/noto-sans-thai', 'Noto Sans Thai');
  return families;
})();

const APP_SHEET_IDS: ReadonlySet<string> = new Set(APP_FONT_SHEETS.map(({ id }) => id));
/** The static pages' original sheets, which the app never requests. */
const STATIC_PAGE_ONLY_SHEETS = ['noto-jp', 'noto-sc', 'noto-tc', 'noto-thai', 'noto-cyrillic'];

/** A built asset's name without Vite's content hash. */
function assetStem(url: string): string {
  const name = new URL(url).pathname.split('/').pop() ?? '';
  return name.replace(/-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/u, '');
}

interface FontRequest {
  readonly url: string;
  readonly stem: string;
  readonly kind: 'sheet' | 'font' | 'other';
  /** The response body size, filled in once Playwright reports it. */
  bytes: number;
}

async function openApp(
  browser: Browser,
  ui: UiLanguage,
  locale: string,
): Promise<{ context: BrowserContext; page: Page; requests: FontRequest[] }> {
  const context = await browser.newContext({
    baseURL: E2E_APP_ORIGIN,
    locale,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  await context.route('**/*', (route) => {
    const { hostname } = new URL(route.request().url());
    return hostname === '127.0.0.1' || hostname === 'localhost' ? route.continue() : route.abort();
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
  const requests: FontRequest[] = [];
  page.on('requestfinished', (request) => {
    const url = request.url();
    const path = new URL(url).pathname;
    const kind = /\.woff2$/u.test(path) ? 'font' : /\.css$/u.test(path) ? 'sheet' : 'other';
    if (kind === 'other' && !/pretendard|primary-font/iu.test(url)) return;
    const entry: FontRequest = { url, stem: assetStem(url), kind, bytes: 0 };
    requests.push(entry);
    void request.sizes().then(
      ({ responseBodySize }) => {
        entry.bytes = responseBodySize;
      },
      () => undefined,
    );
  });
  return { context, page, requests };
}

/** Waits until phase B has declared every sheet and no face is still loading. */
async function settleFonts(page: Page): Promise<void> {
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
}

async function openFullChat(page: Page): Promise<void> {
  await openChatDrawer(page);
  await page.waitForTimeout(500);
  if ((await page.locator('#chat-drawer').getAttribute('data-chat-snap')) !== 'full') {
    await page.locator('#chat-drawer .chat-drawer-header').focus();
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('#chat-drawer')).toHaveAttribute('data-chat-snap', 'full');
    await page.waitForTimeout(500);
  }
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

interface PlatformFont {
  readonly familyName: string;
  readonly isCustomFont: boolean;
}

interface Drawn {
  /** Per target, each grapheme with the faces that draw it. */
  readonly glyphs: Record<string, { grapheme: string; faces: PlatformFont[] }[]>;
  readonly widths: Record<string, number>;
  readonly pixels: Record<string, Buffer>;
}

/**
 * The faces, widths and pixels of every [data-font-target] element. Each
 * grapheme's faces come from CSS.getPlatformFontsForNode on a hidden copy
 * beside the element with the element's computed font properties.
 */
async function readDrawn(page: Page): Promise<Drawn> {
  const order = await page.evaluate(() => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const properties = [
      'font-family',
      'font-weight',
      'font-style',
      'font-size',
      'font-stretch',
      'font-feature-settings',
      'font-variant-ligatures',
      'font-variant-numeric',
      'font-variant-east-asian',
      'font-kerning',
      'font-optical-sizing',
      'font-variation-settings',
      'letter-spacing',
    ];
    const list: { key: string; grapheme: string }[] = [];
    for (const element of document.querySelectorAll<HTMLElement>('[data-font-target]')) {
      const key = element.dataset.fontTarget ?? '';
      const style = getComputedStyle(element);
      const probe = document.createElement('span');
      probe.dataset.fontProbe = key;
      for (const property of properties) {
        probe.style.setProperty(property, style.getPropertyValue(property));
      }
      probe.style.cssText +=
        ';position:absolute;left:0;top:0;visibility:hidden;white-space:pre;pointer-events:none;';
      for (const { segment } of segmenter.segment(element.textContent ?? '')) {
        const span = document.createElement('span');
        span.textContent = segment;
        probe.append(span);
        list.push({ key, grapheme: segment });
      }
      element.parentElement?.append(probe);
    }
    return list;
  });
  const glyphs: Drawn['glyphs'] = {};
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', {
      nodeId: root.nodeId,
      selector: '[data-font-probe] > span',
    });
    expect(nodeIds.length, 'one probe per grapheme').toBe(order.length);
    for (const [index, nodeId] of nodeIds.entries()) {
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
      const entry = order[index];
      if (!entry) continue;
      (glyphs[entry.key] ??= []).push({
        grapheme: entry.grapheme,
        faces: fonts.map(({ familyName, isCustomFont }) => ({ familyName, isCustomFont })),
      });
    }
  } finally {
    await cdp.detach().catch(() => undefined);
    await page.evaluate(() => {
      for (const probe of document.querySelectorAll('[data-font-probe]')) probe.remove();
    });
  }
  const widths = await page.evaluate(() => {
    const result: Record<string, number> = {};
    for (const element of document.querySelectorAll<HTMLElement>('[data-font-target]')) {
      const range = document.createRange();
      range.selectNodeContents(element);
      result[element.dataset.fontTarget ?? ''] = range.getBoundingClientRect().width;
    }
    return result;
  });
  const pixels: Record<string, Buffer> = {};
  for (const key of Object.keys(widths)) {
    pixels[key] = await page
      .locator(`[data-font-target="${key}"]`)
      .screenshot({ animations: 'disabled', caret: 'hide' });
  }
  return { glyphs, widths, pixels };
}

async function markTargets(
  page: Page,
  targets: readonly { key: string; selector: string; text?: string }[],
): Promise<void> {
  await page.evaluate((targets) => {
    for (const element of document.querySelectorAll('[data-font-target]')) {
      element.removeAttribute('data-font-target');
    }
    for (const { key, selector, text } of targets) {
      const element = [...document.querySelectorAll<HTMLElement>(selector)].find(
        (candidate) =>
          candidate.getBoundingClientRect().height > 0 &&
          (text === undefined || candidate.textContent === text),
      );
      if (!element) throw new Error(`No ${key} target: ${selector} ${text ?? ''}`);
      element.dataset.fontTarget = key;
    }
  }, targets);
}

const SCRIPT_FAMILY: readonly [RegExp, RegExp][] = [
  [/[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Nd}]/u, /^Inter/u],
  [/\p{Script=Hangul}/u, /^Noto Sans KR/u],
  [/[\p{Script=Hiragana}\p{Script=Katakana}]/u, /^Noto Sans JP/u],
  [/\p{Script=Thai}/u, /^Noto Sans Thai/u],
  [/\p{Script=Arabic}/u, /^Noto Sans Arabic/u],
];

/** Faces that break the switch's rules: a device face for a covered character, or the wrong family for a script. */
function ruleBreaks(drawn: Drawn): string[] {
  const breaks: string[] = [];
  for (const [key, list] of Object.entries(drawn.glyphs)) {
    for (const { grapheme, faces } of list) {
      if (!grapheme.trim()) continue;
      const names = faces.map(({ familyName, isCustomFont }) =>
        isCustomFont ? familyName : `${familyName} (device)`,
      );
      if (faces.some(({ familyName }) => /pretendard/iu.test(familyName))) {
        breaks.push(`${key} '${grapheme}': Pretendard`);
      }
      if (/\p{Extended_Pictographic}/u.test(grapheme)) continue;
      const covered = [...grapheme].every(
        (character) => !UNCOVERED.has(character.codePointAt(0) ?? 0),
      );
      if (covered && !faces.every(({ isCustomFont }) => isCustomFont)) {
        breaks.push(`${key} '${grapheme}': ${names.join(', ')}`);
      }
      const owner = SCRIPT_FAMILY.find(([script]) => script.test(grapheme))?.[1];
      if (owner && !(faces.length === 1 && owner.test(faces[0]?.familyName ?? ''))) {
        breaks.push(`${key} '${grapheme}' should be ${String(owner)}: ${names.join(', ')}`);
      }
    }
  }
  return breaks;
}

/** One UI's drawing of the whole fixture, after every face has settled. */
async function drawFixture(
  browser: Browser,
  ui: UiLanguage,
  locale: string,
): Promise<{ drawn: Drawn; hanOrder: string | null; lang: string }> {
  const { context, page } = await openApp(browser, ui, locale);
  try {
    await setupHostAndStart(page);
    // Fixed wall-clock labels keep every message in one chat group.
    await page.clock.setFixedTime(new Date('2026-10-31T12:00:00Z'));
    await expect(page.locator('html')).toHaveAttribute('lang', ui);

    // The file track: the player title and its playlist row.
    await page.evaluate((name) => {
      const runtime = window as unknown as {
        __MUSIXQUARE_SET_STATE__: (path: string, value: unknown) => void;
      };
      const item = {
        queueItemId: '00000000-0000-4000-8000-0000000000f1',
        type: 'file',
        name,
        videoId: null,
        playlistId: null,
      };
      runtime.__MUSIXQUARE_SET_STATE__('playlist.items', [item]);
      runtime.__MUSIXQUARE_SET_STATE__('player.currentTrackMeta', { ...item, size: 1024 });
    }, FILE_NAME);
    await navigateToTab(page, 'play');
    await expect(page.locator('#track-title')).toHaveText(FILE_TITLE);
    await navigateToTab(page, 'playlist');
    const row = page.locator('.track-name-text .playlist-title-marquee-content').first();
    await expect(row).toHaveText(FILE_TITLE);
    await settleFonts(page);
    await markTargets(page, [
      { key: 'playlist row', selector: '.track-name-text .playlist-title-marquee-content' },
    ]);
    const playlist = await readDrawn(page);
    await navigateToTab(page, 'play');
    await settleFonts(page);
    await markTargets(page, [{ key: 'player title', selector: '#track-title' }]);
    const player = await readDrawn(page);

    // Chat: only the fixture's messages, in one group from this device.
    await openFullChat(page);
    await page.evaluate(() => {
      (
        window as unknown as { __MUSIXQUARE_BUS__: { emit(type: string): void } }
      ).__MUSIXQUARE_BUS__.emit('chat:clear-all');
      // Clearing leaves a localized notice whose height differs between the
      // UIs; remove it so both lay out only the fixture.
      for (const node of document.querySelectorAll('#chat-messages > *')) node.remove();
    });
    await expect(page.locator('#chat-messages .chat-bubble')).toHaveCount(0);
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
    await settleFonts(page);
    await markTargets(
      page,
      CHAT.map((text, index) => ({
        key: `chat ${index + 1}`,
        selector: '#chat-messages .chat-text',
        text,
      })),
    );
    const chat = await readDrawn(page);

    const root = await page.evaluate(() => ({
      hanOrder: document.documentElement.getAttribute('data-mxqr-han-order'),
      lang: document.documentElement.lang,
    }));
    return {
      drawn: {
        glyphs: { ...playlist.glyphs, ...player.glyphs, ...chat.glyphs },
        widths: { ...playlist.widths, ...player.widths, ...chat.widths },
        pixels: { ...playlist.pixels, ...player.pixels, ...chat.pixels },
      },
      ...root,
    };
  } finally {
    await context.close();
  }
}

const faceList = (drawn: Drawn): Record<string, string[]> =>
  Object.fromEntries(
    Object.entries(drawn.glyphs).map(([key, list]) => [
      key,
      list.map(
        ({ grapheme, faces }) =>
          `${grapheme} ${faces.map(({ familyName, isCustomFont }) => `${familyName}${isCustomFont ? '' : ' (device)'}`).join(' + ')}`,
      ),
    ]),
  );

test.describe('app font identity', () => {
  test.setTimeout(240_000);

  for (const [locale, hanOrder] of [
    ['ko-KR', null],
    ['ja-JP', 'ja'],
  ] as const) {
    test(`the Korean and English UIs draw the same content alike (browser ${locale})`, async ({
      browser,
    }, testInfo) => {
      const korean = await drawFixture(browser, 'ko', locale);
      const english = await drawFixture(browser, 'en', locale);

      expect([korean.lang, english.lang]).toEqual(['ko', 'en']);
      expect([korean.hanOrder, english.hanOrder]).toEqual([hanOrder, hanOrder]);
      expect(ruleBreaks(korean.drawn), 'Korean UI').toEqual([]);
      expect(ruleBreaks(english.drawn), 'English UI').toEqual([]);

      // The record of what drew each character, for the report and a failed run.
      writeFileSync(
        testInfo.outputPath('drawn.json'),
        JSON.stringify(
          { hanOrder, faces: faceList(korean.drawn), widths: korean.drawn.widths },
          null,
          1,
        ),
      );
      expect(faceList(english.drawn)).toEqual(faceList(korean.drawn));
      expect(english.drawn.widths).toEqual(korean.drawn.widths);
      const differing: string[] = [];
      for (const [key, pixels] of Object.entries(korean.drawn.pixels)) {
        const other = english.drawn.pixels[key];
        if (other && pixels.equals(other)) continue;
        differing.push(key);
        await testInfo.attach(`${key} ko`, { body: pixels, contentType: 'image/png' });
        if (other) await testInfo.attach(`${key} en`, { body: other, contentType: 'image/png' });
      }
      expect(differing, 'targets whose pixels differ between the two UIs').toEqual([]);
    });
  }

  test('each UI fetches only its own faces, every app sheet once, and phase C stays in budget', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(180_000);
    const prefetch = FONT_PREFETCH_BY_LANGUAGE.ko;
    if (!prefetch) throw new Error('The Korean UI has no prefetch list');
    const prefetchShards = new Set(prefetch.shards.map(({ shard }) => shard));
    const krShard = (stem: string): number | null =>
      FAMILY_BY_STEM.get(stem) === 'Noto Sans KR'
        ? Number(/\.(\d+)$/u.exec(stem)?.[1] ?? Number.NaN)
        : null;

    const sheetOrder: Record<UiLanguage, string[]> = { ko: [], en: [] };
    for (const ui of ['en', 'ko'] as const) {
      const { context, page, requests } = await openApp(browser, ui, 'ko-KR');
      try {
        await page.goto('/');
        await waitForBootstrapReady(page);
        await expect(page.locator('#btn-setup-host')).toBeVisible({ timeout: 15_000 });
        await settleFonts(page);
        const settledAt = Date.now();
        // Let the last finished requests reach this process.
        await page.waitForTimeout(500);

        // Phase B: every app sheet once, the ones beyond phase A after window load.
        const timing = await page.evaluate(() => {
          const navigation = performance.getEntriesByType('navigation')[0] as
            PerformanceNavigationTiming | undefined;
          return {
            loadEnd: navigation?.loadEventEnd ?? 0,
            sheets: performance
              .getEntriesByType('resource')
              .filter(({ name }) => /\.css(?:[?#]|$)/u.test(name))
              .map(({ name, startTime }) => ({ name, startTime })),
          };
        });
        const appSheets = timing.sheets
          .map(({ name, startTime }) => ({ stem: assetStem(name), startTime }))
          .filter(({ stem }) => APP_SHEET_IDS.has(stem));
        sheetOrder[ui] = appSheets.map(({ stem }) => stem);
        expect([...sheetOrder[ui]].sort(), `${ui}: app sheets`).toEqual([...APP_SHEET_IDS].sort());
        for (const { stem, startTime } of appSheets) {
          if (stem === 'font-inter' || stem === 'font-noto-kr') continue;
          expect(startTime, `${ui}: ${stem} waits for window load`).toBeGreaterThanOrEqual(
            timing.loadEnd,
          );
        }

        // The start screen: Inter's Latin face in English; Inter and Noto Sans KR in Korean.
        const startFonts = requests.filter(({ kind }) => kind === 'font');
        const startFamilies = new Set(startFonts.map(({ stem }) => FAMILY_BY_STEM.get(stem)));
        if (ui === 'en') {
          expect(startFonts.map(({ stem }) => stem)).toEqual(['inter-latin']);
        } else {
          expect([...startFamilies].sort()).toEqual(['Inter', 'Noto Sans KR']);
        }

        // Phase C: after its quiet period, idle batches until the network is still.
        const startCount = startFonts.length;
        await page.waitForTimeout(Math.max(0, FONT_PREFETCH_QUIET_MS - (Date.now() - settledAt)));
        let seen = -1;
        for (let stillFor = 0; stillFor < 4_000 && Date.now() - settledAt < 60_000;) {
          await page.waitForTimeout(500);
          const count = requests.filter(({ kind }) => kind === 'font').length;
          stillFor = count === seen ? stillFor + 500 : 0;
          seen = count;
        }
        const prefetched = requests.filter(({ kind }) => kind === 'font').slice(startCount);
        const summary = (list: FontRequest[]) => ({
          files: list.length,
          bytes: list.reduce((sum, { bytes }) => sum + bytes, 0),
          stems: list.map(({ stem }) => stem),
        });
        writeFileSync(
          testInfo.outputPath(`requests-${ui}.json`),
          JSON.stringify(
            {
              startScreen: summary(startFonts),
              prefetch: summary(prefetched),
              sheets: requests
                .filter(({ kind }) => kind === 'sheet')
                .map(({ stem, bytes }) => ({ stem, bytes })),
            },
            null,
            1,
          ),
        );
        if (ui === 'en') {
          expect(prefetched.map(({ stem }) => stem)).toEqual([]);
        } else {
          const shards = prefetched.map(({ stem }) => krShard(stem));
          expect(shards.every((shard) => shard !== null && prefetchShards.has(shard))).toBe(true);
          expect(prefetched.length).toBeGreaterThan(0);
          expect(prefetched.length).toBeLessThanOrEqual(FONT_PREFETCH_MAX_FACES);
          expect(prefetched.reduce((sum, { bytes }) => sum + bytes, 0)).toBeLessThanOrEqual(
            FONT_PREFETCH_MAX_BYTES,
          );
          const loaded = new Set(
            requests.filter(({ kind }) => kind === 'font').map(({ stem }) => krShard(stem)),
          );
          expect([...prefetchShards].filter((shard) => !loaded.has(shard))).toEqual([]);
        }

        // Nothing of Pretendard, the retired font runtime or the static pages' sheets.
        expect(requests.filter(({ url }) => /pretendard|primary-font/iu.test(url))).toEqual([]);
        expect(
          requests
            .filter(({ stem }) => STATIC_PAGE_ONLY_SHEETS.includes(stem))
            .map(({ url }) => url),
        ).toEqual([]);
        expect(
          requests
            .filter(({ kind }) => kind === 'font')
            .filter(({ stem }) => !FAMILY_BY_STEM.has(stem))
            .map(({ url }) => url),
          'font files outside the app families',
        ).toEqual([]);
      } finally {
        await context.close();
      }
    }
    // Phase A declares the same two sheets first in both UIs.
    expect(sheetOrder.ko.slice(0, 2).sort()).toEqual(['font-inter', 'font-noto-kr']);
    expect(sheetOrder.en.slice(0, 2).sort()).toEqual(['font-inter', 'font-noto-kr']);
  });
});
