/**
 * E2E: Preload System Tests
 *
 * Tests the background preload mechanism.
 * Preload requires successful audio decode and ramstore finalization.
 * These tests verify the preload scheduling and state management
 * at the host level, since headless Chromium may not decode synthetic MP3s.
 */
import { test, expect } from '@playwright/test';
import {
  createHostGuestContexts,
  cleanupContexts,
  type HostGuestPair,
} from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { uploadFixture, uploadFixtures } from './helpers/file-upload.ts';
import {
  clickPlayButton,
  navigateToTab,
  readState,
  waitForFilePlaybackReady,
  waitForPlaybackProjection,
  waitForPlaylistCount,
  waitForState,
} from './helpers/wait.ts';

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

    const nextQueueItemId = await readState(pair.hostPage, 'preload.nextQueueItemId');
    const isPreloading = await readState(pair.hostPage, 'preload.isPreloading');

    expect(nextQueueItemId).toBeNull();
    expect(isPreloading).toBe(false);
  });

  test('host playlist with multiple files sets preload meta', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);

    await pair.hostPage.waitForFunction(
      () => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        if (!get) return false;
        const items = get('playlist.items') as unknown[];
        return items && items.length === 2;
      },
      undefined,
      { timeout: 10_000 },
    );

    const playlist = await pair.hostPage.evaluate(() => {
      const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
        ((p: string) => unknown) | undefined;
      if (!get) return [];
      return get('playlist.items') as unknown[];
    });
    expect(playlist).toHaveLength(2);
  });

  test('backward navigation clears preload state', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);

    await uploadFixture(pair.hostPage, 'test03');
    await waitForPlaylistCount(pair.hostPage, 3);

    // Auto-play on upload may have selected the last file. Select the first
    // stable queue occurrence so "next" has room to advance.
    const queueItemIds = await pair.hostPage.evaluate(() => {
      const get = (window as any).__MUSIXQUARE_GET_STATE__;
      const items = (get?.('playlist.items') ?? []) as Array<{ queueItemId?: string }>;
      return items.map((item) => item.queueItemId).filter(Boolean) as string[];
    });
    expect(queueItemIds).toHaveLength(3);
    const [firstQueueItemId, secondQueueItemId] = queueItemIds;

    await pair.hostPage.evaluate((queueItemId) => {
      const set = (window as any).__MUSIXQUARE_SET_STATE__;
      if (set) set('playlist.currentQueueItemId', queueItemId);
    }, firstQueueItemId);

    // Use a DOM click because responsive CSS can hide the desktop control.
    await pair.hostPage.evaluate(() =>
      (document.getElementById('btn-next') as HTMLElement)?.click(),
    );
    await pair.hostPage.waitForFunction(
      (queueItemId) =>
        (window as any).__MUSIXQUARE_GET_STATE__?.('playlist.currentQueueItemId') === queueItemId,
      secondQueueItemId,
      { timeout: 15_000 },
    );

    const afterNext = await readState(pair.hostPage, 'playlist.currentQueueItemId');
    expect(afterNext).toBe(secondQueueItemId);

    // With no playback progress, Previous navigates instead of restarting the
    // current track.
    await pair.hostPage.evaluate(() =>
      (document.getElementById('btn-prev') as HTMLElement)?.click(),
    );
    await pair.hostPage.waitForFunction(
      (queueItemId) =>
        (window as any).__MUSIXQUARE_GET_STATE__?.('playlist.currentQueueItemId') === queueItemId,
      firstQueueItemId,
      { timeout: 15_000 },
    );

    const ready = await readState(pair.hostPage, 'preload.ready');
    expect(ready).toBeNull();
  });

  test('guest receives playlist update with track metadata', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);
    await waitForPlaylistCount(pair.guestPage, 1, 20_000);

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);
    await waitForPlaylistCount(pair.guestPage, 2, 20_000);

    const guestPlaylist = await pair.guestPage.evaluate(() => {
      const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
        ((p: string) => unknown) | undefined;
      if (!get) return [];
      return get('playlist.items') as unknown[];
    });
    expect(guestPlaylist).toHaveLength(2);
  });

  test('guest follows next and previous MP3 playback with a successor preloaded', async ({}, testInfo) => {
    const messages: string[] = [];
    for (const [name, page] of [
      ['host', pair.hostPage],
      ['guest', pair.guestPage],
    ] as const) {
      await page.addInitScript(() => localStorage.setItem('mxqr:logLevel', 'DEBUG'));
      page.on('console', (message) => messages.push(`${name}: ${message.text()}`));
    }
    try {
      await connectHostAndGuest(pair.hostPage, pair.guestPage);
      await uploadFixtures(pair.hostPage, ['test01', 'test02', 'test03']);
      await waitForPlaylistCount(pair.guestPage, 3);
      const items = (await readState(pair.hostPage, 'playlist.items')) as Array<{
        queueItemId: string;
      }>;
      const [first, second, third] = items.map((item) => item.queueItemId);
      await waitForState(pair.hostPage, 'playlist.currentQueueItemId', first);
      await waitForFilePlaybackReady(pair.hostPage);
      await waitForFilePlaybackReady(pair.guestPage);
      await clickPlayButton(pair.hostPage);
      await waitForPlaybackProjection(pair.guestPage, 'PLAYING_AUDIO');
      await expect
        .poll(async () => {
          const ready = (await readState(pair.guestPage, 'preload.ready')) as {
            queueItemId?: string;
          } | null;
          return ready?.queueItemId;
        })
        .toBe(second);

      await pair.hostPage.locator('#btn-next').click();
      for (const page of [pair.hostPage, pair.guestPage]) {
        await waitForState(page, 'playlist.currentQueueItemId', second);
        await expect
          .poll(async () => {
            const resident = (await readState(page, 'files.current')) as {
              queueItemId?: string;
            } | null;
            return resident?.queueItemId;
          })
          .toBe(second);
        await waitForFilePlaybackReady(page);
        await waitForPlaybackProjection(page, 'PLAYING_AUDIO');
      }
      await expect
        .poll(async () => {
          const ready = (await readState(pair.guestPage, 'preload.ready')) as {
            queueItemId?: string;
          } | null;
          return ready?.queueItemId;
        })
        .toBe(third);

      // After 3s, the first press restarts the current track; the second goes back.
      // If playback is younger, the second press simply restarts the first track.
      await pair.hostPage.locator('#btn-prev').click();
      await pair.hostPage.locator('#btn-prev').click();
      for (const page of [pair.hostPage, pair.guestPage]) {
        await waitForState(page, 'playlist.currentQueueItemId', first);
        await expect
          .poll(async () => {
            const resident = (await readState(page, 'files.current')) as {
              queueItemId?: string;
            } | null;
            return resident?.queueItemId;
          })
          .toBe(first);
        await waitForFilePlaybackReady(page);
        await waitForPlaybackProjection(page, 'PLAYING_AUDIO');
      }

      // Direct playlist selection must also follow arbitrary earlier tracks,
      // including another backward selection after moving forward again.
      for (const queueItemId of [third, first, second, third, second, first]) {
        await navigateToTab(pair.hostPage, 'playlist');
        await pair.hostPage
          .locator(`.track-name[data-action="play"][data-queue-item-id="${queueItemId}"]`)
          .click();
        for (const page of [pair.hostPage, pair.guestPage]) {
          await waitForState(page, 'playlist.currentQueueItemId', queueItemId);
          await expect
            .poll(async () => {
              const resident = (await readState(page, 'files.current')) as {
                queueItemId?: string;
              } | null;
              return resident?.queueItemId;
            })
            .toBe(queueItemId);
          await waitForFilePlaybackReady(page);
          await waitForPlaybackProjection(page, 'PLAYING_AUDIO');
        }
      }
    } finally {
      await testInfo.attach('playback-console', {
        body: messages.join('\n'),
        contentType: 'text/plain',
      });
      for (const [name, page] of [
        ['host', pair.hostPage],
        ['guest', pair.guestPage],
      ] as const) {
        const state: Record<string, unknown> = {};
        for (const key of [
          'files.current',
          'transfer.meta',
          'transfer.localSessionId',
          'transfer.receivedCount',
          'transfer.state',
          'playback.lifecycle',
          'playback.activity',
          'playlist.currentQueueItemId',
          'preload.activeTarget',
        ]) {
          state[key] = await readState(page, key);
        }
        await testInfo.attach(`${name}-playback-state`, {
          body: JSON.stringify(state, null, 2),
          contentType: 'application/json',
        });
      }
    }
  });
});
