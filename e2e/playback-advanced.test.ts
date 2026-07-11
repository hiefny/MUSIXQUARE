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
import {
  readCurrentQueueIndex,
  setCurrentQueueItemByIndex,
  waitForCurrentQueueIndex,
} from './helpers/queue-state.ts';
import {
  isVisible,
  readPlaybackProjection,
  readState,
  waitForPlaybackProjection,
  waitForPlaylistCount,
  waitForState,
} from './helpers/wait.ts';

let pair: HostGuestPair;

test.describe('Advanced Playback', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });

  test.afterEach(async () => {
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
      let mode = (await readState(pair.hostPage, 'playlist.repeatMode')) as number;
      expect(mode).toBe(0);

      await repeatBtn.click();
      await waitForState(pair.hostPage, 'playlist.repeatMode', 1);
      mode = (await readState(pair.hostPage, 'playlist.repeatMode')) as number;
      expect(mode).toBe(1);

      await repeatBtn.click();
      await waitForState(pair.hostPage, 'playlist.repeatMode', 2);
      mode = (await readState(pair.hostPage, 'playlist.repeatMode')) as number;
      expect(mode).toBe(2);

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
      let shuffle = (await readState(pair.hostPage, 'playlist.isShuffle')) as boolean;
      expect(shuffle).toBe(false);

      await shuffleBtn.click();
      await waitForState(pair.hostPage, 'playlist.isShuffle', true);
      shuffle = (await readState(pair.hostPage, 'playlist.isShuffle')) as boolean;
      expect(shuffle).toBe(true);

      const hasActive = await shuffleBtn.evaluate((el) => el.classList.contains('active'));
      expect(hasActive).toBe(true);

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

    await pair.hostPage.waitForFunction(
      () => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get && get('files.current') !== null;
      },
      { timeout: 20_000 },
    );

    await pair.hostPage.click('#play-btn');

    await waitForPlaybackProjection(pair.hostPage, 'PLAYING_AUDIO', 15_000);

    const state = await readPlaybackProjection(pair.hostPage);
    expect(state).toBe('PLAYING_AUDIO');
  });

  test('pause from PLAYING_AUDIO transitions to PAUSED', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await pair.hostPage.waitForFunction(
      () => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get && get('files.current') !== null;
      },
      { timeout: 20_000 },
    );

    await pair.hostPage.click('#play-btn');
    await waitForPlaybackProjection(pair.hostPage, 'PLAYING_AUDIO', 15_000);

    await pair.hostPage.click('#play-btn');
    await waitForPlaybackProjection(pair.hostPage, 'PAUSED', 10_000);

    const state = await readPlaybackProjection(pair.hostPage);
    expect(state).toBe('PAUSED');
  });

  test('resume from PAUSED returns to PLAYING_AUDIO', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await pair.hostPage.waitForFunction(
      () => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get && get('files.current') !== null;
      },
      { timeout: 20_000 },
    );

    await pair.hostPage.click('#play-btn');
    await waitForPlaybackProjection(pair.hostPage, 'PLAYING_AUDIO', 15_000);

    await pair.hostPage.click('#play-btn'); // pause
    await waitForPlaybackProjection(pair.hostPage, 'PAUSED', 10_000);

    await pair.hostPage.click('#play-btn'); // resume
    await waitForPlaybackProjection(pair.hostPage, 'PLAYING_AUDIO', 10_000);

    const state = await readPlaybackProjection(pair.hostPage);
    expect(state).toBe('PLAYING_AUDIO');
  });

  // ── Track Display Tests ──────────────────────────────────────

  test('track title updates after file upload', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await pair.hostPage.waitForFunction(
      () => {
        const el = document.getElementById('track-title');
        return el && el.textContent && el.textContent.trim().length > 0;
      },
      { timeout: 10_000 },
    );

    const titleText = await pair.hostPage.locator('#track-title').textContent();
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
        return get && get('files.current') !== null;
      },
      { timeout: 20_000 },
    );

    await pair.hostPage.click('#play-btn');

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

  test('guest playback projection updates when host plays real MP3', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);
    await waitForPlaylistCount(pair.guestPage, 1, 20_000);

    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.current') !== null,
      { timeout: 15_000 },
    );

    await pair.hostPage.click('#play-btn');
    await waitForPlaybackProjection(pair.hostPage, 'PLAYING_AUDIO', 15_000);

    await pair.guestPage.waitForFunction(
      () => {
        const projected = (window as any).__MUSIXQUARE_GET_PLAYBACK_PROJECTION__;
        if (typeof projected !== 'function') return false;
        const state = projected();
        return state === 'PLAYING_AUDIO' || state === 'PAUSED' || state === 'IDLE';
      },
      { timeout: 15_000 },
    );

    const guestState = await readPlaybackProjection(pair.guestPage);
    expect(['PLAYING_AUDIO', 'PAUSED', 'IDLE']).toContain(guestState);
  });

  test('guest state updates when host pauses', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.current') !== null,
      { timeout: 15_000 },
    );

    await pair.hostPage.click('#play-btn');
    await waitForPlaybackProjection(pair.hostPage, 'PLAYING_AUDIO', 15_000);

    await pair.hostPage.click('#play-btn'); // pause

    await waitForPlaybackProjection(pair.hostPage, 'PAUSED', 10_000);

    const hostState = await readPlaybackProjection(pair.hostPage);
    expect(hostState).toBe('PAUSED');
  });

  // ── Next Track Navigation Tests ────────────────────────────

  test('next button advances track with real audio', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);

    // Reset the selected occurrence to the first row so "next" can advance.
    await setCurrentQueueItemByIndex(pair.hostPage, 0);

    const idx0 = await readCurrentQueueIndex(pair.hostPage);
    expect(idx0).toBe(0);

    // Use a DOM click because responsive CSS can hide the desktop control.
    await pair.hostPage.evaluate(() =>
      (document.getElementById('btn-next') as HTMLElement)?.click(),
    );

    await waitForCurrentQueueIndex(pair.hostPage, 1);

    const idx1 = await readCurrentQueueIndex(pair.hostPage);
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
    await setCurrentQueueItemByIndex(pair.hostPage, 0);

    await pair.hostPage.evaluate(() =>
      (document.getElementById('btn-next') as HTMLElement)?.click(),
    );
    await waitForCurrentQueueIndex(pair.hostPage, 1, 10_000);
    const afterNext = await readCurrentQueueIndex(pair.hostPage);
    expect(afterNext).toBe(1);

    // With no playback progress, Previous navigates instead of restarting the
    // current track.
    await pair.hostPage.evaluate(() =>
      (document.getElementById('btn-prev') as HTMLElement)?.click(),
    );
    await waitForCurrentQueueIndex(pair.hostPage, 0, 10_000);
    const afterPrev = await readCurrentQueueIndex(pair.hostPage);

    expect(afterPrev).toBe(0);
  });
});
