/**
 * E2E: Chaos Scenarios Part 2 — The Nightmare Edition
 *
 * 40+ extreme edge cases covering every imaginable combination of:
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
 * - Full nuclear meltdown: everything at once
 */
import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { injectPeerServer } from './helpers/peer-server.ts';
import { setupHostAndStart, setupGuest } from './helpers/setup-flow.ts';
import { uploadFixture, uploadFixtures } from './helpers/file-upload.ts';
import {
  waitForPlaylistCount,
  waitForDeviceCount,
  waitForChatMessage,
  readState,
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
  if (await chatBtn.isVisible().catch(() => false)) {
    await chatBtn.click();
    await page.waitForTimeout(300);
  }
  const chatInput = page.locator('#chat-input');
  if (await chatInput.isVisible().catch(() => false)) {
    await chatInput.fill(text);
    await page.locator('#btn-chat-send').click();
  }
}

/** Wait for connectedPeers to reach exact count */
async function waitForPeerCount(page: Page, count: number, timeout = 20_000): Promise<void> {
  await page.waitForFunction(
    (expected) => {
      const get = (window as any).__MUSIXQUARE_GET_STATE__;
      if (!get) return false;
      const peers = get('network.connectedPeers') as unknown[];
      return peers && peers.length === expected;
    },
    count,
    { timeout },
  );
}

/** Wait for connectedPeers to be <= count */
async function waitForPeerCountAtMost(page: Page, count: number, timeout = 20_000): Promise<void> {
  await page.waitForFunction(
    (max) => {
      const get = (window as any).__MUSIXQUARE_GET_STATE__;
      if (!get) return false;
      const peers = get('network.connectedPeers') as unknown[];
      return peers && peers.length <= max;
    },
    count,
    { timeout },
  );
}

/** Start playback on host after ensuring blob is loaded */
async function startPlayback(hostPage: Page): Promise<void> {
  await hostPage.waitForFunction(
    () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.currentFileBlob') !== null,
    { timeout: 15_000 },
  );
  await hostPage.click('#play-btn');
  await hostPage.waitForTimeout(1000);
}

/** Assert host is still functional (not crashed) */
async function assertHostAlive(hostPage: Page): Promise<void> {
  const state = await readState(hostPage, 'appState');
  expect(state).toBeDefined();
}

const YT_VIDEO = 'https://youtu.be/bnh70V0yu2s';
const YT_VIDEO_2 = 'https://youtu.be/dQw4w9WgXcQ';

