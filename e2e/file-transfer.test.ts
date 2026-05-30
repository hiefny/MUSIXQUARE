/**
 * E2E: File Transfer Tests
 *
 * Tests file upload and transfer from host to guest:
 * - Host uploads a file → guest receives it
 * - Playlist updates propagate to guest
 * - Transfer state transitions
 */
import { test, expect } from '@playwright/test';
import { createHostGuestContexts, cleanupContexts, type HostGuestPair } from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { uploadFixture } from './helpers/file-upload.ts';
import { waitForPlaylistCount, readState } from './helpers/wait.ts';

let pair: HostGuestPair;

test.describe('File Transfer', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });

  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  test('host uploads file and it appears in playlist', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Upload a file on host
    await uploadFixture(pair.hostPage, 'test01');

    // Wait for playlist to have 1 item on host
    await waitForPlaylistCount(pair.hostPage, 1);

    const hostPlaylistCount = await pair.hostPage.evaluate(() => {
      const list = document.getElementById('playlist-ui');
      return list?.children.length ?? 0;
    });
    expect(hostPlaylistCount).toBeGreaterThanOrEqual(1);
  });

  test('guest receives file after host uploads', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Upload file on host
    await uploadFixture(pair.hostPage, 'test01');

    // Wait for host playlist
    await waitForPlaylistCount(pair.hostPage, 1);

    // Guest should also get the playlist update
    await waitForPlaylistCount(pair.guestPage, 1, 20_000);

    const guestPlaylistCount = await pair.guestPage.evaluate(() => {
      const list = document.getElementById('playlist-ui');
      return list?.children.length ?? 0;
    });
    expect(guestPlaylistCount).toBeGreaterThanOrEqual(1);
  });

  test('host uploads multiple files', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Upload first file
    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    // Upload second file
    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);

    // Guest should see both
    await waitForPlaylistCount(pair.guestPage, 2, 25_000);
  });

  test('transfer state returns to idle after completion', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test03');
    await waitForPlaylistCount(pair.hostPage, 1);

    // Wait for transfer to complete on guest
    await pair.guestPage.waitForFunction(
      () => {
        const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
          | ((p: string) => unknown)
          | undefined;
        if (!get) return false;
        const state = get('transfer.state');
        return state === 'IDLE';
      },
      { timeout: 20_000 },
    );

    const transferState = await readState(pair.guestPage, 'transfer.state');
    expect(transferState).toBe('IDLE');
  });

  test('local direct transfer promotes a pending remote-share wait', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await pair.guestPage.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const get = w.__MUSIXQUARE_GET_STATE__ as ((path: string) => unknown) | undefined;
      const set = w.__MUSIXQUARE_SET_STATE__ as
        | ((path: string, value: unknown) => void)
        | undefined;
      const bus = w.__MUSIXQUARE_BUS__ as
        | { emit: (type: string, ...args: unknown[]) => void }
        | undefined;
      if (!get || !set || !bus) throw new Error('E2E state hooks unavailable');

      const hostConn = get('network.hostConn');
      if (!hostConn) throw new Error('Guest host connection unavailable');

      const name = 'promoted-direct.mp3';
      set('network.connectionType', 'local');
      set('playback.pendingRecoveryTarget', { index: 0, name });
      set('transfer.meta', { name, index: 0, sessionId: 7 });
      set('preload.meta', { name, index: 0, sessionId: 7 });
      set('preload.nextTrackIndex', 0);
      set('transfer.localSessionId', 0);
      set('playback.loadSource', 'preload-promoted');
      set('playback.lifecycle', 'AWAITING_PRELOAD');

      bus.emit(
        'network:data',
        {
          type: 'file-start',
          name,
          mime: 'audio/mpeg',
          total: 2,
          size: 4,
          index: 0,
          sessionId: 7,
        },
        hostConn,
      );
    });

    await pair.guestPage.waitForFunction(
      () => {
        const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
          | ((path: string) => unknown)
          | undefined;
        return (
          get?.('playback.lifecycle') === 'DOWNLOADING' &&
          get?.('playback.loadSource') === 'fresh' &&
          get?.('transfer.state') === 'RECEIVING' &&
          get?.('transfer.localSessionId') === 7 &&
          get?.('preload.meta') === null &&
          get?.('preload.nextTrackIndex') === -1
        );
      },
      { timeout: 10_000 },
    );

    const promotedState = await pair.guestPage.evaluate(() => {
      const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
        | ((path: string) => unknown)
        | undefined;
      return {
        lifecycle: get?.('playback.lifecycle'),
        loadSource: get?.('playback.loadSource'),
        transferState: get?.('transfer.state'),
        localSessionId: get?.('transfer.localSessionId'),
        preloadMeta: get?.('preload.meta'),
        nextTrackIndex: get?.('preload.nextTrackIndex'),
      };
    });

    expect(promotedState).toEqual({
      lifecycle: 'DOWNLOADING',
      loadSource: 'fresh',
      transferState: 'RECEIVING',
      localSessionId: 7,
      preloadMeta: null,
      nextTrackIndex: -1,
    });
  });
});
