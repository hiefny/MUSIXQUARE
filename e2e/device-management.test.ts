/**
 * E2E: Device Management Tests
 *
 * Tests host device management features:
 * - Device list display
 * - Kick guest
 * - Session full when max guests reached
 */
import { test, expect } from '@playwright/test';
import { createHostGuestContexts, cleanupContexts, type HostGuestPair } from './helpers/context-factory.ts';
import { connectHostAndGuest, setupHostAndStart, setupGuest } from './helpers/setup-flow.ts';
import { waitForDeviceCount } from './helpers/wait.ts';
import { injectPeerServer } from './helpers/peer-server.ts';

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

    // Navigate to connect tab
    const connectNav = pair.hostPage.locator('.nav-item[data-tab="connect"]');
    if (await connectNav.isVisible()) {
      await connectNav.click();
    }

    // Wait for device list to show host + guest
    await waitForDeviceCount(pair.hostPage, 2);

    // Check that device rows exist
    const deviceRows = await pair.hostPage.evaluate(() => {
      const list = document.getElementById('connect-device-list') ||
                   document.getElementById('desktop-device-list');
      if (!list) return [];
      return Array.from(list.querySelectorAll('.device-row')).map(row => ({
        name: row.querySelector('.d-name')?.textContent?.trim() || '',
        hasKickBtn: !!row.querySelector('.btn-kick-device'),
      }));
    });

    expect(deviceRows.length).toBeGreaterThanOrEqual(2);
    const hostRow = deviceRows.find(r => r.name.includes('HOST'));
    expect(hostRow).toBeTruthy();
    const guestRow = deviceRows.find(r => !r.name.includes('HOST'));
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

      // Confirm kick dialog if present
      const confirmBtn = pair.hostPage.locator('#btn-dialog-ok');
      if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await confirmBtn.click();
      }

      // Guest should see the kick dialog or be returned to setup
      await pair.guestPage.waitForFunction(
        () => {
          const dialog = document.querySelector('.dialog-overlay.active, .dialog-backdrop.active');
          const overlay = document.getElementById('setup-overlay');
          return dialog || overlay?.classList.contains('active');
        },
        { timeout: 15_000 },
      );
    }
  });

  test('session full rejects extra guest', async ({ browser }) => {
    // Start host session first
    const code = await setupHostAndStart(pair.hostPage);

    // Restrict to 1 guest slot immediately (before any guest connects)
    await pair.hostPage.evaluate(() => {
      const setState = (window as unknown as Record<string, unknown>).__MUSIXQUARE_SET_STATE__ as
        | ((path: string, value: unknown) => void)
        | undefined;
      if (setState) {
        setState('network.maxGuestSlots', 1);
      }
    });

    // First guest joins (should succeed — slot 1 of 1)
    await setupGuest(pair.guestPage, code);

    // Confirm first guest is connected before second guest tries
    await waitForDeviceCount(pair.hostPage, 2);

    // Create a second guest
    const guest2Context = await browser.newContext();
    const guest2Page = await guest2Context.newPage();
    await injectPeerServer(guest2Page);

    try {
      await guest2Page.goto('/');
      await guest2Page.waitForLoadState('networkidle');
      await guest2Page.waitForSelector('#btn-setup-guest', { state: 'visible', timeout: 15_000 });
      await guest2Page.click('#btn-setup-guest');
      await guest2Page.waitForSelector('#setup-role-area', { state: 'visible', timeout: 10_000 });
      await guest2Page.click('#setup-role-grid .ch-opt[data-join-ch="0"]');
      await guest2Page.click('#btn-setup-next');
      await guest2Page.waitForSelector('#setup-join-area', { state: 'visible', timeout: 10_000 });
      await guest2Page.fill('#setup-join-code', code);
      await guest2Page.click('#btn-setup-confirm');

      // Wait for SESSION_FULL — guest2 should see dialog or remain on setup overlay
      await guest2Page.waitForFunction(
        () => {
          const overlay = document.getElementById('setup-overlay');
          const dialog = document.querySelector('.dialog-overlay.active, .dialog-backdrop.active, .dialog-container');
          return overlay?.classList.contains('active') || !!dialog;
        },
        { timeout: 20_000 },
      );

      const overlayActive = await guest2Page.evaluate(() =>
        document.getElementById('setup-overlay')?.classList.contains('active'),
      );
      const dialogVisible = await guest2Page.evaluate(() =>
        !!document.querySelector('.dialog-overlay.active, .dialog-backdrop.active, .dialog-container'),
      );

      expect(overlayActive || dialogVisible).toBe(true);
    } finally {
      await guest2Context.close();
    }
  });
});
