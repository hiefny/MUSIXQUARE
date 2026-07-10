/**
 * E2E: YouTube sync and drift-correction tests.
 *
 * These tests drive two real browser contexts (host + guest) connected over
 * a local PeerJS broker, with a deterministic fake `window.YT` installed
 * BEFORE navigation on both sides. The fake player records every API call
 * with a Date.now() timestamp, so tests can assert on the full
 * host → PeerJS → guest path without touching the real YouTube iframe.
 *
 * These complement the vitest sync-integration.test.ts: those tests cover
 * the logic-order behavior in isolation, these cover the PeerJS round-trip.
 *
 * Companion to src/youtube/__tests__/sync-integration.test.ts.
 */

import { test, expect, type Page } from '@playwright/test';
import {
  createHostGuestContexts,
  cleanupContexts,
  type HostGuestPair,
} from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import {
  readPlaybackProjection,
  waitForPlaybackProjection,
} from './helpers/wait.ts';
import { installFakeYt, readFakeYtLog, clearFakeYtLog } from './helpers/fake-yt.ts';

// Deterministic fake URL — fake-yt stub accepts any videoId
const YT_VIDEO_URL = 'https://www.youtube.com/watch?v=FAKE_VIDEO_ID';

let pair: HostGuestPair;

// ── Helpers ───────────────────────────────────────────────────────────
async function waitForBus(page: Page, timeout = 20_000): Promise<void> {
  await page.waitForFunction(
    () =>
      typeof (window as unknown as Record<string, unknown>).__MUSIXQUARE_BUS__ === 'object' &&
      typeof (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ === 'function',
    undefined,
    { timeout },
  );
}

async function hostLoadYouTube(page: Page, url: string): Promise<void> {
  await page.evaluate((u) => {
    const bus = (window as unknown as Record<string, unknown>).__MUSIXQUARE_BUS__ as
      | { emit: (type: string, ...args: unknown[]) => void }
      | undefined;
    if (!bus) throw new Error('bus not exposed via __MUSIXQUARE_BUS__');
    // Natural entry point — same path chat-link clicks use. Runs the full
    // _addYouTubeToPlaylist pipeline: playlist.items update → loadYouTubeVideo
    // with autoplay=false → _pendingAutoSyncOnReady → onReady fires →
    // youtube:auto-play → the standard two-stage scheduleYtAutoSync path.
    bus.emit('youtube:load-from-chat', u);
  }, url);
}

async function waitForYtLogOp(page: Page, op: string, timeout = 20_000): Promise<void> {
  await page.waitForFunction(
    (expectedOp) => {
      const log = (window as unknown as Record<string, unknown>).__fakeYtLog as
        | Array<{ op: string }>
        | undefined;
      return log?.some((e) => e.op === expectedOp) ?? false;
    },
    op,
    { timeout },
  );
}

// Surface page console errors into test output for diagnostics.
function attachConsoleCapture(page: Page, label: string): void {
  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'error' || type === 'warning') {
      // Surface browser diagnostics without turning warnings into assertions.
      // eslint-disable-next-line no-console
      console.log(`[${label}] ${type}:`, msg.text());
    }
  });
}

