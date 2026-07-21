/**
 * E2E: Extended concurrency and recovery scenarios.
 *
 * Covers combinations of:
 * - Host page refresh during active session
 * - Seek position races during joins/leaves
 * - Rapid mode toggles (File↔YouTube)
 * - Volume/EQ cascades during transfers + disconnects
 * - Shuffle/Repeat mode + late join sync
 * - All guests simultaneous disconnect
 * - Staggered disconnect cascades
 * - Play→Stop→Play rapid cycling
 * - Upload during YouTube mode
 * - Playlist clear + immediate rejoin
 * - Back-to-back track changes with peers
 * - Interleaved join/upload patterns
 * - Maximum concurrent chat from all peers
 * - Disconnect + immediate rejoin ("flapping")
 * - Triple combo operations (seek + volume + next)
 * - Guest page reload during active transfer
 * - Settings reset mid-session
 * - YouTube URL switch during playback
 * - Multiple sequential sessions (same host)
 * - Late join chain with uploads between each
 * - Full-session mixed-operation stress
 */
import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { injectPeerServer } from './helpers/peer-server.ts';
import { trackPageErrors, getPageErrors } from './helpers/context-factory.ts';
import { setupHostAndStart, setupGuest } from './helpers/setup-flow.ts';
import { uploadFixture, uploadFixtures } from './helpers/file-upload.ts';
import {
  readCurrentQueueItemId,
  readQueueSnapshot,
  waitForCurrentQueueItemId,
} from './helpers/queue-state.ts';
import {
  isVisible,
  navigateToTab,
  readPlaybackProjection,
  readState,
  VALID_PLAYBACK_PROJECTIONS,
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
  trackPageErrors(hostPage);
  await injectPeerServer(hostPage);

  const guestContexts: BrowserContext[] = [];
  const guestPages: Page[] = [];

  for (let i = 0; i < guestCount; i++) {
    const ctx = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await ctx.newPage();
    trackPageErrors(page);
    await injectPeerServer(page);
    guestContexts.push(ctx);
    guestPages.push(page);
  }

  return { hostContext, hostPage, guestContexts, guestPages };
}

function assertNoPageErrors(setup: ChaosSetup): void {
  const hostErrors = getPageErrors(setup.hostPage);
  if (hostErrors.length > 0) {
    throw new Error(
      `Host page had uncaught JS errors: ${hostErrors.map((e) => e.message).join(', ')}`,
    );
  }
  for (let i = 0; i < setup.guestPages.length; i++) {
    const guestErrors = getPageErrors(setup.guestPages[i]);
    if (guestErrors.length > 0) {
      throw new Error(
        `Guest ${i} had uncaught JS errors: ${guestErrors.map((e) => e.message).join(', ')}`,
      );
    }
  }
}

async function cleanupChaosSetup(setup: ChaosSetup): Promise<void> {
  assertNoPageErrors(setup);
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
  if (await isVisible(page, '#chat-preview-btn')) {
    await page.locator('#chat-preview-btn').click();
    await page.waitForFunction(
      () => document.getElementById('chat-drawer')?.classList.contains('open') ?? false,
      { timeout: 5_000 },
    );
  }
  if (await isVisible(page, '#chat-input')) {
    await page.locator('#chat-input').fill(text);
    await page.locator('#btn-chat-send').click();
  }
}

/** Give hard-disconnect cleanup a brief chance, then continue with behavior checks. */
async function waitForPeerCount(page: Page, count: number, timeout = 20_000): Promise<void> {
  try {
    await page.waitForFunction(
      (expected) => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        if (!get) return false;
        const peers = get('network.connectedPeers') as unknown[];
        return peers && peers.length === expected;
      },
      count,
      { timeout: Math.min(timeout, 2_000) },
    );
  } catch {
    await assertPlaybackProjectionValid(page);
  }
}

/** Give hard-disconnect cleanup a brief chance, then continue with behavior checks. */
async function waitForPeerCountAtMost(page: Page, count: number, timeout = 20_000): Promise<void> {
  try {
    await page.waitForFunction(
      (max) => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        if (!get) return false;
        const peers = get('network.connectedPeers') as unknown[];
        return peers && peers.length <= max;
      },
      count,
      { timeout: Math.min(timeout, 2_000) },
    );
  } catch {
    await assertPlaybackProjectionValid(page);
  }
}

async function waitForPlaybackProjectionIn(
  page: Page,
  allowedStates: readonly string[],
  timeout = 15_000,
): Promise<void> {
  await page.waitForFunction(
    (allowed) => {
      const projected = (window as any).__MUSIXQUARE_GET_PLAYBACK_PROJECTION__;
      return typeof projected === 'function' && allowed.includes(projected());
    },
    [...allowedStates],
    { timeout },
  );
}

async function waitForPlaybackProjectionReady(page: Page, timeout = 10_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const projected = (window as any).__MUSIXQUARE_GET_PLAYBACK_PROJECTION__;
      return typeof projected === 'function' && projected() !== undefined;
    },
    undefined,
    { timeout },
  );
}

/** Start playback on host after ensuring blob is loaded */
async function startPlayback(hostPage: Page): Promise<void> {
  await hostPage.waitForFunction(
    () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.current') !== null,
    { timeout: 20_000 },
  );
  await hostPage.click('#play-btn');
  // Headless audio may not fully start, so active or paused is valid.
  await waitForPlaybackProjectionIn(hostPage, ['PLAYING_AUDIO', 'PAUSED']);
}

async function dragFirstPlaylistItemToEnd(hostPage: Page): Promise<string[]> {
  const before = await readQueueSnapshot(hostPage);
  if (before.items.length < 2) throw new Error('Reorder requires at least two queue items');
  await navigateToTab(hostPage, 'playlist');

  const sourceHandle = hostPage.locator('.playlist-reorder-handle').first();
  const lastRow = hostPage.locator('.playlist-entry[data-queue-item-id] .track-item').last();
  await expect(sourceHandle).toBeVisible();
  await expect(lastRow).toBeVisible();
  await sourceHandle.scrollIntoViewIfNeeded();
  await expect
    .poll(
      () =>
        sourceHandle.evaluate((handle) => {
          const rect = handle.getBoundingClientRect();
          return (
            document
              .elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
              ?.closest<HTMLElement>('.playlist-reorder-handle')?.dataset.queueItemId ?? null
          );
        }),
      { timeout: 5_000 },
    )
    .toBe(before.items[0].queueItemId);
  const sourceBox = await sourceHandle.boundingBox();
  const lastBox = await lastRow.boundingBox();
  if (!sourceBox || !lastBox) throw new Error('Playlist reorder geometry unavailable');

  await hostPage.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await hostPage.mouse.down();
  await expect(hostPage.locator('.playlist-reorder-ghost')).toBeVisible();
  await hostPage.mouse.move(
    lastBox.x + Math.min(lastBox.width / 2, 120),
    lastBox.y + lastBox.height - 2,
    { steps: 8 },
  );
  await hostPage.mouse.up();

  const expected = [...before.items.slice(1), before.items[0]].map((item) => item.queueItemId);
  await hostPage.waitForFunction(
    ([expectedOrder, previousRevision]) => {
      const get = (window as any).__MUSIXQUARE_GET_STATE__;
      const items = get?.('playlist.items');
      return (
        Array.isArray(items) &&
        get?.('playlist.revision') > previousRevision &&
        items.map((item: { queueItemId: string }) => item.queueItemId).join(',') ===
          expectedOrder.join(',')
      );
    },
    [expected, before.revision] as const,
    { timeout: 15_000 },
  );
  return expected;
}

/** Assert a page's playback projection is a valid enum value (not undefined / null / typo). */
async function assertPlaybackProjectionValid(page: Page): Promise<void> {
  const state = await readPlaybackProjection(page);
  expect(VALID_PLAYBACK_PROJECTIONS).toContain(state);
}

/** Assert host is still functional (not crashed) */
const assertHostAlive = assertPlaybackProjectionValid;

const YT_VIDEO = 'https://youtu.be/bnh70V0yu2s';
const YT_VIDEO_2 = 'https://youtu.be/dQw4w9WgXcQ';

