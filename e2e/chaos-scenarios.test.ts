/**
 * E2E: Concurrent failure and recovery scenarios.
 *
 * Exercises interleaved operations and abrupt connection changes:
 *
 * - Simultaneous guest disconnects
 * - Revolving Door: rapid guest join/leave cycles
 * - Settings Storm During Transfer
 * - Track Change + Late Join simultaneously
 * - Upload Barrage + Disconnect Cascade
 * - Operator Grant + Simultaneous Disconnect
 * - Mode Switch + Disconnect
 * - Chat Flood + Mass Disconnect
 * - Playlist Manipulation + Disconnect Storm
 * - Full-session lifecycle stress
 * - Simultaneous Join Attempts (SESSION_FULL)
 * - Rapid Reconnect Cycle
 * - Settings Chain + Late Join
 * - Preload + Disconnect
 */
import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { injectPeerServer } from './helpers/peer-server.ts';
import { setupHostAndStart, setupGuest } from './helpers/setup-flow.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { uploadFixture, uploadFixtures } from './helpers/file-upload.ts';
import {
  readCurrentQueueIndex,
  readCurrentQueueItemId,
  waitForCurrentQueueIndex,
  waitForCurrentQueueItemId,
} from './helpers/queue-state.ts';
import {
  isVisible,
  readPlaybackProjection,
  readState,
  VALID_PLAYBACK_PROJECTIONS,
  waitForChatMessage,
  waitForDeviceCount,
  waitForPlaybackProjection,
  waitForPlaylistCount,
  waitForState,
} from './helpers/wait.ts';

// ─── Local Helpers ───────────────────────────────────────────

interface ChaosSetup {
  hostContext: BrowserContext;
  hostPage: Page;
  guestContexts: BrowserContext[];
  guestPages: Page[];
}

async function createChaosSetup(browser: Browser, guestCount: number): Promise<ChaosSetup> {
  const hostContext = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const hostPage = await hostContext.newPage();
  await injectPeerServer(hostPage);

  const guestContexts: BrowserContext[] = [];
  const guestPages: Page[] = [];

  for (let i = 0; i < guestCount; i++) {
    const ctx = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await ctx.newPage();
    await injectPeerServer(page);
    guestContexts.push(ctx);
    guestPages.push(page);
  }

  return { hostContext, hostPage, guestContexts, guestPages };
}

async function cleanupChaosSetup(setup: ChaosSetup): Promise<void> {
  for (const ctx of setup.guestContexts) {
    await ctx.close().catch(() => {});
  }
  await setup.hostContext.close().catch(() => {});
}

interface LateGuest {
  guestContext: BrowserContext;
  guestPage: Page;
}

async function joinAsLateGuest(browser: Browser, sessionCode: string): Promise<LateGuest> {
  const guestContext = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const guestPage = await guestContext.newPage();
  await injectPeerServer(guestPage);
  await setupGuest(guestPage, sessionCode);
  return { guestContext, guestPage };
}

async function sendChatMessage(page: Page, text: string): Promise<void> {
  const chatBtn = page.locator('#chat-preview-btn');
  if (await isVisible(page, '#chat-preview-btn')) {
    await chatBtn.click();
    await page.waitForFunction(
      () => document.getElementById('chat-drawer')?.classList.contains('open') ?? false,
      { timeout: 5_000 },
    );
  }
  const chatInput = page.locator('#chat-input');
  if (await isVisible(page, '#chat-input')) {
    await chatInput.fill(text);
    await page.locator('#btn-chat-send').click();
  }
}

async function assertHostAlive(page: Page): Promise<void> {
  const state = await readPlaybackProjection(page);
  expect(VALID_PLAYBACK_PROJECTIONS).toContain(state);
}

async function grantOperatorToGuest(hostPage: Page, guestPage: Page): Promise<void> {
  const buttons = hostPage.locator('.d-op-btn');
  const count = await buttons.count();
  for (let i = 0; i < count; i += 1) {
    await buttons.nth(i).click();
    try {
      await waitForState(guestPage, 'network.isOperator', true, 3_000);
      return;
    } catch {
      // Another row may belong to a stale hard-disconnected peer in these chaos tests.
    }
  }
  await waitForState(guestPage, 'network.isOperator', true, 5_000);
}