test.describe('YouTube Sync — Drift & Rendezvous Regression', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
    // Install fake YT BEFORE any navigation so window.YT is defined when
    // the app's iframe loader runs.
    await installFakeYt(pair.hostPage);
    await installFakeYt(pair.guestPage);
    attachConsoleCapture(pair.hostPage, 'host');
    attachConsoleCapture(pair.guestPage, 'guest');
  });

  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  // ── Test 1: fake YT infrastructure is installed on both sides ─────────
  test('fake YT.Player is installed on host and guest before navigation', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const hostHasYT = await pair.hostPage.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return (
        typeof w.YT === 'object' && typeof (w.YT as Record<string, unknown>).Player === 'function'
      );
    });
    const guestHasYT = await pair.guestPage.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return (
        typeof w.YT === 'object' && typeof (w.YT as Record<string, unknown>).Player === 'function'
      );
    });

    expect(hostHasYT).toBe(true);
    expect(guestHasYT).toBe(true);

    // Bus + state hooks should also be exposed after app bootstrap
    await waitForBus(pair.hostPage);
    await waitForBus(pair.guestPage);
  });

  // ── Test 2: full sync flow end-to-end ────────────────────────────────
  test('host play routes through two-stage rendezvous and guest player seeks/plays', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await waitForBus(pair.hostPage);
    await waitForBus(pair.guestPage);

    await clearFakeYtLog(pair.hostPage);
    await clearFakeYtLog(pair.guestPage);

    // Host kicks off the natural YT load flow via the chat-link entry point.
    // This runs _addYouTubeToPlaylist → loadYouTubeVideo → onReady →
    // youtube:auto-play → scheduleYtAutoSync and broadcasts the rough Stage 1
    // state before the later precision rendezvous.
    await hostLoadYouTube(pair.hostPage, YT_VIDEO_URL);

    // The host action is immediate; the later Stage 2 aligns guests.
    await waitForYtLogOp(pair.hostPage, 'playVideo', 20_000);

    // Guest playback projection must have flipped to PLAYING_YOUTUBE (set by
    // setEngineMode inside loadYouTubeVideo when handleYouTubePlay runs)
    await waitForPlaybackProjection(pair.guestPage, 'PLAYING_YOUTUBE', 20_000);

    // Guest fake player should receive playVideo from handleYouTubeState.
    await waitForYtLogOp(pair.guestPage, 'playVideo', 20_000);

    const hostLog = await readFakeYtLog(pair.hostPage);
    const guestLog = await readFakeYtLog(pair.guestPage);

    const hostOps = hostLog.map((e) => e.op);
    const guestOps = guestLog.map((e) => e.op);

    // Host side: scheduleYtAutoSync is the "immediate-action" path — the
    // host plays right away for instant responsiveness (no pre-pause).
    // Stage 2 rendezvous (broadcastYouTubeSync after
    // STAGE2_RENDEZVOUS_BROADCAST_MS) handles precision alignment for
    // guests whose initial reaction drifted.
    expect(hostOps).toContain('playVideo');

    // Guest side: Stage 1 applies the rough play state before Stage 2 correction.
    expect(guestOps).toContain('playVideo');
  });

  // ── Test 3: state propagation ────────────────────────────────────────
  test('manual YouTube sync frame makes guest seek before replay', async () => {
    test.setTimeout(60_000);
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await waitForBus(pair.hostPage);
    await waitForBus(pair.guestPage);

    await pair.guestPage.evaluate(() => {
      const bus = (window as unknown as Record<string, unknown>).__MUSIXQUARE_BUS__ as
        | { emit: (type: string, ...args: unknown[]) => void }
        | undefined;
      if (!bus) throw new Error('bus not exposed via __MUSIXQUARE_BUS__');
      bus.emit('youtube:load', 'FAKE_VIDEO_ID', null, false);
    });
    await pair.guestPage.waitForFunction(
      () => {
        const w = window as unknown as Record<string, unknown>;
        const get = w.__MUSIXQUARE_GET_STATE__ as ((p: string) => unknown) | undefined;
        return get?.('playback.mode') === 'youtube' && !!w.__fakeYtLastPlayer;
      },
      undefined,
      { timeout: 20_000 },
    );

    await clearFakeYtLog(pair.guestPage);

    await pair.guestPage.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const get = w.__MUSIXQUARE_GET_STATE__ as ((p: string) => unknown) | undefined;
      const bus = w.__MUSIXQUARE_BUS__ as
        | { emit: (type: string, ...args: unknown[]) => void }
        | undefined;
      const player = w.__fakeYtLastPlayer as
        | { __state?: number; __currentTime?: number }
        | undefined;
      const hostConn = get?.('network.hostConn');
      if (!bus || !hostConn || !player) throw new Error('manual sync setup unavailable');

      player.__state = 1;
      player.__currentTime = 12;
      bus.emit(
        'network:data',
        {
          type: 'youtube-sync',
          time: 12,
          state: 1,
          subIndex: -1,
          videoId: 'FAKE_VIDEO_ID',
          hostClock: Date.now(),
          isManual: true,
          title: 'Fake Title',
        },
        hostConn,
      );
    });

    await waitForYtLogOp(pair.guestPage, 'seekTo', 20_000);
    await waitForYtLogOp(pair.guestPage, 'playVideo', 20_000);

    const guestOps = (await readFakeYtLog(pair.guestPage)).map((entry) => entry.op);
    expect(guestOps).toContain('seekTo');
    expect(guestOps).toContain('playVideo');
    expect(guestOps.indexOf('seekTo')).toBeLessThan(guestOps.lastIndexOf('playVideo'));
  });

  test('guest transitions to PLAYING_YOUTUBE after host starts video', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await waitForBus(pair.hostPage);
    await waitForBus(pair.guestPage);

    await hostLoadYouTube(pair.hostPage, YT_VIDEO_URL);

    // Host playback projection flips first
    await waitForPlaybackProjection(pair.hostPage, 'PLAYING_YOUTUBE', 15_000);

    // Guest playback projection should flip to PLAYING_YOUTUBE after receiving YOUTUBE_PLAY
    await waitForPlaybackProjection(pair.guestPage, 'PLAYING_YOUTUBE', 20_000);

    expect(await readPlaybackProjection(pair.guestPage)).toBe('PLAYING_YOUTUBE');
  });

  // ── Test 4: stop mode propagation ────────────────────────────────────
  test('host stop YouTube mode clears guest state', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await waitForBus(pair.hostPage);
    await waitForBus(pair.guestPage);

    await hostLoadYouTube(pair.hostPage, YT_VIDEO_URL);

    // Wait for guest to enter YT mode
    await waitForPlaybackProjection(pair.guestPage, 'PLAYING_YOUTUBE', 20_000);

    // Host triggers stop-mode (listener → stopYouTubeMode → YOUTUBE_STOP broadcast)
    await pair.hostPage.evaluate(() => {
      const bus = (window as unknown as Record<string, unknown>).__MUSIXQUARE_BUS__ as
        | { emit: (type: string, ...args: unknown[]) => void }
        | undefined;
      bus?.emit('youtube:stop-mode');
    });

    // Guest playback projection should leave PLAYING_YOUTUBE once YOUTUBE_STOP arrives
    // (handleYouTubeStop emits youtube:stop-mode + player:stop-all-media,
    // which transitions playback projection out of PLAYING_YOUTUBE)
    await pair.guestPage.waitForFunction(
      () => {
        const projected = (window as unknown as Record<string, unknown>)
          .__MUSIXQUARE_GET_PLAYBACK_PROJECTION__ as (() => unknown) | undefined;
        return typeof projected === 'function' && projected() !== 'PLAYING_YOUTUBE';
      },
      undefined,
      { timeout: 15_000 },
    );

    expect(await readPlaybackProjection(pair.guestPage)).not.toBe('PLAYING_YOUTUBE');
  });
});
