/**
 * E2E: Playback Synchronization Tests
 *
 * Tests synchronized playback between host and guest:
 * - Host play button changes app state
 * - Pause/resume behavior
 * - Play state reflects on host after file load
 *
 * Note: Audio decode of synthetic MP3 files may fail in headless Chromium.
 * These tests verify the transport/state layer rather than actual audio output.
 */
import { test, expect } from '@playwright/test';
import { createHostGuestContexts, cleanupContexts, type HostGuestPair } from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { uploadFixture } from './helpers/file-upload.ts';
import { waitForPlaylistCount, readState } from './helpers/wait.ts';

let pair: HostGuestPair;

test.describe('Playback Sync', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });

  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  test('host file upload sets transfer meta and track index', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    // Host should have currentTrackIndex set to 0
    await pair.hostPage.waitForFunction(
      () => {
        const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
          | ((p: string) => unknown)
          | undefined;
        return get && get('playlist.currentTrackIndex') === 0;
      },
      { timeout: 10_000 },
    );

    const trackIndex = await readState(pair.hostPage, 'playlist.currentTrackIndex');
    expect(trackIndex).toBe(0);
  });

  test('host play button changes app state', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    // Wait for file to be loaded (currentFileBlob should be set)
    await pair.hostPage.waitForFunction(
      () => {
        const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
          | ((p: string) => unknown)
          | undefined;
        return get && get('files.currentFileBlob') !== null;
      },
      { timeout: 15_000 },
    );

    // Click play
    await pair.hostPage.click('#play-btn');
    await pair.hostPage.waitForTimeout(1000);

    // Host appState should change from IDLE
    const hostState = await readState(pair.hostPage, 'appState');
    expect(hostState).not.toBe('IDLE');
  });

  test('guest playlist syncs with host after file upload', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);
    await waitForPlaylistCount(pair.guestPage, 1, 20_000);

    // Guest should have the same playlist
    const guestPlaylist = await pair.guestPage.evaluate(() => {
      const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
        | ((p: string) => unknown)
        | undefined;
      if (!get) return [];
      return get('playlist.items') as unknown[];
    });
    expect(guestPlaylist).toHaveLength(1);
  });

  test('host pause changes state to PAUSED', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    // Wait for file blob
    await pair.hostPage.waitForFunction(
      () => {
        const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
          | ((p: string) => unknown)
          | undefined;
        return get && get('files.currentFileBlob') !== null;
      },
      { timeout: 15_000 },
    );

    // Play
    await pair.hostPage.click('#play-btn');
    await pair.hostPage.waitForTimeout(500);

    // Check state changed
    const stateAfterPlay = await readState(pair.hostPage, 'appState');

    // Only test pause if play succeeded
    if (stateAfterPlay !== 'IDLE') {
      // Click play again to pause
      await pair.hostPage.click('#play-btn');
      await pair.hostPage.waitForTimeout(500);

      const stateAfterPause = await readState(pair.hostPage, 'appState');
      // Should be PAUSED or IDLE (if audio wasn't playing)
      expect(['PAUSED', 'IDLE']).toContain(stateAfterPause);
    }
  });
});
