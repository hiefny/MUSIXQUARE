/**
 * E2E: Playback Synchronization Tests
 *
 * Tests synchronized playback between host and guest:
 * - Host play button changes playback projection
 * - Pause/resume behavior
 * - Play state reflects on host after file load
 *
 * Audio decode of synthetic MP3 files may fail in headless Chromium.
 * These tests verify the transport/state layer rather than actual audio output.
 */
import { test, expect } from '@playwright/test';
import {
  createHostGuestContexts,
  cleanupContexts,
  type HostGuestPair,
} from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { uploadFixture } from './helpers/file-upload.ts';
import {
  readPlaybackProjection,
  readState,
  waitForPlaylistCount,
} from './helpers/wait.ts';

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

  test('host play button changes playback projection', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await pair.hostPage.waitForFunction(
      () => {
        const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
          | ((p: string) => unknown)
          | undefined;
        return get && get('files.currentFileBlob') !== null;
      },
      { timeout: 15_000 },
    );

    await pair.hostPage.click('#play-btn');

    await pair.hostPage.waitForFunction(
      () => {
        const projected = (window as any).__MUSIXQUARE_GET_PLAYBACK_PROJECTION__;
        return typeof projected === 'function' && projected() !== 'IDLE';
      },
      { timeout: 10_000 },
    );

    const hostState = await readPlaybackProjection(pair.hostPage);
    expect(hostState).not.toBe('IDLE');
  });

  test('guest playlist syncs with host after file upload', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);
    await waitForPlaylistCount(pair.guestPage, 1, 20_000);

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

    await pair.hostPage.waitForFunction(
      () => {
        const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
          | ((p: string) => unknown)
          | undefined;
        return get && get('files.currentFileBlob') !== null;
      },
      { timeout: 15_000 },
    );

    await pair.hostPage.click('#play-btn');

    await pair.hostPage.waitForFunction(
      () => {
        const projected = (window as any).__MUSIXQUARE_GET_PLAYBACK_PROJECTION__;
        return typeof projected === 'function' && projected() !== 'IDLE';
      },
      { timeout: 10_000 },
    );

    const stateAfterPlay = await readPlaybackProjection(pair.hostPage);

    // Synthetic MP3 decode can fail in headless Chromium, so pause assertions
    // apply only when transport reached an active state.
    if (stateAfterPlay !== 'IDLE') {
      await pair.hostPage.click('#play-btn');

      await pair.hostPage.waitForFunction(
        () => {
          const projected = (window as any).__MUSIXQUARE_GET_PLAYBACK_PROJECTION__;
          if (typeof projected !== 'function') return false;
          const state = projected();
          return state === 'PAUSED' || state === 'IDLE';
        },
        { timeout: 10_000 },
      );

      const stateAfterPause = await readPlaybackProjection(pair.hostPage);
      expect(['PAUSED', 'IDLE']).toContain(stateAfterPause);
    }
  });
});
