import { test, expect } from '@playwright/test';
import { createHostGuestContexts, cleanupContexts } from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import {
  navigateToSubtab,
  navigateToTab,
  readState,
  waitForDeviceCount,
  waitForState,
} from './helpers/wait.ts';

test('revoking an administrator during a captured effects drag preserves the locked value', async ({
  browser,
}) => {
  const pair = await createHostGuestContexts(browser);
  const { hostPage: host, guestPage: guest } = pair;
  try {
    await connectHostAndGuest(host, guest);
    await navigateToTab(host, 'settings');
    await navigateToSubtab(host, 'connect');
    await waitForDeviceCount(host, 2);
    const grant = host.locator('.d-op-btn[data-administrator-state="inactive"]:visible').first();
    await grant.click();
    await waitForState(guest, 'network.isOperator', true);
    const guestId = String(await readState(guest, 'network.myId'));

    await navigateToTab(guest, 'settings');
    await navigateToSubtab(guest, 'audio');
    await guest.locator('[data-rvb-type="advanced"]').click();
    const range = guest.locator('#reverb-decay-slider');
    await expect(range).toBeEnabled();
    await range.scrollIntoViewIfNeeded();
    const rail = await range.boundingBox();
    if (!rail) throw new Error('The reverb range must have a visible rail');
    await guest.mouse.move(rail.x + rail.width * 0.3, rail.y + rail.height / 2);
    await guest.mouse.down();
    await expect(range).toHaveClass(/is-dragging/);
    expect(await range.evaluate((element: HTMLInputElement) => element.hasPointerCapture(1))).toBe(
      true,
    );
    const canonical = Number(await readState(host, 'audio.reverbDecay'));

    await host
      .locator(`.administrator-list [data-member-id="peer:${guestId}"] .revoke:visible`)
      .click();
    await host.locator('#btn-dialog-ok').click();
    await waitForState(guest, 'network.isOperator', false);
    await expect(range).toBeDisabled();
    await waitForState(guest, 'audio.reverbDecay', canonical);
    await expect(range).toHaveValue(String(canonical));

    // Use the real captured mouse, not dispatchEvent on a disabled element.
    // Neither the canonical audio nor its thumb/label may change on release.
    await guest.mouse.move(rail.x + rail.width * 0.9, rail.y + rail.height / 2, { steps: 3 });
    await guest.mouse.up();
    await expect(range).toHaveValue(String(canonical));
    await expect(guest.locator('#val-rvb-decay')).toHaveText(`${canonical}s`);
    await expect(range).not.toHaveClass(/is-dragging/);
    expect(await readState(guest, 'audio.reverbDecay')).toBe(canonical);

    await grant.click();
    await waitForState(guest, 'network.isOperator', true);
    await guest.locator('[data-rvb-type="advanced"]').click();
    await expect(range).toBeEnabled();
    // The canonical reset can collapse the advanced section. Reopen it and
    // target its current geometry rather than the old captured coordinates.
    await range.scrollIntoViewIfNeeded();
    const restoredRail = await range.boundingBox();
    if (!restoredRail) throw new Error('The restored range must have a visible rail');
    await range.click({ position: { x: restoredRail.width * 0.6, y: restoredRail.height / 2 } });
    const next = Number(await range.inputValue());
    expect(next).not.toBe(canonical);
    await expect.poll(() => readState(guest, 'audio.reverbDecay')).toBe(next);
  } finally {
    await cleanupContexts(pair);
  }
});
