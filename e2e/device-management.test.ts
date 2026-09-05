/**
 * E2E: Device Management Tests
 *
 * Tests host device management features:
 * - Device list display
 * - Kick guest
 */
import { test, expect } from '@playwright/test';
import {
  createHostGuestContexts,
  cleanupContexts,
  type HostGuestPair,
} from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { readState, waitForDeviceCount } from './helpers/wait.ts';

let pair: HostGuestPair;

async function openHostDevices(): Promise<void> {
  const desktopConnect = pair.hostPage.locator('#settings-subtab-connect');
  if (await desktopConnect.isVisible()) await desktopConnect.click();
  else await pair.hostPage.locator('#nav-connect').click();
  await expect(
    pair.hostPage.locator(
      '#connect-device-list:visible .device-row, #desktop-device-list:visible .device-row',
    ),
  ).toHaveCount(2);
}

test.describe('Device Management', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });

  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  test('host device list shows connected guest', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await waitForDeviceCount(pair.hostPage, 2);
    await openHostDevices();

    const deviceRows = await pair.hostPage.evaluate(() => {
      const list =
        document.getElementById('connect-device-list') ||
        document.getElementById('desktop-device-list');
      if (!list) return [];
      return Array.from(list.querySelectorAll('.device-row')).map((row) => ({
        name: row.querySelector('.d-name')?.textContent?.trim() || '',
        hasKickBtn: !!row.querySelector('.btn-kick-device'),
      }));
    });

    expect(deviceRows.length).toBeGreaterThanOrEqual(2);
    const hostRow = deviceRows.find((r) => r.name.includes('HOST'));
    expect(hostRow).toBeTruthy();
    const guestRow = deviceRows.find((r) => !r.name.includes('HOST'));
    expect(guestRow).toBeTruthy();
    expect(guestRow?.hasKickBtn).toBe(true);
  });

  test('host can kick guest', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await waitForDeviceCount(pair.hostPage, 2);
    await openHostDevices();

    const kickBtn = pair.hostPage.locator('.btn-kick-device:visible');
    await expect(kickBtn).toBeVisible();
    await kickBtn.click();
    await expect(pair.hostPage.locator('#dialog-overlay.show')).toBeVisible();
    await pair.hostPage.locator('#btn-dialog-ok').click();
    await expect(pair.guestPage.locator('#dialog-overlay.show')).toBeVisible();
    await waitForDeviceCount(pair.hostPage, 1);
    const reloaded = pair.guestPage.waitForNavigation({ waitUntil: 'domcontentloaded' });
    await pair.guestPage.locator('#btn-dialog-ok').click();
    await reloaded;
    await expect(pair.guestPage.locator('#setup-overlay.active')).toBeVisible();
    expect(await readState(pair.guestPage, 'network.appRole')).toBe('idle');
  });
});
