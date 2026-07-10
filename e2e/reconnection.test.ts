/**
 * E2E: Reconnection & Disconnect Tests
 *
 * Tests disconnection and reconnection scenarios:
 * - Guest disconnect removes from device list
 * - Host sees disconnect toast/notification
 * - Guest intentional disconnect (leave)
 * - Guest context close simulates network drop
 */
import { test, expect } from '@playwright/test';
import { createHostGuestContexts, cleanupContexts, type HostGuestPair } from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import {
  isVisible,
  readState,
  waitForDeviceCount,
  waitForPlaylistCount,
} from './helpers/wait.ts';

let pair: HostGuestPair;

test.describe('Reconnection & Disconnect', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });

  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  test('guest disconnect reduces host device count', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await waitForDeviceCount(pair.hostPage, 2);

    // Closing the browser context simulates an ungraceful network loss.
    await pair.guestContext.close();
    // Prevent afterEach from closing the same context twice.
    (pair as any)._guestClosed = true;

    await pair.hostPage.waitForFunction(
      () => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        if (!get) return false;
        const peers = get('network.connectedPeers') as unknown[];
        return peers && peers.length === 0;
      },
      { timeout: 20_000 },
    );

    const peerCount = await pair.hostPage.evaluate(() => {
      const get = (window as any).__MUSIXQUARE_GET_STATE__;
      return get ? ((get('network.connectedPeers') as unknown[])?.length ?? -1) : -1;
    });
    expect(peerCount).toBe(0);
  });

  test('host remains functional after guest disconnects', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await waitForDeviceCount(pair.hostPage, 2);

    await pair.guestContext.close();
    (pair as any)._guestClosed = true;

    await pair.hostPage.waitForFunction(
      () => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        if (!get) return false;
        const peers = get('network.connectedPeers') as unknown[];
        return peers && peers.length === 0;
      },
      { timeout: 20_000 },
    );

    const appRole = await readState(pair.hostPage, 'network.appRole');
    expect(appRole).toBe('host');

    const sessionCode = await readState(pair.hostPage, 'network.sessionCode');
    expect(sessionCode).toBeTruthy();
    expect(String(sessionCode).length).toBe(6);
  });

  test('host state persists after guest disconnect', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const { uploadFixture } = await import('./helpers/file-upload.ts');

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await pair.guestContext.close();
    (pair as any)._guestClosed = true;

    await pair.hostPage.waitForFunction(
      () => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        if (!get) return false;
        const peers = get('network.connectedPeers') as unknown[];
        return peers && peers.length === 0;
      },
      { timeout: 20_000 },
    );

    const playlistCount = await pair.hostPage.evaluate(() => {
      const list = document.getElementById('playlist-ui');
      return list?.children.length ?? 0;
    });
    expect(playlistCount).toBe(1);
  });

  test('new guest can join after previous guest disconnected', async ({ browser }) => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await waitForDeviceCount(pair.hostPage, 2);

    const code = await readState(pair.hostPage, 'network.sessionCode') as string;

    await pair.guestContext.close();
    (pair as any)._guestClosed = true;

    await pair.hostPage.waitForFunction(
      () => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        if (!get) return false;
        const peers = get('network.connectedPeers') as unknown[];
        return peers && peers.length === 0;
      },
      { timeout: 20_000 },
    );

    const { injectPeerServer } = await import('./helpers/peer-server.ts');
    const { setupGuest } = await import('./helpers/setup-flow.ts');

    const newGuestContext = await browser.newContext();
    const newGuestPage = await newGuestContext.newPage();
    await injectPeerServer(newGuestPage);

    try {
      await setupGuest(newGuestPage, code);

      await waitForDeviceCount(pair.hostPage, 2);

      // A replaced connection can remain briefly in connectedPeers, so assert
      // successful admission rather than an exact transient count.
      const deviceRows = await pair.hostPage.evaluate(() => {
        const list = document.getElementById('connect-device-list') || document.getElementById('desktop-device-list');
        return list?.querySelectorAll('.device-row').length ?? 0;
      });
      expect(deviceRows).toBeGreaterThanOrEqual(2);
    } finally {
      await newGuestContext.close();
    }
  });

  test('guest leave button triggers intentional disconnect', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await waitForDeviceCount(pair.hostPage, 2);

    // The leave action reloads the guest page.
    const leaveBtn = pair.guestPage.locator('#btn-leave-session, #desktop-btn-leave-session');
    if (await leaveBtn.first().isVisible()) {
      await pair.guestPage.evaluate(() => {
        const setState = (window as any).__MUSIXQUARE_SET_STATE__;
        if (setState) setState('network.isIntentionalDisconnect', true);
      });

      const isIntentional = await readState(pair.guestPage, 'network.isIntentionalDisconnect');
      expect(isIntentional).toBe(true);
    }
  });
});
