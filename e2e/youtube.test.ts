/** E2E coverage for the production YouTube entry UI and host/guest mode handoff. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import {
  createHostGuestContexts,
  cleanupContexts,
  type HostGuestPair,
} from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import {
  readPlaybackProjection,
  waitForClass,
  waitForPlaybackProjection,
  waitForPlaybackProjectionIn,
} from './helpers/wait.ts';

const YT_VIDEO = 'https://youtu.be/bnh70V0yu2s';
const YT_PLAYLIST = 'https://youtube.com/playlist?list=PLuKsPSjl0InjvzKVvF3kc0txl5ZtggsEX';
const YT_PLAYLIST_ID = 'PLuKsPSjl0InjvzKVvF3kc0txl5ZtggsEX';

async function openYouTubeOverlay(page: Page): Promise<void> {
  const mediaButton = page.locator('#btn-media-source');
  await expect(mediaButton).toBeVisible();
  await mediaButton.click();
  await waitForClass(page, '#media-source-overlay', 'active');

  const youtubeButton = page.locator('#btn-youtube-source');
  await expect(youtubeButton).toBeVisible();
  await youtubeButton.click();

  await expect(page.locator('#youtube-url-overlay')).toBeVisible();
  await expect(page.locator('#youtube-url-input')).toBeVisible();
  await expect(page.locator('#youtube-play-btn')).toBeVisible();
}

async function submitYouTubeUrl(page: Page, url: string): Promise<void> {
  await openYouTubeOverlay(page);
  const input = page.locator('#youtube-url-input');
  await input.fill(url);
  await input.dispatchEvent('input');
  await expect(page.locator('#youtube-play-btn')).toBeEnabled({ timeout: 10_000 });
  await page.locator('#youtube-play-btn').click();
}

let pair: HostGuestPair;

test.describe('YouTube Integration', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
  });

  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  test('YouTube source button opens the complete URL overlay', async () => {
    await openYouTubeOverlay(pair.hostPage);
  });

  test('YouTube URL input renders a preview or an explicit availability status', async () => {
    await openYouTubeOverlay(pair.hostPage);
    const input = pair.hostPage.locator('#youtube-url-input');
    await input.fill(YT_VIDEO);
    await input.dispatchEvent('input');

    await expect
      .poll(async () => {
        return await pair.hostPage.evaluate(() => {
          const preview = document.getElementById('youtube-preview');
          const status = document.getElementById('youtube-preview-status');
          return (
            preview?.style.display === 'block' ||
            preview?.style.display === 'flex' ||
            (status?.textContent?.trim().length ?? 0) > 0
          );
        });
      })
      .toBe(true);
  });

  test('cancel button closes the YouTube overlay', async () => {
    await openYouTubeOverlay(pair.hostPage);
    const cancel = pair.hostPage.locator('#btn-yt-cancel');
    await expect(cancel).toBeVisible();
    await cancel.click();
    await waitForClass(pair.hostPage, '#youtube-url-overlay', 'active', false);
    await expect(pair.hostPage.locator('#youtube-url-overlay')).not.toBeVisible();
  });

  test('loading a video switches both host and guest to YouTube mode', async () => {
    await submitYouTubeUrl(pair.hostPage, YT_VIDEO);

    await Promise.all([
      waitForPlaybackProjection(pair.hostPage, 'PLAYING_YOUTUBE', 15_000),
      waitForPlaybackProjection(pair.guestPage, 'PLAYING_YOUTUBE', 15_000),
    ]);
    expect(await readPlaybackProjection(pair.hostPage)).toBe('PLAYING_YOUTUBE');
    expect(await readPlaybackProjection(pair.guestPage)).toBe('PLAYING_YOUTUBE');
  });

  test('playlist URL is registered with its production playlist identity', async () => {
    await submitYouTubeUrl(pair.hostPage, YT_PLAYLIST);

    await pair.hostPage.waitForFunction(
      () => {
        const get = (window as unknown as Record<string, (path: string) => unknown>)
          .__MUSIXQUARE_GET_STATE__;
        const items = get?.('playlist.items');
        return Array.isArray(items) && items.length > 0;
      },
      undefined,
      { timeout: 15_000 },
    );
    const item = await pair.hostPage.evaluate(() => {
      const get = (window as unknown as Record<string, (path: string) => unknown>)
        .__MUSIXQUARE_GET_STATE__;
      const items = get?.('playlist.items');
      return Array.isArray(items) ? items.at(-1) : null;
    });
    expect(item).toMatchObject({ type: 'youtube', playlistId: YT_PLAYLIST_ID });
  });

  test('selecting an uploaded local audio track leaves YouTube ownership', async () => {
    await submitYouTubeUrl(pair.hostPage, YT_VIDEO);
    await waitForPlaybackProjection(pair.hostPage, 'PLAYING_YOUTUBE', 15_000);

    const fixturePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      'fixtures',
      'test-01.mp3',
    );
    await pair.hostPage.locator('#file-input').setInputFiles(fixturePath);

    // Uploading while another track is active appends to the queue and warms
    // its preload; it does not implicitly interrupt the active YouTube item.
    const localTrack = pair.hostPage
      .locator('#playlist-ui > .track-item')
      .filter({ hasText: 'test-01.mp3' });
    await expect(localTrack).toHaveCount(1);
    await expect(localTrack).toBeVisible();
    expect(await readPlaybackProjection(pair.hostPage)).toBe('PLAYING_YOUTUBE');

    await localTrack.click();

    await waitForPlaybackProjectionIn(pair.hostPage, ['PLAYING_AUDIO', 'PAUSED'], 15_000);
    expect(['PLAYING_AUDIO', 'PAUSED']).toContain(await readPlaybackProjection(pair.hostPage));
  });
});
