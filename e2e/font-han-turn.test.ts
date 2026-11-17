/**
 * The UI's first Han family applies before any other Han family.
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
 * The test holds the font owner until window load, and the UI's first Han
 * sheet until phase B's idle slice has run and every other sheet the page
 * asked for has applied and drawn. It then requires that no face of another
 * Han family was asked for and that the UI's own family draws the Han.
 *
 * An installed family of the same name (a Windows 11 PC can have Noto Sans
 * KR, SC and TC) would draw the Han while its sheet is held and hide the
 * race, so each CJK name gets a face that never loads, as on a phone without
 * them. Its src must be a URL: Chromium settles a local() face to 'error' at
 * once and then draws with the installed font of that name again. Its weight
 * range is the app faces' 100 to 900; with another range Chromium still drew
 * with the installed font.
 *
 * Chromium only: WebKit holds window load for the font owner and holds
 * rendering while any sheet loads, so a later sheet never draws first there.
 * A local verification spec, not part of the critical set.
 */
import { readdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';

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

interface Row {
  readonly name: string;
  readonly locale: string;
  /** navigator.languages, when it is not just the locale. */
  readonly languages?: readonly string[];
  /** The saved UI language, when it is not the browser's. */
  readonly ui?: string;
  /** The UI's first Han family and its sheet, which the test holds. */
  readonly family: CjkFamily;
  readonly sheet: string;
  /** Han the start screen does not show, laid out over it. */
  readonly content?: string;
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
    content: '漢字 海 返 曜 花 雪',
  },
];

test.describe('the first Han family applies first', () => {
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'WebKit holds rendering while a sheet loads, and the faces are read over CDP',
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

        // Gates: the font owner until window load, the first Han sheet until
        // every other requested sheet has applied and drawn.
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
        await page.route('**/assets/locale-fonts-*.js', async (route) => {
          await runtimeGate;
          await route.continue();
        });
        await page.route(`**/assets/${row.sheet}-*.css`, async (route) => {
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
          await page.evaluate((text) => {
            const line = document.createElement('p');
            line.textContent = text;
            line.style.cssText =
              'position:fixed;left:8px;top:8px;z-index:2147483647;margin:0;font-size:15px;';
            document.body.append(line);
          }, row.content);
        }

        releaseRuntime();
        // Phase A asked for the held sheet, so it has armed phase B; idle
        // callbacks run in the order they were requested, so after two of the
        // test's own, phase B's slice has run.
        await sheetSeen;
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestIdleCallback(() => requestIdleCallback(() => resolve()));
            }),
        );
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
        expect(
          asked.filter((family) => family !== row.family),
          'shards of other Han families',
        ).toEqual([]);
        const touched = await page.evaluate(
          ({ own, families }) =>
            [...document.fonts]
              .filter((face) => face.status !== 'unloaded')
              .map((face) => face.family.replace(/^(['"])(.*)\1$/su, '$2'))
              .filter((family) => family !== own && families.includes(family)),
          { own: row.family, families: CJK_FAMILIES as readonly string[] },
        );
        expect(touched, 'faces of other Han families').toEqual([]);

        // The UI's own family draws the Han.
        await page.evaluate(() => {
          let index = 0;
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const element = node.parentElement;
            if (!element || !/\p{Script=Han}/u.test(node.textContent ?? '')) continue;
            const box = element.getBoundingClientRect();
            if (box.width > 0 && box.height > 0) element.dataset.hanProbe = String(index++);
          }
        });
        const cdp = await context.newCDPSession(page);
        await cdp.send('DOM.enable');
        await cdp.send('CSS.enable');
        const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
        const { nodeIds } = await cdp.send('DOM.querySelectorAll', {
          nodeId: root.nodeId,
          selector: '[data-han-probe]',
        });
        expect(nodeIds.length, 'elements with Han').toBeGreaterThan(0);
        const drawn = new Set<string>();
        for (const nodeId of nodeIds) {
          const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
          for (const { familyName, isCustomFont } of fonts) {
            drawn.add(`${familyName}${isCustomFont ? '' : ' (device)'}`);
          }
        }
        await cdp.detach();
        expect(
          [...drawn].filter((name) => !name.startsWith('Inter') && !name.startsWith(row.family)),
          'faces drawing the Han text',
        ).toEqual([]);
        expect([...drawn].some((name) => name.startsWith(row.family))).toBe(true);
      } finally {
        await context.close();
      }
    });
  }
});
