/**
 * Line boxes with and without the metric overrides (owner decisions
 * 2026-11-01 and 2026-11-02).
 *
 * Safari on the owner's iPhone (2026-11-01) applies size-adjust but ignores
 * ascent-override, descent-override and line-gap-override, so there a
 * line-height: normal line takes its box from each face's own vertical
 * metrics: on that iPhone a 15 px Hangul line was about 20 px high instead of
 * 18 px, and the Playlist title sat higher than the other tab titles. The app
 * faces carry the line box of src/i18n/font-metrics.ts in their tables, so
 * dropping the overrides changes nothing at 13, 15 and 28 px. (The Inter and
 * CJK descriptors are two-decimal percentages within half a unit of the baked
 * box, not equal to it, so a line next to a pixel rounding boundary, such as
 * a kana or Han line at 14.5 px, still differs by 1 px;
 * docs/design/app-font-baked-metrics-2026-11-01.md §3 lists the sizes.) Since
 * the owner decision of 2026-11-02 Hangul is drawn by MUSIXQUARE Hangul,
 * Pretendard's own Hangul in files that hold Pretendard's own line box, so
 * the 14.5 px Hangul line is 17 px with and without the overrides. Chromium
 * models that browser here. On Windows it reads each face's OS/2 typo
 * metrics (USE_TYPO_METRICS is set), where Safari's CoreText reads hhea;
 * src/i18n/__tests__/font-baked-metrics.test.ts and the font guard check
 * that the two are equal in every face. Context B serves the app's Inter,
 * Hangul and CJK sheets without the three overrides (size-adjust stays) and
 * must measure what context A measures with the shipped sheets:
 * - the height and baseline of Latin, Hangul, mixed, kana and Han lines at 13,
 *   14.5, 15 and 28 px in weights 400 and 700, drawn by Inter, MUSIXQUARE
 *   Hangul, Noto Sans KR and Noto Sans JP (but the recorded 1 px of the kana
 *   and Han lines at 14.5 px);
 * - the title of every tab header, with the Playlist title in its switch
 *   button as it shows when the room has more than one playlist.
 *
 * Current WebKit applies the overrides. It takes a line's box from them as
 * they are, but from a face without them from the face's table metrics
 * rounded to whole pixels, so the Hangul faces state their files' own box as
 * descriptors too (HANGUL_FACE_METRICS). The last test opens the shipped
 * sheets in Playwright's WebKit and requires every Hangul and mixed line to
 * have the height and baseline of the Latin line of its size and weight, and
 * the Hangul line those of the Latin one at every half pixel from 8 to 48 px,
 * within one WebKit layout unit (1/64 px). Without the Hangul descriptors
 * the Hangul lines there are a quarter to a third of a pixel taller.
 *
 * A local verification spec, not part of the critical set.
 */
import {
  expect,
  test,
  webkit,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

import { E2E_APP_ORIGIN } from './config.ts';
import { waitForBootstrapReady } from './helpers/bootstrap.ts';
import { injectPeerServer } from './helpers/peer-server.ts';
import { setupHostAndStart } from './helpers/setup-flow.ts';
import { navigateToTab, waitForAppFonts } from './helpers/wait.ts';

/** The built app sheets whose faces carry the metric overrides. */
const OVERRIDE_SHEETS =
  /\/assets\/font-(?:inter|hangul|noto-kr|noto-jp|noto-sc|noto-tc)-[\w-]{8}\.css$/u;
const OVERRIDES = /(?:ascent|descent|line-gap)-override:[^;}]*;?/gu;
/** The Hangul faces' descriptors: their files' own box, 1950 / 494 / 0 of 2048. */
const HANGUL_DESCRIPTORS = [
  'size-adjust:100%',
  'ascent-override:95.21%',
  'descent-override:24.12%',
  'line-gap-override:0%',
];

const SAMPLES = {
  latin: 'Playlist Intro 1:30',
  hangul: '재생목록 플레이리스트',
  mixed: 'Night Drive 밤의 드라이브',
  kana: 'かなカナのうた',
  han: '漢字海返曜花雪',
} as const;
const SIZES = [13, 14.5, 15, 28] as const;
const WEIGHTS = [400, 700] as const;
/** Every half pixel from 8 to 48 px. */
const HALF_PIXELS = Array.from({ length: 81 }, (_, index) => 8 + index / 2);
/** Pretendard's line boxes, which the shipped overrides keep: height|baseline in px. */
const SHIPPED_BOX: Readonly<Record<(typeof SIZES)[number], string>> = {
  13: '15|12',
  14.5: '17|14',
  15: '18|14',
  28: '34|27',
};
/**
 * Where a line drawn from the baked Noto files (no overrides, as Safari reads
 * them) differs from the descriptors: their descent rounds to 4 px at
 * 14.5 px, against 3 px with the override (font-metrics.ts). Hangul is not
 * here: the MUSIXQUARE Hangul files hold Pretendard's box itself.
 */
