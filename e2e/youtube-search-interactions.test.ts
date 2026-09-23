import { expect, test, type Page } from '@playwright/test';
import { injectPeerServer } from './helpers/peer-server.ts';
import { setupHostAndStart } from './helpers/setup-flow.ts';
import { installFakeYt } from './helpers/fake-yt.ts';
import {
  getPageErrors,
  trackPageErrors,
  useAnonymousAccountSession,
} from './helpers/context-factory.ts';
import { readState, waitForPlaylistCount } from './helpers/wait.ts';

const RESULTS = [
  { videoId: '9bZkp7q19f0', title: 'Gangnam Style', channelTitle: 'PSY' },
  {
    videoId: 'dQw4w9WgXcQ',
    title: 'A longer video title that wraps onto two lines in the search result row',
    channelTitle: 'MUSIXQUARE test channel',
  },
  { videoId: 'bnh70V0yu2s', title: 'Third search result', channelTitle: 'Test artist' },
  { videoId: 'abcdefghijk', title: 'Fourth search result', channelTitle: 'Test artist' },
  { videoId: 'lmnopqrstuv', title: 'Fifth search result', channelTitle: 'Test artist' },
];

async function openSearch(page: Page): Promise<void> {
  await page.locator('#btn-media-source').click();
  await page.locator('#btn-youtube-source').click();
  await expect(page.locator('#youtube-url-overlay')).toBeVisible();
  await expect(page.locator('#youtube-url-input')).toBeFocused();
}

async function readRows(page: Page) {
  return page.locator('#youtube-search-results .yt-search-result').evaluateAll((rows) =>
    rows.map((row) => {
      const bounds = row.getBoundingClientRect();
      return ['.yt-search-thumb', '.yt-search-title', '.yt-search-channel'].map((selector) => {
        const rect = row.querySelector(selector)!.getBoundingClientRect();
        return {
          rowHeight: bounds.height,
          x: rect.x - bounds.x,
          y: rect.y - bounds.y,
          width: rect.width,
          height: rect.height,
        };
      });
    }),
  );
}