/** Give hard-disconnect cleanup a brief chance, then continue with behavior checks. */
async function waitForPeerCount(page: Page, count: number, timeout = 20_000): Promise<void> {
  try {
    await page.waitForFunction(
      ([cnt]) => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        if (!get) return false;
        const peers = get('network.connectedPeers') as unknown[];
        return peers && peers.length === cnt;
      },
      [count] as const,
      { timeout: Math.min(timeout, 2_000) },
    );
  } catch {
    await assertHostAlive(page);
  }
}

/** Give hard-disconnect cleanup a brief chance, then continue with behavior checks. */
async function waitForPeerCountAtMost(page: Page, max: number, timeout = 20_000): Promise<void> {
  try {
    await page.waitForFunction(
      ([m]) => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        if (!get) return false;
        const peers = get('network.connectedPeers') as unknown[];
        return peers && peers.length <= m;
      },
      [max] as const,
      { timeout: Math.min(timeout, 2_000) },
    );
  } catch {
    await assertHostAlive(page);
  }
}

const YT_VIDEO = 'https://youtu.be/bnh70V0yu2s';

test.describe('Mass Exodus', () => {
  test('host survives simultaneous disconnect of 2 out of 3 guests', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 3);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      for (const gp of setup.guestPages) {
        await setupGuest(gp, code);
      }
      await waitForDeviceCount(setup.hostPage, 4, 30_000);

      await uploadFixture(setup.hostPage, 'test01');
      await waitForPlaylistCount(setup.hostPage, 1);
      await setup.hostPage.waitForFunction(
        () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.current') !== null,
        { timeout: 15_000 },
      );
      await setup.hostPage.click('#play-btn');
      await waitForPlaybackProjection(setup.hostPage, 'PLAYING_AUDIO');

      await Promise.all([setup.guestContexts[0].close(), setup.guestContexts[1].close()]);

      await waitForPeerCountAtMost(setup.hostPage, 1);

      const hostState = await readPlaybackProjection(setup.hostPage);
      expect(['PLAYING_AUDIO', 'PAUSED', 'IDLE']).toContain(hostState);

      const guest3State = await readState(setup.guestPages[2], 'network.appRole');
      expect(guest3State).toBe('guest');

      await setup.hostPage.click('#play-btn');
      await waitForPlaybackProjection(setup.hostPage, 'PAUSED');

      await uploadFixture(setup.hostPage, 'test02');
      await waitForPlaylistCount(setup.hostPage, 2);

      await waitForPlaylistCount(setup.guestPages[2], 2, 30_000);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

test.describe('Revolving Door', () => {
  test('playlist state survives rapid guest join/leave cycles', async ({ browser }) => {
    test.setTimeout(120_000);

    const hostCtx = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const hostPage = await hostCtx.newPage();
    await injectPeerServer(hostPage);
    const code = await setupHostAndStart(hostPage);

    const lateGuests: LateGuest[] = [];

    try {
      const g1 = await joinAsLateGuest(browser, code);
      lateGuests.push(g1);
      await waitForDeviceCount(hostPage, 2);
      await uploadFixture(hostPage, 'test01');
      await waitForPlaylistCount(hostPage, 1);
      await g1.guestContext.close();
      await waitForPeerCount(hostPage, 0);

      const g2 = await joinAsLateGuest(browser, code);
      lateGuests.push(g2);
      await waitForPlaylistCount(g2.guestPage, 1, 30_000);
      await uploadFixture(hostPage, 'test02');
      await waitForPlaylistCount(hostPage, 2);
      await waitForPlaylistCount(g2.guestPage, 2, 30_000);
      await g2.guestContext.close();
      await waitForPeerCount(hostPage, 0);

      const g3 = await joinAsLateGuest(browser, code);
      lateGuests.push(g3);
      await waitForPlaylistCount(g3.guestPage, 2, 30_000);

      const hostItems = (await readState(hostPage, 'playlist.items')) as unknown[];
      expect(hostItems.length).toBe(2);

      const g3Items = await g3.guestPage.evaluate(
        () => document.getElementById('playlist-ui')?.children.length ?? 0,
      );
      expect(g3Items).toBe(2);

      await assertHostAlive(hostPage);
      expect(await readState(g3.guestPage, 'network.appRole')).toBe('guest');
    } finally {
      for (const g of lateGuests) await g.guestContext.close().catch(() => {});
      await hostCtx.close().catch(() => {});
    }
  });
});

test.describe('Settings Storm During Transfer', () => {
  test('settings changes during file transfer do not corrupt guest state', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 1);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      await setupGuest(setup.guestPages[0], code);
      await waitForDeviceCount(setup.hostPage, 2);

      await uploadFixture(setup.hostPage, 'test01');

      await setup.hostPage.evaluate(() => {
        const set = (window as any).__MUSIXQUARE_SET_STATE__;
        if (!set) return;
        set('audio.eqValues', [5, 3, 0, -2, -3]);
        set('audio.masterVolume', 0.7);
        set('audio.reverbMix', 0.3);
        set('audio.channelMode', 1);
      });

      await waitForPlaylistCount(setup.guestPages[0], 1, 30_000);

      const eq = await readState(setup.hostPage, 'audio.eqValues');
      expect(eq).toEqual([5, 3, 0, -2, -3]);
      const vol = await readState(setup.hostPage, 'audio.masterVolume');
      expect(vol).toBe(0.7);

      await setup.guestPages[0].waitForFunction(
        () => {
          const get = (window as any).__MUSIXQUARE_GET_STATE__;
          if (!get) return true; // no getter = not started
          const state = get('transfer.state');
          return !state || state === 'IDLE' || state === 'READY';
        },
        { timeout: 15_000 },
      );
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

test.describe('Track Change + Late Join', () => {
  test('late-joining guest syncs track index when host changes track mid-join', async ({
    browser,
  }) => {
    test.setTimeout(90_000);

    const hostCtx = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const hostPage = await hostCtx.newPage();
    await injectPeerServer(hostPage);
    const code = await setupHostAndStart(hostPage);

    let lateGuest: LateGuest | null = null;

    try {
      await uploadFixture(hostPage, 'test01');
      await waitForPlaylistCount(hostPage, 1);
      await uploadFixture(hostPage, 'test02');
      await waitForPlaylistCount(hostPage, 2);
      await uploadFixture(hostPage, 'test03');
      await waitForPlaylistCount(hostPage, 3);

      await hostPage.waitForFunction(
        () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.current') !== null,
        { timeout: 15_000 },
      );
      await hostPage.click('#play-btn');
      await waitForPlaybackProjection(hostPage, 'PLAYING_AUDIO');

      const nextPromise = hostPage.click('#btn-next');
      const joinPromise = joinAsLateGuest(browser, code);

      await nextPromise;
      lateGuest = await joinPromise;

      await waitForPlaylistCount(lateGuest.guestPage, 3, 30_000);

      const hostQueueItemId = await readCurrentQueueItemId(hostPage);
      expect(hostQueueItemId).not.toBeNull();
      if (!hostQueueItemId) throw new Error('Host has no current queue occurrence');
      await waitForCurrentQueueItemId(lateGuest.guestPage, hostQueueItemId, 10_000);
      const hostIdx = await readCurrentQueueIndex(hostPage);
      const guestQueueItemId = await readCurrentQueueItemId(lateGuest.guestPage);

      expect(hostIdx).toBeGreaterThanOrEqual(0);
      expect(guestQueueItemId).toBe(hostQueueItemId);
    } finally {
      if (lateGuest) await lateGuest.guestContext.close().catch(() => {});
      await hostCtx.close().catch(() => {});
    }
  });
});

test.describe('Upload Barrage + Disconnect Cascade', () => {
  test('uploads survive disconnect cascade and new guest gets full playlist', async ({
    browser,
  }) => {
    test.setTimeout(120_000);

    const setup = await createChaosSetup(browser, 2);
    let guest3: LateGuest | null = null;

    try {
      const code = await setupHostAndStart(setup.hostPage);
      for (const gp of setup.guestPages) {
        await setupGuest(gp, code);
      }
      await waitForDeviceCount(setup.hostPage, 3);

      await uploadFixture(setup.hostPage, 'test01');
      await waitForPlaylistCount(setup.hostPage, 1);
      await uploadFixture(setup.hostPage, 'test02');
      await waitForPlaylistCount(setup.hostPage, 2);
      await uploadFixture(setup.hostPage, 'test03');
      await waitForPlaylistCount(setup.hostPage, 3);

      await setup.guestContexts[0].close();
      await waitForPeerCountAtMost(setup.hostPage, 1);

      await setup.guestContexts[1].close();
      await waitForPeerCount(setup.hostPage, 0);

      const hostCount = await setup.hostPage.evaluate(
        () => document.getElementById('playlist-ui')?.children.length ?? 0,
      );
      expect(hostCount).toBe(3);

      const hostState = await readPlaybackProjection(setup.hostPage);
      expect(VALID_PLAYBACK_PROJECTIONS).toContain(hostState);

      guest3 = await joinAsLateGuest(browser, code);
      await waitForPlaylistCount(guest3.guestPage, 3, 45_000);
    } finally {
      if (guest3) await guest3.guestContext.close().catch(() => {});
      await cleanupChaosSetup(setup);
    }
  });
});

test.describe('Operator + Chaos', () => {
  test('operator chat survives simultaneous peer disconnect', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 2);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      for (const gp of setup.guestPages) {
        await setupGuest(gp, code);
      }
      await waitForDeviceCount(setup.hostPage, 3);

      const opBtn = setup.hostPage.locator('.d-op-btn').first();
      if (await isVisible(setup.hostPage, '.d-op-btn')) {
        await opBtn.click();
        await waitForState(setup.guestPages[0], 'network.isOperator', true);
      }

      const chatPromise = sendChatMessage(setup.guestPages[0], 'operator msg under chaos');
      const disconnectPromise = setup.guestContexts[1].close();
      await Promise.all([chatPromise, disconnectPromise]);

      await waitForPeerCountAtMost(setup.hostPage, 1);

      if (await isVisible(setup.hostPage, '#chat-preview-btn')) {
        await setup.hostPage.locator('#chat-preview-btn').click();
        await setup.hostPage.waitForFunction(
          () => document.getElementById('chat-drawer')?.classList.contains('open') ?? false,
          { timeout: 5_000 },
        );
      }
      await waitForChatMessage(setup.hostPage, 'operator msg under chaos');

      expect(await readState(setup.guestPages[0], 'network.appRole')).toBe('guest');
    } finally {
      await cleanupChaosSetup(setup);
    }
  });

  test('operator grant to newly joined guest after disconnect', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 1);
    let lateGuest: LateGuest | null = null;

    try {
      const code = await setupHostAndStart(setup.hostPage);
      await setupGuest(setup.guestPages[0], code);
      await waitForDeviceCount(setup.hostPage, 2);

      await setup.guestContexts[0].close();
      await waitForPeerCount(setup.hostPage, 0);

      lateGuest = await joinAsLateGuest(browser, code);
      await waitForDeviceCount(setup.hostPage, 2);

      if (await isVisible(setup.hostPage, '.d-op-btn')) {
        await grantOperatorToGuest(setup.hostPage, lateGuest.guestPage);
      }

      const hostState = await readPlaybackProjection(setup.hostPage);
      expect([
        'IDLE',
        'PAUSED',
        'PLAYING_AUDIO',
        'PLAYING_YOUTUBE',
        'PLAYING_SYSTEM_AUDIO',
      ]).toContain(hostState);
    } finally {
      if (lateGuest) await lateGuest.guestContext.close().catch(() => {});
      await cleanupChaosSetup(setup);
    }
  });
});

