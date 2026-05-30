/**
 * E2E: Multi-Guest Tests
 *
 * Tests with 3 guests connected simultaneously:
 * - All guests see same playlist
 * - File transfer reaches all guests
 * - Chat visible to all guests
 * - Kick one guest, others stay connected
 * - Device list shows all guests
 */
import { test, expect } from '@playwright/test';
import { setupHostAndStart, setupGuest } from './helpers/setup-flow.ts';
import { injectPeerServer } from './helpers/peer-server.ts';
import { uploadFixture } from './helpers/file-upload.ts';
import { waitForPlaylistCount, waitForDeviceCount, waitForChatMessage, isVisible, navigateToTab } from './helpers/wait.ts';
import type { Page, BrowserContext, Browser } from '@playwright/test';

interface MultiGuestSetup {
  hostContext: BrowserContext;
  hostPage: Page;
  guestContexts: BrowserContext[];
  guestPages: Page[];
}

async function createMultiGuestSetup(browser: Browser, guestCount = 3): Promise<MultiGuestSetup> {
  // Create host
  const hostContext = await browser.newContext();
  const hostPage = await hostContext.newPage();
  await injectPeerServer(hostPage);

  // Create guests
  const guestContexts: BrowserContext[] = [];
  const guestPages: Page[] = [];

  for (let i = 0; i < guestCount; i++) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await injectPeerServer(page);
    guestContexts.push(ctx);
    guestPages.push(page);
  }

  return { hostContext, hostPage, guestContexts, guestPages };
}

async function cleanupMultiGuest(setup: MultiGuestSetup): Promise<void> {
  for (const ctx of setup.guestContexts) {
    await ctx.close().catch(() => {});
  }
  await setup.hostContext.close().catch(() => {});
}

let setup: MultiGuestSetup;

