import { test, expect } from '@playwright/test';
import { createHostGuestContexts, cleanupContexts } from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { uploadFixtures } from './helpers/file-upload.ts';
import { readQueueSnapshot, waitForCurrentQueueItemId } from './helpers/queue-state.ts';
import {
  navigateToTab,
  navigateToSubtab,
  readState,
  waitForDeviceCount,
  waitForFilePlaybackReady,
  waitForPlaybackProjection,
  waitForState,
} from './helpers/wait.ts';

test('an administrator seek drag cannot seek the successor selected by the host', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const pair = await createHostGuestContexts(browser);
  const { hostPage: host, guestPage: guest } = pair;
  try {
    await connectHostAndGuest(host, guest);
    await navigateToTab(host, 'settings');
    await navigateToSubtab(host, 'connect');
    await waitForDeviceCount(host, 2);
    await host.locator('.d-op-btn[data-administrator-state="inactive"]:visible').first().click();
    await waitForState(guest, 'network.isOperator', true);

    await uploadFixtures(host, ['test01', 'test02']);
    await waitForFilePlaybackReady(host, 20_000);
    await waitForFilePlaybackReady(guest, 20_000);
    const queue = await readQueueSnapshot(host);
    const successor = queue.items.find((item) => item.queueItemId !== queue.currentQueueItemId);
    expect(successor).toBeDefined();
    await navigateToTab(guest, 'play');
    const range = guest.locator('#seek-slider');
    await expect(range).toHaveAttribute('aria-disabled', 'false');
    const rail = await range.boundingBox();
    if (!rail) throw new Error('The seek rail must be visible');
    await guest.mouse.move(rail.x + rail.width * 0.5, rail.y + rail.height / 2);
    await guest.mouse.down();
    await expect(range).toHaveClass(/is-dragging/);

    await navigateToTab(host, 'playlist');
    await host
      .locator(`.track-name[data-action="play"][data-queue-item-id="${successor!.queueItemId}"]`)
      .click();
    await waitForCurrentQueueItemId(guest, successor!.queueItemId);
    await waitForFilePlaybackReady(guest, 20_000);
    await waitForPlaybackProjection(host, 'PLAYING_AUDIO', 20_000);
    await waitForPlaybackProjection(guest, 'PLAYING_AUDIO', 20_000);
    await expect(range).toHaveAttribute('aria-disabled', 'false');

    // Continue the actual captured mouse gesture after the remote source change.
    await guest.mouse.move(rail.x + rail.width * 0.8, rail.y + rail.height / 2, { steps: 3 });
    await guest.mouse.up();
    await expect(range).not.toHaveClass(/is-dragging/);
    await guest.waitForTimeout(700); // Allow an erroneous RTC seek request to reach the host.
    const duration = Number(await range.getAttribute('max'));
    expect(Number(await range.inputValue())).toBeLessThan(duration * 0.25);
    expect(Number(await host.locator('#seek-slider').inputValue())).toBeLessThan(duration * 0.25);
    expect(await readState(guest, 'player.isSeeking')).toBe(false);

    // A new gesture still controls the new occurrence normally.
    await range.click({ position: { x: rail.width * 0.6, y: rail.height / 2 } });
    await expect
      .poll(async () => Number(await host.locator('#seek-slider').inputValue()))
      .toBeGreaterThan(duration * 0.5);
    await waitForCurrentQueueItemId(host, successor!.queueItemId);
  } finally {
    await guest.mouse.up().catch(() => {});
    await cleanupContexts(pair);
  }
});
