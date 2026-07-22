/**
 * E2E: Operator Mode Tests
 *
 * Tests operator (admin) privilege management:
 * - Host grants operator to guest
 * - Administrator appears in the dedicated list
 * - Host revokes operator
 * - Operator state changes on guest side
 */
import { test, expect } from '@playwright/test';
import {
  createHostGuestContexts,
  cleanupContexts,
  type HostGuestPair,
} from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import {
  navigateToSubtab,
  navigateToTab,
  readState,
  waitForDeviceCount,
  waitForState,
} from './helpers/wait.ts';

let pair: HostGuestPair;

async function grantAdministrator(): Promise<string> {
  await navigateToTab(pair.hostPage, 'settings');
  await navigateToSubtab(pair.hostPage, 'connect');
  await waitForDeviceCount(pair.hostPage, 2);

  const guestId = String(await readState(pair.guestPage, 'network.myId'));
  expect(guestId).not.toBe('undefined');

  const grantButton = pair.hostPage.locator('.d-op-btn:visible').first();
  await expect(grantButton).toBeVisible();
  await grantButton.click();
  await waitForState(pair.guestPage, 'network.isOperator', true);
  return `peer:${guestId}`;
}

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
    await grantAdministrator();

    expect(await readState(pair.guestPage, 'network.isOperator')).toBe(true);
  });

  test('host can revoke operator from guest', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    const authorityKey = await grantAdministrator();

    const administratorRow = pair.hostPage.locator(
      `.administrator-row[data-member-id="${authorityKey}"]:visible`,
    );
    await expect(administratorRow).toBeVisible();
    await administratorRow.locator('.administrator-action-button.revoke').click();
    await expect(pair.hostPage.locator('#dialog-overlay.show')).toBeVisible();
    await pair.hostPage.locator('#btn-dialog-ok').click();
    await waitForState(pair.guestPage, 'network.isOperator', false);

    expect(await readState(pair.guestPage, 'network.isOperator')).toBe(false);
  });

  test('administrator appears in the dedicated administrator list after grant', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    const authorityKey = await grantAdministrator();

    await expect(
      pair.hostPage.locator(`.administrator-row[data-member-id="${authorityKey}"]:visible`),
    ).toBeVisible();
  });

  test('guest account entry remains LOGIN after administrator grant', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await grantAdministrator();

    await expect(pair.guestPage.locator('#role-text')).toHaveText('LOGIN');
    expect(await readState(pair.guestPage, 'network.isOperator')).toBe(true);
  });
});