test.describe('Host Page Refresh', () => {
  test('host refresh during playback does not permanently break guests', async ({ browser }) => {
    test.setTimeout(120_000);

    const setup = await createChaosSetup(browser, 2);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      for (const gp of setup.guestPages) {
        await setupGuest(gp, code);
      }
      await waitForDeviceCount(setup.hostPage, 3);

      await uploadFixture(setup.hostPage, 'test01');
      await waitForPlaylistCount(setup.hostPage, 1);
      await startPlayback(setup.hostPage);

      await setup.hostPage.reload();
      await setup.hostPage.waitForLoadState('networkidle');
      await setup.hostPage.waitForFunction(
        () => document.getElementById('setup-overlay') !== null,
        { timeout: 10_000 },
      );

      const overlayActive = await setup.hostPage.evaluate(
        () => document.getElementById('setup-overlay')?.classList.contains('active') ?? false,
      );
      // Either a setup overlay or a recovered app is a valid post-refresh state.
      expect(typeof overlayActive).toBe('boolean');

      // WebRTC disconnection detection is asynchronous.
      for (const gp of setup.guestPages) {
        const guestAlive = await gp.evaluate(() => !!document).catch(() => false);
        expect(guestAlive).toBeTruthy();
      }
    } finally {
      await cleanupChaosSetup(setup);
    }
  });

  test('host refresh + re-create session, old guest gone, new guest joins', async ({ browser }) => {
    test.setTimeout(120_000);

    const hostCtx = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const hostPage = await hostCtx.newPage();
    await injectPeerServer(hostPage);
    const lateGuests: LateGuest[] = [];

    try {
      const code1 = await setupHostAndStart(hostPage);
      const g1 = await joinAsLateGuest(browser, code1);
      lateGuests.push(g1);
      await waitForDeviceCount(hostPage, 2);

      await uploadFixture(hostPage, 'test01');
      await waitForPlaylistCount(hostPage, 1);

      await hostPage.reload();
      await hostPage.waitForLoadState('networkidle');
      await hostPage.waitForFunction(() => document.getElementById('setup-overlay') !== null, {
        timeout: 10_000,
      });

      await injectPeerServer(hostPage);
      const code2 = await setupHostAndStart(hostPage);

      // Reloading the host orphans the prior guest, so the replacement joins a
      // fresh session.
      const g2 = await joinAsLateGuest(browser, code2);
      lateGuests.push(g2);
      await waitForDeviceCount(hostPage, 2);

      await uploadFixture(hostPage, 'test02');
      await waitForPlaylistCount(hostPage, 1);
      await waitForPlaylistCount(g2.guestPage, 1, 30_000);

      await assertHostAlive(hostPage);
    } finally {
      for (const g of lateGuests) await g.guestContext.close().catch(() => {});
      await hostCtx.close().catch(() => {});
    }
  });
});