const WITHOUT_OVERRIDES_EXCEPTIONS: Readonly<Record<string, string>> = {
  'kana 14.5px 400': '18|14',
  'kana 14.5px 700': '18|14',
  'han 14.5px 400': '18|14',
  'han 14.5px 700': '18|14',
};
const TABS = ['playlist', 'connect', 'settings', 'guide'] as const;
const APP_FAMILIES = [
  'Inter',
  'MUSIXQUARE Hangul',
  'Noto Sans KR',
  'Noto Sans JP',
  'Noto Sans SC',
  'Noto Sans TC',
];

interface Opened {
  readonly context: BrowserContext;
  readonly page: Page;
  /** The override sheets as served (without the overrides when stripped), by URL. */
  readonly served: Map<string, string>;
}

async function openKoreanUi(browser: Browser, stripOverrides: boolean): Promise<Opened> {
  const context = await browser.newContext({
    baseURL: E2E_APP_ORIGIN,
    locale: 'ko-KR',
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
  const served = new Map<string, string>();
  // Registered last, so it runs before the catch-all route above.
  await context.route(OVERRIDE_SHEETS, async (route) => {
    const response = await route.fetch();
    const text = await response.text();
    const css = stripOverrides ? text.replace(OVERRIDES, '') : text;
    served.set(route.request().url(), css);
    await route.fulfill({ response, body: css });
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    try {
      localStorage.setItem('musixquare-lang', 'ko');
    } catch {
      // A blocked storage leaves the browser language (ko-KR) in charge.
    }
  });
  await injectPeerServer(page);
  return { context, page, served };
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

function sheetId(url: string): string | undefined {
  return /font-[a-z-]+(?=-[\w-]{8}\.css$)/u.exec(url)?.[0];
}

/**
 * Every override sheet reached the page with size-adjust, and with its
 * overrides as shipped or none at all; the shipped Hangul sheet states its
 * files' own box.
 */
function expectServed(served: ReadonlyMap<string, string>, stripped: boolean): void {
  expect([...served.keys()].map(sheetId).sort()).toEqual([
    'font-hangul',
    'font-inter',
    'font-noto-jp',
    'font-noto-kr',
    'font-noto-sc',
    'font-noto-tc',
  ]);
  for (const [url, css] of served) {
    expect(css, url).toContain('size-adjust:');
    if (stripped) expect(css, url).not.toMatch(/-override\s*:/u);
    else expect(css, url).toMatch(/ascent-override\s*:/u);
  }
  if (stripped) return;
  const [url, css] = [...served].find(([sheet]) => sheetId(sheet) === 'font-hangul') ?? ['', ''];
  const faces = css.split('@font-face').slice(1);
  expect(faces, url).toHaveLength(87);
  for (const face of faces) {
    for (const descriptor of HANGUL_DESCRIPTORS) {
      expect(face.replace(/\s+/gu, ''), url).toContain(descriptor);
    }
  }
}

/**
 * Line boxes of probes drawn with the app stack: each line's height and its
 * baseline ("height|baseline" in CSS px), read from a zero-size inline-block
 * at the start of the line, by "name size weight".
 */
async function measureBoxes(
  page: Page,
  samples: Readonly<Record<string, string>>,
  sizes: readonly number[],
  weights: readonly number[],
): Promise<Record<string, string>> {
  return page.evaluate(
    async ({ samples, sizes, weights }) => {
      const host = document.createElement('div');
      host.dataset.lineProbes = '';
      host.style.cssText = 'position:absolute;left:0;top:0;z-index:2147483647;';
      for (const [name, text] of Object.entries(samples)) {
        for (const size of sizes) {
          for (const weight of weights) {
            const line = document.createElement('div');
            line.dataset.probe = `${name} ${size}px ${weight}`;
            line.style.cssText = `font-family:var(--font-sans);font-size:${size}px;font-weight:${weight};line-height:normal;white-space:nowrap;width:max-content;`;
            const marker = document.createElement('span');
            marker.style.cssText = 'display:inline-block;width:0;height:0;';
            line.append(marker, text);
            host.append(line);
          }
        }
      }
      document.body.append(host);
      void host.offsetHeight;
      for (let round = 0; round < 200; round += 1) {
        await document.fonts.ready;
        if (![...document.fonts].some((face) => face.status === 'loading')) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const result: Record<string, string> = {};
      for (const line of host.querySelectorAll<HTMLElement>('[data-probe]')) {
        const box = line.getBoundingClientRect();
        const marker = line.firstElementChild?.getBoundingClientRect();
        result[line.dataset.probe ?? ''] = `${box.height}|${(marker?.top ?? Number.NaN) - box.top}`;
      }
      host.remove();
      return result;
    },
    { samples, sizes, weights },
  );
}

interface Lines {
  /** "height|baseline" per probe, in CSS px. */
  readonly boxes: Record<string, string>;
  /** The faces that draw each 15 px probe. */
  readonly faces: Record<string, string[]>;
}

/** The line boxes of the samples, and (from Chromium's DevTools protocol) the faces that draw them. */
async function measureLines(page: Page): Promise<Lines> {
  const boxes = await measureBoxes(page, SAMPLES, SIZES, WEIGHTS);
  await page.evaluate((samples) => {
    const host = document.createElement('div');
    host.dataset.lineProbes = '';
    for (const [name, text] of Object.entries(samples)) {
      const line = document.createElement('div');
      line.dataset.probe = `${name} 15px 400`;
      line.style.cssText = 'font-family:var(--font-sans);font-size:15px;font-weight:400;';
      line.textContent = text;
      host.append(line);
    }
    document.body.append(host);
  }, SAMPLES);
  const faces: Record<string, string[]> = {};
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
    for (const name of Object.keys(SAMPLES)) {
      const { nodeId } = await cdp.send('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: `[data-probe="${name} 15px 400"]`,
      });
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
      // A variable face reports its default instance's name, such as 'Noto Sans KR Thin'.
      faces[name] = fonts
        .map(({ familyName, isCustomFont }) =>
          isCustomFont
            ? (APP_FAMILIES.find((family) => familyName.startsWith(family)) ?? familyName)
            : `${familyName} (device)`,
        )
        .sort();
    }
  } finally {
    await cdp.detach().catch(() => undefined);
    await page.evaluate(() => document.querySelector('[data-line-probes]')?.remove());
  }
  return { boxes, faces };
}

/** The visible title of each tab header: its box and its baseline, in CSS px. */
async function readTabTitles(page: Page): Promise<Record<string, string>> {
  const titles: Record<string, string> = {};
  for (const tab of TABS) {
    await navigateToTab(page, tab);
    await page.waitForTimeout(400);
    titles[tab] = await page.evaluate((name) => {
      const title = [
        ...document.querySelectorAll<HTMLElement>(`#tab-${name} .tab-header .tab-title`),
      ].find((element) => element.getBoundingClientRect().height > 0);
      if (!title) throw new Error(`no visible title in the ${name} tab header`);
      // The marker goes right before the title's first text, inside the box
      // that lays that text out: the switch button's name is an inline-flex
      // box, where a marker of its own would be a flex item at the top.
      const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) =>
          node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
      });
      const text = walker.nextNode();
      if (!text?.parentNode) throw new Error(`no text in the ${name} tab title`);
      const marker = document.createElement('span');
      marker.style.cssText = 'display:inline-block;width:0;height:0;';
      text.parentNode.insertBefore(marker, text);
      const box = title.getBoundingClientRect();
      const baseline = marker.getBoundingClientRect().top;
      marker.remove();
      return `${title.textContent?.trim() ?? ''} top ${box.top} height ${box.height} baseline ${baseline}`;
    }, tab);
  }
  return titles;
}