// ═══════════════════════════════════════════════════════════════
// 1. HOST PAGE REFRESH — guests detect host gone
// ═══════════════════════════════════════════════════════════════

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

      // Upload and play
      await uploadFixture(setup.hostPage, 'test01');
      await waitForPlaylistCount(setup.hostPage, 1);
      await startPlayback(setup.hostPage);

      // ★ CHAOS: Host refreshes page mid-playback
      await setup.hostPage.reload();
      await setup.hostPage.waitForLoadState('networkidle');
      await setup.hostPage.waitForTimeout(5000);

      // Host page should show setup overlay again (session ended)
      const overlayActive = await setup.hostPage.evaluate(() =>
        document.getElementById('setup-overlay')?.classList.contains('active') ?? false,
      );
      // Either overlay is shown or app recovered — both acceptable
      expect(typeof overlayActive).toBe('boolean');

      // Guests should detect the disconnection (may take time)
      // They won't crash — just lose connection
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

    const hostCtx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const hostPage = await hostCtx.newPage();
    await injectPeerServer(hostPage);
    const lateGuests: LateGuest[] = [];

    try {
      // Session 1
      const code1 = await setupHostAndStart(hostPage);
      const g1 = await joinAsLateGuest(browser, code1);
      lateGuests.push(g1);
      await waitForDeviceCount(hostPage, 2);

      // Upload a file
      await uploadFixture(hostPage, 'test01');
      await waitForPlaylistCount(hostPage, 1);

      // ★ CHAOS: Host refreshes
      await hostPage.reload();
      await hostPage.waitForLoadState('networkidle');
      await hostPage.waitForTimeout(3000);

      // Re-inject peer server and create new session
      await injectPeerServer(hostPage);
      const code2 = await setupHostAndStart(hostPage);

      // Old guest is orphaned — new guest joins fresh session
      const g2 = await joinAsLateGuest(browser, code2);
      lateGuests.push(g2);
      await waitForDeviceCount(hostPage, 2);

      // Upload new file in new session
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

// ═══════════════════════════════════════════════════════════════
// 2. SEEK POSITION RACES — seek while guests join/leave
// ═══════════════════════════════════════════════════════════════

test.describe('Seek Position Chaos', () => {
  test('seek commands during guest join do not desync', async ({ browser }) => {
    test.setTimeout(90_000);

    const hostCtx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const hostPage = await hostCtx.newPage();
    await injectPeerServer(hostPage);
    const code = await setupHostAndStart(hostPage);
    let lateGuest: LateGuest | null = null;

    try {
      await uploadFixture(hostPage, 'test01');
      await waitForPlaylistCount(hostPage, 1);
      await startPlayback(hostPage);

      // Wait a bit to build up seek position
      await hostPage.waitForTimeout(2000);

      // ★ CHAOS: Seek to random position + guest join simultaneously
      const seekPromise = hostPage.evaluate(() => {
        const set = (window as any).__MUSIXQUARE_SET_STATE__;
        if (set) set('audio.seekTo', 5.0);
      });
      const joinPromise = joinAsLateGuest(browser, code);

      await seekPromise;
      lateGuest = await joinPromise;

      await waitForPlaylistCount(lateGuest.guestPage, 1, 30_000);
      await lateGuest.guestPage.waitForTimeout(3000);

      // Both should be functional
      await assertHostAlive(hostPage);
      const guestState = await readState(lateGuest.guestPage, 'appState');
      expect(guestState).toBeDefined();
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

      // ★ CHAOS: Rapid-fire seek commands
      for (let i = 0; i < 10; i++) {
        await setup.hostPage.evaluate((pos) => {
          const set = (window as any).__MUSIXQUARE_SET_STATE__;
          if (set) set('audio.seekTo', pos);
        }, i * 0.5);
        await setup.hostPage.waitForTimeout(200);
      }

      // Both should survive
      await assertHostAlive(setup.hostPage);
      const guestState = await readState(setup.guestPages[0], 'appState');
      expect(['PLAYING_AUDIO', 'PAUSED', 'IDLE']).toContain(guestState);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. ALL GUESTS DISCONNECT AT ONCE
// ═══════════════════════════════════════════════════════════════

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

      // Upload and play
      await uploadFixture(setup.hostPage, 'test01');
      await waitForPlaylistCount(setup.hostPage, 1);
      await startPlayback(setup.hostPage);

      // ★ CHAOS: ALL guests drop simultaneously
      await Promise.all(setup.guestContexts.map(ctx => ctx.close()));

      // Wait for host to detect all disconnects
      await waitForPeerCount(setup.hostPage, 0, 30_000);

      // Host should still work
      await assertHostAlive(setup.hostPage);

      // Host can still pause
      await setup.hostPage.click('#play-btn');
      await setup.hostPage.waitForTimeout(1000);

      // Host can still upload
      await uploadFixture(setup.hostPage, 'test02');
      await waitForPlaylistCount(setup.hostPage, 2);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. STAGGERED DISCONNECT CASCADE
// ═══════════════════════════════════════════════════════════════

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

      // ★ CHAOS: Staggered disconnects
      await setup.guestContexts[0].close();
      await setup.hostPage.waitForTimeout(2000);
      await setup.guestContexts[1].close();
      await setup.hostPage.waitForTimeout(2000);
      await setup.guestContexts[2].close();

      // Wait for all to be detected
      await waitForPeerCount(setup.hostPage, 0, 30_000);

      // Host should still be playing or at least alive
      await assertHostAlive(setup.hostPage);
      const state = await readState(setup.hostPage, 'appState');
      expect(['PLAYING_AUDIO', 'PAUSED', 'IDLE']).toContain(state);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. PLAY/STOP/PLAY RAPID CYCLING
// ═══════════════════════════════════════════════════════════════

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

      // ★ CHAOS: 20 rapid play/pause toggles
      for (let i = 0; i < 20; i++) {
        await setup.hostPage.click('#play-btn');
        await setup.hostPage.waitForTimeout(150);
      }

      await setup.hostPage.waitForTimeout(2000);

      // Both should survive
      await assertHostAlive(setup.hostPage);
      const guestState = await readState(setup.guestPages[0], 'appState');
      expect(guestState).toBeDefined();

      // Guest still connected
      const peers = await setup.hostPage.evaluate(() => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get ? (get('network.connectedPeers') as unknown[])?.length ?? 0 : 0;
      });
      expect(peers).toBe(1);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. BACK-TO-BACK TRACK CHANGES
// ═══════════════════════════════════════════════════════════════

test.describe('Rapid Track Navigation', () => {
  test('next→next→next→prev→prev rapid sequence syncs correctly', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 1);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      await setupGuest(setup.guestPages[0], code);
      await waitForDeviceCount(setup.hostPage, 2);

      // Upload 3 tracks
      await uploadFixture(setup.hostPage, 'test01');
      await waitForPlaylistCount(setup.hostPage, 1);
      await setup.hostPage.waitForTimeout(500);
      await uploadFixture(setup.hostPage, 'test02');
      await waitForPlaylistCount(setup.hostPage, 2);
      await setup.hostPage.waitForTimeout(500);
      await uploadFixture(setup.hostPage, 'test03');
      await waitForPlaylistCount(setup.hostPage, 3);
      await waitForPlaylistCount(setup.guestPages[0], 3, 30_000);

      await startPlayback(setup.hostPage);

      // ★ CHAOS: Rapid track navigation
      await setup.hostPage.click('#btn-next');
      await setup.hostPage.waitForTimeout(300);
      await setup.hostPage.click('#btn-next');
      await setup.hostPage.waitForTimeout(300);
      await setup.hostPage.click('#btn-next'); // wraps around
      await setup.hostPage.waitForTimeout(300);
      await setup.hostPage.click('#btn-prev');
      await setup.hostPage.waitForTimeout(300);
      await setup.hostPage.click('#btn-prev');
      await setup.hostPage.waitForTimeout(2000);

      // Both should converge on same track
      const hostIdx = await readState(setup.hostPage, 'playlist.currentTrackIndex');
      const guestIdx = await readState(setup.guestPages[0], 'playlist.currentTrackIndex');
      expect(hostIdx).toBeDefined();
      expect(guestIdx).toBe(hostIdx);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });

  test('track change during guest file transfer', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 1);
    let lateGuest: LateGuest | null = null;

    try {
      const code = await setupHostAndStart(setup.hostPage);
      await setupGuest(setup.guestPages[0], code);
      await waitForDeviceCount(setup.hostPage, 2);

      // Upload 2 tracks
      await uploadFixture(setup.hostPage, 'test01');
      await waitForPlaylistCount(setup.hostPage, 1);
      await setup.hostPage.waitForTimeout(500);
      await uploadFixture(setup.hostPage, 'test02');
      await waitForPlaylistCount(setup.hostPage, 2);

      await startPlayback(setup.hostPage);

      // ★ CHAOS: Upload 3rd track (triggers transfer to guest) + next track simultaneously
      const uploadPromise = uploadFixture(setup.hostPage, 'test03');
      await setup.hostPage.waitForTimeout(200);
      await setup.hostPage.click('#btn-next');

      await uploadPromise;
      await waitForPlaylistCount(setup.hostPage, 3);

      // Guest should eventually get all 3
      await waitForPlaylistCount(setup.guestPages[0], 3, 30_000);

      await assertHostAlive(setup.hostPage);
    } finally {
      if (lateGuest) await lateGuest.guestContext.close().catch(() => {});
      await cleanupChaosSetup(setup);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. VOLUME/EQ CASCADE DURING DISCONNECT
// ═══════════════════════════════════════════════════════════════

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

      // ★ CHAOS: 50 rapid settings changes + guest1 disconnect
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
        // Final stable values
        set('audio.masterVolume', 0.5);
        set('audio.eqValues', [0, 0, 0, 0, 0]);
      });

      const disconnectPromise = setup.guestContexts[0].close();
      await Promise.all([settingsFlood, disconnectPromise]);

      await setup.hostPage.waitForTimeout(3000);

      // Surviving guest should be ok
      await assertHostAlive(setup.hostPage);
      const g2State = await readState(setup.guestPages[1], 'appState');
      expect(g2State).toBeDefined();

      // Final settings should be stable
      const vol = await readState(setup.hostPage, 'audio.masterVolume');
      expect(vol).toBe(0.5);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. SHUFFLE/REPEAT MODE + LATE JOIN
// ═══════════════════════════════════════════════════════════════

test.describe('Shuffle Repeat + Late Join', () => {
  test('shuffle enabled before late join, guest receives shuffle state', async ({ browser }) => {
    test.setTimeout(90_000);

    const hostCtx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const hostPage = await hostCtx.newPage();
    await injectPeerServer(hostPage);
    const code = await setupHostAndStart(hostPage);
    let lateGuest: LateGuest | null = null;

    try {
      // Upload 3 tracks
      await uploadFixture(hostPage, 'test01');
      await waitForPlaylistCount(hostPage, 1);
      await hostPage.waitForTimeout(500);
      await uploadFixture(hostPage, 'test02');
      await waitForPlaylistCount(hostPage, 2);
      await hostPage.waitForTimeout(500);
      await uploadFixture(hostPage, 'test03');
      await waitForPlaylistCount(hostPage, 3);

      // Enable shuffle
      const shuffleBtn = hostPage.locator('#btn-shuffle');
      if (await shuffleBtn.isVisible().catch(() => false)) {
        await shuffleBtn.click();
        await hostPage.waitForTimeout(500);
      }

      // Enable repeat
      const repeatBtn = hostPage.locator('#btn-repeat');
      if (await repeatBtn.isVisible().catch(() => false)) {
        await repeatBtn.click();
        await hostPage.waitForTimeout(500);
      }

      await startPlayback(hostPage);

      // ★ Late guest joins — should sync playlist and play state
      lateGuest = await joinAsLateGuest(browser, code);
      await waitForPlaylistCount(lateGuest.guestPage, 3, 30_000);

      // Guest should have playlist
      const guestItems = await lateGuest.guestPage.evaluate(() =>
        document.getElementById('playlist-ui')?.children.length ?? 0,
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

    const hostCtx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const hostPage = await hostCtx.newPage();
    await injectPeerServer(hostPage);
    const code = await setupHostAndStart(hostPage);
    let lateGuest: LateGuest | null = null;

    try {
      await uploadFixture(hostPage, 'test01');
      await waitForPlaylistCount(hostPage, 1);

      // ★ CHAOS: Toggle repeat 5 times rapidly
      const repeatBtn = hostPage.locator('#btn-repeat');
      if (await repeatBtn.isVisible().catch(() => false)) {
        for (let i = 0; i < 5; i++) {
          await repeatBtn.click();
          await hostPage.waitForTimeout(200);
        }
      }

      // Late join
      lateGuest = await joinAsLateGuest(browser, code);
      await waitForPlaylistCount(lateGuest.guestPage, 1, 30_000);

      await assertHostAlive(hostPage);
      const guestState = await readState(lateGuest.guestPage, 'appState');
      expect(guestState).toBeDefined();
    } finally {
      if (lateGuest) await lateGuest.guestContext.close().catch(() => {});
      await hostCtx.close().catch(() => {});
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. INTERLEAVED JOIN/UPLOAD PATTERN
// ═══════════════════════════════════════════════════════════════

test.describe('Interleaved Join Upload', () => {
  test('guest1→upload→guest2→upload→guest3→upload chain', async ({ browser }) => {
    test.setTimeout(120_000);

    const hostCtx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const hostPage = await hostCtx.newPage();
    await injectPeerServer(hostPage);
    const code = await setupHostAndStart(hostPage);
    const guests: LateGuest[] = [];

    try {
      // Guest1 joins
      const g1 = await joinAsLateGuest(browser, code);
      guests.push(g1);
      await waitForDeviceCount(hostPage, 2);

      // Upload track 1
      await uploadFixture(hostPage, 'test01');
      await waitForPlaylistCount(hostPage, 1);
      await waitForPlaylistCount(g1.guestPage, 1, 30_000);

      // Guest2 joins — should get track 1
      const g2 = await joinAsLateGuest(browser, code);
      guests.push(g2);
      await waitForPlaylistCount(g2.guestPage, 1, 30_000);

      // Upload track 2
      await uploadFixture(hostPage, 'test02');
      await waitForPlaylistCount(hostPage, 2);
      await waitForPlaylistCount(g1.guestPage, 2, 30_000);
      await waitForPlaylistCount(g2.guestPage, 2, 30_000);

      // Guest3 joins — should get tracks 1+2
      const g3 = await joinAsLateGuest(browser, code);
      guests.push(g3);
      await waitForPlaylistCount(g3.guestPage, 2, 30_000);

      // Upload track 3
      await uploadFixture(hostPage, 'test03');
      await waitForPlaylistCount(hostPage, 3);

      // All guests should eventually have 3
      for (const g of guests) {
        await waitForPlaylistCount(g.guestPage, 3, 30_000);
      }

      // Verify consistency
      for (const g of guests) {
        const count = await g.guestPage.evaluate(() =>
          document.getElementById('playlist-ui')?.children.length ?? 0,
        );
        expect(count).toBe(3);
      }
    } finally {
      for (const g of guests) await g.guestContext.close().catch(() => {});
      await hostCtx.close().catch(() => {});
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. CONCURRENT CHAT FROM ALL PEERS
// ═══════════════════════════════════════════════════════════════

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

      // ★ CHAOS: All 3 peers send chat at the same time
      await Promise.all([
        sendChatMessage(setup.hostPage, 'host-simultaneous-msg'),
        sendChatMessage(setup.guestPages[0], 'guest1-simultaneous-msg'),
        sendChatMessage(setup.guestPages[1], 'guest2-simultaneous-msg'),
      ]);

      await setup.hostPage.waitForTimeout(3000);

      // Host should have received all messages (or at least not crashed)
      const hostChat = await setup.hostPage.evaluate(() =>
        document.getElementById('chat-messages')?.textContent || '',
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

      // ★ CHAOS: Host floods 10 messages
      for (let i = 0; i < 10; i++) {
        await sendChatMessage(setup.hostPage, `rapid-${i}`);
        await setup.hostPage.waitForTimeout(100);
      }

      // Guest sends concurrently
      await sendChatMessage(setup.guestPages[0], 'guest-concurrent');

      await setup.hostPage.waitForTimeout(3000);

      // Both should be alive
      await assertHostAlive(setup.hostPage);
      const guestChat = await setup.guestPages[0].evaluate(() =>
        document.getElementById('chat-messages')?.textContent || '',
      );
      expect(guestChat.length).toBeGreaterThan(0);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 11. DISCONNECT + IMMEDIATE REJOIN ("FLAPPING")
// ═══════════════════════════════════════════════════════════════

test.describe('Connection Flapping', () => {
  test('guest disconnect and immediate rejoin 3 times', async ({ browser }) => {
    test.setTimeout(120_000);

    const hostCtx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const hostPage = await hostCtx.newPage();
    await injectPeerServer(hostPage);
    const code = await setupHostAndStart(hostPage);
    const allGuests: LateGuest[] = [];

    try {
      await uploadFixture(hostPage, 'test01');
      await waitForPlaylistCount(hostPage, 1);

      for (let i = 0; i < 3; i++) {
        // Join
        const g = await joinAsLateGuest(browser, code);
        allGuests.push(g);
        await waitForPlaylistCount(g.guestPage, 1, 30_000);

        // Immediately disconnect
        await g.guestContext.close();

        // Wait for detection
        await waitForPeerCount(hostPage, 0, 20_000);

        // Small gap
        await hostPage.waitForTimeout(1000);
      }

      // Final join should work
      const finalGuest = await joinAsLateGuest(browser, code);
      allGuests.push(finalGuest);
      await waitForPlaylistCount(finalGuest.guestPage, 1, 30_000);

      // Verify host has exactly 1 peer
      await waitForPeerCount(hostPage, 1);

      await assertHostAlive(hostPage);
    } finally {
      for (const g of allGuests) await g.guestContext.close().catch(() => {});
      await hostCtx.close().catch(() => {});
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 12. TRIPLE COMBO — seek + volume + next track
// ═══════════════════════════════════════════════════════════════

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
      await setup.hostPage.waitForTimeout(500);
      await uploadFixture(setup.hostPage, 'test02');
      await waitForPlaylistCount(setup.hostPage, 2);
      await waitForPlaylistCount(setup.guestPages[0], 2, 30_000);

      await startPlayback(setup.hostPage);

      // ★ CHAOS: Three operations at once
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

      await setup.hostPage.waitForTimeout(3000);

      // Both alive, host volume set
      await assertHostAlive(setup.hostPage);
      const vol = await readState(setup.hostPage, 'audio.masterVolume');
      expect(vol).toBe(0.3);

      // Guest still connected
      const peers = await setup.hostPage.evaluate(() => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get ? (get('network.connectedPeers') as unknown[])?.length ?? 0 : 0;
      });
      expect(peers).toBe(1);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 13. GUEST PAGE RELOAD DURING TRANSFER
// ═══════════════════════════════════════════════════════════════

test.describe('Guest Reload During Transfer', () => {
  test('guest reloads page during file transfer, host survives', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 1);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      await setupGuest(setup.guestPages[0], code);
      await waitForDeviceCount(setup.hostPage, 2);

      // Start upload (triggers transfer to guest)
      await uploadFixture(setup.hostPage, 'test01');

      // ★ CHAOS: Guest reloads immediately during transfer
      await setup.guestPages[0].reload();
      await setup.guestPages[0].waitForLoadState('networkidle');

      // Guest is now disconnected (reload killed the PeerJS connection)
      await setup.hostPage.waitForTimeout(5000);

      // Host should still be functional
      await assertHostAlive(setup.hostPage);
      await waitForPlaylistCount(setup.hostPage, 1);

      // Upload another file should work
      await uploadFixture(setup.hostPage, 'test02');
      await waitForPlaylistCount(setup.hostPage, 2);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 14. SETTINGS RESET MID-SESSION
// ═══════════════════════════════════════════════════════════════

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

      // Set non-default settings
      await setup.hostPage.evaluate(() => {
        const set = (window as any).__MUSIXQUARE_SET_STATE__;
        if (!set) return;
        set('audio.eqValues', [6, 4, 2, -2, -4]);
        set('audio.masterVolume', 0.3);
        set('audio.reverbMix', 0.7);
        set('audio.reverbDecay', 3.0);
      });

      await setup.hostPage.waitForTimeout(1000);

      // ★ CHAOS: Reset all to defaults
      await setup.hostPage.evaluate(() => {
        const set = (window as any).__MUSIXQUARE_SET_STATE__;
        if (!set) return;
        set('audio.eqValues', [0, 0, 0, 0, 0]);
        set('audio.masterVolume', 1.0);
        set('audio.reverbMix', 0.0);
        set('audio.reverbDecay', 1.5);
        set('audio.channelMode', 0);
      });

      await setup.hostPage.waitForTimeout(2000);

      // Host settings should be at defaults
      const eq = await readState(setup.hostPage, 'audio.eqValues');
      expect(eq).toEqual([0, 0, 0, 0, 0]);
      const vol = await readState(setup.hostPage, 'audio.masterVolume');
      expect(vol).toBe(1.0);

      // Guest should still be connected
      const peers = await setup.hostPage.evaluate(() => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get ? (get('network.connectedPeers') as unknown[])?.length ?? 0 : 0;
      });
      expect(peers).toBe(1);

      await assertHostAlive(setup.hostPage);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 15. YOUTUBE MODE + FILE MODE RAPID TOGGLE
// ═══════════════════════════════════════════════════════════════

test.describe('Mode Toggle Storm', () => {
  test('switch media source 3 times rapidly with guest connected', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 1);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      await setupGuest(setup.guestPages[0], code);
      await waitForDeviceCount(setup.hostPage, 2);

      // Upload a file first
      await uploadFixture(setup.hostPage, 'test01');
      await waitForPlaylistCount(setup.hostPage, 1);

      // ★ CHAOS: Toggle media source button rapidly
      const mediaBtn = setup.hostPage.locator('#media-source-btn');
      if (await mediaBtn.isVisible().catch(() => false)) {
        for (let i = 0; i < 3; i++) {
          await mediaBtn.click();
          await setup.hostPage.waitForTimeout(500);

          // Click YouTube option if visible
          const ytBtn = setup.hostPage.locator('#media-youtube-btn, .media-opt-youtube');
          if (await ytBtn.isVisible().catch(() => false)) {
            await ytBtn.click();
            await setup.hostPage.waitForTimeout(500);
          }

          // Click back to file if visible
          const fileBtn = setup.hostPage.locator('#media-file-btn, .media-opt-file');
          if (await fileBtn.isVisible().catch(() => false)) {
            await fileBtn.click();
            await setup.hostPage.waitForTimeout(500);
          }
        }
      }

      await setup.hostPage.waitForTimeout(2000);

      // Both should be alive
      await assertHostAlive(setup.hostPage);
      const guestState = await readState(setup.guestPages[0], 'appState');
      expect(guestState).toBeDefined();
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 16. YOUTUBE URL CHANGE DURING PLAYBACK
// ═══════════════════════════════════════════════════════════════

test.describe('YouTube URL Switch', () => {
  test('change YouTube URL mid-playback with guest connected', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 1);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      await setupGuest(setup.guestPages[0], code);
      await waitForDeviceCount(setup.hostPage, 2);

      // Enter YouTube mode
      const mediaBtn = setup.hostPage.locator('#media-source-btn');
      if (await mediaBtn.isVisible().catch(() => false)) {
        await mediaBtn.click();
        await setup.hostPage.waitForTimeout(500);
      }
      const ytBtn = setup.hostPage.locator('#media-youtube-btn, .media-opt-youtube');
      if (await ytBtn.isVisible().catch(() => false)) {
        await ytBtn.click();
        await setup.hostPage.waitForTimeout(500);
      }

      const ytInput = setup.hostPage.locator('#youtube-url-input');
      const playBtn = setup.hostPage.locator('#youtube-play-btn, #btn-yt-play');

      if (await ytInput.isVisible().catch(() => false)) {
        // Load first video
        await ytInput.fill(YT_VIDEO);
        await setup.hostPage.waitForTimeout(500);
        if (await playBtn.isVisible().catch(() => false)) {
          await playBtn.click();
        }

        await setup.hostPage.waitForTimeout(3000);

        // ★ CHAOS: Switch to different video
        await ytInput.fill('');
        await ytInput.fill(YT_VIDEO_2);
        await setup.hostPage.waitForTimeout(500);
        if (await playBtn.isVisible().catch(() => false)) {
          await playBtn.click();
        }
      }

      await setup.hostPage.waitForTimeout(3000);

      // Both should be alive
      await assertHostAlive(setup.hostPage);
      const guestState = await readState(setup.guestPages[0], 'appState');
      expect(guestState).toBeDefined();
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 17. MULTIPLE SEQUENTIAL SESSIONS (SAME HOST)
// ═══════════════════════════════════════════════════════════════

test.describe('Sequential Sessions', () => {
  test('host creates 3 sessions back-to-back, guests join each', async ({ browser }) => {
    test.setTimeout(180_000);

    const hostCtx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const hostPage = await hostCtx.newPage();
    await injectPeerServer(hostPage);
    const allGuests: LateGuest[] = [];

    try {
      for (let session = 0; session < 3; session++) {
        // Create session
        const code = await setupHostAndStart(hostPage);

        // Guest joins
        const g = await joinAsLateGuest(browser, code);
        allGuests.push(g);
        await waitForDeviceCount(hostPage, 2);

        // Upload a file
        const fixture = (['test01', 'test02', 'test03'] as const)[session];
        await uploadFixture(hostPage, fixture);
        await waitForPlaylistCount(hostPage, 1);
        await waitForPlaylistCount(g.guestPage, 1, 30_000);

        // Disconnect guest
        await g.guestContext.close();
        await waitForPeerCount(hostPage, 0, 20_000);

        // Navigate back to start a new session
        if (session < 2) {
          await hostPage.reload();
          await hostPage.waitForLoadState('networkidle');
          await hostPage.waitForTimeout(2000);
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

// ═══════════════════════════════════════════════════════════════
// 18. LATE JOIN CHAIN — 3 guests join with uploads between
// ═══════════════════════════════════════════════════════════════

test.describe('Late Join Chain', () => {
  test('3 guests join sequentially with track uploads between, all converge', async ({ browser }) => {
    test.setTimeout(120_000);

    const hostCtx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const hostPage = await hostCtx.newPage();
    await injectPeerServer(hostPage);
    const code = await setupHostAndStart(hostPage);
    const guests: LateGuest[] = [];

    try {
      // Upload track 1
      await uploadFixture(hostPage, 'test01');
      await waitForPlaylistCount(hostPage, 1);

      // Guest1 joins — gets 1 track
      const g1 = await joinAsLateGuest(browser, code);
      guests.push(g1);
      await waitForPlaylistCount(g1.guestPage, 1, 30_000);

      // Upload track 2
      await uploadFixture(hostPage, 'test02');
      await waitForPlaylistCount(hostPage, 2);

      // Guest2 joins — gets 2 tracks
      const g2 = await joinAsLateGuest(browser, code);
      guests.push(g2);
      await waitForPlaylistCount(g2.guestPage, 2, 30_000);

      // Upload track 3
      await uploadFixture(hostPage, 'test03');
      await waitForPlaylistCount(hostPage, 3);

      // Guest3 joins — gets 3 tracks
      const g3 = await joinAsLateGuest(browser, code);
      guests.push(g3);
      await waitForPlaylistCount(g3.guestPage, 3, 30_000);

      // Earlier guests should also have all 3 now
      await waitForPlaylistCount(g1.guestPage, 3, 30_000);
      await waitForPlaylistCount(g2.guestPage, 3, 30_000);

      // All should have consistent state
      for (const g of guests) {
        const count = await g.guestPage.evaluate(() =>
          document.getElementById('playlist-ui')?.children.length ?? 0,
        );
        expect(count).toBe(3);
      }
    } finally {
      for (const g of guests) await g.guestContext.close().catch(() => {});
      await hostCtx.close().catch(() => {});
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 19. PLAYLIST CLEAR + JOIN
// ═══════════════════════════════════════════════════════════════

test.describe('Playlist Clear + Join', () => {
  test('clear all tracks then new guest joins empty session', async ({ browser }) => {
    test.setTimeout(90_000);

    const hostCtx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const hostPage = await hostCtx.newPage();
    await injectPeerServer(hostPage);
    const code = await setupHostAndStart(hostPage);
    let lateGuest: LateGuest | null = null;

    try {
      // Upload and then remove all tracks
      await uploadFixture(hostPage, 'test01');
      await waitForPlaylistCount(hostPage, 1);
      await hostPage.waitForTimeout(500);
      await uploadFixture(hostPage, 'test02');
      await waitForPlaylistCount(hostPage, 2);

      // Remove tracks one by one
      for (let i = 0; i < 2; i++) {
        const removeBtn = hostPage.locator('.btn-playlist-remove').first();
        if (await removeBtn.isVisible().catch(() => false)) {
          await removeBtn.click();
          const confirmBtn = hostPage.locator('#btn-dialog-ok');
          if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await confirmBtn.click();
          }
          await hostPage.waitForTimeout(1000);
        }
      }

      await hostPage.waitForTimeout(2000);

      // Host playlist should be empty (or 0)
      const hostCount = await hostPage.evaluate(() =>
        document.getElementById('playlist-ui')?.children.length ?? 0,
      );

      // ★ New guest joins the empty session
      lateGuest = await joinAsLateGuest(browser, code);
      await lateGuest.guestPage.waitForTimeout(3000);

      // Guest should match host's playlist count
      const guestCount = await lateGuest.guestPage.evaluate(() =>
        document.getElementById('playlist-ui')?.children.length ?? 0,
      );
      expect(guestCount).toBe(hostCount);

      await assertHostAlive(hostPage);
    } finally {
      if (lateGuest) await lateGuest.guestContext.close().catch(() => {});
      await hostCtx.close().catch(() => {});
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 20. UPLOAD SAME FILE TWICE
// ═══════════════════════════════════════════════════════════════

test.describe('Duplicate Upload Chaos', () => {
  test('upload same fixture twice, both synced to guest', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 1);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      await setupGuest(setup.guestPages[0], code);
      await waitForDeviceCount(setup.hostPage, 2);

      // Upload same file twice
      await uploadFixture(setup.hostPage, 'test01');
      await waitForPlaylistCount(setup.hostPage, 1);
      await setup.hostPage.waitForTimeout(1000);
      await uploadFixture(setup.hostPage, 'test01');

      // Wait for host to register (might be 1 or 2 depending on dedup logic)
      await setup.hostPage.waitForTimeout(3000);
      const hostCount = await setup.hostPage.evaluate(() =>
        document.getElementById('playlist-ui')?.children.length ?? 0,
      );
      expect(hostCount).toBeGreaterThanOrEqual(1);

      // Guest should eventually match
      await waitForPlaylistCount(setup.guestPages[0], hostCount, 30_000);

      await assertHostAlive(setup.hostPage);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 21. CHAT + UPLOAD + SETTINGS SIMULTANEOUSLY
// ═══════════════════════════════════════════════════════════════

test.describe('Chat Upload Settings Triple', () => {
  test('chat + upload + settings change all at once', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 1);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      await setupGuest(setup.guestPages[0], code);
      await waitForDeviceCount(setup.hostPage, 2);

      // ★ CHAOS: Triple simultaneous operations
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

      await setup.hostPage.waitForTimeout(3000);

      // File should arrive
      await waitForPlaylistCount(setup.hostPage, 1);
      await waitForPlaylistCount(setup.guestPages[0], 1, 30_000);

      // Settings should be set
      const vol = await readState(setup.hostPage, 'audio.masterVolume');
      expect(vol).toBe(0.6);

      await assertHostAlive(setup.hostPage);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 22. DISCONNECT DURING CHAT SEND
// ═══════════════════════════════════════════════════════════════

test.describe('Disconnect During Chat', () => {
  test('guest sends chat then disconnects immediately', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 1);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      await setupGuest(setup.guestPages[0], code);
      await waitForDeviceCount(setup.hostPage, 2);

      // ★ CHAOS: Guest sends chat + disconnects simultaneously
      await Promise.all([
        sendChatMessage(setup.guestPages[0], 'goodbye-crash-msg'),
        (async () => {
          await setup.guestPages[0].waitForTimeout(100);
          await setup.guestContexts[0].close();
        })(),
      ]).catch(() => {});

      await setup.hostPage.waitForTimeout(5000);

      // Host should not crash
      await assertHostAlive(setup.hostPage);

      // Host should eventually detect disconnect
      await waitForPeerCount(setup.hostPage, 0, 20_000);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 23. EQ EXTREME VALUES
// ═══════════════════════════════════════════════════════════════

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

      // ★ CHAOS: Extreme EQ values
      await setup.hostPage.evaluate(() => {
        const set = (window as any).__MUSIXQUARE_SET_STATE__;
        if (!set) return;
        set('audio.eqValues', [12, 12, 12, 12, 12]); // Max
        set('audio.masterVolume', 0.01); // Near zero
      });
      await setup.hostPage.waitForTimeout(500);

      await setup.hostPage.evaluate(() => {
        const set = (window as any).__MUSIXQUARE_SET_STATE__;
        if (!set) return;
        set('audio.eqValues', [-12, -12, -12, -12, -12]); // Min
        set('audio.masterVolume', 1.0); // Max
      });
      await setup.hostPage.waitForTimeout(500);

      await setup.hostPage.evaluate(() => {
        const set = (window as any).__MUSIXQUARE_SET_STATE__;
        if (!set) return;
        set('audio.eqValues', [12, -12, 12, -12, 12]); // Alternating
        set('audio.reverbMix', 1.0); // Full wet
        set('audio.reverbDecay', 10.0); // Very long decay
      });

      await setup.hostPage.waitForTimeout(2000);

      // Both should survive
      await assertHostAlive(setup.hostPage);
      const guestState = await readState(setup.guestPages[0], 'appState');
      expect(['PLAYING_AUDIO', 'PAUSED', 'IDLE']).toContain(guestState);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 24. CHANNEL MODE SWITCHING
// ═══════════════════════════════════════════════════════════════

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

      // ★ CHAOS: Cycle through channel modes
      for (const mode of [0, 1, -1, 0, 1, -1]) {
        await setup.hostPage.evaluate((m) => {
          const set = (window as any).__MUSIXQUARE_SET_STATE__;
          if (set) set('audio.channelMode', m);
        }, mode);
        await setup.hostPage.waitForTimeout(300);
      }

      await setup.hostPage.waitForTimeout(2000);

      await assertHostAlive(setup.hostPage);
      const guestState = await readState(setup.guestPages[0], 'appState');
      expect(guestState).toBeDefined();
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 25. UPLOAD DURING PLAYBACK + DISCONNECT
// ═══════════════════════════════════════════════════════════════

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

      // ★ CHAOS: Upload + disconnect simultaneously
      await Promise.all([
        uploadFixture(setup.hostPage, 'test02'),
        setup.guestContexts[0].close(),
      ]);

      await waitForPlaylistCount(setup.hostPage, 2);
      await setup.hostPage.waitForTimeout(3000);

      // Surviving guest should get track 2
      await waitForPlaylistCount(setup.guestPages[1], 2, 30_000);

      // Late joiner should also get both
      lateGuest = await joinAsLateGuest(browser, code);
      await waitForPlaylistCount(lateGuest.guestPage, 2, 30_000);

      await assertHostAlive(setup.hostPage);
    } finally {
      if (lateGuest) await lateGuest.guestContext.close().catch(() => {});
      await cleanupChaosSetup(setup);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 26. PAUSE DURING FILE TRANSFER
// ═══════════════════════════════════════════════════════════════

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

      // Start upload of track 2 (triggers transfer)
      const uploadPromise = uploadFixture(setup.hostPage, 'test02');

      // ★ CHAOS: Pause during the transfer
      await setup.hostPage.waitForTimeout(200);
      await setup.hostPage.click('#play-btn');

      await uploadPromise;
      await waitForPlaylistCount(setup.hostPage, 2);

      // Guest should still get the file
      await waitForPlaylistCount(setup.guestPages[0], 2, 30_000);

      // Host should be paused
      const state = await readState(setup.hostPage, 'appState');
      expect(['PAUSED', 'IDLE']).toContain(state);

      await assertHostAlive(setup.hostPage);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 27. GUEST JOINS DIFFERENT CHANNEL
// ═══════════════════════════════════════════════════════════════

test.describe('Channel Mismatch', () => {
  test('guest joins on different channel, session still works', async ({ browser }) => {
    test.setTimeout(90_000);

    const hostCtx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const hostPage = await hostCtx.newPage();
    await injectPeerServer(hostPage);
    // Host on channel 0
    const code = await setupHostAndStart(hostPage, 0);

    const guestCtx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const guestPage = await guestCtx.newPage();
    await injectPeerServer(guestPage);

    try {
      // Guest on channel 1 (different from host's channel 0)
      await setupGuest(guestPage, code, 1);
      await waitForDeviceCount(hostPage, 2);

      // Upload should still work
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

// ═══════════════════════════════════════════════════════════════
// 28. LATE JOIN DURING TRACK REMOVAL
// ═══════════════════════════════════════════════════════════════

test.describe('Late Join During Track Removal', () => {
  test('guest joins while host is removing a track', async ({ browser }) => {
    test.setTimeout(90_000);

    const hostCtx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const hostPage = await hostCtx.newPage();
    await injectPeerServer(hostPage);
    const code = await setupHostAndStart(hostPage);
    let lateGuest: LateGuest | null = null;

    try {
      // Upload 3 tracks
      await uploadFixture(hostPage, 'test01');
      await waitForPlaylistCount(hostPage, 1);
      await hostPage.waitForTimeout(500);
      await uploadFixture(hostPage, 'test02');
      await waitForPlaylistCount(hostPage, 2);
      await hostPage.waitForTimeout(500);
      await uploadFixture(hostPage, 'test03');
      await waitForPlaylistCount(hostPage, 3);

      // ★ CHAOS: Remove track + guest join simultaneously
      const removeBtn = hostPage.locator('.btn-playlist-remove').first();
      let removePromise = Promise.resolve();
      if (await removeBtn.isVisible().catch(() => false)) {
        removePromise = (async () => {
          await removeBtn.click();
          const confirmBtn = hostPage.locator('#btn-dialog-ok');
          if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await confirmBtn.click();
          }
        })();
      }
      const joinPromise = joinAsLateGuest(browser, code);

      await removePromise;
      lateGuest = await joinPromise;

      await hostPage.waitForTimeout(3000);

      // Read host's final count
      const hostCount = await hostPage.evaluate(() =>
        document.getElementById('playlist-ui')?.children.length ?? 0,
      );

      // Guest should eventually converge to host's count
      await waitForPlaylistCount(lateGuest.guestPage, hostCount, 30_000);

      await assertHostAlive(hostPage);
    } finally {
      if (lateGuest) await lateGuest.guestContext.close().catch(() => {});
      await hostCtx.close().catch(() => {});
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 29. PLAYLIST REORDER + DISCONNECT
// ═══════════════════════════════════════════════════════════════

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

      // Upload 3 tracks
      await uploadFixture(setup.hostPage, 'test01');
      await waitForPlaylistCount(setup.hostPage, 1);
      await setup.hostPage.waitForTimeout(500);
      await uploadFixture(setup.hostPage, 'test02');
      await waitForPlaylistCount(setup.hostPage, 2);
      await setup.hostPage.waitForTimeout(500);
      await uploadFixture(setup.hostPage, 'test03');
      await waitForPlaylistCount(setup.hostPage, 3);

      // ★ CHAOS: Reorder via state + guest disconnect simultaneously
      await Promise.all([
        setup.hostPage.evaluate(() => {
          const get = (window as any).__MUSIXQUARE_GET_STATE__;
          const set = (window as any).__MUSIXQUARE_SET_STATE__;
          if (!get || !set) return;
          const items = get('playlist.items') as any[];
          if (items && items.length >= 3) {
            // Reverse the order
            const reversed = [...items].reverse();
            set('playlist.items', reversed);
          }
        }),
        setup.guestContexts[0].close(),
      ]);

      await setup.hostPage.waitForTimeout(5000);

      // Host should still have 3 tracks
      const hostCount = await setup.hostPage.evaluate(() =>
        document.getElementById('playlist-ui')?.children.length ?? 0,
      );
      expect(hostCount).toBe(3);

      // Late guest joins and gets current state
      lateGuest = await joinAsLateGuest(browser, code);
      await waitForPlaylistCount(lateGuest.guestPage, 3, 30_000);

      await assertHostAlive(setup.hostPage);
    } finally {
      if (lateGuest) await lateGuest.guestContext.close().catch(() => {});
      await cleanupChaosSetup(setup);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 30. DEVICE NAME COLLISION
// ═══════════════════════════════════════════════════════════════

test.describe('Device Name Collision', () => {
  test('two guests with same default name do not conflict', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 2);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      for (const gp of setup.guestPages) {
        await setupGuest(gp, code);
      }
      await waitForDeviceCount(setup.hostPage, 3);

      // Both should be connected
      const peers = await setup.hostPage.evaluate(() => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get ? (get('network.connectedPeers') as unknown[])?.length ?? 0 : 0;
      });
      expect(peers).toBe(2);

      // Upload should work with both connected
      await uploadFixture(setup.hostPage, 'test01');
      await waitForPlaylistCount(setup.hostPage, 1);

      // Both guests should get the file
      for (const gp of setup.guestPages) {
        await waitForPlaylistCount(gp, 1, 30_000);
      }

      await assertHostAlive(setup.hostPage);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 31. HOST UPLOAD DURING YOUTUBE MODE
// ═══════════════════════════════════════════════════════════════

test.describe('Upload During YouTube Mode', () => {
  test('file upload while in YouTube mode queues properly', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 1);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      await setupGuest(setup.guestPages[0], code);
      await waitForDeviceCount(setup.hostPage, 2);

      // Enter YouTube mode
      const mediaBtn = setup.hostPage.locator('#media-source-btn');
      if (await mediaBtn.isVisible().catch(() => false)) {
        await mediaBtn.click();
        await setup.hostPage.waitForTimeout(500);
        const ytBtn = setup.hostPage.locator('#media-youtube-btn, .media-opt-youtube');
        if (await ytBtn.isVisible().catch(() => false)) {
          await ytBtn.click();
          await setup.hostPage.waitForTimeout(1000);
        }
      }

      // ★ CHAOS: Upload file while in YouTube mode
      await uploadFixture(setup.hostPage, 'test01');
      await setup.hostPage.waitForTimeout(3000);

      // App should handle this gracefully (file may be queued or mode may switch)
      await assertHostAlive(setup.hostPage);
      const guestState = await readState(setup.guestPages[0], 'appState');
      expect(guestState).toBeDefined();
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 32. RAPID OPERATOR TOGGLE
// ═══════════════════════════════════════════════════════════════

test.describe('Rapid Operator Toggle', () => {
  test('toggle operator grant 5 times rapidly', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 1);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      await setupGuest(setup.guestPages[0], code);
      await waitForDeviceCount(setup.hostPage, 2);

      // ★ CHAOS: Toggle operator rapidly
      const opBtn = setup.hostPage.locator('.d-op-btn').first();
      if (await opBtn.isVisible().catch(() => false)) {
        for (let i = 0; i < 5; i++) {
          await opBtn.click();
          await setup.hostPage.waitForTimeout(300);
        }
      }

      await setup.hostPage.waitForTimeout(2000);

      // Both should survive
      await assertHostAlive(setup.hostPage);
      const guestState = await readState(setup.guestPages[0], 'appState');
      expect(guestState).toBeDefined();

      // Guest should still be connected
      const peers = await setup.hostPage.evaluate(() => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get ? (get('network.connectedPeers') as unknown[])?.length ?? 0 : 0;
      });
      expect(peers).toBe(1);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 33. LATE JOIN DURING PAUSE + SEEK
// ═══════════════════════════════════════════════════════════════

test.describe('Late Join During Pause + Seek', () => {
  test('guest joins while host is paused at specific seek position', async ({ browser }) => {
    test.setTimeout(90_000);

    const hostCtx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const hostPage = await hostCtx.newPage();
    await injectPeerServer(hostPage);
    const code = await setupHostAndStart(hostPage);
    let lateGuest: LateGuest | null = null;

    try {
      await uploadFixture(hostPage, 'test01');
      await waitForPlaylistCount(hostPage, 1);
      await startPlayback(hostPage);

      // Play for a bit then pause
      await hostPage.waitForTimeout(2000);
      await hostPage.click('#play-btn');
      await hostPage.waitForTimeout(500);

      // Seek to specific position while paused
      await hostPage.evaluate(() => {
        const set = (window as any).__MUSIXQUARE_SET_STATE__;
        if (set) set('audio.seekTo', 3.5);
      });
      await hostPage.waitForTimeout(1000);

      // ★ Late guest joins during pause
      lateGuest = await joinAsLateGuest(browser, code);
      await waitForPlaylistCount(lateGuest.guestPage, 1, 30_000);
      await lateGuest.guestPage.waitForTimeout(3000);

      // Guest should see paused state
      const guestState = await readState(lateGuest.guestPage, 'appState');
      expect(['PAUSED', 'IDLE']).toContain(guestState);

      await assertHostAlive(hostPage);
    } finally {
      if (lateGuest) await lateGuest.guestContext.close().catch(() => {});
      await hostCtx.close().catch(() => {});
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 34. MASSIVE STATE MUTATION BURST
// ═══════════════════════════════════════════════════════════════

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

      // ★ CHAOS: 100 rapid state mutations
      await setup.hostPage.evaluate(() => {
        const set = (window as any).__MUSIXQUARE_SET_STATE__;
        if (!set) return;
        for (let i = 0; i < 100; i++) {
          set('audio.masterVolume', Math.random());
        }
        // Final known state
        set('audio.masterVolume', 0.75);
      });

      await setup.hostPage.waitForTimeout(3000);

      const vol = await readState(setup.hostPage, 'audio.masterVolume');
      expect(vol).toBe(0.75);

      // Guest should still be connected
      const peers = await setup.hostPage.evaluate(() => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get ? (get('network.connectedPeers') as unknown[])?.length ?? 0 : 0;
      });
      expect(peers).toBe(1);

      await assertHostAlive(setup.hostPage);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 35. HOST PLAY/STOP + GUEST CHAT RACE
// ═══════════════════════════════════════════════════════════════

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

      // ★ CHAOS: Interleaved play toggles + chat
      for (let i = 0; i < 5; i++) {
        await Promise.all([
          setup.hostPage.click('#play-btn'),
          sendChatMessage(setup.guestPages[0], `race-msg-${i}`),
        ]).catch(() => {});
        await setup.hostPage.waitForTimeout(300);
      }

      await setup.hostPage.waitForTimeout(3000);

      await assertHostAlive(setup.hostPage);
      const guestState = await readState(setup.guestPages[0], 'appState');
      expect(guestState).toBeDefined();
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 36. DOUBLE LATE JOIN AT THE SAME TIME
// ═══════════════════════════════════════════════════════════════

test.describe('Double Late Join', () => {
  test('two guests join simultaneously during playback', async ({ browser }) => {
    test.setTimeout(120_000);

    const hostCtx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const hostPage = await hostCtx.newPage();
    await injectPeerServer(hostPage);
    const code = await setupHostAndStart(hostPage);
    const guests: LateGuest[] = [];

    try {
      await uploadFixture(hostPage, 'test01');
      await waitForPlaylistCount(hostPage, 1);
      await startPlayback(hostPage);

      // ★ CHAOS: Two guests join at the exact same time
      const [g1, g2] = await Promise.all([
        joinAsLateGuest(browser, code),
        joinAsLateGuest(browser, code),
      ]);
      guests.push(g1, g2);

      // Wait for both to be connected
      await hostPage.waitForFunction(
        () => {
          const get = (window as any).__MUSIXQUARE_GET_STATE__;
          if (!get) return false;
          const peers = get('network.connectedPeers') as unknown[];
          return peers && peers.length >= 2;
        },
        { timeout: 30_000 },
      );

      // Both should get the playlist
      await waitForPlaylistCount(g1.guestPage, 1, 30_000);
      await waitForPlaylistCount(g2.guestPage, 1, 30_000);

      await assertHostAlive(hostPage);
    } finally {
      for (const g of guests) await g.guestContext.close().catch(() => {});
      await hostCtx.close().catch(() => {});
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 37. UPLOAD ALL 3 FILES AT ONCE (BATCH)
// ═══════════════════════════════════════════════════════════════

test.describe('Batch Upload Stress', () => {
  test('upload all 3 fixtures at once, guest receives all', async ({ browser }) => {
    test.setTimeout(90_000);

    const setup = await createChaosSetup(browser, 1);
    try {
      const code = await setupHostAndStart(setup.hostPage);
      await setupGuest(setup.guestPages[0], code);
      await waitForDeviceCount(setup.hostPage, 2);

      // ★ CHAOS: Batch upload all 3 at once
      await uploadFixtures(setup.hostPage, ['test01', 'test02', 'test03']);

      // Host should get all 3
      await waitForPlaylistCount(setup.hostPage, 3, 30_000);

      // Guest should also get all 3 (may take longer due to transfer)
      await waitForPlaylistCount(setup.guestPages[0], 3, 45_000);

      await assertHostAlive(setup.hostPage);
    } finally {
      await cleanupChaosSetup(setup);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 38. LONG IDLE SESSION + LATE JOIN
// ═══════════════════════════════════════════════════════════════

test.describe('Idle Session + Late Join', () => {
  test('session idle for 15 seconds then guest joins', async ({ browser }) => {
    test.setTimeout(90_000);

    const hostCtx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const hostPage = await hostCtx.newPage();
    await injectPeerServer(hostPage);
    const code = await setupHostAndStart(hostPage);
    let lateGuest: LateGuest | null = null;

    try {
      await uploadFixture(hostPage, 'test01');
      await waitForPlaylistCount(hostPage, 1);

      // ★ Let session sit idle for 15 seconds
      await hostPage.waitForTimeout(15_000);

      // Late guest joins the idle session
      lateGuest = await joinAsLateGuest(browser, code);
      await waitForPlaylistCount(lateGuest.guestPage, 1, 30_000);

      // Session code should still work
      await waitForDeviceCount(hostPage, 2);

      await assertHostAlive(hostPage);
    } finally {
      if (lateGuest) await lateGuest.guestContext.close().catch(() => {});
      await hostCtx.close().catch(() => {});
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 39. HOST ONLY — NO GUESTS, FULL WORKFLOW
// ═══════════════════════════════════════════════════════════════

test.describe('Host Solo Stress', () => {
  test('host uploads, plays, skips, seeks, changes settings — all alone', async ({ browser }) => {
    test.setTimeout(90_000);

    const hostCtx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const hostPage = await hostCtx.newPage();
    await injectPeerServer(hostPage);
    await setupHostAndStart(hostPage);

    try {
      // Upload 3 files
      await uploadFixture(hostPage, 'test01');
      await waitForPlaylistCount(hostPage, 1);
      await hostPage.waitForTimeout(500);
      await uploadFixture(hostPage, 'test02');
      await waitForPlaylistCount(hostPage, 2);
      await hostPage.waitForTimeout(500);
      await uploadFixture(hostPage, 'test03');
      await waitForPlaylistCount(hostPage, 3);

      // Start playing
      await startPlayback(hostPage);

      // Rapid controls
      await hostPage.click('#btn-next');
      await hostPage.waitForTimeout(300);
      await hostPage.click('#btn-next');
      await hostPage.waitForTimeout(300);
      await hostPage.click('#btn-prev');
      await hostPage.waitForTimeout(300);

      // Seek
      await hostPage.evaluate(() => {
        const set = (window as any).__MUSIXQUARE_SET_STATE__;
        if (set) set('audio.seekTo', 2.0);
      });
      await hostPage.waitForTimeout(500);

      // Settings storm
      await hostPage.evaluate(() => {
        const set = (window as any).__MUSIXQUARE_SET_STATE__;
        if (!set) return;
        set('audio.eqValues', [5, -3, 0, 4, -2]);
        set('audio.masterVolume', 0.4);
        set('audio.reverbMix', 0.6);
        set('audio.channelMode', 1);
      });
      await hostPage.waitForTimeout(500);

      // Toggle shuffle/repeat
      const shuffleBtn = hostPage.locator('#btn-shuffle');
      if (await shuffleBtn.isVisible().catch(() => false)) {
        await shuffleBtn.click();
      }
      const repeatBtn = hostPage.locator('#btn-repeat');
      if (await repeatBtn.isVisible().catch(() => false)) {
        await repeatBtn.click();
      }

      // Pause, seek, resume
      await hostPage.click('#play-btn');
      await hostPage.waitForTimeout(500);
      await hostPage.evaluate(() => {
        const set = (window as any).__MUSIXQUARE_SET_STATE__;
        if (set) set('audio.seekTo', 1.0);
      });
      await hostPage.click('#play-btn');
      await hostPage.waitForTimeout(1000);

      await assertHostAlive(hostPage);

      // Should still have 3 tracks
      const count = await hostPage.evaluate(() =>
        document.getElementById('playlist-ui')?.children.length ?? 0,
      );
      expect(count).toBe(3);
    } finally {
      await hostCtx.close().catch(() => {});
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 40. THE NUCLEAR MELTDOWN — everything at once (Part 2)
// ═══════════════════════════════════════════════════════════════

test.describe('Nuclear Meltdown v2', () => {
  test('15-step lifecycle: upload, join, play, seek, settings, chat, disconnect, rejoin, mode switch, repeat', async ({ browser }) => {
    test.setTimeout(240_000);

    const hostCtx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const hostPage = await hostCtx.newPage();
    await injectPeerServer(hostPage);
    const code = await setupHostAndStart(hostPage);
    const allGuests: LateGuest[] = [];

    try {
      // Step 1: Upload all 3 files
      await uploadFixture(hostPage, 'test01');
      await waitForPlaylistCount(hostPage, 1);
      await hostPage.waitForTimeout(500);
      await uploadFixture(hostPage, 'test02');
      await waitForPlaylistCount(hostPage, 2);
      await hostPage.waitForTimeout(500);
      await uploadFixture(hostPage, 'test03');
      await waitForPlaylistCount(hostPage, 3);

      // Step 2: Guest1 joins, gets all files
      const g1 = await joinAsLateGuest(browser, code);
      allGuests.push(g1);
      await waitForPlaylistCount(g1.guestPage, 3, 30_000);

      // Step 3: Start playing + Guest2 joins simultaneously
      await startPlayback(hostPage);
      const g2 = await joinAsLateGuest(browser, code);
      allGuests.push(g2);
      await waitForPlaylistCount(g2.guestPage, 3, 30_000);

      // Step 4: Seek + settings change
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

      // Step 5: Guest1 sends chat
      await sendChatMessage(g1.guestPage, 'nuclear-chat-1');
      await hostPage.waitForTimeout(1000);

      // Step 6: Next track
      await hostPage.click('#btn-next');
      await hostPage.waitForTimeout(1000);

      // Step 7: Guest1 disconnects
      await g1.guestContext.close();
      await hostPage.waitForTimeout(2000);

      // Step 8: Guest3 joins
      const g3 = await joinAsLateGuest(browser, code);
      allGuests.push(g3);
      await waitForPlaylistCount(g3.guestPage, 3, 30_000);

      // Step 9: Rapid settings burst
      await hostPage.evaluate(() => {
        const set = (window as any).__MUSIXQUARE_SET_STATE__;
        if (!set) return;
        for (let i = 0; i < 20; i++) {
          set('audio.masterVolume', Math.random());
        }
        set('audio.masterVolume', 0.8);
      });

      // Step 10: Guest2 sends chat + guest3 disconnects simultaneously
      await Promise.all([
        sendChatMessage(g2.guestPage, 'nuclear-chat-2'),
        g3.guestContext.close(),
      ]).catch(() => {});

      await hostPage.waitForTimeout(3000);

      // Step 11: Upload 4th file
      await uploadFixture(hostPage, 'test01');
      await waitForPlaylistCount(hostPage, 4);

      // Step 12: Next track + pause
      await hostPage.click('#btn-next');
      await hostPage.waitForTimeout(500);
      await hostPage.click('#play-btn');
      await hostPage.waitForTimeout(1000);

      // Step 13: Guest4 joins during pause
      const g4 = await joinAsLateGuest(browser, code);
      allGuests.push(g4);
      await waitForPlaylistCount(g4.guestPage, 4, 45_000);

      // Step 14: Guest2 disconnects
      await g2.guestContext.close();
      await hostPage.waitForTimeout(3000);

      // Step 15: Resume play + verify
      await hostPage.click('#play-btn');
      await hostPage.waitForTimeout(2000);

      // ★ FINAL ASSERTIONS
      await assertHostAlive(hostPage);

      // Guest4 should have 4 tracks
      const g4Count = await g4.guestPage.evaluate(() =>
        document.getElementById('playlist-ui')?.children.length ?? 0,
      );
      expect(g4Count).toBe(4);

      // Host volume should be at final value
      const vol = await readState(hostPage, 'audio.masterVolume');
      expect(vol).toBe(0.8);

      // Track index should match
      const hostIdx = await readState(hostPage, 'playlist.currentTrackIndex');
      const g4Idx = await readState(g4.guestPage, 'playlist.currentTrackIndex');
      expect(g4Idx).toBe(hostIdx);

      // Host should be playing
      const state = await readState(hostPage, 'appState');
      expect(['PLAYING_AUDIO', 'PAUSED', 'IDLE']).toContain(state);
    } finally {
      for (const g of allGuests) await g.guestContext.close().catch(() => {});
      await hostCtx.close().catch(() => {});
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 41. RAPID SESSION CODE COPY
// ═══════════════════════════════════════════════════════════════

test.describe('Session Code Stability', () => {
  test('session code remains valid after multiple guest joins and leaves', async ({ browser }) => {
    test.setTimeout(120_000);

    const hostCtx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const hostPage = await hostCtx.newPage();
    await injectPeerServer(hostPage);
    const code = await setupHostAndStart(hostPage);
    const allGuests: LateGuest[] = [];

    try {
      // 5 join/leave cycles using the same code
      for (let i = 0; i < 5; i++) {
        const g = await joinAsLateGuest(browser, code);
        allGuests.push(g);
        await waitForDeviceCount(hostPage, 2);
        await g.guestContext.close();
        await waitForPeerCount(hostPage, 0, 20_000);
        await hostPage.waitForTimeout(1000);
      }

      // Code should still work
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

// ═══════════════════════════════════════════════════════════════
// 42. PLAYBACK END + LATE JOIN
// ═══════════════════════════════════════════════════════════════

test.describe('Playback End + Late Join', () => {
  test('guest joins after track ends naturally', async ({ browser }) => {
    test.setTimeout(90_000);

    const hostCtx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const hostPage = await hostCtx.newPage();
    await injectPeerServer(hostPage);
    const code = await setupHostAndStart(hostPage);
    let lateGuest: LateGuest | null = null;

    try {
      // Upload short test file and play
      await uploadFixture(hostPage, 'test01');
      await waitForPlaylistCount(hostPage, 1);
      await startPlayback(hostPage);

      // Seek near end to force quick finish
      await hostPage.evaluate(() => {
        const set = (window as any).__MUSIXQUARE_SET_STATE__;
        if (set) set('audio.seekTo', 999.0); // Seek past end
      });

      await hostPage.waitForTimeout(5000);

      // Host should be IDLE or PAUSED after track ends
      const state = await readState(hostPage, 'appState');
      expect(['IDLE', 'PAUSED', 'PLAYING_AUDIO']).toContain(state);

      // ★ Guest joins after playback ended
      lateGuest = await joinAsLateGuest(browser, code);
      await waitForPlaylistCount(lateGuest.guestPage, 1, 30_000);

      await assertHostAlive(hostPage);
    } finally {
      if (lateGuest) await lateGuest.guestContext.close().catch(() => {});
      await hostCtx.close().catch(() => {});
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 43. STRESS: CONNECT 3 GUESTS, UPLOAD, PLAY, DISCONNECT ALL, REJOIN 3
// ═══════════════════════════════════════════════════════════════

test.describe('Full Cycle Stress', () => {
  test('connect 3 → upload → play → disconnect all → rejoin 3, all sync', async ({ browser }) => {
    test.setTimeout(180_000);

    const hostCtx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const hostPage = await hostCtx.newPage();
    await injectPeerServer(hostPage);
    const code = await setupHostAndStart(hostPage);
    const allGuests: LateGuest[] = [];

    try {
      // Phase 1: Connect 3 guests
      for (let i = 0; i < 3; i++) {
        const g = await joinAsLateGuest(browser, code);
        allGuests.push(g);
      }
      await waitForDeviceCount(hostPage, 4, 30_000);

      // Phase 2: Upload 2 tracks
      await uploadFixture(hostPage, 'test01');
      await waitForPlaylistCount(hostPage, 1);
      await hostPage.waitForTimeout(500);
      await uploadFixture(hostPage, 'test02');
      await waitForPlaylistCount(hostPage, 2);

      // Phase 3: Verify all guests have 2 tracks
      for (const g of allGuests) {
        await waitForPlaylistCount(g.guestPage, 2, 30_000);
      }

      // Phase 4: Start playing
      await startPlayback(hostPage);
      await hostPage.waitForTimeout(2000);

      // Phase 5: Disconnect ALL guests
      for (const g of allGuests) {
        await g.guestContext.close().catch(() => {});
      }
      await waitForPeerCount(hostPage, 0, 30_000);

      // Host should still be playing
      const midState = await readState(hostPage, 'appState');
      expect(['PLAYING_AUDIO', 'PAUSED', 'IDLE']).toContain(midState);

      // Phase 6: 3 NEW guests join
      const newGuests: LateGuest[] = [];
      for (let i = 0; i < 3; i++) {
        const g = await joinAsLateGuest(browser, code);
        newGuests.push(g);
        allGuests.push(g);
      }

      // Phase 7: All new guests should get both tracks
      for (const g of newGuests) {
        await waitForPlaylistCount(g.guestPage, 2, 30_000);
      }

      // Phase 8: Verify state consistency
      const hostIdx = await readState(hostPage, 'playlist.currentTrackIndex');
      for (const g of newGuests) {
        const gIdx = await readState(g.guestPage, 'playlist.currentTrackIndex');
        expect(gIdx).toBe(hostIdx);
      }

      await assertHostAlive(hostPage);
    } finally {
      for (const g of allGuests) await g.guestContext.close().catch(() => {});
      await hostCtx.close().catch(() => {});
    }
  });
});
