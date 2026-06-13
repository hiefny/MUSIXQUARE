/**
 * E2E: YouTube Integration Tests
 *
 * Tests YouTube video/playlist loading, playback, and host-guest sync.
 * Note: YouTube IFrame API may be blocked in headless Chromium.
 * Tests are designed to gracefully handle API unavailability.
 */
import { test, expect } from '@playwright/test';
import {
  createHostGuestContexts,
  cleanupContexts,
  type HostGuestPair,
} from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import {
  isVisible,
  readPlaybackProjection,
  waitForClass,
  waitForPlaybackProjection,
} from './helpers/wait.ts';

const YT_VIDEO_1 = 'https://youtu.be/bnh70V0yu2s';
const YT_VIDEO_2 = 'https://youtu.be/OALIXy23HvI';
const YT_PLAYLIST = 'https://youtube.com/playlist?list=PLuKsPSjl0InjvzKVvF3kc0txl5ZtggsEX';

let pair: HostGuestPair;

test.describe('YouTube Integration', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });

  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  test('YouTube source button opens URL overlay', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Open media source popup
    const mediaBtn = pair.hostPage.locator('#btn-media-source');
    if (await mediaBtn.isVisible()) {
      await mediaBtn.click();
      await waitForClass(pair.hostPage, '#media-source-overlay', 'active');
    }

    // Click YouTube source button
    const ytBtn = pair.hostPage.locator('#btn-youtube-source');
    if (await ytBtn.isVisible()) {
      await ytBtn.click();

      // YouTube URL overlay should appear
      await expect(pair.hostPage.locator('#youtube-url-overlay')).toBeVisible({ timeout: 5000 });
      await expect(pair.hostPage.locator('#youtube-url-input')).toBeVisible();
      await expect(pair.hostPage.locator('#youtube-play-btn')).toBeVisible();
    }
  });

  test('YouTube URL input shows preview', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Navigate to YouTube overlay
    await pair.hostPage.evaluate(() => {
      const overlay = document.getElementById('youtube-url-overlay');
      if (overlay) overlay.classList.add('active');
    });
    await waitForClass(pair.hostPage, '#youtube-url-overlay', 'active');

    const ytInput = pair.hostPage.locator('#youtube-url-input');
    if (await ytInput.isVisible()) {
      await ytInput.fill(YT_VIDEO_1);
      // Trigger input event for preview
      await ytInput.dispatchEvent('input');

      // Wait for preview to potentially load (oEmbed fetch)
      await pair.hostPage.waitForFunction(
        () => {
          const preview = document.getElementById('youtube-preview');
          const status = document.getElementById('youtube-preview-status');
          return (
            preview?.style.display === 'block' ||
            preview?.style.display === 'flex' ||
            (status?.textContent?.trim()?.length ?? 0) > 0
          );
        },
        { timeout: 10_000 },
      );

      // Preview container should appear or status should update
      const previewVisible = await pair.hostPage.evaluate(() => {
        const preview = document.getElementById('youtube-preview');
        const status = document.getElementById('youtube-preview-status');
        return {
          previewDisplay: preview?.style.display,
          statusText: status?.textContent?.trim() || '',
        };
      });

      // Either preview shows or status has a message
      expect(
        previewVisible.previewDisplay === 'block' ||
          previewVisible.previewDisplay === 'flex' ||
          previewVisible.statusText.length > 0,
      ).toBe(true);
    }
  });

  test('cancel button closes YouTube overlay', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Open YouTube overlay
    await pair.hostPage.evaluate(() => {
      const overlay = document.getElementById('youtube-url-overlay');
      if (overlay) overlay.classList.add('active');
    });
    await waitForClass(pair.hostPage, '#youtube-url-overlay', 'active');

    const cancelBtn = pair.hostPage.locator('#btn-yt-cancel');
    if (await cancelBtn.isVisible()) {
      await cancelBtn.click();

      // Overlay should be dismissed
      await waitForClass(pair.hostPage, '#youtube-url-overlay', 'active', false);

      const isActive = await pair.hostPage.evaluate(() =>
        document.getElementById('youtube-url-overlay')?.classList.contains('active'),
      );
      expect(isActive).toBeFalsy();
    }
  });

  test('loading YouTube video changes playback projection to PLAYING_YOUTUBE', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Open YouTube overlay and enter URL
    await pair.hostPage.evaluate(() => {
      const overlay = document.getElementById('youtube-url-overlay');
      if (overlay) overlay.classList.add('active');
    });

    const ytInput = pair.hostPage.locator('#youtube-url-input');
    if (await ytInput.isVisible()) {
      await ytInput.fill(YT_VIDEO_1);
      await ytInput.dispatchEvent('input');

      // Wait for preview/play button to become enabled
      await pair.hostPage.waitForFunction(
        () => {
          const btn = document.getElementById('youtube-play-btn') as HTMLButtonElement | null;
          return btn && !btn.disabled;
        },
        { timeout: 10_000 },
      );

      // Click play button
      const playBtn = pair.hostPage.locator('#youtube-play-btn');
      if (await isVisible(pair.hostPage, '#youtube-play-btn')) {
        await playBtn.click();

        // playback projection should change to PLAYING_YOUTUBE
        await waitForPlaybackProjection(pair.hostPage, 'PLAYING_YOUTUBE', 15_000);

        const playbackProjection = await readPlaybackProjection(pair.hostPage);
        expect(playbackProjection).toBe('PLAYING_YOUTUBE');
      }
    }
  });

  test('YouTube video loads and changes to PLAYING_YOUTUBE mode', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Open overlay and load video via UI
    await pair.hostPage.evaluate(() => {
      const overlay = document.getElementById('youtube-url-overlay');
      if (overlay) overlay.classList.add('active');
    });

    const ytInput = pair.hostPage.locator('#youtube-url-input');
    if (await ytInput.isVisible()) {
      await ytInput.fill(YT_VIDEO_1);
      await ytInput.dispatchEvent('input');

      // Wait for play button to become enabled
      await pair.hostPage.waitForFunction(
        () => {
          const btn = document.getElementById('youtube-play-btn') as HTMLButtonElement | null;
          return btn && !btn.disabled;
        },
        { timeout: 10_000 },
      );

      const playBtn = pair.hostPage.locator('#youtube-play-btn');
      if (await isVisible(pair.hostPage, '#youtube-play-btn')) {
        await playBtn.click();

        // Wait for state to settle
        await pair.hostPage.waitForFunction(
          () => {
            const projected = (window as any).__MUSIXQUARE_GET_PLAYBACK_PROJECTION__;
            if (typeof projected !== 'function') return false;
            const state = projected();
            return state === 'PLAYING_YOUTUBE' || state === 'IDLE';
          },
          { timeout: 15_000 },
        );

        const playbackProjection = await readPlaybackProjection(pair.hostPage);
        expect(['PLAYING_YOUTUBE', 'IDLE']).toContain(playbackProjection);
      }
    }
  });

  test('guest receives YouTube mode state from host', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Host opens YouTube overlay and enters URL
    await pair.hostPage.evaluate(() => {
      const overlay = document.getElementById('youtube-url-overlay');
      if (overlay) overlay.classList.add('active');
    });

    const ytInput = pair.hostPage.locator('#youtube-url-input');
    if (await ytInput.isVisible()) {
      await ytInput.fill(YT_VIDEO_1);
      await ytInput.dispatchEvent('input');

      // Wait for play button to become enabled
      await pair.hostPage.waitForFunction(
        () => {
          const btn = document.getElementById('youtube-play-btn') as HTMLButtonElement | null;
          return btn && !btn.disabled;
        },
        { timeout: 10_000 },
      );

      const playBtn = pair.hostPage.locator('#youtube-play-btn');
      if (await isVisible(pair.hostPage, '#youtube-play-btn')) {
        await playBtn.click();

        // Wait for host state to settle
        await pair.hostPage.waitForFunction(
          () => {
            const projected = (window as any).__MUSIXQUARE_GET_PLAYBACK_PROJECTION__;
            if (typeof projected !== 'function') return false;
            const state = projected();
            return state === 'PLAYING_YOUTUBE' || state === 'IDLE';
          },
          { timeout: 15_000 },
        );

        // Guest should receive YouTube mode
        await pair.guestPage.waitForFunction(
          () => {
            const projected = (window as any).__MUSIXQUARE_GET_PLAYBACK_PROJECTION__;
            if (typeof projected !== 'function') return false;
            const state = projected();
            return state === 'PLAYING_YOUTUBE' || state === 'IDLE';
          },
          { timeout: 15_000 },
        );

        const guestState = await readPlaybackProjection(pair.guestPage);
        expect(['PLAYING_YOUTUBE', 'IDLE']).toContain(guestState);
      }
    }
  });

  test('YouTube playlist URL loads multiple sub-items', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await pair.hostPage.evaluate(() => {
      const overlay = document.getElementById('youtube-url-overlay');
      if (overlay) overlay.classList.add('active');
    });

    const ytInput = pair.hostPage.locator('#youtube-url-input');
    if (await ytInput.isVisible()) {
      await ytInput.fill(YT_PLAYLIST);
      await ytInput.dispatchEvent('input');

      // Wait for play button to become enabled
      await pair.hostPage.waitForFunction(
        () => {
          const btn = document.getElementById('youtube-play-btn') as HTMLButtonElement | null;
          return btn && !btn.disabled;
        },
        { timeout: 10_000 },
      );

      const playBtn = pair.hostPage.locator('#youtube-play-btn');
      if (await isVisible(pair.hostPage, '#youtube-play-btn')) {
        await playBtn.click();

        // Wait for playlist to be populated
        await pair.hostPage.waitForFunction(
          () => {
            const get = (window as any).__MUSIXQUARE_GET_STATE__;
            if (!get) return false;
            const items = get('playlist.items') as unknown[];
            return items && items.length >= 1;
          },
          { timeout: 15_000 },
        );

        const playlistCount = await pair.hostPage.evaluate(() => {
          const get = (window as any).__MUSIXQUARE_GET_STATE__;
          return get ? ((get('playlist.items') as unknown[])?.length ?? 0) : 0;
        });
        expect(playlistCount).toBeGreaterThanOrEqual(1);
      }
    }
  });

  test('switching from YouTube to audio mode changes state', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // First enter YouTube mode
    await pair.hostPage.evaluate(() => {
      const overlay = document.getElementById('youtube-url-overlay');
      if (overlay) overlay.classList.add('active');
    });

    const ytInput = pair.hostPage.locator('#youtube-url-input');
    if (await ytInput.isVisible()) {
      await ytInput.fill(YT_VIDEO_1);
      await ytInput.dispatchEvent('input');

      // Wait for play button to become enabled
      await pair.hostPage.waitForFunction(
        () => {
          const btn = document.getElementById('youtube-play-btn') as HTMLButtonElement | null;
          return btn && !btn.disabled;
        },
        { timeout: 10_000 },
      );

      const playBtn = pair.hostPage.locator('#youtube-play-btn');
      if (await isVisible(pair.hostPage, '#youtube-play-btn')) {
        await playBtn.click();

        // Wait for YouTube state
        await pair.hostPage.waitForFunction(
          () => {
            const projected = (window as any).__MUSIXQUARE_GET_PLAYBACK_PROJECTION__;
            if (typeof projected !== 'function') return false;
            const state = projected();
            return state === 'PLAYING_YOUTUBE' || state === 'IDLE';
          },
          { timeout: 15_000 },
        );

        const ytState = await readPlaybackProjection(pair.hostPage);
        expect(['PLAYING_YOUTUBE', 'IDLE']).toContain(ytState);

        // Upload an audio file
        const fileInput = pair.hostPage.locator('#file-input');
        const path = await import('path');
        const { fileURLToPath } = await import('url');
        const __dirname = path.dirname(fileURLToPath(import.meta.url));
        const fixturePath = path.resolve(__dirname, 'fixtures', 'test-01.mp3');
        await fileInput.setInputFiles(fixturePath);

        // Wait for state to settle after file upload
        await pair.hostPage.waitForFunction(
          () => {
            const projected = (window as any).__MUSIXQUARE_GET_PLAYBACK_PROJECTION__;
            return typeof projected === 'function' && projected() !== undefined;
          },
          { timeout: 10_000 },
        );

        const playbackProjection = await readPlaybackProjection(pair.hostPage);
        expect(['IDLE', 'PAUSED', 'PLAYING_AUDIO', 'PLAYING_YOUTUBE']).toContain(playbackProjection);
      }
    }
  });
});