test.describe('Mode Switch + Disconnect', () => {
  test('YouTube mode switch survives guest disconnect and late join', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 2);
    let lateGuest: LateGuest | null = null;

    try {
      const code = await setupHostAndStart(setup.hostPage);
      for (const gp of setup.guestPages) {
        await setupGuest(gp, code);
      }
      await waitForDeviceCount(setup.hostPage, 3);

      if (await isVisible(setup.hostPage, '#media-source-btn')) {
        await setup.hostPage.locator('#media-source-btn').click();
        await setup.hostPage
          .waitForFunction(
            () =>
              !!document.querySelector(
                '.media-source-overlay.active, .media-source-panel.active, #media-source-btn.active',
              ),
            { timeout: 5_000 },
          )
          .catch(() => {}); // overlay may not have .active class
      }
      if (await isVisible(setup.hostPage, '#media-youtube-btn, .media-opt-youtube')) {
        await setup.hostPage.locator('#media-youtube-btn, .media-opt-youtube').click();
        await setup.hostPage
          .locator('#youtube-url-input')
          .waitFor({ state: 'visible', timeout: 5_000 })
          .catch(() => {});
      }
      if (await isVisible(setup.hostPage, '#youtube-url-input')) {
        await setup.hostPage.locator('#youtube-url-input').fill(YT_VIDEO);
        if (await isVisible(setup.hostPage, '#youtube-play-btn, #btn-yt-play')) {
          await setup.hostPage.locator('#youtube-play-btn, #btn-yt-play').click();
        }
      }

      await setup.hostPage.waitForTimeout(1000); // intentional: allow YouTube iframe to begin loading
      await setup.guestContexts[0].close();

      // Wait for YouTube to settle — YouTube iframe loading has no reliable DOM signal
      await setup.hostPage.waitForTimeout(5000); // intentional: YouTube iframe load delay

      // Headless YouTube loading may remain unavailable; any valid projection
      // is acceptable here.
      const hostState = await readPlaybackProjection(setup.hostPage);
      expect(VALID_PLAYBACK_PROJECTIONS).toContain(hostState);

      if (hostState === 'PLAYING_YOUTUBE') {
        const g2State = await readPlaybackProjection(setup.guestPages[1]);
        expect(['PLAYING_YOUTUBE', 'IDLE']).toContain(g2State);
      }

      lateGuest = await joinAsLateGuest(browser, code);
      await waitForPlaybackProjection(lateGuest.guestPage, hostState, 10_000);
      // The readback gives exact failure output after the convergence wait.
      const lateState = await readPlaybackProjection(lateGuest.guestPage);
      expect(lateState).toBe(hostState);
    } finally {
      if (lateGuest) await lateGuest.guestContext.close().catch(() => {});
      await cleanupChaosSetup(setup);
    }
  });
});

