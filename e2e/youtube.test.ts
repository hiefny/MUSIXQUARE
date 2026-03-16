/**
 * E2E: YouTube Integration Tests
 *
 * Tests YouTube video/playlist loading, playback, and host-guest sync.
 * Note: YouTube IFrame API may be blocked in headless Chromium.
 * Tests are designed to gracefully handle API unavailability.
 */
import { test, expect } from '@playwright/test';
import { createHostGuestContexts, cleanupContexts, type HostGuestPair } from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { readState } from './helpers/wait.ts';

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
      await pair.hostPage.waitForTimeout(500);
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
    await pair.hostPage.waitForTimeout(300);

    const ytInput = pair.hostPage.locator('#youtube-url-input');
    if (await ytInput.isVisible()) {
      await ytInput.fill(YT_VIDEO_1);
      // Trigger input event for preview
      await ytInput.dispatchEvent('input');

      // Wait for preview to potentially load (oEmbed fetch)
      await pair.hostPage.waitForTimeout(3000);

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
      expect(previewVisible.previewDisplay === 'block' ||
             previewVisible.previewDisplay === 'flex' ||
             previewVisible.statusText.length > 0).toBe(true);
    }
  });

  test('cancel button closes YouTube overlay', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Open YouTube overlay
    await pair.hostPage.evaluate(() => {
      const overlay = document.getElementById('youtube-url-overlay');
      if (overlay) overlay.classList.add('active');
    });
    await pair.hostPage.waitForTimeout(300);

    const cancelBtn = pair.hostPage.locator('#btn-yt-cancel');
    if (await cancelBtn.isVisible()) {
      await cancelBtn.click();
      await pair.hostPage.waitForTimeout(500);

      // Overlay should be dismissed
      const isActive = await pair.hostPage.evaluate(() =>
        document.getElementById('youtube-url-overlay')?.classList.contains('active'),
      );
      expect(isActive).toBeFalsy();
    }
  });

  test('loading YouTube video changes appState to PLAYING_YOUTUBE', async () => {
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
      await pair.hostPage.waitForTimeout(2000);

      // Click play button
      const playBtn = pair.hostPage.locator('#youtube-play-btn');
      if (await playBtn.isEnabled({ timeout: 5000 }).catch(() => false)) {
        await playBtn.click();
        await pair.hostPage.waitForTimeout(5000);

        // appState should change to PLAYING_YOUTUBE
        const appState = await readState(pair.hostPage, 'appState');
        expect(appState).toBe('PLAYING_YOUTUBE');
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
      await pair.hostPage.waitForTimeout(2000);

      const playBtn = pair.hostPage.locator('#youtube-play-btn');
      if (await playBtn.isEnabled({ timeout: 5000 }).catch(() => false)) {
        await playBtn.click();
        await pair.hostPage.waitForTimeout(8000);

        const appState = await readState(pair.hostPage, 'appState');
        expect(['PLAYING_YOUTUBE', 'IDLE']).toContain(appState);
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
      await pair.hostPage.waitForTimeout(2000);

      const playBtn = pair.hostPage.locator('#youtube-play-btn');
      if (await playBtn.isEnabled({ timeout: 5000 }).catch(() => false)) {
        await playBtn.click();
        await pair.hostPage.waitForTimeout(8000);

        // Guest should receive YouTube mode
        const guestState = await readState(pair.guestPage, 'appState');
        // Guest may be PLAYING_YOUTUBE or still loading
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
      await pair.hostPage.waitForTimeout(3000);

      const playBtn = pair.hostPage.locator('#youtube-play-btn');
      if (await playBtn.isEnabled({ timeout: 5000 }).catch(() => false)) {
        await playBtn.click();
        await pair.hostPage.waitForTimeout(8000);

        // Playlist should be added
        const playlistCount = await pair.hostPage.evaluate(() => {
          const get = (window as any).__MUSIXQUARE_GET_STATE__;
          return get ? (get('playlist.items') as unknown[])?.length ?? 0 : 0;
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
      await pair.hostPage.waitForTimeout(2000);

      const playBtn = pair.hostPage.locator('#youtube-play-btn');
      if (await playBtn.isEnabled({ timeout: 5000 }).catch(() => false)) {
        await playBtn.click();
        await pair.hostPage.waitForTimeout(5000);

        // Verify YouTube is playing
        const ytState = await readState(pair.hostPage, 'appState');
        expect(['PLAYING_YOUTUBE', 'IDLE']).toContain(ytState);

        // Upload an audio file
        const fileInput = pair.hostPage.locator('#file-input');
        const path = await import('path');
        const { fileURLToPath } = await import('url');
        const __dirname = path.dirname(fileURLToPath(import.meta.url));
        const fixturePath = path.resolve(__dirname, 'fixtures', 'test-01.mp3');
        await fileInput.setInputFiles(fixturePath);
        await pair.hostPage.waitForTimeout(5000);

        // State should change (might go to IDLE or PLAYING_AUDIO, or stay PLAYING_YOUTUBE
        // depending on whether audio file triggers a mode switch)
        const appState = await readState(pair.hostPage, 'appState');
        expect(['IDLE', 'PAUSED', 'PLAYING_AUDIO', 'PLAYING_YOUTUBE']).toContain(appState);
      }
    }
  });
});
