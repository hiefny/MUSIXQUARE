/**
 * E2E: Host-Guest Connection Tests
 *
 * Tests the full WebRTC connection lifecycle:
 * - Host creates session and gets a 6-digit code
 * - Guest joins using the code
 * - Both sides confirm connection
 * - Disconnect and reconnect scenarios
 */
import { test, expect } from '@playwright/test';
import {
  createHostGuestContexts,
  cleanupContexts,
  type HostGuestPair,
} from './helpers/context-factory.ts';
import {
  setupHost,
  setupHostAndStart,
  setupGuest,
  connectHostAndGuest,
} from './helpers/setup-flow.ts';
import { waitForDeviceCount } from './helpers/wait.ts';

let pair: HostGuestPair;

test.describe('Host-Guest Connection', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });

  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  test('host creates session and gets 6-digit code', async () => {
    const code = await setupHost(pair.hostPage);
    expect(code).toMatch(/^\d{6}$/);
  });

  test('host starts session and overlay closes', async () => {
    const code = await setupHostAndStart(pair.hostPage);
    expect(code).toMatch(/^\d{6}$/);

    const overlayActive = await pair.hostPage.evaluate(() =>
      document.getElementById('setup-overlay')?.classList.contains('active'),
    );
    expect(overlayActive).toBe(false);
  });

  test('guest joins host session successfully', async () => {
    const code = await setupHostAndStart(pair.hostPage);
    await setupGuest(pair.guestPage, code);

    const guestOverlay = await pair.guestPage.evaluate(() =>
      document.getElementById('setup-overlay')?.classList.contains('active'),
    );
    expect(guestOverlay).toBe(false);
  });

  test('preflights room/media constraints and reveals the one-time Center role path', async () => {
    const code = await setupHostAndStart(pair.hostPage);

    await pair.guestPage.goto('/');
    await pair.guestPage.waitForLoadState('domcontentloaded');
    await pair.guestPage.waitForSelector('#btn-setup-guest', {
      state: 'visible',
      timeout: 15_000,
    });
    await pair.guestPage.click('#btn-setup-guest');
    await pair.guestPage.waitForSelector('#setup-join-code', { state: 'visible' });

    const joinInput = pair.guestPage.locator('#setup-join-code');
    const roomInfo = pair.guestPage.locator('#setup-room-type-info');
    await joinInput.fill('000001');
    await expect(roomInfo).toHaveAttribute('data-room-kind', 'pro');
    await expect(roomInfo).toHaveAttribute('data-i18n', 'setup.pro_room_summary');
    await joinInput.fill(code);
    await expect(roomInfo).toHaveAttribute('data-room-kind', 'standard');
    await expect(roomInfo).toHaveAttribute('data-i18n', 'setup.standard_room_summary');

    await setupGuest(pair.guestPage, code);
    const roleGuide = pair.guestPage.locator('#center-role-guide');
    await expect(roleGuide).toBeVisible({ timeout: 5_000 });
    await expect(roleGuide.locator('#btn-center-role-settings')).toBeVisible();
    expect(
      await pair.guestPage.evaluate(() => localStorage.getItem('mxqr_center_role_guide_seen_v1')),
    ).toBe('1');

    await roleGuide.locator('#btn-center-role-settings').click();
    await expect(pair.guestPage.locator('#tab-settings')).toHaveClass(/active/);
    await expect(pair.guestPage.locator('#settings-role-title')).toBeFocused();

    const hostGuideDismiss = pair.hostPage.locator('#btn-center-role-dismiss');
    if (await hostGuideDismiss.isVisible()) await hostGuideDismiss.click();
    await pair.hostPage.locator('#btn-media-source').click();
    await expect(pair.hostPage.locator('#media-source-overlay')).toHaveClass(/active/);
    await expect(pair.hostPage.locator('#media-local-file-description')).toContainText('200 MiB');
    await expect(pair.hostPage.locator('#media-local-file-description')).toContainText('RAM');
    await expect(pair.hostPage.locator('#media-system-audio-limits')).toContainText('4');
    await expect(pair.hostPage.locator('#media-system-audio-limits')).toContainText('2');
    await expect(pair.hostPage.locator('#btn-system-audio')).toHaveAttribute(
      'aria-describedby',
      'media-system-audio-limits media-system-audio-status',
    );
  });

  test('host sees guest in device list after connection', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const connectNav = pair.hostPage.locator('.nav-item[data-tab="connect"]');
    if (await connectNav.isVisible()) {
      await connectNav.click();
    }

    await waitForDeviceCount(pair.hostPage, 2);

    const deviceCount = await pair.hostPage.evaluate(() => {
      const list =
        document.getElementById('connect-device-list') ||
        document.getElementById('desktop-device-list');
      return list?.querySelectorAll('.device-row').length ?? 0;
    });
    expect(deviceCount).toBeGreaterThanOrEqual(2);
  });

  test('guest with invalid code sees error', async () => {
    await setupHostAndStart(pair.hostPage);

    await pair.guestPage.goto('/');
    await pair.guestPage.waitForLoadState('domcontentloaded');
    await pair.guestPage.waitForSelector('#btn-setup-guest', { state: 'visible', timeout: 15_000 });
    await pair.guestPage.click('#btn-setup-guest');
    await pair.guestPage.waitForSelector('#setup-join-area', { state: 'visible', timeout: 10_000 });
    await pair.guestPage.fill('#setup-join-code', '999999');
    await pair.guestPage.click('#btn-setup-confirm');

    // A negative assertion needs a bounded observation window because there is
    // no DOM event for an overlay that correctly remains open.
    await pair.guestPage.waitForTimeout(2_000);
    const overlayStillActive = await pair.guestPage.evaluate(() =>
      document.getElementById('setup-overlay')?.classList.contains('active'),
    );
    expect(overlayStillActive).toBe(true);
  });

  test('guest selects different channel modes', async () => {
    // Host on center (0), guest on left (-1)
    const code = await setupHostAndStart(pair.hostPage, 0);
    await setupGuest(pair.guestPage, code, -1);

    const [hostOverlay, guestOverlay] = await Promise.all([
      pair.hostPage.evaluate(() =>
        document.getElementById('setup-overlay')?.classList.contains('active'),
      ),
      pair.guestPage.evaluate(() =>
        document.getElementById('setup-overlay')?.classList.contains('active'),
      ),
    ]);
    expect(hostOverlay).toBe(false);
    expect(guestOverlay).toBe(false);
  });
});
