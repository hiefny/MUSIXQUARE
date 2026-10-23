/**
 * E2E: Standard-room owner PIN (local PeerJS signaling).
 *
 * The local suite runs Standard rooms over PeerJS, which has no signaling PIN,
 * so the Worker's kept set, socket revocation and wrong-PIN limit are covered
 * by the Worker tests. This file covers the browser flow: the shared two-step
 * dialog, the masked PIN, and the host-side removal with its guest notice.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  cleanupContexts,
  createHostGuestContexts,
  type HostGuestPair,
} from './helpers/context-factory.ts';
import { connectHostAndGuest, setupHostAndStart } from './helpers/setup-flow.ts';
import { waitForDeviceCount } from './helpers/wait.ts';

let pair: HostGuestPair;

// The dialog ignores action presses just after a page swap (double-press
// guard), so a scripted press waits that long, as a person reading would.
async function afterPageSwap(page: Page): Promise<void> {
  await page.waitForTimeout(450);
}

async function openPasswordSettings(page: Page) {
  const desktop = page.locator('#settings-subtab-connect');
  if (await desktop.isVisible()) await desktop.click();
  else await page.locator('#nav-connect').click();
  return page.locator('#room-password-toggle:visible, #desktop-room-password-toggle:visible');
}

function connectedPeerCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
      ((path: string) => unknown) | undefined;
    const peers = get?.('network.connectedPeers');
    return Array.isArray(peers) ? peers.length : -1;
  });
}

async function typePin(page: Page, pin: string): Promise<void> {
  const segments = page.locator('.dialog-input-segment');
  await segments.first().fill(pin.slice(0, 4));
  await segments.last().fill(pin.slice(4));
}

test.describe('Standard-room owner PIN', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });

  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  test('a host alone types the PIN on one page and then sees it masked', async () => {
    const page = pair.hostPage;
    await setupHostAndStart(page);
    const toggle = await openPasswordSettings(page);
    const segments = page.locator('.dialog-input-segment');

    await toggle.click();
    await expect(page.locator('#dialog-title')).toHaveText('Set room password');
    await expect(page.locator('#btn-dialog-secondary')).toHaveText('Cancel');
    await expect(page.locator('#btn-dialog-ok')).toHaveText('OK');
    // No generated PIN: the field starts empty.
    await expect(segments.first()).toHaveValue('');
    await expect(segments.last()).toHaveValue('');
    await typePin(page, '00000000');
    await page.locator('#btn-dialog-ok').click();

    await expect(page.locator('#dialog-overlay')).not.toHaveClass(/show/);
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const row = page.locator('.room-password-code-row:visible');
    await expect(row.locator('.room-password-code')).toHaveText('••••-••••');
    await expect(row.locator('.room-password-code')).toHaveAttribute('aria-hidden', 'true');
    await expect(row.locator('.sr-only')).toHaveText('Password applied');
    // Standard rooms offer an eye that shows the PIN (masked by default);
    // only PRO rooms keep the "Change room password" pencil.
    await expect(row.locator('.room-password-refresh')).toHaveAttribute(
      'aria-label',
      'Show password',
    );
    await expect(row.locator('.room-password-refresh')).toHaveAttribute('aria-pressed', 'false');

    // Turning protection off is immediate and asks nothing.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#dialog-overlay')).not.toHaveClass(/show/);
    await expect(row.locator('.room-password-code')).toHaveText('- - - - - - - -');
    await expect(row.locator('.room-password-refresh')).toBeHidden();
  });

  test('"Everyone rejoins" removes the guest with the host notice and reopens the room', async () => {
    const code = await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await waitForDeviceCount(pair.hostPage, 2);
    const host = pair.hostPage;
    const toggle = await openPasswordSettings(host);
    const title = host.locator('#dialog-title');

    await toggle.click();
    await expect(title).toHaveText('Set room password');
    await expect(host.locator('#btn-dialog-ok')).toHaveText('Next');
    await typePin(host, '12345678');
    await host.locator('#btn-dialog-ok').click();
    await expect(title).toHaveText('What should happen to current participants?');
    await expect(
      host.locator('input[name="room-pin-existing-participants"][value="keep_present"]'),
    ).toBeChecked();
    await afterPageSwap(host);
    await host.locator('.dialog-choice-option', { hasText: 'Everyone rejoins' }).click();
    await afterPageSwap(host);
    await host.locator('#btn-dialog-ok').click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    const guest = pair.guestPage;
    await expect(guest.locator('#dialog-title')).toHaveText('Room password set');
    await expect(guest.locator('#dialog-message')).toContainText(
      'The host set a room password. Enter it to join again.',
    );
    await guest.locator('#btn-dialog-ok').click();
    await guest.waitForURL(new RegExp(`/${code}/?$`));
  });

  test('"Keep everyone" leaves the present guest connected', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await waitForDeviceCount(pair.hostPage, 2);
    const host = pair.hostPage;
    const toggle = await openPasswordSettings(host);

    await toggle.click();
    await typePin(host, '87654321');
    await host.locator('#btn-dialog-ok').click();
    await expect(host.locator('#dialog-title')).toHaveText(
      'What should happen to current participants?',
    );
    await afterPageSwap(host);
    await host.locator('#btn-dialog-ok').click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    await host.waitForTimeout(1000);
    await expect(pair.guestPage.locator('#dialog-overlay')).not.toHaveClass(/show/);
    expect(await connectedPeerCount(host)).toBe(1);
  });
});
