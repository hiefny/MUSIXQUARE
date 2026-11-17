/**
 * The Han family text draws first applies before the other Han families.
 *
 * Each of the four CJK families draws Han, and Chromium draws a character
 * with the first family in the stack whose declared faces have it. On a first
 * visit window load can fire before the font owner (locale-fonts.ts) arrives,
 * so in App 9.0.829 phase B declared the other Han families right after
 * phase A, and when one of their sheets applied before the UI's own family's,
 * the visible Han was fetched from its shards first: the Japanese start
 * screen fetched 30 Noto Sans KR and 8 Noto Sans SC shards before its Noto
 * Sans JP ones. A Korean or English UI under a Japanese or Chinese Han order
 * declared Noto Sans KR in phase A beside its first family the same way.
 *
 * The test holds the font owner until window load, and the sheet of the
 * family under test (the UI's first, or a marked line's own) until phase B's
 * idle slice has run and every other sheet the page asked for has applied
 * and drawn. It then requires that no face of a Han family other than the
 * UI's first and the line's own was asked for, and that each Han text draws
 * with its own family.
 *
 * Two rows lay a Traditional Chinese line the app marks as user text
 * (src/ui/user-text-font.ts; its stack is Noto Sans TC, SC, JP, KR) over the
 * Korean and Japanese start screens and hold Noto Sans TC. The UI's first
 * family may draw the line until TC applies, since phase A declares only
 * that one. When the remaining families are declared together, as in App
 * 9.0.829, Noto Sans SC, whose sheet applies while TC's is held, draws the
 * line and has its shards fetched.
 *
 * Two rows fail the first request for the Japanese UI's own sheet: at once,
 * before phase B, or once phase B has left the other Han families waiting
 * for it. The font owner tries the sheet again at once and the other families
 * wait for that attempt too, so the test holds the second request instead.
 * Were the other families declared as soon as the first attempt failed
 * (phase B asking for Noto Sans KR before the retry, or the retry waiting
 * 10 s for its timer), Noto Sans KR would draw the Japanese start screen.
 *
 * An installed family of the same name (a Windows 11 PC can have Noto Sans
 * KR, SC and TC) would draw the Han while its sheet is held and hide the
 * race, so each CJK name gets a face that never loads, as on a phone without
 * them. Its src must be a URL: Chromium settles a local() face to 'error' at
 * once and then draws with the installed font of that name again. Its weight
 * range is the app faces' 100 to 900; with another range Chromium still drew
 * with the installed font.
 *
 * Chromium only: WebKit holds window load while the font owner loads, so the
 * test cannot hold the owner past load there, and the faces are read over
 * CDP. WebKit also holds rendering while a sheet is pending, but it can still
 * draw Han with a later family while the first family's sheet is not
 * pending, as after a failed first attempt; the failure rows cover that path
 * in Chromium. A local verification spec, not part of the critical set.
 */
import { readdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

import { E2E_APP_ORIGIN } from './config.ts';
import { waitForAppFonts } from './helpers/wait.ts';

const CJK_DIRECTORIES = {
  'Noto Sans KR': 'noto-sans-kr',
  'Noto Sans JP': 'noto-sans-jp',
  'Noto Sans SC': 'noto-sans-sc',
  'Noto Sans TC': 'noto-sans-tc',
} as const;
type CjkFamily = keyof typeof CJK_DIRECTORIES;
const CJK_FAMILIES = Object.keys(CJK_DIRECTORIES) as CjkFamily[];

/** The CJK family of each committed shard, by file stem (the app serves the baked copies). */
const FAMILY_BY_STEM: ReadonlyMap<string, CjkFamily> = new Map(
  CJK_FAMILIES.flatMap((family) =>
    readdirSync(new URL(`../fonts/app/${CJK_DIRECTORIES[family]}/`, import.meta.url))
      .filter((file) => file.endsWith('.woff2'))
      .map((file) => [file.slice(0, -'.woff2'.length), family] as const),
  ),
);

/** A built asset's name without Vite's content hash. */
function assetStem(url: string): string {
  const name = new URL(url).pathname.split('/').pop() ?? '';
  return name.replace(/-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/u, '');
}

/** A line src/ui/user-text-font.ts marks as Traditional Chinese (體, 這, 樂, 說), and its classes. */
const TRADITIONAL_LINE = '繁體中文歌詞 這個測試 臺灣樂團 說話';
const TRADITIONAL_CLASS = 'user-text-font user-text-font-zh-hant';

interface Row {
  readonly name: string;
  readonly locale: string;
  /** navigator.languages, when it is not just the locale. */
  readonly languages?: readonly string[];
  /** The saved UI language, when it is not the browser's. */
  readonly ui?: string;
  /** The UI's first Han family, which draws the start screen's Han. */
  readonly family: CjkFamily;
  /** The sheet the test holds: the UI's first family's, or the line's family's. */
  readonly sheet: string;
  /**
   * Han the start screen does not show, laid out over it: its text, the
   * order class src/ui/user-text-font.ts gives it, and the family that class
   * draws it with first (the UI's first family without a class).
   */
  readonly content?: {
    readonly text: string;
    readonly className?: string;
    readonly family?: CjkFamily;
  };
  /**
   * The held sheet's first request fails at once (before phase B), or once
   * phase B has left the other Han families waiting for it.
   */
  readonly failFirst?: 'at once' | 'while they wait';
}

const ROWS: readonly Row[] = [
  {
    name: 'the Japanese start screen',
    locale: 'ja-JP',
    family: 'Noto Sans JP',
    sheet: 'font-noto-jp',
  },
  {
    name: 'the Simplified Chinese start screen',
    locale: 'zh-CN',
    family: 'Noto Sans SC',
    sheet: 'font-noto-sc',
  },
  {
    name: 'the Traditional Chinese start screen',
    locale: 'zh-TW',
    family: 'Noto Sans TC',
    sheet: 'font-noto-tc',
  },
  {
    name: 'Han in the English UI under a Japanese Han order',
    locale: 'en-US',
    languages: ['en-US', 'ja-JP'],
    ui: 'en',
    family: 'Noto Sans JP',
    sheet: 'font-noto-jp',
    content: { text: '漢字 海 返 曜 花 雪' },
  },
  {
    name: 'the Japanese start screen whose sheet fails first',
    locale: 'ja-JP',
    family: 'Noto Sans JP',
    sheet: 'font-noto-jp',
    failFirst: 'at once',
  },
  {
    name: 'the Japanese start screen whose sheet fails while the other families wait',
    locale: 'ja-JP',
    family: 'Noto Sans JP',
    sheet: 'font-noto-jp',
    failFirst: 'while they wait',
  },
  {
    name: 'a Traditional Chinese user-text line in the Korean UI',
    locale: 'ko-KR',
    family: 'Noto Sans KR',
    sheet: 'font-noto-tc',
    content: { text: TRADITIONAL_LINE, className: TRADITIONAL_CLASS, family: 'Noto Sans TC' },
  },
  {
    name: 'a Traditional Chinese user-text line in the Japanese UI',
    locale: 'ja-JP',
    family: 'Noto Sans JP',
    sheet: 'font-noto-tc',
    content: { text: TRADITIONAL_LINE, className: TRADITIONAL_CLASS, family: 'Noto Sans TC' },
  },
];

/** Two of the page's idle slices: one requested before them has run. */
async function idleSlices(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestIdleCallback(() => requestIdleCallback(() => resolve()));
      }),
  );
}