/** Two playlists, so the Playlist title is the active playlist's name in its switch button. */
async function showPlaylists(page: Page): Promise<void> {
  await page.evaluate(() => {
    const runtime = window as unknown as {
      __MUSIXQUARE_SET_STATE__: (path: string, value: unknown) => void;
    };
    const item = (index: number, name: string) => ({
      queueItemId: `00000000-0000-4000-8000-00000000000${index}`,
      type: 'file',
      name,
      videoId: null,
      playlistId: null,
    });
    runtime.__MUSIXQUARE_SET_STATE__('playlist.items', [
      item(1, 'Night Drive.mp3'),
      item(2, '밤의 드라이브.mp3'),
      item(3, 'City Pop 1984.mp3'),
    ]);
    runtime.__MUSIXQUARE_SET_STATE__('playlist.slots', {
      activeSlot: 0,
      slots: [
        { count: 3, bytes: 3072 },
        { count: 2, bytes: 2048 },
        { count: 0, bytes: null },
      ],
    });
  });
  await expect(page.locator('#btn-playlist-switch')).not.toHaveAttribute('hidden');
}

/** Opens the Korean start screen and waits for its fonts. */
async function openStart(browser: Browser, strip: boolean): Promise<Opened> {
  const opened = await openKoreanUi(browser, strip);
  await opened.page.goto('/');
  await waitForBootstrapReady(opened.page);
  await expect(opened.page.locator('#btn-setup-host')).toBeVisible({ timeout: 15_000 });
  await settleFonts(opened.page);
  expectServed(opened.served, strip);
  return opened;
}

