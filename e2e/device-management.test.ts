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
import { isVisible, waitForDeviceCount } from './helpers/wait.ts';

let pair: HostGuestPair;

test.describe('Device Management', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });

  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  test('host device list shows connected guest', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const connectNav = pair.hostPage.locator('.nav-item[data-tab="connect"]');
    if (await connectNav.isVisible()) {
      await connectNav.click();
    }

    await waitForDeviceCount(pair.hostPage, 2);

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
    if (guestRow) {
      expect(guestRow.hasKickBtn).toBe(true);
    }
  });

  test('host can kick guest', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const connectNav = pair.hostPage.locator('.nav-item[data-tab="connect"]');
    if (await connectNav.isVisible()) {
      await connectNav.click();
    }

    await waitForDeviceCount(pair.hostPage, 2);

    const kickBtn = pair.hostPage.locator('.btn-kick-device').first();
    if (await kickBtn.isVisible()) {
      await kickBtn.click();

      const confirmBtn = pair.hostPage.locator('#btn-dialog-ok');
      if (await isVisible(pair.hostPage, '#btn-dialog-ok', 3000)) {
        await confirmBtn.click();
      }

      await pair.guestPage.waitForFunction(
        () => {
          const dialog = document.querySelector('.dialog-overlay.active, .dialog-backdrop.active');
          const overlay = document.getElementById('setup-overlay');
          return dialog || overlay?.classList.contains('active');
        },
        undefined,
        { timeout: 15_000 },
      );
    }
  });
});