test.describe('the first Han family applies first', () => {
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'WebKit holds window load while the font owner loads, and the faces are read over CDP',
  );

  for (const row of ROWS) {
    test(`${row.name} asks for no other Han family's faces`, async ({ browser }) => {
      const context = await browser.newContext({
        baseURL: E2E_APP_ORIGIN,
        locale: row.locale,
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        colorScheme: 'dark',
        reducedMotion: 'reduce',
        serviceWorkers: 'block',
      });
      try {
        await context.route('**/*', (route) => {
          const { hostname } = new URL(route.request().url());
          return hostname === '127.0.0.1' || hostname === 'localhost'
            ? route.continue()
            : route.abort();
        });
        const page = await context.newPage();
        await page.addInitScript(
          ({ languages, ui, families }) => {
            if (languages) {
              Object.defineProperty(Navigator.prototype, 'languages', {
                configurable: true,
                get: () => languages,
              });
              Object.defineProperty(Navigator.prototype, 'language', {
                configurable: true,
                get: () => languages[0],
              });
            }
            if (ui) {
              try {
                localStorage.setItem('musixquare-lang', ui);
              } catch {
                // A blocked storage leaves the browser language in charge.
              }
            }
            const style = document.createElement('style');
            style.textContent = families
              .map(
                (family) =>
                  `@font-face{font-family:'${family}';font-style:normal;font-weight:100 900;` +
                  "src:url(data:font/woff2;base64,AAAA) format('woff2');unicode-range:U+10FFFD}",
              )
              .join('');
            const add = () => (document.head ?? document.documentElement).append(style);
            if (document.documentElement) add();
            else document.addEventListener('readystatechange', add, { once: true });
          },
          { languages: row.languages ?? null, ui: row.ui ?? null, families: CJK_FAMILIES },
        );

        const asked: CjkFamily[] = [];
        page.on('request', (request) => {
          const family = FAMILY_BY_STEM.get(assetStem(request.url()));
          if (family) asked.push(family);
        });

        // Gates: the font owner until window load, the held sheet until every
        // other requested sheet has applied and drawn. A failing row fails the
        // sheet's first request and holds its second instead.
        let releaseRuntime!: () => void;
        const runtimeGate = new Promise<void>((resolve) => {
          releaseRuntime = resolve;
        });
        let releaseSheet!: () => void;
        const sheetGate = new Promise<void>((resolve) => {
          releaseSheet = resolve;
        });
        let sheetAsked!: () => void;
        const sheetSeen = new Promise<void>((resolve) => {
          sheetAsked = resolve;
        });
        let failFirstRequest!: () => void;
        const failGate = new Promise<void>((resolve) => {
          failFirstRequest = resolve;
        });
        let firstAsked!: () => void;
        const firstSeen = new Promise<void>((resolve) => {
          firstAsked = resolve;
        });
        await page.route('**/assets/locale-fonts-*.js', async (route) => {
          await runtimeGate;
          await route.continue();
        });
        let sheetRequests = 0;
        await page.route(`**/assets/${row.sheet}-*.css`, async (route) => {
          sheetRequests += 1;
          if (row.failFirst && sheetRequests === 1) {
            firstAsked();
            if (row.failFirst === 'while they wait') await failGate;
            await route.abort('failed');
            return;
          }
          sheetAsked();
          await sheetGate;
          await route.continue();
        });

        const loaded = page.waitForEvent('load');
        await page.goto('/', { waitUntil: 'commit' });
        // Chromium fires window load without the font owner, as on a slow first visit.
        await loaded;
        await expect(page.locator('#btn-setup-host')).toBeVisible();
        if (row.content) {
          await page.evaluate(
            ({ text, className }) => {
              const line = document.createElement('p');
              line.textContent = text;
              if (className) line.className = className;
              line.dataset.hanLine = '';
              line.style.cssText =
                'position:fixed;left:8px;top:8px;z-index:2147483647;margin:0;font-size:15px;';
              document.body.append(line);
            },
            { text: row.content.text, className: row.content.className ?? null },
          );
        }

        releaseRuntime();
        // The font owner armed phase B before phase A asked for any sheet, and
        // idle callbacks run in the order they were requested, so once the
        // held sheet has been asked for (in phase A or B), phase B's slice has
        // run after two of the test's own.
        if (row.failFirst === 'while they wait') {
          await firstSeen;
          await idleSlices(page);
          failFirstRequest();
        }
        await sheetSeen;
        await idleSlices(page);
        // Every other app sheet the page asked for applies, and two frames
        // lay the text out with it.
        await page.evaluate(async (held) => {
          const links = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
            .filter((link) => /\/assets\/(?:font|noto)-/u.test(link.href))
            .filter((link) => !link.href.includes(`/assets/${held}-`));
          await Promise.all(
            links.map((link) =>
              link.sheet
                ? undefined
                : new Promise((resolve) => {
                    link.addEventListener('load', resolve, { once: true });
                    link.addEventListener('error', resolve, { once: true });
                  }),
            ),
          );
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
        }, row.sheet);
        releaseSheet();

        await waitForAppFonts(page, 30_000);
        await expect
          .poll(() =>
            page.evaluate(
              () => [...document.fonts].filter((face) => face.status === 'loading').length,
            ),
          )
          .toBe(0);

        // No shard of another Han family, on the network or in the font set.
        // The UI's first family may draw a marked line until the line's own
        // family applies.
        const allowed: readonly CjkFamily[] = [row.family, row.content?.family ?? row.family];
        expect(
          asked.filter((family) => !allowed.includes(family)),
          'shards of other Han families',
        ).toEqual([]);
        const touched = await page.evaluate(
          ({ own, families }) =>
            [...document.fonts]
              .filter((face) => face.status !== 'unloaded')
              .map((face) => face.family.replace(/^(['"])(.*)\1$/su, '$2'))
              .filter((family) => !own.includes(family) && families.includes(family)),
          { own: allowed as readonly string[], families: CJK_FAMILIES as readonly string[] },
        );
        expect(touched, 'faces of other Han families').toEqual([]);

        // Each Han text draws with its own family: the start screen's with the
        // UI's first family, the laid-out line's with its own.
        await page.evaluate(() => {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const element = node.parentElement;
            if (!element || !/\p{Script=Han}/u.test(node.textContent ?? '')) continue;
            const box = element.getBoundingClientRect();
            if (box.width === 0 || box.height === 0) continue;
            element.dataset.hanProbe = element.closest('[data-han-line]') ? 'line' : 'screen';
          }
        });
        const cdp = await context.newCDPSession(page);
        await cdp.send('DOM.enable');
        await cdp.send('CSS.enable');
        const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
        let probed = 0;
        for (const [probe, family] of [
          ['screen', row.family],
          ['line', row.content?.family ?? row.family],
        ] as const) {
          const { nodeIds } = await cdp.send('DOM.querySelectorAll', {
            nodeId: root.nodeId,
            selector: `[data-han-probe="${probe}"]`,
          });
          if (nodeIds.length === 0) continue;
          probed += nodeIds.length;
          const drawn = new Set<string>();
          for (const nodeId of nodeIds) {
            const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
            for (const { familyName, isCustomFont } of fonts) {
              drawn.add(`${familyName}${isCustomFont ? '' : ' (device)'}`);
            }
          }
          expect(
            [...drawn].filter((name) => !name.startsWith('Inter') && !name.startsWith(family)),
            `faces drawing the ${probe}'s Han`,
          ).toEqual([]);
          expect([...drawn].some((name) => name.startsWith(family))).toBe(true);
        }
        await cdp.detach();
        expect(probed, 'elements with Han').toBeGreaterThan(0);
      } finally {
        await context.close();
      }
    });
  }
});
