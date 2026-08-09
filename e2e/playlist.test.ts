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
import {
  createHostGuestContexts,
  cleanupContexts,
  type HostGuestPair,
} from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { uploadFixture } from './helpers/file-upload.ts';
import {
  readCurrentQueueIndex,
  readQueueSnapshot,
  setCurrentQueueItemByIndex,
  waitForCurrentQueueIndex,
} from './helpers/queue-state.ts';
import { navigateToTab, waitForPlaylistCount } from './helpers/wait.ts';

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

    await waitForPlaylistCount(pair.guestPage, 3, 30_000);
  });

  test('host track navigation updates the current queue occurrence', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);

    await uploadFixture(pair.hostPage, 'test03');
    await waitForPlaylistCount(pair.hostPage, 3);

    // Reset the selected occurrence to the first row so "next" has room to
    // advance without hitting the end of the playlist.
    await setCurrentQueueItemByIndex(pair.hostPage, 0);

    const initialIndex = await readCurrentQueueIndex(pair.hostPage);
    expect(initialIndex).toBe(0);

    // Use a DOM click because responsive CSS can hide the desktop control.
    await pair.hostPage.evaluate(() =>
      (document.getElementById('btn-next') as HTMLElement)?.click(),
    );
    await waitForCurrentQueueIndex(pair.hostPage, 1);

    const afterNext = await readCurrentQueueIndex(pair.hostPage);
    expect(afterNext).toBe(1);

    await pair.hostPage.evaluate(() =>
      (document.getElementById('btn-next') as HTMLElement)?.click(),
    );
    await waitForCurrentQueueIndex(pair.hostPage, 2);
    const afterNext2 = await readCurrentQueueIndex(pair.hostPage);
    expect(afterNext2).toBe(2);

    // With no playback progress, Previous navigates instead of restarting the
    // current track.
    await pair.hostPage.evaluate(() =>
      (document.getElementById('btn-prev') as HTMLElement)?.click(),
    );
    await waitForCurrentQueueIndex(pair.hostPage, 1);

    const afterPrev = await readCurrentQueueIndex(pair.hostPage);
    expect(afterPrev).toBe(1);
  });

  test('host drag reorder converges by queueItemId without changing the current item', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);
    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);
    await uploadFixture(pair.hostPage, 'test03');
    await waitForPlaylistCount(pair.hostPage, 3);
    await waitForPlaylistCount(pair.guestPage, 3, 30_000);

    const before = await readQueueSnapshot(pair.hostPage);
    expect(before.items).toHaveLength(3);
    expect(before.currentQueueItemId).not.toBeNull();

    await navigateToTab(pair.hostPage, 'playlist');

    const guestHandles = pair.guestPage.locator('.playlist-reorder-handle');
    await expect(guestHandles).toHaveCount(0);

    const sourceHandle = pair.hostPage.locator('.playlist-reorder-handle').first();
    const lastRow = pair.hostPage.locator('.playlist-entry[data-queue-item-id] .track-item').last();
    await expect(sourceHandle).toBeVisible();
    await expect(lastRow).toBeVisible();
    await sourceHandle.scrollIntoViewIfNeeded();

    // View Transitions temporarily replace the hit-test tree with HTML-only
    // snapshots. Wait for the real handle to be interactive before using the
    // browser mouse; this still exercises pointerdown -> move -> pointerup.
    await expect
      .poll(
        () =>
          sourceHandle.evaluate((handle) => {
            const rect = handle.getBoundingClientRect();
            return (
              document
                .elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
                ?.closest<HTMLElement>('.playlist-reorder-handle')?.dataset.queueItemId ?? null
            );
          }),
        { timeout: 5_000 },
      )
      .toBe(before.items[0].queueItemId);

    const sourceBox = await sourceHandle.boundingBox();
    const lastBox = await lastRow.boundingBox();
    expect(sourceBox).not.toBeNull();
    expect(lastBox).not.toBeNull();
    if (!sourceBox || !lastBox) throw new Error('Playlist reorder geometry unavailable');

    await pair.hostPage.mouse.move(
      sourceBox.x + sourceBox.width / 2,
      sourceBox.y + sourceBox.height / 2,
    );
    await pair.hostPage.mouse.down();
    await expect(pair.hostPage.locator('.playlist-reorder-ghost')).toBeVisible();
    await pair.hostPage.mouse.move(
      lastBox.x + Math.min(lastBox.width / 2, 120),
      lastBox.y + lastBox.height - 2,
      { steps: 8 },
    );

    await pair.hostPage.evaluate((sourceQueueItemId) => {
      const findEntry = (): HTMLElement | null =>
        Array.from(
          document.querySelectorAll<HTMLElement>('.playlist-entry[data-queue-item-id]'),
        ).find((entry) => entry.dataset.queueItemId === sourceQueueItemId) ?? null;
      const original = findEntry();
      if (!original) throw new Error('Reorder source entry is unavailable');

      const probe = {
        done: false,
        timedOut: false,
        samples: [] as Array<{
          sameNode: boolean;
          sourceConnected: boolean;
          numberOpacity: number;
          gripOpacity: number;
        }>,
      };
      (window as any).__MUSIXQUARE_REORDER_HANDLE_FADE__ = probe;
      const startedAt = performance.now();
      let returnStarted = false;
      const sample = (): void => {
        const current = findEntry();
        if (!original.classList.contains('is-reorder-source')) returnStarted = true;
        if (returnStarted && current) {
          const number = current.querySelector<HTMLElement>('.track-idx');
          const grip = current.querySelector<SVGElement>('.playlist-reorder-grip');
          if (number && grip) {
            probe.samples.push({
              sameNode: current === original,
              sourceConnected: original.isConnected,
              numberOpacity: Number.parseFloat(getComputedStyle(number).opacity),
              gripOpacity: Number.parseFloat(getComputedStyle(grip).opacity),
            });
          }
          if (current !== original) {
            probe.done = true;
            return;
          }
        }
        if (performance.now() - startedAt > 1_500) {
          probe.timedOut = true;
          probe.done = true;
          return;
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, before.items[0].queueItemId);
    await pair.hostPage.mouse.up();
    await pair.hostPage.mouse.move(1, 1);
    await pair.hostPage.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    await expect
      .poll(
        () =>
          pair.hostPage.evaluate(() => !!(window as any).__MUSIXQUARE_REORDER_HANDLE_FADE__?.done),
        { timeout: 3_000 },
      )
      .toBe(true);
    const fadeProbe = (await pair.hostPage.evaluate(
      () => (window as any).__MUSIXQUARE_REORDER_HANDLE_FADE__,
    )) as {
      done: boolean;
      timedOut: boolean;
      samples: Array<{
        sameNode: boolean;
        sourceConnected: boolean;
        numberOpacity: number;
        gripOpacity: number;
      }>;
    };
    expect(fadeProbe.timedOut).toBe(false);
    const originalSamples = fadeProbe.samples.filter(
      (sample) => sample.sameNode && sample.sourceConnected,
    );
    expect(originalSamples.length).toBeGreaterThan(3);
    expect(
      originalSamples.some((sample) => sample.numberOpacity > 0.05 && sample.numberOpacity < 0.95),
    ).toBe(true);
    expect(
      originalSamples.some((sample) => sample.gripOpacity > 0.05 && sample.gripOpacity < 0.95),
    ).toBe(true);
    const replacementIndex = fadeProbe.samples.findIndex((sample) => !sample.sameNode);
    expect(replacementIndex).toBeGreaterThan(0);
    const lastOriginalSample = fadeProbe.samples[replacementIndex - 1]!;
    expect(lastOriginalSample.numberOpacity).toBeGreaterThan(0.95);
    expect(lastOriginalSample.gripOpacity).toBeLessThan(0.05);

    const expectedOrder = [
      before.items[1].queueItemId,
      before.items[2].queueItemId,
      before.items[0].queueItemId,
    ];
    await pair.hostPage.waitForFunction(
      ([expected, previousRevision]) => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        const items = get?.('playlist.items');
        const revision = get?.('playlist.revision');
        return (
          Array.isArray(items) &&
          revision > previousRevision &&
          items.map((item: { queueItemId: string }) => item.queueItemId).join(',') ===
            expected.join(',')
        );
      },
      [expectedOrder, before.revision] as const,
      { timeout: 15_000 },
    );
    await pair.guestPage.waitForFunction(
      (expected) => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        const items = get?.('playlist.items');
        return (
          Array.isArray(items) &&
          items.map((item: { queueItemId: string }) => item.queueItemId).join(',') ===
            expected.join(',')
        );
      },
      expectedOrder,
      { timeout: 15_000 },
    );

    const [hostAfter, guestAfter] = await Promise.all([
      readQueueSnapshot(pair.hostPage),
      readQueueSnapshot(pair.guestPage),
    ]);
    expect(hostAfter.items.map((item) => item.queueItemId)).toEqual(expectedOrder);
    expect(guestAfter.items.map((item) => item.queueItemId)).toEqual(expectedOrder);
    expect(hostAfter.currentQueueItemId).toBe(before.currentQueueItemId);
    expect(guestAfter.currentQueueItemId).toBe(before.currentQueueItemId);
  });

  test('host can select and atomically remove multiple tracks', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);

    await uploadFixture(pair.hostPage, 'test03');
    await waitForPlaylistCount(pair.hostPage, 3);
    await waitForPlaylistCount(pair.guestPage, 3, 25_000);

    const playNav = pair.hostPage.locator('.nav-item[data-tab="play"]');
    if (await playNav.isVisible()) {
      await navigateToTab(pair.hostPage, 'play');
    }

    const removeBtns = pair.hostPage.locator('#playlist-ui .btn-playlist-remove');
    const btnCount = await removeBtns.count();
    expect(btnCount).toBe(3);
    const before = await readQueueSnapshot(pair.hostPage);

    await removeBtns.first().click();
    await removeBtns.last().click();
    await expect(removeBtns.first()).toHaveAttribute('aria-pressed', 'true');
    await expect(removeBtns.last()).toHaveAttribute('aria-pressed', 'true');
    await expect(pair.hostPage.locator('.playlist-selection-pill')).toHaveClass(/is-visible/);
    await expect(pair.hostPage.locator('.playlist-selection-count')).toHaveText('2');
    await expect(pair.hostPage.locator('#dialog-overlay')).toBeHidden();

    const guestBeforeDelete = await readQueueSnapshot(pair.guestPage);
    expect(guestBeforeDelete.items).toHaveLength(3);

    await pair.hostPage.locator('.playlist-selection-delete').click();
    const expectedSurvivor = before.items[1]!.queueItemId;
    await pair.guestPage.waitForFunction(
      (queueItemId) => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        const items = get?.('playlist.items');
        return Array.isArray(items) && items.length === 1 && items[0]?.queueItemId === queueItemId;
      },
      expectedSurvivor,
      { timeout: 15_000 },
    );

    const [hostAfter, guestAfter] = await Promise.all([
      readQueueSnapshot(pair.hostPage),
      readQueueSnapshot(pair.guestPage),
    ]);
    expect(hostAfter.items.map((item) => item.queueItemId)).toEqual([expectedSurvivor]);
    expect(guestAfter.items.map((item) => item.queueItemId)).toEqual([expectedSurvivor]);
    expect(hostAfter.revision).toBe(before.revision + 1);
    expect(guestAfter.revision).toBe(hostAfter.revision);
  });

  test('playlist sync: guest sees same track count as host', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);
    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);

    await waitForPlaylistCount(pair.guestPage, 2, 25_000);

    const [hostCount, guestCount] = await Promise.all([
      pair.hostPage.evaluate(() => document.getElementById('playlist-ui')?.children.length ?? 0),
      pair.guestPage.evaluate(() => document.getElementById('playlist-ui')?.children.length ?? 0),
    ]);
    expect(hostCount).toBe(guestCount);
  });
});
