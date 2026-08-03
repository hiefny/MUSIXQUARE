/** E2E coverage for the production YouTube entry UI and host/guest mode handoff. */
import { expect, test, type Page } from '@playwright/test';
import {
  createHostGuestContexts,
  cleanupContexts,
  type HostGuestPair,
} from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { uploadFixture } from './helpers/file-upload.ts';
import { installFakeYt } from './helpers/fake-yt.ts';
import {
  readPlaybackProjection,
  waitForClass,
  waitForPlaylistCount,
  waitForPlaybackProjection,
  waitForPlaybackProjectionIn,
} from './helpers/wait.ts';

const YT_VIDEO = 'https://youtu.be/bnh70V0yu2s';
const YT_VIDEO_ID = 'bnh70V0yu2s';
const YT_PLAYLIST = 'https://youtube.com/playlist?list=PLuKsPSjl0InjvzKVvF3kc0txl5ZtggsEX';
const YT_PLAYLIST_ID = 'PLuKsPSjl0InjvzKVvF3kc0txl5ZtggsEX';
const YT_PLAYLIST_VIDEO_IDS = [YT_VIDEO_ID, 'dQw4w9WgXcQ'];

function trackUnexpectedExternalRequests(page: Page, requests: string[]): void {
  const track = (rawUrl: string): void => {
    const url = new URL(rawUrl);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return;
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return;
    // These two YouTube URLs are fully intercepted by this spec's fixture
    // routes; seeing any other remote URL means the suite regained an
    // accidental production-network dependency.
    if (
      url.hostname === 'www.youtube.com' &&
      (url.pathname === '/oembed' || url.pathname === '/iframe_api')
    ) {
      return;
    }
    requests.push(url.href);
  };
  page.on('request', (request) => track(request.url()));
  page.on('websocket', (socket) => track(socket.url()));
}

async function installYouTubeFixtures(page: Page): Promise<void> {
  await installFakeYt(page);

  await page.route(/\/api\/youtube-playlist-manifest(?:\?|$)/, async (route) => {
    const playlistId = new URL(route.request().url()).searchParams.get('playlistId');
    if (playlistId !== YT_PLAYLIST_ID) {
      await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        playlistId,
        videoId: YT_PLAYLIST_VIDEO_IDS[0],
        videoIds: YT_PLAYLIST_VIDEO_IDS,
        title: 'MUSIXQUARE E2E Playlist',
      }),
    });
  });

  await page.route(/\/api\/youtube-playlist-entry(?:\?|$)/, async (route) => {
    const playlistId = new URL(route.request().url()).searchParams.get('playlistId');
    if (playlistId !== YT_PLAYLIST_ID) {
      await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        playlistId,
        videoId: YT_PLAYLIST_VIDEO_IDS[0],
        title: 'MUSIXQUARE E2E Playlist',
      }),
    });
  });

  await page.route(/https:\/\/www\.youtube\.com\/oembed(?:\?|$)/, async (route) => {
    const sourceUrl = new URL(route.request().url()).searchParams.get('url') || '';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        title: sourceUrl.includes(YT_PLAYLIST_ID)
          ? 'MUSIXQUARE E2E Playlist'
          : 'MUSIXQUARE E2E Video',
        author_name: 'MUSIXQUARE E2E',
      }),
    });
  });
}

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
let unexpectedExternalRequests: string[];

test.describe('YouTube Integration', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
    unexpectedExternalRequests = [];
    trackUnexpectedExternalRequests(pair.hostPage, unexpectedExternalRequests);
    trackUnexpectedExternalRequests(pair.guestPage, unexpectedExternalRequests);
    await Promise.all([
      installYouTubeFixtures(pair.hostPage),
      installYouTubeFixtures(pair.guestPage),
    ]);
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
  });

  test.afterEach(async () => {
    await cleanupContexts(pair);
    expect(unexpectedExternalRequests).toEqual([]);
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

    await uploadFixture(pair.hostPage, 'test01');

    // Uploading while another track is active appends to the queue and warms
    // its preload; it does not implicitly interrupt the active YouTube item.
    // Display titles are metadata-aware and hide recognized audio extensions,
    // so assert the canonical queue item and select its appended row rather
    // than coupling this ownership test to user-facing title formatting.
    await waitForPlaylistCount(pair.hostPage, 2);
    const appendedItem = await pair.hostPage.evaluate(() => {
      const get = (window as unknown as Record<string, (path: string) => unknown>)
        .__MUSIXQUARE_GET_STATE__;
      const items = get?.('playlist.items');
      const item = Array.isArray(items) ? items.at(-1) : null;
      if (!item || typeof item !== 'object') return null;
      const queueItem = item as { type?: unknown; name?: unknown };
      return { type: queueItem.type, name: queueItem.name };
    });
    expect(appendedItem).toEqual({ type: 'file', name: 'test-01.mp3' });

    const localTrack = pair.hostPage.locator('#playlist-ui > .playlist-entry > .track-item').last();
    await expect(localTrack).toBeVisible();
    expect(await readPlaybackProjection(pair.hostPage)).toBe('PLAYING_YOUTUBE');

    await localTrack.click();

    await waitForPlaybackProjectionIn(pair.hostPage, ['PLAYING_AUDIO', 'PAUSED'], 15_000);
    expect(['PLAYING_AUDIO', 'PAUSED']).toContain(await readPlaybackProjection(pair.hostPage));
  });
});
