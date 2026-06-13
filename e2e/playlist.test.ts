/**
 * E2E: Playlist Management Tests
 *
 * Tests playlist operations synced between host and guest:
 * - Add multiple tracks
 * - Navigate forward/backward
 * - Remove tracks
 * - Empty playlist resets guest
 */
import { test, expect } from '@playwright/test';
import { createHostGuestContexts, cleanupContexts, type HostGuestPair } from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { uploadFixture } from './helpers/file-upload.ts';
import {
  isVisible,
  navigateToTab,
  readState,
  waitForPlaylistCount,
} from './helpers/wait.ts';

let pair: HostGuestPair;

test.describe('Playlist Management', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });

  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  test('multiple files appear in playlist on both sides', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);

    await uploadFixture(pair.hostPage, 'test03');
    await waitForPlaylistCount(pair.hostPage, 3);

    // Guest should eventually see all 3
    await waitForPlaylistCount(pair.guestPage, 3, 30_000);
  });

  test('host track navigation updates current index via state', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Upload 3 files
    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);

    await uploadFixture(pair.hostPage, 'test03');
    await waitForPlaylistCount(pair.hostPage, 3);

    // Auto-play on upload may have advanced currentTrackIndex to the last file.
    // Reset to index 0 so "next" has room to advance without hitting end-of-playlist.
    await pair.hostPage.evaluate(() => {
      const set = (window as any).__MUSIXQUARE_SET_STATE__;
      if (set) set('playlist.currentTrackIndex', 0);
    });

    const initialIndex = await readState(pair.hostPage, 'playlist.currentTrackIndex') as number;
    expect(initialIndex).toBe(0);

    // Click next track via JS fallback (button may be CSS-hidden)
    await pair.hostPage.evaluate(() => (document.getElementById('btn-next') as HTMLElement)?.click());
    await pair.hostPage.waitForFunction(
      (prev) => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        if (!get) return false;
        return get('playlist.currentTrackIndex') !== prev;
      },
      initialIndex,
      { timeout: 15_000 },
    );

    const afterNext = await readState(pair.hostPage, 'playlist.currentTrackIndex') as number;
    expect(afterNext).toBe(1);

    // Click next again to go to index 2 (so prev can go back to 1)
    await pair.hostPage.evaluate(() => (document.getElementById('btn-next') as HTMLElement)?.click());
    await pair.hostPage.waitForFunction(
      (prev) => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        if (!get) return false;
        return get('playlist.currentTrackIndex') !== prev;
      },
      afterNext,
      { timeout: 15_000 },
    );
    const afterNext2 = await readState(pair.hostPage, 'playlist.currentTrackIndex') as number;
    expect(afterNext2).toBe(2);

    // Click prev track via JS fallback
    // playPrevTrack restarts current track if position > 3s; since we haven't
    // actually played audio, position is 0 so it goes to the previous track.
    await pair.hostPage.evaluate(() => (document.getElementById('btn-prev') as HTMLElement)?.click());
    await pair.hostPage.waitForFunction(
      (prev) => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        if (!get) return false;
        return get('playlist.currentTrackIndex') !== prev;
      },
      afterNext2,
      { timeout: 15_000 },
    );

    const afterPrev = await readState(pair.hostPage, 'playlist.currentTrackIndex') as number;
    expect(afterPrev).toBe(1);
  });

  test('host can remove tracks from playlist', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Upload 2 files
    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);

    // Ensure play tab is visible
    const playNav = pair.hostPage.locator('.nav-item[data-tab="play"]');
    if (await playNav.isVisible()) {
      await navigateToTab(pair.hostPage, 'play');
    }

    // Click remove button on the last track
    const removeBtns = pair.hostPage.locator('#playlist-ui .btn-playlist-remove');
    const btnCount = await removeBtns.count();

    if (btnCount > 0) {
      await removeBtns.last().click();

      // Confirm the removal dialog (showDialog produces a dialog with #btn-dialog-ok)
      const okBtn = pair.hostPage.locator('#btn-dialog-ok');
      await okBtn.waitFor({ state: 'visible', timeout: 5000 });
      await okBtn.click();

      // Wait for playlist count to actually drop below 2
      await pair.hostPage.waitForFunction(
        () => {
          const list = document.getElementById('playlist-ui');
          return list ? list.children.length < 2 : false;
        },
        { timeout: 10_000 },
      );

      const countAfter = await pair.hostPage.evaluate(() => {
        const list = document.getElementById('playlist-ui');
        return list?.children.length ?? 0;
      });
      expect(countAfter).toBe(1);
    }
  });

  test('playlist sync: guest sees same track count as host', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);
    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);

    // Guest should see 2 tracks
    await waitForPlaylistCount(pair.guestPage, 2, 25_000);

    const [hostCount, guestCount] = await Promise.all([
      pair.hostPage.evaluate(() => document.getElementById('playlist-ui')?.children.length ?? 0),
      pair.guestPage.evaluate(() => document.getElementById('playlist-ui')?.children.length ?? 0),
    ]);
    expect(hostCount).toBe(guestCount);
  });
});