test.describe('YouTube search loading and quick add', () => {
  test.beforeEach(async ({ page }) => {
    trackPageErrors(page);
    await injectPeerServer(page);
    // No live YouTube/account service is required by these interaction tests.
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
      if (['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
      return route.abort();
    });
    await useAnonymousAccountSession(page);
    await installFakeYt(page);
    await page.route('https://i.ytimg.com/**', (route) =>
      route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#4080ed"/></svg>',
      }),
    );
    await page.route('https://www.youtube.com/oembed**', (route) =>
      route.fulfill({ json: { title: 'Fixture video', author_name: 'Fixture channel' } }),
    );
    await setupHostAndStart(page);
  });

  test.afterEach(async ({ page }) => {
    expect(getPageErrors(page).map((error) => error.message)).toEqual([]);
  });

  for (const viewport of [
    { name: 'desktop', width: 1280, height: 800, rtl: false },
    { name: 'mobile', width: 390, height: 844, rtl: false },
    { name: 'mobile RTL light reduced motion', width: 390, height: 844, rtl: true },
  ]) {
    test(`${viewport.name}: skeleton keeps row geometry and Enter searches then adds once`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      if (viewport.rtl) {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.evaluate(() => {
          document.documentElement.dir = 'rtl';
          document.documentElement.dataset.theme = 'light';
        });
      }
      await openSearch(page);
      let releaseSearch!: () => void;
      const pending = new Promise<void>((resolve) => {
        releaseSearch = resolve;
      });
      let requests = 0;
      await page.route('**/api/youtube-search?**', async (route) => {
        requests++;
        await pending;
        await route.fulfill({ json: { results: RESULTS } });
      });
      const input = page.locator('#youtube-url-input');
      const results = page.locator('#youtube-search-results');
      try {
        await input.fill('Gangnam Style');
        await input.press('Enter');
        await expect(results).toHaveAttribute('aria-busy', 'true');
        await expect(results.locator('.yt-search-skeleton')).toHaveCount(5);
        await expect(results.locator('button')).toHaveCount(0);
        await expect(page.locator('#youtube-play-btn')).toBeDisabled();
        if (viewport.rtl) {
          expect(
            await results
              .locator('.yt-skeleton-block')
              .first()
              .evaluate((element) => getComputedStyle(element).animationName),
          ).toBe('none');
        }
        const skeletonRows = await readRows(page);
        await page.screenshot({ path: testInfo.outputPath('search-loading.png') });
        await input.press('Enter');
        await input.dispatchEvent('keydown', { key: 'Enter', repeat: true });
        expect(await readState(page, 'playlist.items')).toEqual([]);
        expect(requests).toBe(1);
        releaseSearch();
        await expect(results.locator('button')).toHaveCount(RESULTS.length);
        await expect(results).not.toHaveAttribute('aria-busy', 'true');
        const actualRows = await readRows(page);
        for (let row = 0; row < skeletonRows.length; row++) {
          for (let part = 0; part < skeletonRows[row]!.length; part++) {
            for (const key of ['rowHeight', 'x', 'y', 'width', 'height'] as const) {
              expect(actualRows[row]![part]![key]).toBeCloseTo(skeletonRows[row]![part]![key], 1);
            }
          }
        }
        await page.screenshot({ path: testInfo.outputPath('search-results.png') });
        await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
        await input.dispatchEvent('keydown', { key: 'Enter', repeat: true });
        expect(await readState(page, 'playlist.items')).toEqual([]);
        await input.press('Enter');
        await waitForPlaylistCount(page, 1);
        const items = (await readState(page, 'playlist.items')) as Array<{ videoId: string }>;
        expect(items[0]?.videoId).toBe(RESULTS[0]!.videoId);
        expect(requests).toBe(1);
        await expect(page.locator('#youtube-url-overlay')).not.toBeVisible();
      } finally {
        releaseSearch();
      }
    });
  }

  for (const action of ['Enter', 'double click'] as const) {
    test(`selected result ${action} adds that result exactly once`, async ({ page }) => {
      await page.route('**/api/youtube-search?**', (route) =>
        route.fulfill({ json: { results: RESULTS } }),
      );
      await openSearch(page);
      await page.locator('#youtube-url-input').fill('Selected video');
      await page.locator('#youtube-url-input').press('Enter');
      const chosen = page.locator('#youtube-search-results button').nth(1);
      await expect(chosen).toBeVisible();
      if (action === 'Enter') {
        await chosen.click();
        expect(await readState(page, 'playlist.items')).toEqual([]);
        await chosen.press('Enter');
      } else {
        await chosen.dblclick();
      }
      await waitForPlaylistCount(page, 1);
      const items = (await readState(page, 'playlist.items')) as Array<{ videoId: string }>;
      expect(items[0]?.videoId).toBe(RESULTS[1]!.videoId);
      await expect(page.locator('#youtube-url-overlay')).not.toBeVisible();
    });
  }

  test('search failure removes skeleton and allows a fresh search', async ({ page }) => {
    let requests = 0;
    await page.route('**/api/youtube-search?**', (route) => {
      requests++;
      return requests === 1
        ? route.fulfill({ status: 500, json: { error: 'fixture failure' } })
        : route.fulfill({ json: { results: RESULTS } });
    });
    await openSearch(page);
    const input = page.locator('#youtube-url-input');
    await input.fill('Retry search');
    await input.press('Enter');
    await expect(page.locator('#youtube-preview-status')).toHaveAttribute(
      'data-i18n',
      'youtube.search_failed',
    );
    await expect(page.locator('.yt-search-skeleton')).toHaveCount(0);
    await expect(page.locator('#youtube-search-results')).not.toHaveAttribute('aria-busy', 'true');
    await input.press('Enter');
    await expect(page.locator('#youtube-search-results button')).toHaveCount(RESULTS.length);
    expect(requests).toBe(2);
  });
});
