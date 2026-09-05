import { expect, type Page } from '@playwright/test';
import { installFakeYt } from './fake-yt.ts';
import { navigateToTab, readState, waitForPlaybackProjection } from './wait.ts';
import type { PlaylistItem } from '../../src/types/index.ts';

/** Install before navigation: source-entry scenarios never depend on a live iframe. */
export async function installLocalYouTube(page: Page): Promise<void> {
  await installFakeYt(page);
  await page.route(/https:\/\/www\.youtube\.com\/oembed(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ title: 'E2E fixture video', author_name: 'E2E' }),
    }),
  );
}

/** Submit through the source UI and select its new occurrence for transition scenarios. */
export async function submitYouTubeSource(page: Page, url: string): Promise<void> {
  await navigateToTab(page, 'play');
  const existingIds = ((await readState(page, 'playlist.items')) as PlaylistItem[]).map(
    (item) => item.queueItemId,
  );
  await page.locator('#btn-media-source').click();
  await expect(page.locator('#media-source-overlay')).toHaveClass(/active/);
  await page.locator('#btn-youtube-source').click();
  const input = page.locator('#youtube-url-input');
  await expect(input).toBeVisible();
  await input.fill(url);
  await input.dispatchEvent('input');
  await expect(page.locator('#youtube-play-btn')).toBeEnabled();
  await page.locator('#youtube-play-btn').click();
  await page.waitForFunction(
    (priorIds) => {
      const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
        | ((path: string) => unknown)
        | undefined;
      const items = get?.('playlist.items') as PlaylistItem[] | undefined;
      return items?.some((item) => item.type === 'youtube' && !priorIds.includes(item.queueItemId));
    },
    existingIds,
    { timeout: 15_000 },
  );
  const added = ((await readState(page, 'playlist.items')) as PlaylistItem[]).find(
    (item) => item.type === 'youtube' && !existingIds.includes(item.queueItemId),
  )!;
  // Adding to a nonempty queue intentionally preserves its active track.
  // These transition scenarios must explicitly select the new occurrence.
  if ((await readState(page, 'playlist.currentQueueItemId')) !== added.queueItemId) {
    await navigateToTab(page, 'playlist');
    await page.locator(`.track-item[data-queue-item-id="${added.queueItemId}"]`).click();
  }
}

export async function waitForYouTubePlayback(page: Page, videoId: string): Promise<void> {
  await page.waitForFunction(
    (expectedId) => {
      const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
        | ((path: string) => unknown)
        | undefined;
      const items = get?.('playlist.items') as
        | Array<{ queueItemId: string; type: string; videoId?: string }>
        | undefined;
      const currentId = get?.('playlist.currentQueueItemId');
      return items?.some(
        (item) =>
          item.queueItemId === currentId && item.type === 'youtube' && item.videoId === expectedId,
      );
    },
    videoId,
    { timeout: 15_000 },
  );
  await waitForPlaybackProjection(page, 'PLAYING_YOUTUBE');
}
