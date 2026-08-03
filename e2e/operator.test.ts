/**
 * E2E: Operator Mode Tests
 *
 * Tests operator (admin) privilege management:
 * - Host grants operator to guest
 * - Administrator appears in the dedicated list
 * - Host revokes operator
 * - Operator state changes on guest side
 */
import { test, expect, type Locator } from '@playwright/test';
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

interface AdministratorActionIcon {
  geometryCount: number;
  markup: string;
}

const CROWN_PATH = 'M5 16 3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5zm1 2h12v2H6z';
const REVOKE_PATH =
  'M18.3 5.71 12 12l6.3 6.29-1.41 1.42L10.59 13.41 4.29 19.71 2.88 18.3 9.17 12 2.88 5.7 4.29 4.29 10.59 10.59 16.89 4.29z';

async function expectIconOnlyAdministratorAction(
  button: Locator,
  actionName: 'grant' | 'revoke',
): Promise<AdministratorActionIcon> {
  await expect(button).toBeVisible();
  await expect(button).toHaveText('');

  const ariaLabel = (await button.getAttribute('aria-label'))?.trim() || '';
  const title = (await button.getAttribute('title'))?.trim() || '';
  expect(ariaLabel).toMatch(actionName === 'grant' ? /grant/i : /revoke/i);
  expect(title).toBe(ariaLabel);

  const icon = button.locator('svg');
  await expect(icon).toHaveCount(1);
  await expect(icon).toHaveAttribute('aria-hidden', 'true');

  return icon.evaluate((svg) => ({
    geometryCount: svg.querySelectorAll('path, line, polyline').length,
    markup: svg.innerHTML.replace(/\s+/g, ' ').trim(),
  }));
}

async function expectAdministratorActionFitsRow(button: Locator): Promise<void> {
  const metrics = await button.evaluate((element) => {
    const row = element.closest<HTMLElement>('.device-row');
    const list = element.closest<HTMLElement>('.device-list, .administrator-list');
    if (!row || !list) throw new Error('Administrator action is not inside a device list row');

    const actionRect = element.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    return {
      actionLeft: actionRect.left,
      actionRight: actionRect.right,
      rowLeft: rowRect.left,
      rowRight: rowRect.right,
      listLeft: listRect.left,
      listRight: listRect.right,
      rowClientWidth: row.clientWidth,
      rowScrollWidth: row.scrollWidth,
      listClientWidth: list.clientWidth,
      listScrollWidth: list.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    };
  });

  expect(metrics.actionLeft).toBeGreaterThanOrEqual(metrics.rowLeft - 1);
  expect(metrics.actionRight).toBeLessThanOrEqual(metrics.rowRight + 1);
  expect(metrics.rowLeft).toBeGreaterThanOrEqual(metrics.listLeft - 1);
  expect(metrics.rowRight).toBeLessThanOrEqual(metrics.listRight + 1);
  expect(metrics.actionRight).toBeLessThanOrEqual(metrics.viewportWidth + 1);
  expect(metrics.rowScrollWidth).toBeLessThanOrEqual(metrics.rowClientWidth + 1);
  expect(metrics.listScrollWidth).toBeLessThanOrEqual(metrics.listClientWidth + 1);
}

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

  test('host can revoke operator from guest with an accessible X action', async () => {
    await pair.hostPage.addInitScript(() => localStorage.setItem('musixquare-lang', 'en'));
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await waitForDeviceCount(pair.hostPage, 2);
    await pair.hostPage.setViewportSize({ width: 320, height: 844 });
    await navigateToTab(pair.hostPage, 'connect');

    const guestId = String(await readState(pair.guestPage, 'network.myId'));
    expect(guestId).not.toBe('undefined');

    const grantButton = pair.hostPage
      .locator(
        '#connect-device-list .d-op-btn.administrator-state-button.grant[data-administrator-state="inactive"]:visible',
      )
      .first();
    await expect(grantButton).toHaveClass(/\badministrator-state-button\b/);
    await expect(grantButton).toHaveAttribute('data-administrator-state', 'inactive');
    const inactiveIcon = await expectIconOnlyAdministratorAction(grantButton, 'grant');
    expect(inactiveIcon.geometryCount).toBe(1);
    await expect(grantButton.locator('svg > path')).toHaveAttribute('d', CROWN_PATH);
    await expectAdministratorActionFitsRow(grantButton);

    await grantButton.click();
    await waitForState(pair.guestPage, 'network.isOperator', true);

    const authorityKey = `peer:${guestId}`;
    const administratorRow = pair.hostPage.locator(
      `#connect-administrator-list .administrator-row[data-member-id="${authorityKey}"]:visible`,
    );
    await expect(administratorRow).toBeVisible();

    const revokeButton = administratorRow.locator('.administrator-action-button.revoke');
    const revokeIcon = await expectIconOnlyAdministratorAction(revokeButton, 'revoke');
    expect(revokeIcon.geometryCount).toBe(1);
    expect(inactiveIcon.markup).not.toBe(revokeIcon.markup);
    await expect(revokeButton).not.toHaveClass(/\badministrator-state-button\b/);
    expect(await revokeButton.getAttribute('data-administrator-state')).toBeNull();
    await expect(revokeButton.locator('svg > path')).toHaveAttribute('d', REVOKE_PATH);
    await expectAdministratorActionFitsRow(revokeButton);

    await revokeButton.click();
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
