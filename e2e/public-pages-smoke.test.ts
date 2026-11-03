/**
 * Every page outside the app loads once in Chromium with no same-origin
 * response of 400 or more and no console error. A light load check in the
 * default suite: the static font contract and the built output are the font
 * guards' and the unit tests' (scripts/check-app-font.mts,
 * src/i18n/__tests__/public-font-pages.test.ts), and which face draws what
 * is the opt-in lab's (e2e/public-fonts/, playwright.public-fonts.config.ts).
 *
 * The page list comes from the registry (scripts/lib/public-font-pages.mts),
 * so a newly registered page is loaded too: every built public page, About
 * in every UI language, a page whose script picks its language once per
 * language it is shown in, the sign-in completion page (the app's, whose
 * script adds the shared sheets once its completion message is out), and
 * the two pages the App Worker renders from its own markup (the admin page
 * and the blog article without a built blog page), rendered by the Worker
 * itself and served at their own paths. The UI kit is served in development
 * only.
 *
 * The local preview serves no API, so responses under /api/ and the console
 * lines Chromium logs for them are not counted.
 */
import { expect, test, type Page } from '@playwright/test';

import appWorker from '../cloudflare/app-worker.ts';
import { PUBLIC_FONT_PAGES, PUBLIC_WORKER_FONT_PAGES } from '../scripts/lib/public-font-pages.mts';
import { LANGUAGE_OPTIONS } from '../src/i18n/locales.ts';
import { isBenignPageError } from './helpers/page-errors.ts';

interface SmokePage {
  readonly name: string;
  readonly path: string;
  readonly locale: string;
  /** The page's HTML as the App Worker renders it at this origin, served at `path`. */
  readonly workerHtml?: (origin: string) => Promise<string>;
}

/** A browser locale whose first language is the page language. */
const BROWSER_LOCALE: Readonly<Record<string, string>> = { en: 'en-US', ko: 'ko-KR' };

const ABOUT_SOURCE = '.workshop/landing/landing.html';

const ARTICLE_SLUG = 'public-page-smoke-article';

/** The admin page, as the App Worker renders it with no bindings. */
async function renderAdminPage(origin: string): Promise<string> {
  const response = await appWorker.fetch(new Request(`${origin}/admin`), {});
  expect(response.status).toBe(200);
  return response.text();
}

/**
 * A blog article as the App Worker renders it when the built blog page is
 * not there to hold it: one synthetic article in the RSS backup, no hidden
 * article, and an asset binding with no /blog/index.html.
 */
async function renderArticleFallback(origin: string): Promise<string> {
  const store = new Map<string, string>([
    [
      'soro-rss-latest-good.xml',
      `<rss><channel><item>
        <title>Public page smoke article</title>
        <description>A synthetic article for the load check.</description>
        <link>https://musixquare.com/blog/${ARTICLE_SLUG}</link>
        <pubDate>Mon, 02 Nov 2026 12:00:00 GMT</pubDate>
        <content:encoded><![CDATA[<p>Text in English, 한국어, 日本語.</p>]]></content:encoded>
      </item></channel></rss>`,
    ],
  ]);
  const env = {
    SORO_RSS_BACKUP: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
    },
    MUSIXQUARE_ADMIN_DB: {
      prepare: () => ({ all: async () => ({ results: [] }) }),
    },
    ASSETS: {
      fetch: async () =>
        new Response('', { headers: { 'Content-Type': 'application/octet-stream' } }),
    },
  };
  const response = await appWorker.fetch(new Request(`${origin}/blog/${ARTICLE_SLUG}`), env);
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain('Public page smoke article');
  return html;
}

const PAGES: readonly SmokePage[] = [
  ...PUBLIC_FONT_PAGES.flatMap(({ html, dist, htmlLangs }): SmokePage[] => {
    if (dist === null) return [];
    if (html === ABOUT_SOURCE) {
      // One built copy per UI language, read in a browser that lists English.
      return LANGUAGE_OPTIONS.map(({ code }) => ({
        name: `About (${code})`,
        path: code === 'en' ? '/about.html' : `/${code}/about.html`,
        locale: 'en-US',
      }));
    }
    // One file whose script picks its language: once per language it shows.
    return htmlLangs.map((htmlLang) => ({
      name: htmlLangs.length > 1 ? `${dist} (${htmlLang})` : dist,
      path: `/${dist}`,
      locale: BROWSER_LOCALE[htmlLang] ?? 'en-US',
    }));
  }),
  ...['ko', 'en'].map((language) => ({
    name: `account-complete.html (${language})`,
    path: '/account-complete.html?accountClient=smoke-0001',
    locale: BROWSER_LOCALE[language] ?? 'en-US',
  })),
  {
    name: 'the admin page (App Worker)',
    path: '/admin',
    locale: 'en-US',
    workerHtml: renderAdminPage,
  },
  {
    name: 'the blog article fallback (App Worker)',
    path: `/blog/${ARTICLE_SLUG}`,
    locale: 'en-US',
    workerHtml: renderArticleFallback,
  },
];

test('loads every registered page, About in every language and both Worker pages', () => {
  expect(PUBLIC_WORKER_FONT_PAGES).toHaveLength(2);
  expect(PAGES.filter(({ name }) => name.startsWith('About ('))).toHaveLength(
    LANGUAGE_OPTIONS.length,
  );
  expect(PAGES.length).toBeGreaterThan(LANGUAGE_OPTIONS.length + 30);
});

/** Same-origin responses of 400 or more, console errors and page errors. */
function watch(page: Page, origin: string): { failures: string[] } {
  const failures: string[] = [];
  const isApi = (url: string) => {
    const parsed = new URL(url);
    return parsed.origin === origin && parsed.pathname.startsWith('/api/');
  };
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin !== origin || isApi(response.url())) return;
    if (response.status() >= 400) failures.push(`${response.status()} ${url.pathname}`);
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // Chromium logs a line for each failed request; an API request is the
    // preview's missing API, not the page's.
    const { url } = message.location();
    if (url && isApi(url) && /^Failed to load resource/u.test(message.text())) return;
    failures.push(`console: ${message.text()}${url ? ` (${url})` : ''}`);
  });
  page.on('pageerror', (error) => {
    if (!isBenignPageError(error)) failures.push(`page error: ${error.message}`);
  });
  return { failures };
}

test.describe('public pages load without a failed request or a console error', () => {
  for (const smoke of PAGES) {
    test(smoke.name, async ({ browser, baseURL }) => {
      const origin = new URL(baseURL ?? '').origin;
      const context = await browser.newContext({ locale: smoke.locale, serviceWorkers: 'block' });
      try {
        // Keep the run on the local preview.
        await context.route(
          (url) => url.origin !== origin,
          (route) => route.abort(),
        );
        if (smoke.workerHtml) {
          const html = await smoke.workerHtml(origin);
          await context.route(`${origin}${smoke.path}`, (route) =>
            route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }),
          );
        }
        const page = await context.newPage();
        const { failures } = watch(page, origin);
        const response = await page.goto(`${origin}${smoke.path}`, { waitUntil: 'load' });
        expect(response?.status(), smoke.path).toBeLessThan(400);
        await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
        });
        // Late requests (deferred scripts, rest.css at the body end, faces).
        await page.waitForTimeout(500);
        expect(failures).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
});
