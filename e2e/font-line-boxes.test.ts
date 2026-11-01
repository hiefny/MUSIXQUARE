/**
 * Line boxes without the metric overrides (owner decision 2026-11-01).
 *
 * Safari applies size-adjust but ignores ascent-override, descent-override and
 * line-gap-override, so there a line-height: normal line takes its box from
 * each face's own vertical metrics: on the owner's iPhone a 15 px Hangul line
 * was about 20 px high instead of 18 px, and the Playlist title sat higher
 * than the other tab titles. The app faces carry the line box of
 * src/i18n/font-metrics.ts in their tables, so dropping the overrides changes
 * nothing at the sizes probed here. (The descriptors are two-decimal
 * percentages within half a unit of the baked box, not equal to it, so a line
 * next to a pixel rounding boundary, such as a CJK line at 14.5 px, still
 * differs by 1 px; docs/design/app-font-baked-metrics-2026-11-01.md §3 lists
 * the sizes.) Chromium models that browser here. On Windows it reads each
 * face's OS/2 typo metrics (USE_TYPO_METRICS is set), where Safari's CoreText
 * reads hhea; src/i18n/__tests__/font-baked-metrics.test.ts and the font guard
 * check that the two are equal in every face. Context B serves the app's
 * Inter and CJK sheets without the three overrides (size-adjust stays) and
 * must measure what context A measures with the shipped sheets:
 * - the height and baseline of Latin, Hangul, mixed, kana and Han lines at 13,
 *   15 and 28 px in weights 400 and 700, drawn by Inter, Noto Sans KR and Noto
 *   Sans JP;
 * - the title of every tab header, with the Playlist title in its switch
 *   button as it shows when the room has more than one playlist.
 *
 * A local verification spec, not part of the critical set.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { E2E_APP_ORIGIN } from './config.ts';
import { waitForBootstrapReady } from './helpers/bootstrap.ts';
import { injectPeerServer } from './helpers/peer-server.ts';
import { setupHostAndStart } from './helpers/setup-flow.ts';
import { navigateToTab, waitForAppFonts } from './helpers/wait.ts';

/** The built app sheets whose faces carry the metric overrides. */
const OVERRIDE_SHEETS = /\/assets\/font-(?:inter|noto-kr|noto-jp|noto-sc|noto-tc)-[\w-]{8}\.css$/u;
const OVERRIDES = /(?:ascent|descent|line-gap)-override:[^;}]*;?/gu;

const SAMPLES = {
  latin: 'Playlist Intro 1:30',
  hangul: '재생목록 플레이리스트',
  mixed: 'Night Drive 밤의 드라이브',
  kana: 'かなカナのうた',
  han: '漢字海返曜花雪',
} as const;
const SIZES = [13, 15, 28] as const;
const WEIGHTS = [400, 700] as const;
/** Pretendard's line boxes, which the shipped overrides keep: height|baseline in px. */
const SHIPPED_BOX: Readonly<Record<(typeof SIZES)[number], string>> = {
  13: '15|12',
  15: '18|14',
  28: '34|27',
};
const TABS = ['playlist', 'connect', 'settings', 'guide'] as const;
const APP_FAMILIES = ['Inter', 'Noto Sans KR', 'Noto Sans JP', 'Noto Sans SC', 'Noto Sans TC'];

interface Opened {
  readonly context: BrowserContext;
  readonly page: Page;
  /** The sheets served without overrides, by URL. */
  readonly stripped: Map<string, string>;
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
  const stripped = new Map<string, string>();
  if (stripOverrides) {
    // Registered last, so it runs before the catch-all route above.
    await context.route(OVERRIDE_SHEETS, async (route) => {
      const response = await route.fetch();
      const css = (await response.text()).replace(OVERRIDES, '');
      stripped.set(route.request().url(), css);
      await route.fulfill({ response, body: css });
    });
  }
  const page = await context.newPage();
  await page.addInitScript(() => {
    try {
      localStorage.setItem('musixquare-lang', 'ko');
    } catch {
      // A blocked storage leaves the browser language (ko-KR) in charge.
    }
  });
  await injectPeerServer(page);
  return { context, page, stripped };
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

/** Every override sheet reached the page without overrides and with size-adjust. */
function expectStripped(stripped: ReadonlyMap<string, string>): void {
  expect(
    [...stripped.keys()].map((url) => /font-[a-z-]+(?=-[\w-]{8}\.css$)/u.exec(url)?.[0]).sort(),
  ).toEqual(['font-inter', 'font-noto-jp', 'font-noto-kr', 'font-noto-sc', 'font-noto-tc']);
  for (const [url, css] of stripped) {
    expect(css, url).toContain('size-adjust:');
    expect(css, url).not.toMatch(/-override\s*:/u);
  }
}

interface Lines {
  /** "height|baseline" per probe, in CSS px. */
  readonly boxes: Record<string, string>;
  /** The faces that draw each 15 px probe. */
  readonly faces: Record<string, string[]>;
}

/**
 * Line boxes of probes drawn with the app stack: each line's height and its
 * baseline, read from a zero-size inline-block at the start of the line.
 */
async function measureLines(page: Page): Promise<Lines> {
  const boxes = await page.evaluate(
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
      return result;
    },
    { samples: SAMPLES, sizes: SIZES, weights: WEIGHTS },
  );

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

test.describe('line boxes without the metric overrides', () => {
  test.setTimeout(180_000);

  test('every line keeps its shipped height and baseline when the overrides are dropped', async ({
    browser,
  }) => {
    const measured: Lines[] = [];
    for (const strip of [false, true]) {
      const { context, page, stripped } = await openKoreanUi(browser, strip);
      try {
        await page.goto('/');
        await waitForBootstrapReady(page);
        await expect(page.locator('#btn-setup-host')).toBeVisible({ timeout: 15_000 });
        await settleFonts(page);
        if (strip) expectStripped(stripped);
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
      hangul: ['Inter', 'Noto Sans KR'],
      mixed: ['Inter', 'Noto Sans KR'],
      kana: ['Noto Sans JP'],
      han: ['Noto Sans KR'],
    });
    expect(withoutOverrides?.faces).toEqual(shipped?.faces);
    expect(withoutOverrides?.boxes, 'line boxes without the overrides').toEqual(shipped?.boxes);
  });

  test('every tab title sits where it does with the overrides', async ({ browser }) => {
    const measured: Record<string, string>[] = [];
    for (const strip of [false, true]) {
      const { context, page, stripped } = await openKoreanUi(browser, strip);
      try {
        await setupHostAndStart(page);
        await showPlaylists(page);
        await settleFonts(page);
        if (strip) expectStripped(stripped);
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
});
