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
import {
  openChatDrawer,
  readState,
  sendChat,
  waitForChatMessage,
  waitForDeviceCount,
  waitForPlaylistCount,
} from './helpers/wait.ts';
import type { Page, BrowserContext, Browser } from '@playwright/test';

interface MultiGuestSetup {
  hostContext: BrowserContext;
  hostPage: Page;
  guestContexts: BrowserContext[];
  guestPages: Page[];
}

async function createMultiGuestSetup(browser: Browser, guestCount = 3): Promise<MultiGuestSetup> {
  const hostContext = await browser.newContext();
  const hostPage = await hostContext.newPage();
  await injectPeerServer(hostPage);

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

async function leaveGuestThroughUi(page: Page): Promise<void> {
  const leaveButton = page
    .locator('#desktop-btn-leave-session:visible, #btn-leave-session:visible')
    .first();
  if (!(await leaveButton.isVisible())) {
    const desktopConnectTab = page.locator(
      '.settings-subtab-nav .subtab-pill[data-subtab="connect"]',
    );
    if (await desktopConnectTab.isVisible()) {
      await desktopConnectTab.click();
    } else {
      await page.locator('.nav-item[data-tab="connect"]:visible').click();
    }
  }

  await expect(leaveButton).toBeVisible();
  await leaveButton.click();
  await expect(page.locator('#dialog-overlay.show')).toBeVisible();

  const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
  await page.locator('#btn-dialog-ok').click();
  await navigation;
  await expect(page.locator('#setup-overlay.active')).toBeVisible();
}

let setup: MultiGuestSetup;

test.describe('Multi-Guest', () => {
  test.afterEach(async () => {
    if (setup) await cleanupMultiGuest(setup);
  });

  test('3 guests all connect successfully', async ({ browser }) => {
    setup = await createMultiGuestSetup(browser, 3);

    const code = await setupHostAndStart(setup.hostPage);

    for (const guestPage of setup.guestPages) {
      await setupGuest(guestPage, code);
    }

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

    await uploadFixture(setup.hostPage, 'test01');
    await waitForPlaylistCount(setup.hostPage, 1);

    for (let i = 0; i < setup.guestPages.length; i++) {
      await waitForPlaylistCount(setup.guestPages[i], 1, 30_000);
    }
  });

  test('replacement guest rejoins while existing guest still receives fan-out', async ({
    browser,
  }) => {
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

    // This scenario covers a normal replacement, not abrupt process death.
    // Leave through the product UI so the page closes its RTC connection
    // before Playwright tears down the browser context. A raw context.close()
    // may skip pagehide and legitimately fall back to the 30/90s heartbeat
    // grace used to protect backgrounded mobile guests.
    await leaveGuestThroughUi(setup.guestPages[0]);
    await setup.hostPage.waitForFunction(
      () => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        const peers = get?.('network.connectedPeers') as
          | Array<{ status?: string; conn?: { open?: boolean } }>
          | undefined;
        return peers?.length === 1 && peers[0]?.status === 'connected' && peers[0]?.conn?.open;
      },
      undefined,
      { timeout: 20_000 },
    );
    await setup.guestContexts[0].close();

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

    await uploadFixture(setup.hostPage, 'test01');
    await waitForPlaylistCount(setup.hostPage, 1);

    await uploadFixture(setup.hostPage, 'test02');
    await waitForPlaylistCount(setup.hostPage, 2);

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

    await openChatDrawer(setup.hostPage);
    await sendChat(setup.hostPage, 'Hello all guests!');

    for (const guestPage of setup.guestPages) {
      await waitForChatMessage(guestPage, 'Hello all guests!');
    }
  });

  test('kicking one guest keeps others connected', async ({ browser }) => {
    setup = await createMultiGuestSetup(browser, 2);

    const code = await setupHostAndStart(setup.hostPage);
    for (const guestPage of setup.guestPages) {
      await setupGuest(guestPage, code);
    }
    await waitForDeviceCount(setup.hostPage, 3);

    const kickedPeerId = await readState(setup.guestPages[0], 'network.myId');
    const retainedPeerId = await readState(setup.guestPages[1], 'network.myId');
    expect(typeof kickedPeerId).toBe('string');
    expect(typeof retainedPeerId).toBe('string');
    expect(kickedPeerId).not.toBe(retainedPeerId);
    const kickedMemberKey = await setup.hostPage.evaluate((peerId) => {
      const get = (window as any).__MUSIXQUARE_GET_STATE__;
      const peer = (
        get?.('network.connectedPeers') as Array<{ id: string; memberId?: string }>
      ).find((candidate) => candidate.id === peerId);
      if (!peer) throw new Error('Kick target is not connected');
      return peer.memberId ? `member:${peer.memberId}` : `device:${peer.id}`;
    }, kickedPeerId);
    const desktopConnect = setup.hostPage.locator('#settings-subtab-connect');
    if (await desktopConnect.isVisible()) await desktopConnect.click();
    else await setup.hostPage.locator('#nav-connect').click();

    const kickBtn = setup.hostPage.locator(
      `.device-entry[data-member-key="${kickedMemberKey}"]:visible .btn-kick-device`,
    );
    await expect(kickBtn).toBeVisible();
    await kickBtn.click();

    await expect(setup.hostPage.locator('#dialog-overlay.show')).toBeVisible();
    await setup.hostPage.locator('#btn-dialog-ok').click();
    await expect(setup.guestPages[0].locator('#dialog-overlay.show')).toBeVisible();

    await setup.hostPage.waitForFunction(
      (peerId) => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        const peers = get?.('network.connectedPeers') as
          | Array<{ id?: string; status?: string; conn?: { open?: boolean } }>
          | undefined;
        return (
          peers?.length === 1 &&
          peers[0]?.id === peerId &&
          peers[0]?.status === 'connected' &&
          peers[0]?.conn?.open === true
        );
      },
      retainedPeerId,
      { timeout: 15_000 },
    );

    await openChatDrawer(setup.hostPage);
    await sendChat(setup.hostPage, 'Remaining guest is connected');
    await waitForChatMessage(setup.guestPages[1], 'Remaining guest is connected');
  });

  test('device list shows correct count for all guests', async ({ browser }) => {
    setup = await createMultiGuestSetup(browser, 3);

    const code = await setupHostAndStart(setup.hostPage);

    await setupGuest(setup.guestPages[0], code);
    await waitForDeviceCount(setup.hostPage, 2);

    await setupGuest(setup.guestPages[1], code);
    await waitForDeviceCount(setup.hostPage, 3);

    await setupGuest(setup.guestPages[2], code);
    await waitForDeviceCount(setup.hostPage, 4);

    const connectNav = setup.hostPage.locator('.nav-item[data-tab="connect"]');
    if (await connectNav.isVisible()) {
      await connectNav.click();
      await setup.hostPage
        .locator('#tab-connect')
        .waitFor({ state: 'visible', timeout: 5_000 })
        .catch(() => {});
    }

    const deviceRows = await setup.hostPage.evaluate(() => {
      const list =
        document.getElementById('connect-device-list') ||
        document.getElementById('desktop-device-list');
      if (!list) return 0;
      return list.querySelectorAll('.device-row, .section-row').length;
    });
    expect(deviceRows).toBeGreaterThanOrEqual(4); // host + 3 guests
  });
});
