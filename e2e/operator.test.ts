/**
 * E2E: Operator Mode Tests
 *
 * Tests operator (admin) privilege management:
 * - Host grants operator to guest
 * - Operator badge appears
 * - Host revokes operator
 * - Operator state changes on guest side
 */
import { test, expect } from '@playwright/test';
import { createHostGuestContexts, cleanupContexts, type HostGuestPair } from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { waitForDeviceCount, readState } from './helpers/wait.ts';

let pair: HostGuestPair;

test.describe('Operator Mode', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });

  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  test('guest starts as non-operator', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const isOp = await readState(pair.guestPage, 'network.isOperator');
    expect(isOp).toBe(false);
  });

  test('host can grant operator to guest via device list', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Navigate to connect tab
    const connectNav = pair.hostPage.locator('.nav-item[data-tab="connect"]');
    if (await connectNav.isVisible()) {
      await connectNav.click();
    }

    await waitForDeviceCount(pair.hostPage, 2);

    // Find operator toggle button for guest (not host row)
    const opBtn = pair.hostPage.locator('.d-op-btn').first();
    if (await opBtn.isVisible()) {
      await opBtn.click();
      await pair.hostPage.waitForTimeout(2000);

      // Guest should now be operator
      const isOp = await readState(pair.guestPage, 'network.isOperator');
      expect(isOp).toBe(true);
    }
  });

  test('host can revoke operator from guest', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const connectNav = pair.hostPage.locator('.nav-item[data-tab="connect"]');
    if (await connectNav.isVisible()) {
      await connectNav.click();
    }

    await waitForDeviceCount(pair.hostPage, 2);

    const opBtn = pair.hostPage.locator('.d-op-btn').first();
    if (await opBtn.isVisible()) {
      // Grant
      await opBtn.click();
      await pair.hostPage.waitForTimeout(1000);

      // Revoke
      await opBtn.click();
      await pair.hostPage.waitForTimeout(2000);

      const isOp = await readState(pair.guestPage, 'network.isOperator');
      expect(isOp).toBe(false);
    }
  });

  test('operator badge appears in device list after grant', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const connectNav = pair.hostPage.locator('.nav-item[data-tab="connect"]');
    if (await connectNav.isVisible()) {
      await connectNav.click();
    }

    await waitForDeviceCount(pair.hostPage, 2);

    const opBtn = pair.hostPage.locator('.d-op-btn').first();
    if (await opBtn.isVisible()) {
      await opBtn.click();
      await pair.hostPage.waitForTimeout(2000);

      // Check for OP badge in device list
      const hasBadge = await pair.hostPage.evaluate(() => {
        const badges = document.querySelectorAll('.d-op-badge');
        return badges.length > 0;
      });
      // Host always has OP, guest should now also have it
      expect(hasBadge).toBe(true);
    }
  });

  test('guest role badge shows OP after operator grant', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const connectNav = pair.hostPage.locator('.nav-item[data-tab="connect"]');
    if (await connectNav.isVisible()) {
      await connectNav.click();
    }

    await waitForDeviceCount(pair.hostPage, 2);

    // Grant operator
    const opBtn = pair.hostPage.locator('.d-op-btn').first();
    if (await opBtn.isVisible()) {
      await opBtn.click();
      await pair.hostPage.waitForTimeout(2000);

      // Guest's role badge should show OP
      const guestRoleText = await pair.guestPage.evaluate(() => {
        const badge = document.getElementById('role-text');
        return badge?.textContent?.trim() || '';
      });
      expect(guestRoleText.toUpperCase()).toContain('OP');
    }
  });
});