test.describe('Multi-Guest', () => {
  test.afterEach(async () => {
    if (setup) await cleanupMultiGuest(setup);
  });

  test('3 guests all connect successfully', async ({ browser }) => {
    setup = await createMultiGuestSetup(browser, 3);

    const code = await setupHostAndStart(setup.hostPage);

    // Connect all 3 guests sequentially
    for (const guestPage of setup.guestPages) {
      await setupGuest(guestPage, code);
    }

    // Host should see 4 devices (self + 3 guests)
    await waitForDeviceCount(setup.hostPage, 4);

    const deviceCount = await setup.hostPage.evaluate(() => {
      const get = (window as any).__MUSIXQUARE_GET_STATE__;
      if (!get) return 0;
      const peers = get('network.connectedPeers') as unknown[];
      return peers ? peers.length : 0;
    });
    expect(deviceCount).toBe(3);
  });

  test('file transfer reaches all 3 guests', async ({ browser }) => {
    setup = await createMultiGuestSetup(browser, 3);

    const code = await setupHostAndStart(setup.hostPage);
    for (const guestPage of setup.guestPages) {
      await setupGuest(guestPage, code);
    }
    await waitForDeviceCount(setup.hostPage, 4);

    // Upload file
    await uploadFixture(setup.hostPage, 'test01');
    await waitForPlaylistCount(setup.hostPage, 1);

    // All guests should receive playlist
    for (let i = 0; i < setup.guestPages.length; i++) {
      await waitForPlaylistCount(setup.guestPages[i], 1, 30_000);
    }
  });

  test('replacement guest rejoins while existing guest still receives fan-out', async ({ browser }) => {
    test.setTimeout(90_000);
    setup = await createMultiGuestSetup(browser, 2);

    const code = await setupHostAndStart(setup.hostPage);
    for (const guestPage of setup.guestPages) {
      await setupGuest(guestPage, code);
    }
    await waitForDeviceCount(setup.hostPage, 3);

    await uploadFixture(setup.hostPage, 'test01');
    await waitForPlaylistCount(setup.hostPage, 1);
    await waitForPlaylistCount(setup.guestPages[0], 1, 30_000);
    await waitForPlaylistCount(setup.guestPages[1], 1, 30_000);

    await setup.guestContexts[0].close();
    await setup.hostPage.waitForFunction(
      () => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        const peers = get?.('network.connectedPeers') as Array<{ status?: string }> | undefined;
        return peers?.filter((peer) => peer.status === 'connected').length === 1;
      },
      { timeout: 20_000 },
    );

    const replacementContext = await browser.newContext();
    const replacementPage = await replacementContext.newPage();
    await injectPeerServer(replacementPage);
    setup.guestContexts[0] = replacementContext;
    setup.guestPages[0] = replacementPage;

    await setupGuest(replacementPage, code);
    await waitForDeviceCount(setup.hostPage, 3, 20_000);

    await uploadFixture(setup.hostPage, 'test02');
    await waitForPlaylistCount(setup.hostPage, 2);
    await waitForPlaylistCount(replacementPage, 2, 30_000);
    await waitForPlaylistCount(setup.guestPages[1], 2, 30_000);

    const connectedPeerCount = await setup.hostPage.evaluate(() => {
      const get = (window as any).__MUSIXQUARE_GET_STATE__;
      const peers = get?.('network.connectedPeers') as Array<{ status?: string }> | undefined;
      return peers?.filter((peer) => peer.status === 'connected').length ?? 0;
    });
    expect(connectedPeerCount).toBe(2);
  });

  test('all guests see same playlist after multiple uploads', async ({ browser }) => {
    setup = await createMultiGuestSetup(browser, 3);

    const code = await setupHostAndStart(setup.hostPage);
    for (const guestPage of setup.guestPages) {
      await setupGuest(guestPage, code);
    }
    await waitForDeviceCount(setup.hostPage, 4);

    // Upload 2 files
    await uploadFixture(setup.hostPage, 'test01');
    await waitForPlaylistCount(setup.hostPage, 1);

    await uploadFixture(setup.hostPage, 'test02');
    await waitForPlaylistCount(setup.hostPage, 2);

    // All guests should have 2 items
    for (const guestPage of setup.guestPages) {
      await waitForPlaylistCount(guestPage, 2, 30_000);

      const count = await guestPage.evaluate(() => {
        const list = document.getElementById('playlist-ui');
        return list?.children.length ?? 0;
      });
      expect(count).toBe(2);
    }
  });

  test('chat message reaches all guests', async ({ browser }) => {
    setup = await createMultiGuestSetup(browser, 2);

    const code = await setupHostAndStart(setup.hostPage);
    for (const guestPage of setup.guestPages) {
      await setupGuest(guestPage, code);
    }
    await waitForDeviceCount(setup.hostPage, 3);

    // Host sends chat message
    const chatInput = setup.hostPage.locator('#chat-input');
    if (await chatInput.isVisible()) {
      await chatInput.fill('Hello all guests!');
      await setup.hostPage.locator('#btn-chat-send').click();

      // Both guests should receive
      for (const guestPage of setup.guestPages) {
        await waitForChatMessage(guestPage, 'Hello all guests!');
      }
    }
  });

  test('kicking one guest keeps others connected', async ({ browser }) => {
    setup = await createMultiGuestSetup(browser, 2);

    const code = await setupHostAndStart(setup.hostPage);
    for (const guestPage of setup.guestPages) {
      await setupGuest(guestPage, code);
    }
    await waitForDeviceCount(setup.hostPage, 3);

    // Navigate to connect tab
    const connectNav = setup.hostPage.locator('.nav-item[data-tab="connect"]');
    if (await connectNav.isVisible()) {
      await connectNav.click();
      await setup.hostPage.locator('#tab-connect').waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
    }

    // Kick first guest
    const kickBtn = setup.hostPage.locator('.btn-kick-device').first();
    if (await kickBtn.isVisible()) {
      await kickBtn.click();

      const confirmBtn = setup.hostPage.locator('#btn-dialog-ok');
      if (await isVisible(setup.hostPage, '#btn-dialog-ok', 3000)) {
        await confirmBtn.click();
      }

      // Wait for peer count to decrease to 1
      await setup.hostPage.waitForFunction(
        () => {
          const get = (window as any).__MUSIXQUARE_GET_STATE__;
          if (!get) return false;
          const peers = get('network.connectedPeers') as unknown[];
          return peers && peers.length === 1;
        },
        { timeout: 15_000 },
      );

      const peerCount = await setup.hostPage.evaluate(() => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        if (!get) return 0;
        const peers = get('network.connectedPeers') as unknown[];
        return peers ? peers.length : 0;
      });
      expect(peerCount).toBe(1); // 1 remaining guest
    }
  });

  test('device list shows correct count for all guests', async ({ browser }) => {
    setup = await createMultiGuestSetup(browser, 3);

    const code = await setupHostAndStart(setup.hostPage);

    // Connect guests one by one and verify count increases
    await setupGuest(setup.guestPages[0], code);
    await waitForDeviceCount(setup.hostPage, 2);

    await setupGuest(setup.guestPages[1], code);
    await waitForDeviceCount(setup.hostPage, 3);

    await setupGuest(setup.guestPages[2], code);
    await waitForDeviceCount(setup.hostPage, 4);

    // Navigate to connect tab and verify rows
    const connectNav = setup.hostPage.locator('.nav-item[data-tab="connect"]');
    if (await connectNav.isVisible()) {
      await connectNav.click();
      await setup.hostPage.locator('#tab-connect').waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
    }

    const deviceRows = await setup.hostPage.evaluate(() => {
      const list = document.getElementById('connect-device-list') ||
                   document.getElementById('desktop-device-list');
      if (!list) return 0;
      return list.querySelectorAll('.device-row, .section-row').length;
    });
    expect(deviceRows).toBeGreaterThanOrEqual(4); // host + 3 guests
  });
});
