import { expect, test, type Page } from '@playwright/test';
import { cleanupContexts, createHostGuestContexts } from './helpers/context-factory.ts';
import { uploadFixtures } from './helpers/file-upload.ts';
import { readQueueSnapshot } from './helpers/queue-state.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { navigateToTab, waitForPlaylistCount } from './helpers/wait.ts';

const SCREENSHOT_DIR = process.env.MXQR_E2E_SCREENSHOT_DIR;

async function snap(page: Page, name: string): Promise<void> {
  if (SCREENSHOT_DIR) await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png` });
}

async function readSlots(page: Page): Promise<unknown> {
  return page.evaluate(() =>
    (
      window as unknown as { __MUSIXQUARE_GET_STATE__: (path: string) => unknown }
    ).__MUSIXQUARE_GET_STATE__('playlist.slots'),
  );
}

async function selectRows(page: Page, indices: number[]): Promise<void> {
  const checks = page.locator('#playlist-ui .btn-playlist-select');
  for (const index of indices) await checks.nth(index).click();
}

test.describe('Multiple playlists', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('copy, switch and move between playlists, followed by a guest', async ({ browser }) => {
    test.setTimeout(120_000);
    const pair = await createHostGuestContexts(browser);
    const { hostPage: host, guestPage: guest } = pair;
    try {
      await connectHostAndGuest(host, guest);
      await uploadFixtures(host, ['test01', 'test02', 'test03', 'test01']);
      await waitForPlaylistCount(host, 4);
      await waitForPlaylistCount(guest, 4);
      await navigateToTab(host, 'playlist');
      await navigateToTab(guest, 'playlist');

      // Both devices show the active playlist's name as the switcher button.
      for (const page of [host, guest]) {
        await expect(page.locator('#btn-playlist-switch')).toBeVisible();
        await expect(page.locator('#playlist-switch-label')).toHaveText('Playlist');
      }
      await expect
        .poll(() => readSlots(guest))
        .toEqual({
          activeSlot: 0,
          slots: [
            { count: 4, bytes: expect.any(Number) },
            { count: 0, bytes: null },
            { count: 0, bytes: null },
          ],
        });
      await snap(host, '01-header');

      // Copy two tracks to Playlist 2.
      const before = await readQueueSnapshot(host);
      await selectRows(host, [0, 1]);
      await expect(host.locator('.playlist-selection-move')).toBeVisible();
      await snap(host, '02-edit-bar');
      await host.locator('.playlist-selection-move').click();
      const transfer = host.locator('#playlist-transfer-overlay');
      await expect(transfer).toHaveClass(/\bshow\b/);
      await expect(host.locator('#playlist-transfer-title')).toHaveText('Move 2 tracks');
      const targets = host.locator('#playlist-transfer-list .playlist-slot-option');
      await expect(targets).toHaveCount(2);
      await expect(host.locator('#btn-playlist-transfer-copy')).toBeDisabled();
      await targets.nth(0).click();
      await expect(targets.nth(0)).toHaveAttribute('aria-pressed', 'true');
      await snap(host, '03-transfer-dialog');
      await host.locator('#btn-playlist-transfer-copy').click();
      await expect(transfer).not.toHaveClass(/\bshow\b/);
      await expect(host.locator('.playlist-selection-bar')).toBeHidden();
      expect((await readQueueSnapshot(host)).items.map((item) => item.queueItemId)).toEqual(
        before.items.map((item) => item.queueItemId),
      );
      await expect
        .poll(async () => ((await readSlots(guest)) as { slots: { count: number }[] }).slots)
        .toEqual([
          { count: 4, bytes: expect.any(Number) },
          { count: 2, bytes: expect.any(Number) },
          { count: 0, bytes: null },
        ]);

      // Switch the room to Playlist 2 through the switcher.
      await host.locator('#btn-playlist-switch').click();
      const switcher = host.locator('#playlist-slots-overlay');
      await expect(switcher).toHaveClass(/\bshow\b/);
      const rows = host.locator('#playlist-slots-list .playlist-slot-option');
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(0)).toHaveAttribute('aria-pressed', 'true');
      await expect(rows.nth(1)).toContainText('Playlist 2');
      await expect(rows.nth(1)).toContainText('2 tracks');
      await rows.nth(1).click();
      await snap(host, '04-switcher');
      await host.locator('#btn-playlist-slots-done').click();
      await expect(switcher).not.toHaveClass(/\bshow\b/);
      await waitForPlaylistCount(host, 2);
      await waitForPlaylistCount(guest, 2);
      for (const page of [host, guest]) {
        await expect(page.locator('#playlist-switch-label')).toHaveText('Playlist 2');
      }
      expect((await readQueueSnapshot(guest)).currentQueueItemId).toBeNull();
      await snap(guest, '05-guest-playlist-2');

      // Move one track from Playlist 2 to Playlist 3.
      await selectRows(host, [1]);
      await host.locator('.playlist-selection-move').click();
      await expect(host.locator('#playlist-transfer-title')).toHaveText('Move 1 track');
      await host.locator('#playlist-transfer-list .playlist-slot-option').nth(1).click();
      await host.locator('#btn-playlist-transfer-move').click();
      await waitForPlaylistCount(host, 1);
      await waitForPlaylistCount(guest, 1);
      await expect
        .poll(async () => ((await readSlots(guest)) as { slots: { count: number }[] }).slots)
        .toEqual([
          { count: 4, bytes: expect.any(Number) },
          { count: 1, bytes: expect.any(Number) },
          { count: 1, bytes: expect.any(Number) },
        ]);

      // Back to the first playlist: all four tracks, in their order.
      await host.locator('#btn-playlist-switch').click();
      await host.locator('#playlist-slots-list .playlist-slot-option').nth(0).click();
      await host.locator('#btn-playlist-slots-done').click();
      await waitForPlaylistCount(guest, 4);
      expect((await readQueueSnapshot(host)).items.map((item) => item.queueItemId)).toEqual(
        before.items.map((item) => item.queueItemId),
      );
      await expect(guest.locator('#playlist-switch-label')).toHaveText('Playlist');
    } finally {
      await cleanupContexts(pair);
    }
  });
});
