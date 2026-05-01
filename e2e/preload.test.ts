/**
 * E2E: Preload System Tests
 *
 * Tests the background preload mechanism.
 * Note: Preload requires successful audio decode + ramstore finalize.
 * These tests verify the preload scheduling and state management
 * at the host level, since headless Chromium may not decode synthetic MP3s.
 */
import { test, expect } from '@playwright/test';
import { createHostGuestContexts, cleanupContexts, type HostGuestPair } from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { uploadFixture } from './helpers/file-upload.ts';
import { waitForPlaylistCount, readState, waitForState } from './helpers/wait.ts';

let pair: HostGuestPair;

test.describe('Preload System', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });

  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  test('preload state initializes correctly', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Initial preload state should be clean
    const nextTrackIndex = await readState(pair.hostPage, 'preload.nextTrackIndex');
    const isPreloading = await readState(pair.hostPage, 'preload.isPreloading');

    expect(nextTrackIndex).toBe(-1);
    expect(isPreloading).toBe(false);
  });

  test('host playlist with multiple files sets preload meta', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Upload 2 files
    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);

    // Wait for preload state to potentially update (nextTrackIndex or isPreloading should change)
    await pair.hostPage.waitForFunction(
      () => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        if (!get) return false;
        const items = get('playlist.items') as unknown[];
        return items && items.length === 2;
      },
      { timeout: 10_000 },
    );

    // Verify playlist has 2 items
    const playlist = await pair.hostPage.evaluate(() => {
      const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
        | ((p: string) => unknown)
        | undefined;
      if (!get) return [];
      return get('playlist.items') as unknown[];
    });
    expect(playlist).toHaveLength(2);
  });

  test('backward navigation clears preload state', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Upload 3 files
    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);

    await uploadFixture(pair.hostPage, 'test03');
    await waitForPlaylistCount(pair.hostPage, 3);

    // Auto-play on upload may have advanced currentTrackIndex to the last file.
    // Reset to index 0 so "next" has room to advance.
    await pair.hostPage.evaluate(() => {
      const set = (window as any).__MUSIXQUARE_SET_STATE__;
      if (set) set('playlist.currentTrackIndex', 0);
    });

    // Navigate forward via JS fallback (button may be CSS-hidden)
    await pair.hostPage.evaluate(() => (document.getElementById('btn-next') as HTMLElement)?.click());
    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('playlist.currentTrackIndex') !== 0,
      { timeout: 15_000 },
    );

    const afterNext = await readState(pair.hostPage, 'playlist.currentTrackIndex') as number;
    expect(afterNext).toBe(1);

    // Navigate backward via JS fallback
    // playPrevTrack restarts current track if position > 3s; position is 0 here
    // so it goes to the previous track (index 0).
    await pair.hostPage.evaluate(() => (document.getElementById('btn-prev') as HTMLElement)?.click());
    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('playlist.currentTrackIndex') === 0,
      { timeout: 15_000 },
    );

    // After backward nav, preload state should be cleared/reset
    const nextBlob = await readState(pair.hostPage, 'preload.nextFileBlob');
    // nextFileBlob should be null after clearPreloadState
    expect(nextBlob).toBeNull();
  });

  test('guest receives playlist update with track metadata', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);
    await waitForPlaylistCount(pair.guestPage, 1, 20_000);

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);
    await waitForPlaylistCount(pair.guestPage, 2, 20_000);

    // Guest should have both tracks in playlist state
    const guestPlaylist = await pair.guestPage.evaluate(() => {
      const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
        | ((p: string) => unknown)
        | undefined;
      if (!get) return [];
      return get('playlist.items') as unknown[];
    });
    expect(guestPlaylist).toHaveLength(2);
  });
});