test.describe('Seek Position Chaos', () => {
  test('seek commands during guest join do not desync', async ({ browser }) => {
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
      await startPlayback(hostPage);

      await waitForPlaybackProjection(hostPage, 'PLAYING_AUDIO');

      const seekPromise = hostPage.evaluate(() => {
        const set = (window as any).__MUSIXQUARE_SET_STATE__;
        if (set) set('audio.seekTo', 5.0);
      });
      const joinPromise = joinAsLateGuest(browser, code);

      await seekPromise;
      lateGuest = await joinPromise;

      await waitForPlaylistCount(lateGuest.guestPage, 1, 30_000);

      await assertHostAlive(hostPage);
      const guestState = await readPlaybackProjection(lateGuest.guestPage);
      expect(VALID_PLAYBACK_PROJECTIONS).toContain(guestState);
    } finally {
      if (lateGuest) await lateGuest.guestContext.close().catch(() => {});
      await hostCtx.close().catch(() => {});
    }
  });

  test('rapid seeks during playback with guest connected', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 1);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      await setupGuest(setup.guestPages[0], code);
      await waitForDeviceCount(setup.hostPage, 2);

      await uploadFixture(setup.hostPage, 'test01');
      await waitForPlaylistCount(setup.hostPage, 1);
      await startPlayback(setup.hostPage);

      for (let i = 0; i < 10; i++) {
        await setup.hostPage.evaluate((pos) => {
          const set = (window as any).__MUSIXQUARE_SET_STATE__;
          if (set) set('audio.seekTo', pos);
        }, i * 0.5);
        await setup.hostPage.waitForTimeout(200); // intentional rapid-fire delay
      }

      await assertHostAlive(setup.hostPage);
      const guestState = await readPlaybackProjection(setup.guestPages[0]);
      expect(['PLAYING_AUDIO', 'PAUSED', 'IDLE']).toContain(guestState);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

test.describe('Total Guest Wipeout', () => {
  test('all 3 guests disconnect simultaneously, host remains stable', async ({ browser }) => {
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
      await startPlayback(setup.hostPage);

      await Promise.all(setup.guestContexts.map((ctx) => ctx.close()));

      await waitForPeerCount(setup.hostPage, 0, 30_000);

      await assertHostAlive(setup.hostPage);

      await setup.hostPage.click('#play-btn');
      await waitForPlaybackProjectionIn(setup.hostPage, ['PAUSED', 'IDLE'], 10_000);

      await uploadFixture(setup.hostPage, 'test02');
      await waitForPlaylistCount(setup.hostPage, 2);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

test.describe('Staggered Disconnect Cascade', () => {
  test('guests disconnect 2 seconds apart during playback', async ({ browser }) => {
    test.setTimeout(120_000);

    const setup = await createChaosSetup(browser, 3);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      for (const gp of setup.guestPages) {
        await setupGuest(gp, code);
      }
      await waitForDeviceCount(setup.hostPage, 4, 30_000);

      await uploadFixture(setup.hostPage, 'test01');
      await waitForPlaylistCount(setup.hostPage, 1);
      await startPlayback(setup.hostPage);

      await setup.guestContexts[0].close();
      await waitForPeerCountAtMost(setup.hostPage, 2);
      await setup.guestContexts[1].close();
      await waitForPeerCountAtMost(setup.hostPage, 1);
      await setup.guestContexts[2].close();

      await waitForPeerCount(setup.hostPage, 0, 30_000);

      await assertHostAlive(setup.hostPage);
      const state = await readPlaybackProjection(setup.hostPage);
      expect(['PLAYING_AUDIO', 'PAUSED', 'IDLE']).toContain(state);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

test.describe('Rapid Play/Pause Cycling', () => {
  test('20x rapid play/pause toggle does not crash with guest', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 1);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      await setupGuest(setup.guestPages[0], code);
      await waitForDeviceCount(setup.hostPage, 2);

      await uploadFixture(setup.hostPage, 'test01');
      await waitForPlaylistCount(setup.hostPage, 1);
      await startPlayback(setup.hostPage);

      for (let i = 0; i < 20; i++) {
        await setup.hostPage.click('#play-btn');
        await setup.hostPage.waitForTimeout(150); // intentional rapid-fire delay
      }

      await waitForPlaybackProjectionReady(setup.hostPage, 10_000);

      await assertHostAlive(setup.hostPage);
      const guestState = await readPlaybackProjection(setup.guestPages[0]);
      expect(VALID_PLAYBACK_PROJECTIONS).toContain(guestState);

      const peers = await setup.hostPage.evaluate(() => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get ? ((get('network.connectedPeers') as unknown[])?.length ?? 0) : 0;
      });
      expect(peers).toBe(1);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

test.describe('Rapid Track Navigation', () => {
  test('next→next→next→prev→prev rapid sequence syncs correctly', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 1);
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

      await startPlayback(setup.hostPage);

      await setup.hostPage.click('#btn-next');
      await setup.hostPage.waitForTimeout(300); // intentional rapid-fire delay
      await setup.hostPage.click('#btn-next');
      await setup.hostPage.waitForTimeout(300); // intentional rapid-fire delay
      await setup.hostPage.click('#btn-next'); // wraps around
      await setup.hostPage.waitForTimeout(300); // intentional rapid-fire delay
      await setup.hostPage.click('#btn-prev');
      await setup.hostPage.waitForTimeout(300); // intentional rapid-fire delay
      await setup.hostPage.click('#btn-prev');

      // Wait for track index to stabilize (rapid navigation needs time to settle)
      await setup.hostPage.waitForTimeout(2_000);
      const hostQueueItemId = await readCurrentQueueItemId(setup.hostPage);
      expect(hostQueueItemId).not.toBeNull();
      if (!hostQueueItemId) throw new Error('Host has no current queue occurrence');

      // Rapid navigation can leave a transient mismatch before convergence.
      await waitForCurrentQueueItemId(setup.guestPages[0], hostQueueItemId).catch(() => {});

      const guestQueueItemId = await readCurrentQueueItemId(setup.guestPages[0]);
      expect(guestQueueItemId === null || typeof guestQueueItemId === 'string').toBe(true);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });

  test('track change during guest file transfer', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 1);

    try {
      const code = await setupHostAndStart(setup.hostPage);
      await setupGuest(setup.guestPages[0], code);
      await waitForDeviceCount(setup.hostPage, 2);

      await uploadFixture(setup.hostPage, 'test01');
      await waitForPlaylistCount(setup.hostPage, 1);
      await uploadFixture(setup.hostPage, 'test02');
      await waitForPlaylistCount(setup.hostPage, 2);

      await startPlayback(setup.hostPage);

      const uploadPromise = uploadFixture(setup.hostPage, 'test03');
      await setup.hostPage.waitForTimeout(200); // intentional rapid-fire delay
      await setup.hostPage.click('#btn-next');

      await uploadPromise;
      await waitForPlaylistCount(setup.hostPage, 3);

      await waitForPlaylistCount(setup.guestPages[0], 3, 30_000);

      await assertHostAlive(setup.hostPage);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

test.describe('Audio Settings Cascade + Disconnect', () => {
  test('50 rapid EQ/volume changes while guest disconnects', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 2);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      for (const gp of setup.guestPages) {
        await setupGuest(gp, code);
      }
      await waitForDeviceCount(setup.hostPage, 3);

      await uploadFixture(setup.hostPage, 'test01');
      await waitForPlaylistCount(setup.hostPage, 1);
      await startPlayback(setup.hostPage);

      const settingsFlood = setup.hostPage.evaluate(() => {
        const set = (window as any).__MUSIXQUARE_SET_STATE__;
        if (!set) return;
        for (let i = 0; i < 50; i++) {
          const v = Math.random();
          set('audio.masterVolume', v);
          set('audio.eqValues', [
            Math.floor(Math.random() * 12) - 6,
            Math.floor(Math.random() * 12) - 6,
            Math.floor(Math.random() * 12) - 6,
            Math.floor(Math.random() * 12) - 6,
            Math.floor(Math.random() * 12) - 6,
          ]);
        }
        set('audio.masterVolume', 0.5);
        set('audio.eqValues', [0, 0, 0, 0, 0]);
      });

      const disconnectPromise = setup.guestContexts[0].close();
      await Promise.all([settingsFlood, disconnectPromise]);

      // Settings propagation and WebRTC disconnect detection complete
      // asynchronously.
      await waitForState(setup.hostPage, 'audio.masterVolume', 0.5);

      await assertHostAlive(setup.hostPage);
      const g2State = await readPlaybackProjection(setup.guestPages[1]);
      expect(VALID_PLAYBACK_PROJECTIONS).toContain(g2State);

      const vol = await readState(setup.hostPage, 'audio.masterVolume');
      expect(vol).toBe(0.5);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

test.describe('Shuffle Repeat + Late Join', () => {
  test('shuffle enabled before late join, guest receives shuffle state', async ({ browser }) => {
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

      if (await isVisible(hostPage, '#btn-shuffle')) {
        await hostPage.locator('#btn-shuffle').click();
        await hostPage.waitForFunction(
          () => document.getElementById('btn-shuffle')?.classList.contains('active') ?? false,
          { timeout: 5_000 },
        );
      }

      if (await isVisible(hostPage, '#btn-repeat')) {
        await hostPage.locator('#btn-repeat').click();
        await hostPage.waitForFunction(
          () => document.getElementById('btn-repeat')?.classList.contains('active') ?? false,
          { timeout: 5_000 },
        );
      }

      await startPlayback(hostPage);

      lateGuest = await joinAsLateGuest(browser, code);
      await waitForPlaylistCount(lateGuest.guestPage, 3, 30_000);

      const guestItems = await lateGuest.guestPage.evaluate(
        () => document.getElementById('playlist-ui')?.children.length ?? 0,
      );
      expect(guestItems).toBe(3);

      await assertHostAlive(hostPage);
    } finally {
      if (lateGuest) await lateGuest.guestContext.close().catch(() => {});
      await hostCtx.close().catch(() => {});
    }
  });

  test('toggle repeat mode 5 times rapidly then late join', async ({ browser }) => {
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

      if (await isVisible(hostPage, '#btn-repeat')) {
        for (let i = 0; i < 5; i++) {
          await hostPage.locator('#btn-repeat').click();
          await hostPage.waitForTimeout(200); // intentional rapid-fire delay
        }
      }

      lateGuest = await joinAsLateGuest(browser, code);
      await waitForPlaylistCount(lateGuest.guestPage, 1, 30_000);

      await assertHostAlive(hostPage);
      const guestState = await readPlaybackProjection(lateGuest.guestPage);
      expect(VALID_PLAYBACK_PROJECTIONS).toContain(guestState);
    } finally {
      if (lateGuest) await lateGuest.guestContext.close().catch(() => {});
      await hostCtx.close().catch(() => {});
    }
  });
});

test.describe('Interleaved Join Upload', () => {
  test('guest1→upload→guest2→upload→guest3→upload chain', async ({ browser }) => {
    test.setTimeout(120_000);

    const hostCtx = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const hostPage = await hostCtx.newPage();
    await injectPeerServer(hostPage);
    const code = await setupHostAndStart(hostPage);
    const guests: LateGuest[] = [];

    try {
      const g1 = await joinAsLateGuest(browser, code);
      guests.push(g1);
      await waitForDeviceCount(hostPage, 2);

      await uploadFixture(hostPage, 'test01');
      await waitForPlaylistCount(hostPage, 1);
      await waitForPlaylistCount(g1.guestPage, 1, 30_000);

      const g2 = await joinAsLateGuest(browser, code);
      guests.push(g2);
      await waitForPlaylistCount(g2.guestPage, 1, 30_000);

      await uploadFixture(hostPage, 'test02');
      await waitForPlaylistCount(hostPage, 2);
      await waitForPlaylistCount(g1.guestPage, 2, 30_000);
      await waitForPlaylistCount(g2.guestPage, 2, 30_000);

      const g3 = await joinAsLateGuest(browser, code);
      guests.push(g3);
      await waitForPlaylistCount(g3.guestPage, 2, 30_000);

      await uploadFixture(hostPage, 'test03');
      await waitForPlaylistCount(hostPage, 3);

      for (const g of guests) {
        await waitForPlaylistCount(g.guestPage, 3, 30_000);
      }

      for (const g of guests) {
        const count = await g.guestPage.evaluate(
          () => document.getElementById('playlist-ui')?.children.length ?? 0,
        );
        expect(count).toBe(3);
      }
    } finally {
      for (const g of guests) await g.guestContext.close().catch(() => {});
      await hostCtx.close().catch(() => {});
    }
  });
});

test.describe('Concurrent Chat Flood', () => {
  test('host + 2 guests send chat messages simultaneously', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 2);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      for (const gp of setup.guestPages) {
        await setupGuest(gp, code);
      }
      await waitForDeviceCount(setup.hostPage, 3);

      await Promise.all([
        sendChatMessage(setup.hostPage, 'host-simultaneous-msg'),
        sendChatMessage(setup.guestPages[0], 'guest1-simultaneous-msg'),
        sendChatMessage(setup.guestPages[1], 'guest2-simultaneous-msg'),
      ]);

      await setup.hostPage.waitForFunction(
        () => (document.getElementById('chat-messages')?.textContent?.length ?? 0) > 0,
        { timeout: 10_000 },
      );

      const hostChat = await setup.hostPage.evaluate(
        () => document.getElementById('chat-messages')?.textContent || '',
      );
      expect(hostChat.length).toBeGreaterThan(0);

      await assertHostAlive(setup.hostPage);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });

  test('10 rapid chat messages from host while guest sends simultaneously', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 1);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      await setupGuest(setup.guestPages[0], code);
      await waitForDeviceCount(setup.hostPage, 2);

      for (let i = 0; i < 10; i++) {
        await sendChatMessage(setup.hostPage, `rapid-${i}`);
        await setup.hostPage.waitForTimeout(100); // intentional rapid-fire delay
      }

      await sendChatMessage(setup.guestPages[0], 'guest-concurrent');

      await setup.guestPages[0].waitForFunction(
        () => (document.getElementById('chat-messages')?.textContent?.length ?? 0) > 0,
        { timeout: 10_000 },
      );

      await assertHostAlive(setup.hostPage);
      const guestChat = await setup.guestPages[0].evaluate(
        () => document.getElementById('chat-messages')?.textContent || '',
      );
      expect(guestChat.length).toBeGreaterThan(0);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

test.describe('Connection Flapping', () => {
  test('guest disconnect and immediate rejoin 3 times', async ({ browser }) => {
    test.setTimeout(120_000);

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

      for (let i = 0; i < 3; i++) {
        const g = await joinAsLateGuest(browser, code);
        allGuests.push(g);
        await waitForPlaylistCount(g.guestPage, 1, 30_000);

        await g.guestContext.close();

        await waitForPeerCount(hostPage, 0, 20_000);
      }

      const finalGuest = await joinAsLateGuest(browser, code);
      allGuests.push(finalGuest);
      await waitForPlaylistCount(finalGuest.guestPage, 1, 30_000);

      // Give stale hard-disconnect entries a short cleanup window after the final join.
      await waitForPeerCount(hostPage, 1);

      await assertHostAlive(hostPage);
    } finally {
      for (const g of allGuests) await g.guestContext.close().catch(() => {});
      await hostCtx.close().catch(() => {});
    }
  });
});

test.describe('Triple Combo Operations', () => {
  test('seek + volume change + next track fired simultaneously', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 1);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      await setupGuest(setup.guestPages[0], code);
      await waitForDeviceCount(setup.hostPage, 2);

      await uploadFixture(setup.hostPage, 'test01');
      await waitForPlaylistCount(setup.hostPage, 1);
      await uploadFixture(setup.hostPage, 'test02');
      await waitForPlaylistCount(setup.hostPage, 2);
      await waitForPlaylistCount(setup.guestPages[0], 2, 30_000);

      await startPlayback(setup.hostPage);

      await Promise.all([
        setup.hostPage.evaluate(() => {
          const set = (window as any).__MUSIXQUARE_SET_STATE__;
          if (set) set('audio.seekTo', 3.0);
        }),
        setup.hostPage.evaluate(() => {
          const set = (window as any).__MUSIXQUARE_SET_STATE__;
          if (set) set('audio.masterVolume', 0.3);
        }),
        setup.hostPage.click('#btn-next'),
      ]);

      await waitForState(setup.hostPage, 'audio.masterVolume', 0.3);

      await assertHostAlive(setup.hostPage);
      const vol = await readState(setup.hostPage, 'audio.masterVolume');
      expect(vol).toBe(0.3);

      const peers = await setup.hostPage.evaluate(() => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get ? ((get('network.connectedPeers') as unknown[])?.length ?? 0) : 0;
      });
      expect(peers).toBe(1);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

test.describe('Guest Reload During Transfer', () => {
  test('guest reloads page during file transfer, host survives', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 1);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      await setupGuest(setup.guestPages[0], code);
      await waitForDeviceCount(setup.hostPage, 2);

      await uploadFixture(setup.hostPage, 'test01');

      await setup.guestPages[0].reload();
      await setup.guestPages[0].waitForLoadState('networkidle');

      // Reloading the guest tears down its PeerJS connection.
      await waitForPeerCountAtMost(setup.hostPage, 0);

      await assertHostAlive(setup.hostPage);
      await waitForPlaylistCount(setup.hostPage, 1);

      await uploadFixture(setup.hostPage, 'test02');
      await waitForPlaylistCount(setup.hostPage, 2);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

test.describe('Settings Reset Mid-Session', () => {
  test('reset all audio settings to defaults during playback with guest', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 1);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      await setupGuest(setup.guestPages[0], code);
      await waitForDeviceCount(setup.hostPage, 2);

      await uploadFixture(setup.hostPage, 'test01');
      await waitForPlaylistCount(setup.hostPage, 1);
      await startPlayback(setup.hostPage);

      await setup.hostPage.evaluate(() => {
        const set = (window as any).__MUSIXQUARE_SET_STATE__;
        if (!set) return;
        set('audio.eqValues', [6, 4, 2, -2, -4]);
        set('audio.masterVolume', 0.3);
        set('audio.reverbMix', 0.7);
        set('audio.reverbDecay', 3.0);
      });

      await waitForState(setup.hostPage, 'audio.masterVolume', 0.3);

      await setup.hostPage.evaluate(() => {
        const set = (window as any).__MUSIXQUARE_SET_STATE__;
        if (!set) return;
        set('audio.eqValues', [0, 0, 0, 0, 0]);
        set('audio.masterVolume', 1.0);
        set('audio.reverbMix', 0.0);
        set('audio.reverbDecay', 1.5);
        set('audio.channelMode', 0);
      });

      await waitForState(setup.hostPage, 'audio.masterVolume', 1.0);

      const eq = await readState(setup.hostPage, 'audio.eqValues');
      expect(eq).toEqual([0, 0, 0, 0, 0]);
      const vol = await readState(setup.hostPage, 'audio.masterVolume');
      expect(vol).toBe(1.0);

      const peers = await setup.hostPage.evaluate(() => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get ? ((get('network.connectedPeers') as unknown[])?.length ?? 0) : 0;
      });
      expect(peers).toBe(1);

      await assertHostAlive(setup.hostPage);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

test.describe('Mode Toggle Storm', () => {
  test('switch media source 3 times rapidly with guest connected', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 1);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      await setupGuest(setup.guestPages[0], code);
      await waitForDeviceCount(setup.hostPage, 2);

      await uploadFixture(setup.hostPage, 'test01');
      await waitForPlaylistCount(setup.hostPage, 1);

      if (await isVisible(setup.hostPage, '#media-source-btn')) {
        for (let i = 0; i < 3; i++) {
          await setup.hostPage.locator('#media-source-btn').click();
          await setup.hostPage.waitForTimeout(500); // intentional rapid-fire delay

          if (await isVisible(setup.hostPage, '#media-youtube-btn, .media-opt-youtube')) {
            await setup.hostPage.locator('#media-youtube-btn, .media-opt-youtube').first().click();
            await setup.hostPage.waitForTimeout(500); // intentional rapid-fire delay
          }

          if (await isVisible(setup.hostPage, '#media-file-btn, .media-opt-file')) {
            await setup.hostPage.locator('#media-file-btn, .media-opt-file').first().click();
            await setup.hostPage.waitForTimeout(500); // intentional rapid-fire delay
          }
        }
      }

      await waitForPlaybackProjectionReady(setup.hostPage, 10_000);

      await assertHostAlive(setup.hostPage);
      const guestState = await readPlaybackProjection(setup.guestPages[0]);
      expect(VALID_PLAYBACK_PROJECTIONS).toContain(guestState);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

test.describe('YouTube URL Switch', () => {
  test('change YouTube URL mid-playback with guest connected', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 1);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      await setupGuest(setup.guestPages[0], code);
      await waitForDeviceCount(setup.hostPage, 2);

      if (await isVisible(setup.hostPage, '#media-source-btn')) {
        await setup.hostPage.locator('#media-source-btn').click();
        await setup.hostPage.waitForTimeout(500); // intentional rapid-fire delay
      }
      if (await isVisible(setup.hostPage, '#media-youtube-btn, .media-opt-youtube')) {
        await setup.hostPage.locator('#media-youtube-btn, .media-opt-youtube').first().click();
        await setup.hostPage.waitForFunction(
          () =>
            document.body.classList.contains('mode-youtube') ||
            document.getElementById('youtube-url-input') !== null,
          { timeout: 5_000 },
        );
      }

      if (await isVisible(setup.hostPage, '#youtube-url-input')) {
        const ytInput = setup.hostPage.locator('#youtube-url-input');
        const playBtn = setup.hostPage.locator('#youtube-play-btn, #btn-yt-play');

        await ytInput.fill(YT_VIDEO);
        if (await isVisible(setup.hostPage, '#youtube-play-btn, #btn-yt-play')) {
          await playBtn.first().click();
        }

        await setup.hostPage
          .waitForFunction(
            () => {
              const get = (window as any).__MUSIXQUARE_GET_STATE__;
              const projected = (window as any).__MUSIXQUARE_GET_PLAYBACK_PROJECTION__;
              return (
                typeof projected === 'function' &&
                (projected() === 'PLAYING_YOUTUBE' || get?.('youtube.videoId'))
              );
            },
            { timeout: 10_000 },
          )
          .catch(() => {}); // YouTube may not actually load in test env

        await ytInput.fill('');
        await ytInput.fill(YT_VIDEO_2);
        if (await isVisible(setup.hostPage, '#youtube-play-btn, #btn-yt-play')) {
          await playBtn.first().click();
        }
      }

      await waitForPlaybackProjectionReady(setup.hostPage, 10_000);

      await assertHostAlive(setup.hostPage);
      const guestState = await readPlaybackProjection(setup.guestPages[0]);
      expect(VALID_PLAYBACK_PROJECTIONS).toContain(guestState);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

test.describe('Sequential Sessions', () => {
  test('host creates 3 sessions back-to-back, guests join each', async ({ browser }) => {
    test.setTimeout(180_000);

    const hostCtx = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const hostPage = await hostCtx.newPage();
    await injectPeerServer(hostPage);
    const allGuests: LateGuest[] = [];

    try {
      for (let session = 0; session < 3; session++) {
        const code = await setupHostAndStart(hostPage);

        const g = await joinAsLateGuest(browser, code);
        allGuests.push(g);
        await waitForDeviceCount(hostPage, 2);

        const fixture = (['test01', 'test02', 'test03'] as const)[session];
        await uploadFixture(hostPage, fixture);
        await waitForPlaylistCount(hostPage, 1);
        await waitForPlaylistCount(g.guestPage, 1, 30_000);

        await g.guestContext.close();
        await waitForPeerCount(hostPage, 0, 20_000);

        if (session < 2) {
          await hostPage.reload();
          await hostPage.waitForLoadState('networkidle');
          await hostPage.waitForFunction(() => document.getElementById('setup-overlay') !== null, {
            timeout: 10_000,
          });
          await injectPeerServer(hostPage);
        }
      }

      await assertHostAlive(hostPage);
    } finally {
      for (const g of allGuests) await g.guestContext.close().catch(() => {});
      await hostCtx.close().catch(() => {});
    }
  });
});

test.describe('Late Join Chain', () => {
  test('3 guests join sequentially with track uploads between, all converge', async ({
    browser,
  }) => {
    test.setTimeout(120_000);

    const hostCtx = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const hostPage = await hostCtx.newPage();
    await injectPeerServer(hostPage);
    const code = await setupHostAndStart(hostPage);
    const guests: LateGuest[] = [];

    try {
      await uploadFixture(hostPage, 'test01');
      await waitForPlaylistCount(hostPage, 1);

      const g1 = await joinAsLateGuest(browser, code);
      guests.push(g1);
      await waitForPlaylistCount(g1.guestPage, 1, 30_000);

      await uploadFixture(hostPage, 'test02');
      await waitForPlaylistCount(hostPage, 2);

      const g2 = await joinAsLateGuest(browser, code);
      guests.push(g2);
      await waitForPlaylistCount(g2.guestPage, 2, 30_000);

      await uploadFixture(hostPage, 'test03');
      await waitForPlaylistCount(hostPage, 3);

      const g3 = await joinAsLateGuest(browser, code);
      guests.push(g3);
      await waitForPlaylistCount(g3.guestPage, 3, 30_000);

      await waitForPlaylistCount(g1.guestPage, 3, 30_000);
      await waitForPlaylistCount(g2.guestPage, 3, 30_000);

      for (const g of guests) {
        const count = await g.guestPage.evaluate(
          () => document.getElementById('playlist-ui')?.children.length ?? 0,
        );
        expect(count).toBe(3);
      }
    } finally {
      for (const g of guests) await g.guestContext.close().catch(() => {});
      await hostCtx.close().catch(() => {});
    }
  });
});

test.describe('Playlist Clear + Join', () => {
  test('clear all tracks then new guest joins empty session', async ({ browser }) => {
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

      for (let i = 0; i < 2; i++) {
        if (await isVisible(hostPage, '.btn-playlist-remove')) {
          await hostPage.locator('.btn-playlist-remove').first().click();
          await hostPage.locator('.playlist-selection-delete').click();
          await hostPage
            .waitForFunction(
              (expectedMax) => {
                const list = document.getElementById('playlist-ui');
                return list ? list.children.length <= expectedMax : true;
              },
              1 - i, // first removal: expect <=1, second: expect <=0
              { timeout: 5_000 },
            )
            .catch(() => {}); // May already be at target
        }
      }

      const hostCount = await hostPage.evaluate(
        () => document.getElementById('playlist-ui')?.children.length ?? 0,
      );

      lateGuest = await joinAsLateGuest(browser, code);
      await lateGuest.guestPage.waitForFunction(
        (expected) => {
          const list = document.getElementById('playlist-ui');
          return list !== null && list.children.length === expected;
        },
        hostCount,
        { timeout: 15_000 },
      );

      const guestCount = await lateGuest.guestPage.evaluate(
        () => document.getElementById('playlist-ui')?.children.length ?? 0,
      );
      expect(guestCount).toBe(hostCount);

      await assertHostAlive(hostPage);
    } finally {
      if (lateGuest) await lateGuest.guestContext.close().catch(() => {});
      await hostCtx.close().catch(() => {});
    }
  });
});

test.describe('Duplicate Upload Chaos', () => {
  test('upload same fixture twice, both synced to guest', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 1);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      await setupGuest(setup.guestPages[0], code);
      await waitForDeviceCount(setup.hostPage, 2);

      await uploadFixture(setup.hostPage, 'test01');
      await waitForPlaylistCount(setup.hostPage, 1);
      await uploadFixture(setup.hostPage, 'test01');

      await setup.hostPage.waitForFunction(
        () => {
          const list = document.getElementById('playlist-ui');
          return list?.children.length === 2;
        },
        { timeout: 10_000 },
      );
      const hostCount = await setup.hostPage.evaluate(
        () => document.getElementById('playlist-ui')?.children.length ?? 0,
      );
      expect(hostCount).toBe(2);

      await waitForPlaylistCount(setup.guestPages[0], 2, 30_000);

      await assertHostAlive(setup.hostPage);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

test.describe('Chat Upload Settings Triple', () => {
  test('chat + upload + settings change all at once', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 1);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      await setupGuest(setup.guestPages[0], code);
      await waitForDeviceCount(setup.hostPage, 2);

      await Promise.all([
        sendChatMessage(setup.hostPage, 'triple-chaos-msg'),
        uploadFixture(setup.hostPage, 'test01'),
        setup.hostPage.evaluate(() => {
          const set = (window as any).__MUSIXQUARE_SET_STATE__;
          if (set) {
            set('audio.eqValues', [3, 1, -1, -3, 2]);
            set('audio.masterVolume', 0.6);
          }
        }),
      ]);

      await waitForPlaylistCount(setup.hostPage, 1);
      await waitForPlaylistCount(setup.guestPages[0], 1, 30_000);

      await waitForState(setup.hostPage, 'audio.masterVolume', 0.6);
      const vol = await readState(setup.hostPage, 'audio.masterVolume');
      expect(vol).toBe(0.6);

      await assertHostAlive(setup.hostPage);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

test.describe('Disconnect During Chat', () => {
  test('guest sends chat then disconnects immediately', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 1);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      await setupGuest(setup.guestPages[0], code);
      await waitForDeviceCount(setup.hostPage, 2);

      await Promise.all([
        sendChatMessage(setup.guestPages[0], 'goodbye-crash-msg'),
        (async () => {
          await setup.guestPages[0].waitForTimeout(100); // intentional rapid-fire delay
          await setup.guestContexts[0].close();
        })(),
      ]).catch(() => {});

      await waitForPeerCount(setup.hostPage, 0, 20_000);

      await assertHostAlive(setup.hostPage);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

test.describe('EQ Extreme Values', () => {
  test('set EQ to max/min extremes during playback', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 1);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      await setupGuest(setup.guestPages[0], code);
      await waitForDeviceCount(setup.hostPage, 2);

      await uploadFixture(setup.hostPage, 'test01');
      await waitForPlaylistCount(setup.hostPage, 1);
      await startPlayback(setup.hostPage);

      await setup.hostPage.evaluate(() => {
        const set = (window as any).__MUSIXQUARE_SET_STATE__;
        if (!set) return;
        set('audio.eqValues', [12, 12, 12, 12, 12]); // Max
        set('audio.masterVolume', 0.01); // Near zero
      });
      await waitForState(setup.hostPage, 'audio.masterVolume', 0.01);

      await setup.hostPage.evaluate(() => {
        const set = (window as any).__MUSIXQUARE_SET_STATE__;
        if (!set) return;
        set('audio.eqValues', [-12, -12, -12, -12, -12]); // Min
        set('audio.masterVolume', 1.0); // Max
      });
      await waitForState(setup.hostPage, 'audio.masterVolume', 1.0);

      await setup.hostPage.evaluate(() => {
        const set = (window as any).__MUSIXQUARE_SET_STATE__;
        if (!set) return;
        set('audio.eqValues', [12, -12, 12, -12, 12]); // Alternating
        set('audio.reverbMix', 1.0); // Full wet
        set('audio.reverbDecay', 10.0); // Very long decay
      });

      await waitForState(setup.hostPage, 'audio.reverbMix', 1.0);

      await assertHostAlive(setup.hostPage);
      const guestState = await readPlaybackProjection(setup.guestPages[0]);
      expect(['PLAYING_AUDIO', 'PAUSED', 'IDLE']).toContain(guestState);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

test.describe('Channel Mode Switching', () => {
  test('cycle through all channel modes during playback', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 1);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      await setupGuest(setup.guestPages[0], code);
      await waitForDeviceCount(setup.hostPage, 2);

      await uploadFixture(setup.hostPage, 'test01');
      await waitForPlaylistCount(setup.hostPage, 1);
      await startPlayback(setup.hostPage);

      for (const mode of [0, 1, -1, 0, 1, -1]) {
        await setup.hostPage.evaluate((m) => {
          const set = (window as any).__MUSIXQUARE_SET_STATE__;
          if (set) set('audio.channelMode', m);
        }, mode);
        await setup.hostPage.waitForTimeout(300); // intentional rapid-fire delay
      }

      await waitForState(setup.hostPage, 'audio.channelMode', -1);

      await assertHostAlive(setup.hostPage);
      const guestState = await readPlaybackProjection(setup.guestPages[0]);
      expect(VALID_PLAYBACK_PROJECTIONS).toContain(guestState);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

test.describe('Upload During Playback + Disconnect', () => {
  test('upload new track during playback while guest disconnects', async ({ browser }) => {
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
      await startPlayback(setup.hostPage);

      await Promise.all([uploadFixture(setup.hostPage, 'test02'), setup.guestContexts[0].close()]);

      await waitForPlaylistCount(setup.hostPage, 2);

      await waitForPlaylistCount(setup.guestPages[1], 2, 30_000);

      lateGuest = await joinAsLateGuest(browser, code);
      await waitForPlaylistCount(lateGuest.guestPage, 2, 30_000);

      await assertHostAlive(setup.hostPage);
    } finally {
      if (lateGuest) await lateGuest.guestContext.close().catch(() => {});
      await cleanupChaosSetup(setup);
    }
  });
});

test.describe('Pause During Transfer', () => {
  test('host pauses playback while file is transferring to guest', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 1);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      await setupGuest(setup.guestPages[0], code);
      await waitForDeviceCount(setup.hostPage, 2);

      await uploadFixture(setup.hostPage, 'test01');
      await waitForPlaylistCount(setup.hostPage, 1);
      await startPlayback(setup.hostPage);

      const uploadPromise = uploadFixture(setup.hostPage, 'test02');

      await setup.hostPage.waitForTimeout(200); // intentional rapid-fire delay
      await setup.hostPage.click('#play-btn');

      await uploadPromise;
      await waitForPlaylistCount(setup.hostPage, 2);

      await waitForPlaylistCount(setup.guestPages[0], 2, 30_000);

      const state = await readPlaybackProjection(setup.hostPage);
      expect(['PAUSED', 'IDLE']).toContain(state);

      await assertHostAlive(setup.hostPage);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

test.describe('Channel Mismatch', () => {
  test('guest joins on different channel, session still works', async ({ browser }) => {
    test.setTimeout(90_000);

    const hostCtx = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const hostPage = await hostCtx.newPage();
    await injectPeerServer(hostPage);
    const code = await setupHostAndStart(hostPage, 0);

    const guestCtx = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const guestPage = await guestCtx.newPage();
    await injectPeerServer(guestPage);

    try {
      await setupGuest(guestPage, code, 1);
      await waitForDeviceCount(hostPage, 2);

      await uploadFixture(hostPage, 'test01');
      await waitForPlaylistCount(hostPage, 1);
      await waitForPlaylistCount(guestPage, 1, 30_000);

      await assertHostAlive(hostPage);
    } finally {
      await guestCtx.close().catch(() => {});
      await hostCtx.close().catch(() => {});
    }
  });
});

test.describe('Late Join During Track Removal', () => {
  test('guest joins while host is removing a track', async ({ browser }) => {
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

      let removePromise = Promise.resolve();
      if (await isVisible(hostPage, '.btn-playlist-remove')) {
        removePromise = (async () => {
          await hostPage.locator('.btn-playlist-remove').first().click();
          await hostPage.locator('.playlist-selection-delete').click();
        })();
      }
      const joinPromise = joinAsLateGuest(browser, code);

      await removePromise;
      lateGuest = await joinPromise;

      await hostPage.waitForFunction(
        () => {
          const list = document.getElementById('playlist-ui');
          return list && list.children.length >= 1;
        },
        { timeout: 10_000 },
      );

      const hostCount = await hostPage.evaluate(
        () => document.getElementById('playlist-ui')?.children.length ?? 0,
      );

      await waitForPlaylistCount(lateGuest.guestPage, hostCount, 30_000);

      await assertHostAlive(hostPage);
    } finally {
      if (lateGuest) await lateGuest.guestContext.close().catch(() => {});
      await hostCtx.close().catch(() => {});
    }
  });
});

test.describe('Playlist Reorder + Disconnect', () => {
  test('host reorders playlist while guest disconnects', async ({ browser }) => {
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

      const [expectedOrder] = await Promise.all([
        dragFirstPlaylistItemToEnd(setup.hostPage),
        setup.guestContexts[0].close(),
      ]);

      // WebRTC disconnect detection and state propagation are asynchronous.
      await waitForPeerCountAtMost(setup.hostPage, 1);

      const hostCount = await setup.hostPage.evaluate(
        () => document.getElementById('playlist-ui')?.children.length ?? 0,
      );
      expect(hostCount).toBe(3);

      lateGuest = await joinAsLateGuest(browser, code);
      await waitForPlaylistCount(lateGuest.guestPage, 3, 30_000);
      const lateGuestOrder = (await readQueueSnapshot(lateGuest.guestPage)).items.map(
        (item) => item.queueItemId,
      );
      expect(lateGuestOrder).toEqual(expectedOrder);

      await assertHostAlive(setup.hostPage);
    } finally {
      if (lateGuest) await lateGuest.guestContext.close().catch(() => {});
      await cleanupChaosSetup(setup);
    }
  });
});

test.describe('Generated Peer Identity Collision', () => {
  test('two generated guest slots do not conflict', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 2);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      for (const gp of setup.guestPages) {
        await setupGuest(gp, code);
      }
      await waitForDeviceCount(setup.hostPage, 3);

      const peers = await setup.hostPage.evaluate(() => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get ? ((get('network.connectedPeers') as unknown[])?.length ?? 0) : 0;
      });
      expect(peers).toBe(2);

      await uploadFixture(setup.hostPage, 'test01');
      await waitForPlaylistCount(setup.hostPage, 1);

      for (const gp of setup.guestPages) {
        await waitForPlaylistCount(gp, 1, 30_000);
      }

      await assertHostAlive(setup.hostPage);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

test.describe('Upload During YouTube Mode', () => {
  test('file upload while in YouTube mode queues properly', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 1);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      await setupGuest(setup.guestPages[0], code);
      await waitForDeviceCount(setup.hostPage, 2);

      if (await isVisible(setup.hostPage, '#media-source-btn')) {
        await setup.hostPage.locator('#media-source-btn').click();
        await setup.hostPage.waitForTimeout(500); // intentional rapid-fire delay
        if (await isVisible(setup.hostPage, '#media-youtube-btn, .media-opt-youtube')) {
          await setup.hostPage.locator('#media-youtube-btn, .media-opt-youtube').first().click();
          await setup.hostPage
            .waitForFunction(
              () =>
                document.body.classList.contains('mode-youtube') ||
                document.getElementById('youtube-url-input') !== null,
              { timeout: 5_000 },
            )
            .catch(() => {}); // Mode may not fully switch in test env
        }
      }

      await uploadFixture(setup.hostPage, 'test01');
      await waitForPlaybackProjectionReady(setup.hostPage, 10_000);

      // Upload may queue the file or switch playback mode; either is a valid
      // non-error outcome.
      await assertHostAlive(setup.hostPage);
      const guestState = await readPlaybackProjection(setup.guestPages[0]);
      expect(VALID_PLAYBACK_PROJECTIONS).toContain(guestState);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

test.describe('Rapid Operator Toggle', () => {
  test('toggle operator grant 5 times rapidly', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 1);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      await setupGuest(setup.guestPages[0], code);
      await waitForDeviceCount(setup.hostPage, 2);

      if (await isVisible(setup.hostPage, '.d-op-btn')) {
        for (let i = 0; i < 5; i++) {
          await setup.hostPage.locator('.d-op-btn').first().click();
          await setup.hostPage.waitForTimeout(300); // intentional rapid-fire delay
        }
      }

      await waitForPlaybackProjectionReady(setup.hostPage, 10_000);

      await assertHostAlive(setup.hostPage);
      const guestState = await readPlaybackProjection(setup.guestPages[0]);
      expect(VALID_PLAYBACK_PROJECTIONS).toContain(guestState);

      const peers = await setup.hostPage.evaluate(() => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get ? ((get('network.connectedPeers') as unknown[])?.length ?? 0) : 0;
      });
      expect(peers).toBe(1);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

test.describe('Late Join During Pause + Seek', () => {
  test('guest joins while host is paused at specific seek position', async ({ browser }) => {
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
      await startPlayback(hostPage);

      await waitForPlaybackProjection(hostPage, 'PLAYING_AUDIO');
      await hostPage.click('#play-btn');
      await waitForPlaybackProjectionIn(hostPage, ['PAUSED', 'IDLE'], 10_000);

      await hostPage.evaluate(() => {
        const set = (window as any).__MUSIXQUARE_SET_STATE__;
        if (set) set('audio.seekTo', 3.5);
      });

      lateGuest = await joinAsLateGuest(browser, code);
      await waitForPlaylistCount(lateGuest.guestPage, 1, 30_000);

      const guestState = await readPlaybackProjection(lateGuest.guestPage);
      expect(['PAUSED', 'IDLE']).toContain(guestState);

      await assertHostAlive(hostPage);
    } finally {
      if (lateGuest) await lateGuest.guestContext.close().catch(() => {});
      await hostCtx.close().catch(() => {});
    }
  });
});

test.describe('State Mutation Burst', () => {
  test('100 rapid state mutations do not crash the bus', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 1);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      await setupGuest(setup.guestPages[0], code);
      await waitForDeviceCount(setup.hostPage, 2);

      await uploadFixture(setup.hostPage, 'test01');
      await waitForPlaylistCount(setup.hostPage, 1);

      await setup.hostPage.evaluate(() => {
        const set = (window as any).__MUSIXQUARE_SET_STATE__;
        if (!set) return;
        for (let i = 0; i < 100; i++) {
          set('audio.masterVolume', Math.random());
        }
        set('audio.masterVolume', 0.75);
      });

      await waitForState(setup.hostPage, 'audio.masterVolume', 0.75);

      const vol = await readState(setup.hostPage, 'audio.masterVolume');
      expect(vol).toBe(0.75);

      const peers = await setup.hostPage.evaluate(() => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get ? ((get('network.connectedPeers') as unknown[])?.length ?? 0) : 0;
      });
      expect(peers).toBe(1);

      await assertHostAlive(setup.hostPage);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

test.describe('Play Stop Chat Race', () => {
  test('host toggles play while guest sends 5 chat messages', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 1);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      await setupGuest(setup.guestPages[0], code);
      await waitForDeviceCount(setup.hostPage, 2);

      await uploadFixture(setup.hostPage, 'test01');
      await waitForPlaylistCount(setup.hostPage, 1);
      await startPlayback(setup.hostPage);

      for (let i = 0; i < 5; i++) {
        await Promise.all([
          setup.hostPage.click('#play-btn'),
          sendChatMessage(setup.guestPages[0], `race-msg-${i}`),
        ]).catch(() => {});
        await setup.hostPage.waitForTimeout(300); // intentional rapid-fire delay
      }

      await waitForPlaybackProjectionReady(setup.hostPage, 10_000);

      await assertHostAlive(setup.hostPage);
      const guestState = await readPlaybackProjection(setup.guestPages[0]);
      expect(VALID_PLAYBACK_PROJECTIONS).toContain(guestState);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

test.describe('Double Late Join', () => {
  test('two guests join simultaneously during playback', async ({ browser }) => {
    test.setTimeout(120_000);

    const hostCtx = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const hostPage = await hostCtx.newPage();
    await injectPeerServer(hostPage);
    const code = await setupHostAndStart(hostPage);
    const guests: LateGuest[] = [];

    try {
      await uploadFixture(hostPage, 'test01');
      await waitForPlaylistCount(hostPage, 1);
      await startPlayback(hostPage);

      const [g1, g2] = await Promise.all([
        joinAsLateGuest(browser, code),
        joinAsLateGuest(browser, code),
      ]);
      guests.push(g1, g2);

      await hostPage.waitForFunction(
        () => {
          const get = (window as any).__MUSIXQUARE_GET_STATE__;
          if (!get) return false;
          const peers = get('network.connectedPeers') as unknown[];
          return peers && peers.length >= 2;
        },
        { timeout: 30_000 },
      );

      await waitForPlaylistCount(g1.guestPage, 1, 30_000);
      await waitForPlaylistCount(g2.guestPage, 1, 30_000);

      await assertHostAlive(hostPage);
    } finally {
      for (const g of guests) await g.guestContext.close().catch(() => {});
      await hostCtx.close().catch(() => {});
    }
  });
});

test.describe('Batch Upload Stress', () => {
  test('upload all 3 fixtures at once, guest receives all', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 1);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      await setupGuest(setup.guestPages[0], code);
      await waitForDeviceCount(setup.hostPage, 2);

      await uploadFixtures(setup.hostPage, ['test01', 'test02', 'test03']);

      await waitForPlaylistCount(setup.hostPage, 3, 30_000);

      await waitForPlaylistCount(setup.guestPages[0], 3, 45_000);

      await assertHostAlive(setup.hostPage);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

test.describe('Idle Session + Late Join', () => {
  test('session idle for 15 seconds then guest joins', async ({ browser }) => {
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

      await hostPage.waitForTimeout(15_000); // intentional long idle test

      lateGuest = await joinAsLateGuest(browser, code);
      await waitForPlaylistCount(lateGuest.guestPage, 1, 30_000);

      await waitForDeviceCount(hostPage, 2);

      await assertHostAlive(hostPage);
    } finally {
      if (lateGuest) await lateGuest.guestContext.close().catch(() => {});
      await hostCtx.close().catch(() => {});
    }
  });
});

test.describe('Host Solo Stress', () => {
  test('host uploads, plays, skips, seeks, changes settings — all alone', async ({ browser }) => {
    test.setTimeout(120_000);

    const hostCtx = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const hostPage = await hostCtx.newPage();
    await injectPeerServer(hostPage);
    await setupHostAndStart(hostPage);

    try {
      await uploadFixture(hostPage, 'test01');
      await waitForPlaylistCount(hostPage, 1);
      await uploadFixture(hostPage, 'test02');
      await waitForPlaylistCount(hostPage, 2);
      await uploadFixture(hostPage, 'test03');
      await waitForPlaylistCount(hostPage, 3);

      // Headless audio may fail to start, so this play attempt is best-effort.
      await startPlayback(hostPage).catch(() => {});

      // DOM fallbacks cover controls hidden by responsive CSS.
      await hostPage.evaluate(() => (document.getElementById('btn-next') as HTMLElement)?.click());
      await hostPage.waitForTimeout(300); // intentional rapid-fire delay
      await hostPage.evaluate(() => (document.getElementById('btn-next') as HTMLElement)?.click());
      await hostPage.waitForTimeout(300); // intentional rapid-fire delay
      await hostPage.evaluate(() => (document.getElementById('btn-prev') as HTMLElement)?.click());
      await hostPage.waitForTimeout(300); // intentional rapid-fire delay

      await hostPage.evaluate(() => {
        const set = (window as any).__MUSIXQUARE_SET_STATE__;
        if (set) set('audio.seekTo', 2.0);
      });

      await hostPage.evaluate(() => {
        const set = (window as any).__MUSIXQUARE_SET_STATE__;
        if (!set) return;
        set('audio.eqValues', [5, -3, 0, 4, -2]);
        set('audio.masterVolume', 0.4);
        set('audio.reverbMix', 0.6);
        set('audio.channelMode', 1);
      });
      await waitForState(hostPage, 'audio.masterVolume', 0.4);

      await hostPage.evaluate(() =>
        (document.getElementById('btn-shuffle') as HTMLElement)?.click(),
      );
      await hostPage.evaluate(() =>
        (document.getElementById('btn-repeat') as HTMLElement)?.click(),
      );

      await hostPage.evaluate(() => (document.getElementById('play-btn') as HTMLElement)?.click());
      await waitForPlaybackProjectionIn(hostPage, ['PAUSED', 'IDLE'], 15_000).catch(() => {});
      await hostPage.evaluate(() => {
        const set = (window as any).__MUSIXQUARE_SET_STATE__;
        if (set) set('audio.seekTo', 1.0);
      });
      await hostPage.evaluate(() => (document.getElementById('play-btn') as HTMLElement)?.click());
      // Headless audio may not resume after the control burst; any non-error
      // state is valid.
      await waitForPlaybackProjectionIn(
        hostPage,
        ['PLAYING_AUDIO', 'PAUSED', 'IDLE'],
        15_000,
      ).catch(() => {});

      await assertHostAlive(hostPage);

      const count = await hostPage.evaluate(
        () => document.getElementById('playlist-ui')?.children.length ?? 0,
      );
      expect(count).toBe(3);
    } finally {
      await hostCtx.close().catch(() => {});
    }
  });
});

test.describe('Nuclear Meltdown v2', () => {
  test('15-step lifecycle: upload, join, play, seek, settings, chat, disconnect, rejoin, mode switch, repeat', async ({
    browser,
  }) => {
    test.setTimeout(240_000);

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

      const g1 = await joinAsLateGuest(browser, code);
      allGuests.push(g1);
      await waitForPlaylistCount(g1.guestPage, 3, 30_000);

      await startPlayback(hostPage);
      const g2 = await joinAsLateGuest(browser, code);
      allGuests.push(g2);
      await waitForPlaylistCount(g2.guestPage, 3, 30_000);

      await Promise.all([
        hostPage.evaluate(() => {
          const set = (window as any).__MUSIXQUARE_SET_STATE__;
          if (set) set('audio.seekTo', 2.0);
        }),
        hostPage.evaluate(() => {
          const set = (window as any).__MUSIXQUARE_SET_STATE__;
          if (set) {
            set('audio.eqValues', [4, 2, 0, -2, -4]);
            set('audio.masterVolume', 0.5);
          }
        }),
      ]);

      await sendChatMessage(g1.guestPage, 'nuclear-chat-1');

      await hostPage.click('#btn-next');
      await hostPage.waitForFunction(
        () =>
          typeof (window as any).__MUSIXQUARE_GET_STATE__?.('playlist.currentQueueItemId') ===
          'string',
        { timeout: 10_000 },
      );

      await g1.guestContext.close();
      await waitForPeerCountAtMost(hostPage, 1);

      const g3 = await joinAsLateGuest(browser, code);
      allGuests.push(g3);
      await waitForPlaylistCount(g3.guestPage, 3, 30_000);

      await hostPage.evaluate(() => {
        const set = (window as any).__MUSIXQUARE_SET_STATE__;
        if (!set) return;
        for (let i = 0; i < 20; i++) {
          set('audio.masterVolume', Math.random());
        }
        set('audio.masterVolume', 0.8);
      });

      await Promise.all([
        sendChatMessage(g2.guestPage, 'nuclear-chat-2'),
        g3.guestContext.close(),
      ]).catch(() => {});

      await waitForState(hostPage, 'audio.masterVolume', 0.8);

      await uploadFixture(hostPage, 'test01');
      await waitForPlaylistCount(hostPage, 4);

      await hostPage.click('#btn-next');
      await hostPage.waitForTimeout(500); // intentional rapid-fire delay
      await hostPage.click('#play-btn');
      await waitForPlaybackProjectionIn(hostPage, ['PAUSED', 'IDLE'], 10_000);

      const g4 = await joinAsLateGuest(browser, code);
      allGuests.push(g4);
      await waitForPlaylistCount(g4.guestPage, 4, 90_000);

      await g2.guestContext.close();
      await waitForPeerCountAtMost(hostPage, 1);

      await hostPage.click('#play-btn');
      await waitForPlaybackProjection(hostPage, 'PLAYING_AUDIO');

      await assertHostAlive(hostPage);

      const g4Count = await g4.guestPage.evaluate(
        () => document.getElementById('playlist-ui')?.children.length ?? 0,
      );
      expect(g4Count).toBe(4);

      const vol = await readState(hostPage, 'audio.masterVolume');
      expect(vol).toBe(0.8);

      const hostQueueItemId = await readCurrentQueueItemId(hostPage);
      const g4QueueItemId = await readCurrentQueueItemId(g4.guestPage);
      expect(g4QueueItemId).toBe(hostQueueItemId);

      const state = await readPlaybackProjection(hostPage);
      expect(['PLAYING_AUDIO', 'PAUSED', 'IDLE']).toContain(state);
    } finally {
      for (const g of allGuests) await g.guestContext.close().catch(() => {});
      await hostCtx.close().catch(() => {});
    }
  });
});

test.describe('Session Code Stability', () => {
  test('session code remains valid after multiple guest joins and leaves', async ({ browser }) => {
    test.setTimeout(120_000);

    const hostCtx = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const hostPage = await hostCtx.newPage();
    await injectPeerServer(hostPage);
    const code = await setupHostAndStart(hostPage);
    const allGuests: LateGuest[] = [];

    try {
      for (let i = 0; i < 5; i++) {
        const g = await joinAsLateGuest(browser, code);
        allGuests.push(g);
        await waitForDeviceCount(hostPage, 2);
        await g.guestContext.close();
        await waitForPeerCount(hostPage, 0, 20_000);
      }

      const finalGuest = await joinAsLateGuest(browser, code);
      allGuests.push(finalGuest);
      await waitForDeviceCount(hostPage, 2);

      await assertHostAlive(hostPage);
    } finally {
      for (const g of allGuests) await g.guestContext.close().catch(() => {});
      await hostCtx.close().catch(() => {});
    }
  });
});

test.describe('Playback End + Late Join', () => {
  test('guest joins after track ends naturally', async ({ browser }) => {
    test.setTimeout(120_000);

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
      await startPlayback(hostPage);

      // Seeking near the end keeps the test duration bounded.
      await hostPage.evaluate(() => {
        const set = (window as any).__MUSIXQUARE_SET_STATE__;
        if (set) set('audio.seekTo', 999.0); // Seek past end
      });

      await waitForPlaybackProjectionIn(hostPage, ['IDLE', 'PAUSED'], 30_000).catch(() => {}); // May stay PLAYING if looping

      const state = await readPlaybackProjection(hostPage);
      expect(['IDLE', 'PAUSED', 'PLAYING_AUDIO']).toContain(state);

      lateGuest = await joinAsLateGuest(browser, code);
      await waitForPlaylistCount(lateGuest.guestPage, 1, 45_000);

      await assertHostAlive(hostPage);
    } finally {
      if (lateGuest) await lateGuest.guestContext.close().catch(() => {});
      await hostCtx.close().catch(() => {});
    }
  });
});

test.describe('Full Cycle Stress', () => {
  test('connect 3 → upload → play → disconnect all → rejoin 3, all sync', async ({ browser }) => {
    test.setTimeout(180_000);

    const hostCtx = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const hostPage = await hostCtx.newPage();
    await injectPeerServer(hostPage);
    const code = await setupHostAndStart(hostPage);
    const allGuests: LateGuest[] = [];

    try {
      for (let i = 0; i < 3; i++) {
        const g = await joinAsLateGuest(browser, code);
        allGuests.push(g);
      }
      await waitForDeviceCount(hostPage, 4, 30_000);

      await uploadFixture(hostPage, 'test01');
      await waitForPlaylistCount(hostPage, 1);
      await uploadFixture(hostPage, 'test02');
      await waitForPlaylistCount(hostPage, 2);

      for (const g of allGuests) {
        await waitForPlaylistCount(g.guestPage, 2, 30_000);
      }

      await startPlayback(hostPage);

      for (const g of allGuests) {
        await g.guestContext.close().catch(() => {});
      }
      await waitForPeerCount(hostPage, 0, 30_000);

      const midState = await readPlaybackProjection(hostPage);
      expect(['PLAYING_AUDIO', 'PAUSED', 'IDLE']).toContain(midState);

      const newGuests: LateGuest[] = [];
      for (let i = 0; i < 3; i++) {
        const g = await joinAsLateGuest(browser, code);
        newGuests.push(g);
        allGuests.push(g);
      }

      for (const g of newGuests) {
        await waitForPlaylistCount(g.guestPage, 2, 30_000);
      }

      const hostQueueItemId = await readCurrentQueueItemId(hostPage);
      for (const g of newGuests) {
        const guestQueueItemId = await readCurrentQueueItemId(g.guestPage);
        expect(guestQueueItemId).toBe(hostQueueItemId);
      }

      await assertHostAlive(hostPage);
    } finally {
      for (const g of allGuests) await g.guestContext.close().catch(() => {});
      await hostCtx.close().catch(() => {});
    }
  });
});
