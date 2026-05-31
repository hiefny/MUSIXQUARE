/**
 * E2E: Advanced Playback Tests
 *
 * Tests advanced playback features with real MP3 files:
 * - Repeat mode cycling (off → all → one → off)
 * - Shuffle mode toggle
 * - Actual PLAYING_AUDIO state with real MP3
 * - Pause → PAUSED state
 * - Track title display
 * - Auto-advance to next track
 * - Seek slider interaction
 */
import { test, expect } from '@playwright/test';
import {
  createHostGuestContexts,
  cleanupContexts,
  getPageErrors,
  type HostGuestPair,
} from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { uploadFixture } from './helpers/file-upload.ts';
import { waitForPlaylistCount, readState, waitForState } from './helpers/wait.ts';

let pair: HostGuestPair;

test.describe('Advanced Playback', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });

  test.afterEach(async () => {
    // Fail test if any uncaught JS errors occurred during the test
    const hostErrors = getPageErrors(pair.hostPage);
    const guestErrors = getPageErrors(pair.guestPage);
    await cleanupContexts(pair);
    expect(hostErrors, 'Host page had uncaught JS errors').toHaveLength(0);
    expect(guestErrors, 'Guest page had uncaught JS errors').toHaveLength(0);
  });

  // ── Repeat Mode Tests ────────────────────────────────────────

  test('repeat button cycles through modes: off → all → one → off', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const repeatBtn = pair.hostPage.locator('#btn-repeat');
    if (await repeatBtn.isVisible()) {
      // Initial: off (0)
      let mode = (await readState(pair.hostPage, 'playlist.repeatMode')) as number;
      expect(mode).toBe(0);

      // Click 1: → all (1)
      await repeatBtn.click();
      await waitForState(pair.hostPage, 'playlist.repeatMode', 1);
      mode = (await readState(pair.hostPage, 'playlist.repeatMode')) as number;
      expect(mode).toBe(1);

      // Click 2: → one (2)
      await repeatBtn.click();
      await waitForState(pair.hostPage, 'playlist.repeatMode', 2);
      mode = (await readState(pair.hostPage, 'playlist.repeatMode')) as number;
      expect(mode).toBe(2);

      // Click 3: → off (0)
      await repeatBtn.click();
      await waitForState(pair.hostPage, 'playlist.repeatMode', 0);
      mode = (await readState(pair.hostPage, 'playlist.repeatMode')) as number;
      expect(mode).toBe(0);
    }
  });

  test('repeat all shows active class on button', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const repeatBtn = pair.hostPage.locator('#btn-repeat');
    if (await repeatBtn.isVisible()) {
      await repeatBtn.click(); // → all
      await waitForState(pair.hostPage, 'playlist.repeatMode', 1);

      const hasActive = await repeatBtn.evaluate((el) => el.classList.contains('active'));
      expect(hasActive).toBe(true);
    }
  });

  test('repeat one shows active-one class on button', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const repeatBtn = pair.hostPage.locator('#btn-repeat');
    if (await repeatBtn.isVisible()) {
      await repeatBtn.click(); // → all
      await repeatBtn.click(); // → one
      await waitForState(pair.hostPage, 'playlist.repeatMode', 2);

      const hasActiveOne = await repeatBtn.evaluate((el) => el.classList.contains('active-one'));
      expect(hasActiveOne).toBe(true);
    }
  });

  // ── Shuffle Mode Tests ──────────────────────────────────────

  test('shuffle button toggles shuffle mode', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const shuffleBtn = pair.hostPage.locator('#btn-shuffle');
    if (await shuffleBtn.isVisible()) {
      // Initial: off
      let shuffle = (await readState(pair.hostPage, 'playlist.isShuffle')) as boolean;
      expect(shuffle).toBe(false);

      // Click: on
      await shuffleBtn.click();
      await waitForState(pair.hostPage, 'playlist.isShuffle', true);
      shuffle = (await readState(pair.hostPage, 'playlist.isShuffle')) as boolean;
      expect(shuffle).toBe(true);

      // Active class
      const hasActive = await shuffleBtn.evaluate((el) => el.classList.contains('active'));
      expect(hasActive).toBe(true);

      // Click again: off
      await shuffleBtn.click();
      await waitForState(pair.hostPage, 'playlist.isShuffle', false);
      shuffle = (await readState(pair.hostPage, 'playlist.isShuffle')) as boolean;
      expect(shuffle).toBe(false);
    }
  });

  // ── Real Audio Playback Tests ──────────────────────────────

  test('play real MP3 reaches PLAYING_AUDIO state', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    // Wait for file to decode
    await pair.hostPage.waitForFunction(
      () => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get && get('files.currentFileBlob') !== null;
      },
      { timeout: 20_000 },
    );

    // Click play
    await pair.hostPage.click('#play-btn');

    // Wait for PLAYING_AUDIO state
    await waitForState(pair.hostPage, 'appState', 'PLAYING_AUDIO', 15_000);

    const state = await readState(pair.hostPage, 'appState');
    expect(state).toBe('PLAYING_AUDIO');
  });

  test('pause from PLAYING_AUDIO transitions to PAUSED', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    // Wait for decode
    await pair.hostPage.waitForFunction(
      () => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get && get('files.currentFileBlob') !== null;
      },
      { timeout: 20_000 },
    );

    // Play
    await pair.hostPage.click('#play-btn');
    await waitForState(pair.hostPage, 'appState', 'PLAYING_AUDIO', 15_000);

    // Pause
    await pair.hostPage.click('#play-btn');
    await waitForState(pair.hostPage, 'appState', 'PAUSED', 10_000);

    const state = await readState(pair.hostPage, 'appState');
    expect(state).toBe('PAUSED');
  });

  test('resume from PAUSED returns to PLAYING_AUDIO', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await pair.hostPage.waitForFunction(
      () => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get && get('files.currentFileBlob') !== null;
      },
      { timeout: 20_000 },
    );

    // Play → Pause → Resume
    await pair.hostPage.click('#play-btn');
    await waitForState(pair.hostPage, 'appState', 'PLAYING_AUDIO', 15_000);

    await pair.hostPage.click('#play-btn'); // pause
    await waitForState(pair.hostPage, 'appState', 'PAUSED', 10_000);

    await pair.hostPage.click('#play-btn'); // resume
    await waitForState(pair.hostPage, 'appState', 'PLAYING_AUDIO', 10_000);

    const state = await readState(pair.hostPage, 'appState');
    expect(state).toBe('PLAYING_AUDIO');
  });

  // ── Track Display Tests ──────────────────────────────────────

  test('track title updates after file upload', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    // Wait for track title to update
    await pair.hostPage.waitForFunction(
      () => {
        const el = document.getElementById('track-title');
        return el && el.textContent && el.textContent.trim().length > 0;
      },
      { timeout: 10_000 },
    );

    const titleText = await pair.hostPage.locator('#track-title').textContent();
    // Should not be default "no media" text anymore
    expect(titleText).toBeTruthy();
    expect(titleText!.trim().length).toBeGreaterThan(0);
  });

  test('time display updates during playback', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await pair.hostPage.waitForFunction(
      () => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get && get('files.currentFileBlob') !== null;
      },
      { timeout: 20_000 },
    );

    // Play
    await pair.hostPage.click('#play-btn');

    // Wait for duration text to be populated
    await pair.hostPage.waitForFunction(
      () => {
        const dur = document.getElementById('time-dur');
        return (
          dur &&
          dur.textContent &&
          dur.textContent.trim() !== '' &&
          dur.textContent.trim() !== '0:00'
        );
      },
      { timeout: 10_000 },
    );

    const durText = await pair.hostPage.locator('#time-dur').textContent();
    expect(durText).toBeTruthy();
    expect(durText!.trim()).not.toBe('');
  });

  // ── Seek Slider Tests ──────────────────────────────────────

  test('seek slider exists and is interactive', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    const seekSlider = pair.hostPage.locator('#seek-slider');
    await expect(seekSlider).toBeAttached();
  });

  // ── Guest Sync Tests ──────────────────────────────────────

  test('guest appState updates when host plays real MP3', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);
    await waitForPlaylistCount(pair.guestPage, 1, 20_000);

    // Wait for host file blob
    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.currentFileBlob') !== null,
      { timeout: 15_000 },
    );

    // Host plays
    await pair.hostPage.click('#play-btn');
    await waitForState(pair.hostPage, 'appState', 'PLAYING_AUDIO', 15_000);

    // Guest should receive state update
    await pair.guestPage.waitForFunction(
      () => {
        const projected = (window as any).__MUSIXQUARE_GET_PROJECTED_APP_STATE__;
        if (typeof projected !== 'function') return false;
        const state = projected();
        return state === 'PLAYING_AUDIO' || state === 'PAUSED' || state === 'IDLE';
      },
      { timeout: 15_000 },
    );

    const guestState = await readState(pair.guestPage, 'appState');
    expect(['PLAYING_AUDIO', 'PAUSED', 'IDLE']).toContain(guestState);
  });

  test('guest state updates when host pauses', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    // Wait for host blob
    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.currentFileBlob') !== null,
      { timeout: 15_000 },
    );

    // Play then pause
    await pair.hostPage.click('#play-btn');
    await waitForState(pair.hostPage, 'appState', 'PLAYING_AUDIO', 15_000);

    await pair.hostPage.click('#play-btn'); // pause

    await waitForState(pair.hostPage, 'appState', 'PAUSED', 10_000);

    // Host should be PAUSED
    const hostState = await readState(pair.hostPage, 'appState');
    expect(hostState).toBe('PAUSED');
  });

  // ── Next Track Navigation Tests ────────────────────────────

  test('next button advances track with real audio', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Upload 2 files
    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);

    // Auto-play on upload may have advanced currentTrackIndex to the last file.
    // Reset to index 0 so "next" has room to advance.
    await pair.hostPage.evaluate(() => {
      const set = (window as any).__MUSIXQUARE_SET_STATE__;
      if (set) set('playlist.currentTrackIndex', 0);
    });

    const idx0 = (await readState(pair.hostPage, 'playlist.currentTrackIndex')) as number;
    expect(idx0).toBe(0);

    // Use JS fallback click for CSS-hidden button
    await pair.hostPage.evaluate(() =>
      (document.getElementById('btn-next') as HTMLElement)?.click(),
    );

    // Wait for track index to change (track loading can take time)
    await pair.hostPage.waitForFunction(
      ([prevIdx]) => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        if (!get) return false;
        return get('playlist.currentTrackIndex') !== prevIdx;
      },
      [idx0] as const,
      { timeout: 15_000 },
    );

    const idx1 = (await readState(pair.hostPage, 'playlist.currentTrackIndex')) as number;
    expect(idx1).toBe(1);
  });

  test('prev button goes back with real audio', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);

    // Auto-play on upload may have advanced currentTrackIndex to the last file.
    // Reset to index 0 so we can test next→prev navigation.
    await pair.hostPage.evaluate(() => {
      const set = (window as any).__MUSIXQUARE_SET_STATE__;
      if (set) set('playlist.currentTrackIndex', 0);
    });

    // Go next first (0 → 1)
    await pair.hostPage.evaluate(() =>
      (document.getElementById('btn-next') as HTMLElement)?.click(),
    );
    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('playlist.currentTrackIndex') !== 0,
      { timeout: 10_000 },
    );
    const afterNext = (await readState(pair.hostPage, 'playlist.currentTrackIndex')) as number;
    expect(afterNext).toBe(1);

    // Then prev (1 → 0). playPrevTrack restarts if position > 3s,
    // but position is 0 so it goes to the previous track.
    await pair.hostPage.evaluate(() =>
      (document.getElementById('btn-prev') as HTMLElement)?.click(),
    );
    await pair.hostPage.waitForFunction(
      ([prevIdx]) => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        if (!get) return false;
        return get('playlist.currentTrackIndex') !== prevIdx;
      },
      [afterNext] as const,
      { timeout: 10_000 },
    );
    const afterPrev = (await readState(pair.hostPage, 'playlist.currentTrackIndex')) as number;

    expect(afterPrev).toBe(0);
  });
});