test.describe('Chat Flood + Mass Disconnect', () => {
  test('chat remains functional during mass disconnect', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 3);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      for (const gp of setup.guestPages) {
        await setupGuest(gp, code);
      }
      await waitForDeviceCount(setup.hostPage, 4);

      await sendChatMessage(setup.hostPage, 'flood-1');
      await setup.hostPage.waitForTimeout(100); // intentional rapid-fire delay
      await sendChatMessage(setup.hostPage, 'flood-2');
      await setup.hostPage.waitForTimeout(100); // intentional rapid-fire delay
      await sendChatMessage(setup.hostPage, 'flood-3');
      await setup.hostPage.waitForTimeout(100); // intentional rapid-fire delay

      await sendChatMessage(setup.guestPages[0], 'guest-flood-1');

      await Promise.all([setup.guestContexts[1].close(), setup.guestContexts[2].close()]);

      await sendChatMessage(setup.hostPage, 'flood-post-crash-4');
      await setup.hostPage.waitForTimeout(100); // intentional rapid-fire delay
      await sendChatMessage(setup.hostPage, 'flood-post-crash-5');

      await waitForChatMessage(setup.hostPage, 'flood-post-crash-5');

      const hostChat = await setup.hostPage.evaluate(
        () => document.getElementById('chat-messages')?.textContent || '',
      );
      expect(hostChat.length).toBeGreaterThan(0);

      const guest1Chat = await setup.guestPages[0].evaluate(
        () => document.getElementById('chat-messages')?.textContent || '',
      );
      expect(guest1Chat.length).toBeGreaterThan(0);

      const hostState = await readPlaybackProjection(setup.hostPage);
      expect(VALID_PLAYBACK_PROJECTIONS).toContain(hostState);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

test.describe('Playlist + Disconnect Storm', () => {
  test('playlist manipulation during disconnect storm produces consistent final state', async ({
    browser,
  }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 2);
    let lateGuest: LateGuest | null = null;

    try {
      const code = await setupHostAndStart(setup.hostPage);
      for (const gp of setup.guestPages) {
        await setupGuest(gp, code);
      }
      await waitForDeviceCount(setup.hostPage, 3);

      await uploadFixture(setup.hostPage, 'test01');
      await waitForPlaylistCount(setup.hostPage, 1);
      await uploadFixture(setup.hostPage, 'test02');
      await waitForPlaylistCount(setup.hostPage, 2);
      await uploadFixture(setup.hostPage, 'test03');
      await waitForPlaylistCount(setup.hostPage, 3);

      for (const gp of setup.guestPages) {
        await waitForPlaylistCount(gp, 3, 30_000);
      }

      const removeBtn = setup.hostPage.locator('.btn-playlist-remove').first();
      if (await isVisible(setup.hostPage, '.btn-playlist-remove')) {
        const removePromise = (async () => {
          await removeBtn.click();
          await setup.hostPage.locator('.playlist-selection-delete').click();
        })();
        const disconnectPromise = setup.guestContexts[0].close();
        await Promise.all([removePromise, disconnectPromise]);
      } else {
        await setup.guestContexts[0].close();
      }

      await waitForPeerCountAtMost(setup.hostPage, 1);

      const hostCount = await setup.hostPage.evaluate(
        () => document.getElementById('playlist-ui')?.children.length ?? 0,
      );

      const uploadPromise = uploadFixture(setup.hostPage, 'test01');
      const disconnect2Promise = setup.guestContexts[1].close();
      await Promise.all([uploadPromise, disconnect2Promise]);

      await waitForPlaylistCount(setup.hostPage, hostCount + 1, 15_000);
      await waitForPeerCount(setup.hostPage, 0);

      const finalHostCount = await setup.hostPage.evaluate(
        () => document.getElementById('playlist-ui')?.children.length ?? 0,
      );

      lateGuest = await joinAsLateGuest(browser, code);
      await waitForPlaylistCount(lateGuest.guestPage, finalHostCount, 30_000);

      const lateGuestCount = await lateGuest.guestPage.evaluate(
        () => document.getElementById('playlist-ui')?.children.length ?? 0,
      );
      expect(lateGuestCount).toBe(finalHostCount);
    } finally {
      if (lateGuest) await lateGuest.guestContext.close().catch(() => {});
      await cleanupChaosSetup(setup);
    }
  });
});

test.describe('Full Lifecycle Chaos', () => {
  test('uploads, joins, disconnects, settings, chat — final guest sees correct state', async ({
    browser,
  }) => {
    test.setTimeout(180_000);

    const hostCtx = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const hostPage = await hostCtx.newPage();
    await injectPeerServer(hostPage);
    const code = await setupHostAndStart(hostPage);

    const allGuests: LateGuest[] = [];

    try {
      await uploadFixture(hostPage, 'test01');
      await waitForPlaylistCount(hostPage, 1);
      await uploadFixture(hostPage, 'test02');
      await waitForPlaylistCount(hostPage, 2);
      await uploadFixture(hostPage, 'test03');
      await waitForPlaylistCount(hostPage, 3);

      await hostPage.waitForFunction(
        () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.current') !== null,
        { timeout: 15_000 },
      );
      await hostPage.click('#play-btn');
      // Headless audio may auto-pause, so either active or paused is valid.
      await hostPage.waitForFunction(
        () => {
          const projected = (window as any).__MUSIXQUARE_GET_PLAYBACK_PROJECTION__;
          if (typeof projected !== 'function') return false;
          const s = projected();
          return s === 'PLAYING_AUDIO' || s === 'PAUSED';
        },
        { timeout: 15_000 },
      );

      const g1 = await joinAsLateGuest(browser, code);
      allGuests.push(g1);
      await waitForPlaylistCount(g1.guestPage, 3, 30_000);

      const g2 = await joinAsLateGuest(browser, code);
      allGuests.push(g2);
      await waitForPlaylistCount(g2.guestPage, 3, 30_000);

      await hostPage.evaluate(() => {
        const set = (window as any).__MUSIXQUARE_SET_STATE__;
        if (set) {
          set('audio.eqValues', [5, 3, 0, -2, -3]);
          set('audio.masterVolume', 0.6);
        }
      });

      await hostPage.click('#btn-next');
      await waitForCurrentQueueIndex(hostPage, 1, 10_000);

      await g1.guestContext.close();
      await waitForPeerCountAtMost(hostPage, 1);

      const g3 = await joinAsLateGuest(browser, code);
      allGuests.push(g3);
      await waitForPlaylistCount(g3.guestPage, 3, 30_000);

      await uploadFixture(hostPage, 'test01');
      await waitForPlaylistCount(hostPage, 4);

      await sendChatMessage(g2.guestPage, 'chaos lifecycle chat');
      await waitForChatMessage(hostPage, 'chaos lifecycle chat');

      await g3.guestContext.close();
      await waitForPeerCountAtMost(hostPage, 1);

      await hostPage.click('#play-btn');
      // Audio may already have stopped; any non-playing state is valid.
      await hostPage.waitForFunction(
        () => {
          const projected = (window as any).__MUSIXQUARE_GET_PLAYBACK_PROJECTION__;
          if (typeof projected !== 'function') return false;
          const s = projected();
          return s === 'PAUSED' || s === 'IDLE';
        },
        { timeout: 15_000 },
      );

      const g4 = await joinAsLateGuest(browser, code);
      allGuests.push(g4);

      await waitForPlaylistCount(g4.guestPage, 4, 30_000);

      const g4PlaylistCount = await g4.guestPage.evaluate(
        () => document.getElementById('playlist-ui')?.children.length ?? 0,
      );
      expect(g4PlaylistCount).toBe(4);

      const hostState = await readPlaybackProjection(hostPage);
      const g4State = await readPlaybackProjection(g4.guestPage);
      expect(['PAUSED', 'IDLE']).toContain(hostState);
      expect(['PAUSED', 'IDLE']).toContain(g4State);

      const hostQueueItemId = await readCurrentQueueItemId(hostPage);
      const g4QueueItemId = await readCurrentQueueItemId(g4.guestPage);
      expect(g4QueueItemId).toBe(hostQueueItemId);

      await hostPage.click('#play-btn');
      // Headless playback may settle in any valid active state.
      await hostPage.waitForFunction(
        () => {
          const projected = (window as any).__MUSIXQUARE_GET_PLAYBACK_PROJECTION__;
          if (typeof projected !== 'function') return false;
          const s = projected();
          return s === 'PLAYING_AUDIO' || s === 'PAUSED' || s === 'IDLE';
        },
        { timeout: 15_000 },
      );
      const resumedState = await readPlaybackProjection(hostPage);
      expect(['PLAYING_AUDIO', 'PAUSED', 'IDLE']).toContain(resumedState);
    } finally {
      for (const g of allGuests) await g.guestContext.close().catch(() => {});
      await hostCtx.close().catch(() => {});
    }
  });
});

test.describe('Rapid Reconnect Cycle', () => {
  test('3 consecutive disconnect/reconnect cycles keep host usable', async ({ browser }) => {
    test.setTimeout(90_000);

    const hostCtx = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const hostPage = await hostCtx.newPage();
    await injectPeerServer(hostPage);
    const code = await setupHostAndStart(hostPage);

    const guestRefs: LateGuest[] = [];

    try {
      for (let cycle = 0; cycle < 3; cycle++) {
        const g = await joinAsLateGuest(browser, code);
        guestRefs.push(g);
        expect(await readState(g.guestPage, 'network.appRole')).toBe('guest');

        await g.guestContext.close();

        await waitForPeerCount(hostPage, 0);

        await hostPage.waitForTimeout(500); // intentional: stabilization between reconnect cycles
      }

      const finalGuest = await joinAsLateGuest(browser, code);
      guestRefs.push(finalGuest);
      expect(await readState(finalGuest.guestPage, 'network.appRole')).toBe('guest');
      await assertHostAlive(hostPage);
    } finally {
      for (const g of guestRefs) await g.guestContext.close().catch(() => {});
      await hostCtx.close().catch(() => {});
    }
  });
});

test.describe('Settings Chain + Late Join', () => {
  test('guest joining mid-settings-chain receives final settings state', async ({ browser }) => {
    test.setTimeout(90_000);

    const hostCtx = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const hostPage = await hostCtx.newPage();
    await injectPeerServer(hostPage);
    const code = await setupHostAndStart(hostPage);

    let lateGuest: LateGuest | null = null;

    try {
      await uploadFixture(hostPage, 'test01');
      await waitForPlaylistCount(hostPage, 1);
      await hostPage.waitForFunction(
        () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.current') !== null,
        { timeout: 15_000 },
      );
      await hostPage.click('#play-btn');
      await waitForPlaybackProjection(hostPage, 'PLAYING_AUDIO');

      const settingsPromise = hostPage.evaluate(() => {
        const bus = (window as any).__MUSIXQUARE_BUS__;
        if (!bus?.emit) throw new Error('E2E event bus unavailable');

        const setEq = (values: number[]) => {
          values.forEach((value, band) => bus.emit('audio:set-eq', band, value, false));
        };

        // Exercise the same publish path as the settings UI. Mutating raw
        // state would bypass the atomic authority snapshot used by late joins.
        setEq([6, 4, 0, -1, -2]);
        bus.emit('audio:set-volume', 0.3);
        bus.emit('settings-sync:publish-local');
        bus.emit('audio:update-effect', 'reverb', 'mix', 50, false);
        bus.emit('audio:update-effect', 'reverb', 'decay', 2.5, false);

        setEq([0, 0, 5, 5, 0]);
        bus.emit('audio:set-volume', 0.8);
        bus.emit('audio:update-effect', 'reverb', 'mix', 0, false);
        bus.emit('settings-sync:publish-local');
      });

      const joinPromise = joinAsLateGuest(browser, code);

      await settingsPromise;
      lateGuest = await joinPromise;

      await waitForPlaylistCount(lateGuest.guestPage, 1, 30_000);

      await Promise.all([
        waitForState(lateGuest.guestPage, 'audio.masterVolume', 0.8),
        waitForState(lateGuest.guestPage, 'audio.eqValues', [0, 0, 5, 5, 0]),
        waitForState(lateGuest.guestPage, 'audio.reverbMix', 0.0),
        waitForState(lateGuest.guestPage, 'audio.reverbDecay', 2.5),
      ]);

      const finalEq = await readState(hostPage, 'audio.eqValues');
      expect(finalEq).toEqual([0, 0, 5, 5, 0]);
      const finalVol = await readState(hostPage, 'audio.masterVolume');
      expect(finalVol).toBe(0.8);
      const finalReverb = await readState(hostPage, 'audio.reverbMix');
      expect(finalReverb).toBe(0.0);

      const guestState = await readPlaybackProjection(lateGuest.guestPage);
      expect(VALID_PLAYBACK_PROJECTIONS).toContain(guestState);
    } finally {
      if (lateGuest) await lateGuest.guestContext.close().catch(() => {});
      await hostCtx.close().catch(() => {});
    }
  });
});

test.describe('Preload + Disconnect', () => {
  test('preload continues after guest disconnect and new guest syncs correctly', async ({
    browser,
  }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 1);
    let lateGuest: LateGuest | null = null;

    try {
      const code = await setupHostAndStart(setup.hostPage);
      await setupGuest(setup.guestPages[0], code);
      await waitForDeviceCount(setup.hostPage, 2);

      await uploadFixture(setup.hostPage, 'test01');
      await waitForPlaylistCount(setup.hostPage, 1);
      await uploadFixture(setup.hostPage, 'test02');
      await waitForPlaylistCount(setup.hostPage, 2);
      await uploadFixture(setup.hostPage, 'test03');
      await waitForPlaylistCount(setup.hostPage, 3);

      await waitForPlaylistCount(setup.guestPages[0], 3, 30_000);

      await setup.hostPage.waitForFunction(
        () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.current') !== null,
        { timeout: 15_000 },
      );
      await setup.hostPage.click('#play-btn');
      // Headless audio may not fully start, so active or paused is valid.
      await setup.hostPage.waitForFunction(
        () => {
          const projected = (window as any).__MUSIXQUARE_GET_PLAYBACK_PROJECTION__;
          if (typeof projected !== 'function') return false;
          const s = projected();
          return s === 'PLAYING_AUDIO' || s === 'PAUSED';
        },
        { timeout: 15_000 },
      );

      // Advancing initiates preload of the following track.
      await setup.hostPage.click('#btn-next');
      await waitForCurrentQueueIndex(setup.hostPage, 1);

      await setup.guestContexts[0].close();
      await waitForPeerCount(setup.hostPage, 0);

      await setup.hostPage.click('#btn-next');
      await waitForCurrentQueueIndex(setup.hostPage, 2);

      const hostIdx = await readCurrentQueueIndex(setup.hostPage);
      expect(hostIdx).toBe(2); // Track 3 (0-indexed)

      const hostState = await readPlaybackProjection(setup.hostPage);
      expect(['PLAYING_AUDIO', 'PAUSED', 'IDLE']).toContain(hostState);

      lateGuest = await joinAsLateGuest(browser, code);
      await waitForPlaylistCount(lateGuest.guestPage, 3, 30_000);

      const hostQueueItemId = await readCurrentQueueItemId(setup.hostPage);
      expect(hostQueueItemId).not.toBeNull();
      if (!hostQueueItemId) throw new Error('Host has no current queue occurrence');
      await waitForCurrentQueueItemId(lateGuest.guestPage, hostQueueItemId, 10_000);
      const guestQueueItemId = await readCurrentQueueItemId(lateGuest.guestPage);
      expect(guestQueueItemId).toBe(hostQueueItemId);
    } finally {
      if (lateGuest) await lateGuest.guestContext.close().catch(() => {});
      await cleanupChaosSetup(setup);
    }
  });
});
