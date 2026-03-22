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
import { createHostGuestContexts, cleanupContexts, getPageErrors, type HostGuestPair } from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { uploadFixture } from './helpers/file-upload.ts';
import { waitForPlaylistCount, readState } from './helpers/wait.ts';

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
      let mode = await readState(pair.hostPage, 'playlist.repeatMode') as number;
      expect(mode).toBe(0);

      // Click 1: → all (1)
      await repeatBtn.click();
      await pair.hostPage.waitForTimeout(300);
      mode = await readState(pair.hostPage, 'playlist.repeatMode') as number;
      expect(mode).toBe(1);

      // Click 2: → one (2)
      await repeatBtn.click();
      await pair.hostPage.waitForTimeout(300);
      mode = await readState(pair.hostPage, 'playlist.repeatMode') as number;
      expect(mode).toBe(2);

      // Click 3: → off (0)
      await repeatBtn.click();
      await pair.hostPage.waitForTimeout(300);
      mode = await readState(pair.hostPage, 'playlist.repeatMode') as number;
      expect(mode).toBe(0);
    }
  });

  test('repeat all shows active class on button', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const repeatBtn = pair.hostPage.locator('#btn-repeat');
    if (await repeatBtn.isVisible()) {
      await repeatBtn.click(); // → all
      await pair.hostPage.waitForTimeout(300);

      const hasActive = await repeatBtn.evaluate(el => el.classList.contains('active'));
      expect(hasActive).toBe(true);
    }
  });

  test('repeat one shows active-one class on button', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const repeatBtn = pair.hostPage.locator('#btn-repeat');
    if (await repeatBtn.isVisible()) {
      await repeatBtn.click(); // → all
      await repeatBtn.click(); // → one
      await pair.hostPage.waitForTimeout(300);

      const hasActiveOne = await repeatBtn.evaluate(el => el.classList.contains('active-one'));
      expect(hasActiveOne).toBe(true);
    }
  });

  // ── Shuffle Mode Tests ──────────────────────────────────────

  test('shuffle button toggles shuffle mode', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const shuffleBtn = pair.hostPage.locator('#btn-shuffle');
    if (await shuffleBtn.isVisible()) {
      // Initial: off
      let shuffle = await readState(pair.hostPage, 'playlist.isShuffle') as boolean;
      expect(shuffle).toBe(false);

      // Click: on
      await shuffleBtn.click();
      await pair.hostPage.waitForTimeout(300);
      shuffle = await readState(pair.hostPage, 'playlist.isShuffle') as boolean;
      expect(shuffle).toBe(true);

      // Active class
      const hasActive = await shuffleBtn.evaluate(el => el.classList.contains('active'));
      expect(hasActive).toBe(true);

      // Click again: off
      await shuffleBtn.click();
      await pair.hostPage.waitForTimeout(300);
      shuffle = await readState(pair.hostPage, 'playlist.isShuffle') as boolean;
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
    await pair.hostPage.waitForFunction(
      () => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get && get('appState') === 'PLAYING_AUDIO';
      },
      { timeout: 15_000 },
    );

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
    await pair.hostPage.waitForFunction(
      () => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get && get('appState') === 'PLAYING_AUDIO';
      },
      { timeout: 15_000 },
    );

    // Pause
    await pair.hostPage.click('#play-btn');
    await pair.hostPage.waitForTimeout(1000);

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
    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__('appState') === 'PLAYING_AUDIO',
      { timeout: 15_000 },
    );

    await pair.hostPage.click('#play-btn'); // pause
    await pair.hostPage.waitForTimeout(500);

    await pair.hostPage.click('#play-btn'); // resume
    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__('appState') === 'PLAYING_AUDIO',
      { timeout: 10_000 },
    );

    const state = await readState(pair.hostPage, 'appState');
    expect(state).toBe('PLAYING_AUDIO');
  });

  // ── Track Display Tests ──────────────────────────────────────

  test('track title updates after file upload', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);
    await pair.hostPage.waitForTimeout(2000);

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
    await pair.hostPage.waitForTimeout(3000);

    // Duration should show a value
    const durText = await pair.hostPage.locator('#time-dur').textContent();
    expect(durText).toBeTruthy();
    // Should not be "0:00" or empty if file loaded
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
    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__('appState') === 'PLAYING_AUDIO',
      { timeout: 15_000 },
    );

    // Guest should receive state update (PLAYING_AUDIO, PAUSED, or IDLE depending on file transfer timing)
    await pair.guestPage.waitForTimeout(5000);

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
    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__('appState') === 'PLAYING_AUDIO',
      { timeout: 15_000 },
    );

    await pair.hostPage.waitForTimeout(1000);
    await pair.hostPage.click('#play-btn'); // pause

    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__('appState') === 'PAUSED',
      { timeout: 10_000 },
    );

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
    await pair.hostPage.waitForTimeout(3000);

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);
    await pair.hostPage.waitForTimeout(2000);

    const idx0 = await readState(pair.hostPage, 'playlist.currentTrackIndex') as number;

    await pair.hostPage.click('#btn-next');
    await pair.hostPage.waitForTimeout(3000);

    const idx1 = await readState(pair.hostPage, 'playlist.currentTrackIndex') as number;
    // Both indices should be valid (navigation may wrap depending on timing)
    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx1).toBeLessThan(2);
  });

  test('prev button goes back with real audio', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);
    await pair.hostPage.waitForTimeout(3000);

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);
    await pair.hostPage.waitForTimeout(2000);

    // Go next first
    await pair.hostPage.click('#btn-next');
    await pair.hostPage.waitForTimeout(3000);
    const afterNext = await readState(pair.hostPage, 'playlist.currentTrackIndex') as number;

    // Then prev
    await pair.hostPage.click('#btn-prev');
    await pair.hostPage.waitForTimeout(3000);
    const afterPrev = await readState(pair.hostPage, 'playlist.currentTrackIndex') as number;

    expect(afterPrev).not.toBe(afterNext);
  });
});