/**
 * WebKit lays out in 1/64 px units. The Hangul descriptors and Inter's,
 * rounded to two decimals of a percent each, differ by about 0.0001 em, which
 * can put one line a single unit across a boundary from the other.
 */
const LAYOUT_UNIT = 1 / 64;

/** How far apart two "height|baseline" boxes are: the larger of the two differences, in px. */
function boxDistance(left: string | undefined, right: string | undefined): number {
  const [a = Number.NaN, b = Number.NaN] = (left ?? '').split('|').map(Number);
  const [c = Number.NaN, d = Number.NaN] = (right ?? '').split('|').map(Number);
  return Math.max(Math.abs(a - c), Math.abs(b - d));
}

test.describe('line boxes without the metric overrides', () => {
  test.setTimeout(180_000);

  test('every line keeps its shipped height and baseline when the overrides are dropped', async ({
    browser,
  }) => {
    const measured: Lines[] = [];
    for (const strip of [false, true]) {
      const { context, page } = await openStart(browser, strip);
      try {
        measured.push(await measureLines(page));
      } finally {
        await context.close();
      }
    }
    const [shipped, withoutOverrides] = measured;

    // The shipped sheets keep Pretendard's boxes for every script and weight.
    expect(shipped?.boxes).toEqual(
      Object.fromEntries(
        Object.keys(SAMPLES).flatMap((name) =>
          SIZES.flatMap((size) =>
            WEIGHTS.map((weight) => [`${name} ${size}px ${weight}`, SHIPPED_BOX[size]]),
          ),
        ),
      ),
    );
    expect(shipped?.faces).toEqual({
      latin: ['Inter'],
      hangul: ['Inter', 'MUSIXQUARE Hangul'],
      mixed: ['Inter', 'MUSIXQUARE Hangul'],
      kana: ['Noto Sans JP'],
      han: ['Noto Sans KR'],
    });
    expect(withoutOverrides?.faces).toEqual(shipped?.faces);
    expect(withoutOverrides?.boxes, 'line boxes without the overrides').toEqual({
      ...shipped?.boxes,
      ...WITHOUT_OVERRIDES_EXCEPTIONS,
    });
  });

  test('every tab title sits where it does with the overrides', async ({ browser }) => {
    const measured: Record<string, string>[] = [];
    for (const strip of [false, true]) {
      const { context, page, served } = await openKoreanUi(browser, strip);
      try {
        await setupHostAndStart(page);
        await showPlaylists(page);
        await settleFonts(page);
        expectServed(served, strip);
        measured.push(await readTabTitles(page));
      } finally {
        await context.close();
      }
    }
    const [shipped, withoutOverrides] = measured;
    expect(withoutOverrides, 'tab titles without the overrides').toEqual(shipped);
    // One title line across the four tabs, the switch button's included.
    const baselines = (titles: Record<string, string> | undefined) =>
      TABS.map((tab) => /baseline (\S+)$/u.exec(titles?.[tab] ?? '')?.[1]);
    expect(new Set(baselines(withoutOverrides)).size, 'title baselines without the overrides').toBe(
      1,
    );
  });

  test('WebKit, which applies the overrides, draws Hangul lines as tall as Latin ones', async () => {
    const browser = await webkit.launch();
    try {
      const { page } = await openStart(browser, false);
      const apart = (
        boxes: Record<string, string>,
        names: readonly string[],
        sizes: readonly number[],
        weights: readonly number[],
      ): string[] =>
        names.flatMap((name) =>
          sizes.flatMap((size) =>
            weights.flatMap((weight) => {
              const latin = boxes[`latin ${size}px ${weight}`];
              const other = boxes[`${name} ${size}px ${weight}`];
              return boxDistance(latin, other) > LAYOUT_UNIT
                ? [`${name} ${size}px ${weight}: latin ${latin}, ${name} ${other}`]
                : [];
            }),
          ),
        );
      const boxes = await measureBoxes(page, SAMPLES, SIZES, WEIGHTS);
      expect(apart(boxes, ['hangul', 'mixed'], SIZES, WEIGHTS), 'lines unlike Latin').toEqual([]);
      const sweep = await measureBoxes(
        page,
        { latin: SAMPLES.latin, hangul: SAMPLES.hangul },
        HALF_PIXELS,
        [400],
      );
      expect(apart(sweep, ['hangul'], HALF_PIXELS, [400]), 'half pixels unlike Latin').toEqual([]);
    } finally {
      await browser.close();
    }
  });
});
