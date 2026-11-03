/**
 * E2E: a Standard YouTube guest returns at the moment the browser stops its
 * hidden iframe.
 *
 * Device report (2026-11-03): WebKit stops an iPhone guest's YouTube iframe
 * when the page goes to the home screen or the screen turns off, and the
 * return re-aligns the guest by itself. Reopened at the very moment of that
 * stop, the guest stays paused until the participant taps PLAY in the iframe
 * or presses Sync.
 *
 * Chromium never stops a hidden iframe, so each row plays the stop itself on
 * the guest page: the page reports hidden, the fake player stops 100 ms
 * before the page reports visible again, and the iframe's PAUSED callback
 * reaches the app's real handler (youtube/iframe.ts) before the visible
 * event, in the same task right after it ('at'), or 100 ms after it. The
 * host, the guest, the PeerJS transport and every app module are real. The
 * guest page keeps a desktop user agent: the iOS-only YouTube code is the
 * start path (prime and gesture gate), not the return.
 *
 * Expected for every row, as for a normal return: without a tap the guest
 * plays again within two host heartbeats and ends in step with the host.
 * Tests first: on today's code the sub-second rows stay paused, and so does
 * the row whose PAUSED arrives just after a return that waits out the Sync
 * button's rendezvous cooldown. The unit rows in
 * src/player/__tests__/local-output-realign-cross-flow.test.ts explain why.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  createHostGuestContexts,
  cleanupContexts,
  type HostGuestPair,
} from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { waitForState } from './helpers/wait.ts';
import { installFakeYt, readFakeYtSnapshot } from './helpers/fake-yt.ts';
import { DEFAULT_RECOVER_THRESHOLD_MS } from '../src/core/background-resume-guard.ts';
import { HEARTBEAT_INTERVAL_MS } from '../src/youtube/constants.ts';

/** The browser stops the hidden iframe this long before the page is visible again. */
const STOP_BEFORE_VISIBLE_MS = 100;
/** The 'after' rows deliver the PAUSED callback this long after the visible event. */
const PAUSED_AFTER_VISIBLE_MS = 100;
/** The guest plays again within two host heartbeats of the return. */
const RESUME_DEADLINE_MS = 2 * HEARTBEAT_INTERVAL_MS;
/** The rows judge the guest this long after the return. */
const WATCH_MS = 4 * HEARTBEAT_INTERVAL_MS;
/** In step across two pages and real timers: a quarter of a second. */
const IN_STEP_MS = 250;

type PausedDelivered = 'before' | 'at' | 'after';

interface ReturnRow {
  label: string;
  hiddenMs: number;
  /** When the PAUSED of the browser's stop reaches the app; null: no stop (control). */
  paused: PausedDelivered | null;
  /** The participant pressed Sync this long before hiding the page. */
  syncPressedBeforeHideMs?: number;
}

interface PlayerReading {
  state: number;
  currentTime: number;
  at: number;
}

let pair: HostGuestPair;

async function readPlayer(page: Page): Promise<PlayerReading> {
  return page.evaluate(() => {
    const player = (
      window as unknown as {
        __fakeYtLastPlayer: { __state: number; getCurrentTime(): number };
      }
    ).__fakeYtLastPlayer;
    return { state: player.__state, currentTime: player.getCurrentTime(), at: Date.now() };
  });
}

/** Guest position minus host position at the same instant, in ms. */
async function guestOffsetMs(): Promise<number> {
  const [host, guest] = await Promise.all([readPlayer(pair.hostPage), readPlayer(pair.guestPage)]);
  const guestRate = guest.state === 1 ? 1 : 0;
  const hostRate = host.state === 1 ? 1 : 0;
  const instant = Math.max(host.at, guest.at);
  const guestPosition = guest.currentTime + (guestRate * (instant - guest.at)) / 1000;
  const hostPosition = host.currentTime + (hostRate * (instant - host.at)) / 1000;
  return Math.round((guestPosition - hostPosition) * 1000);
}

async function waitForPlaying(page: Page): Promise<void> {
  await waitForState(page, 'playback.activity', 'playing');
  await expect.poll(async () => (await readFakeYtSnapshot(page))?.state).toBe(1);
}

async function prepareRoom(): Promise<void> {
  await connectHostAndGuest(pair.hostPage, pair.guestPage);
  await pair.hostPage.evaluate(() => {
    const bus = (
      window as unknown as {
        __MUSIXQUARE_BUS__: { emit: (type: string, ...args: unknown[]) => void };
      }
    ).__MUSIXQUARE_BUS__;
    bus.emit('youtube:load-from-chat', 'https://www.youtube.com/watch?v=FAKEVID0001');
  });
  await Promise.all([waitForPlaying(pair.hostPage), waitForPlaying(pair.guestPage)]);
  // Let the initial rendezvous finish through advancing media.
  await expect
    .poll(async () => (await readFakeYtSnapshot(pair.guestPage))?.currentTime ?? 0)
    .toBeGreaterThan(6);
  await expect.poll(async () => Math.abs(await guestOffsetMs())).toBeLessThan(IN_STEP_MS);
}

/**
 * Hide the guest page, stop its iframe as the browser would, deliver the
 * PAUSED callback at the row's moment and show the page again. Resolves with
 * the time of the visible event.
 */
async function returnAroundTheStop(row: ReturnRow): Promise<number> {
  return pair.guestPage.evaluate(
    async ({
      hiddenMs,
      paused,
      syncPressedBeforeHideMs,
      stopBeforeVisibleMs,
      pausedAfterVisibleMs,
    }) => {
      const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
      const setVisibility = (value: DocumentVisibilityState): void => {
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          get: () => value,
        });
        Object.defineProperty(document, 'hidden', {
          configurable: true,
          get: () => value === 'hidden',
        });
        document.dispatchEvent(new Event('visibilitychange'));
      };
      const root = window as unknown as {
        __fakeYtLastPlayer: {
          __setState(state: number, emit?: boolean): void;
          __events: { onStateChange?: (event: { data: number; target: unknown }) => void };
        };
        __MUSIXQUARE_BUS__: {
          on(type: string, listener: (...args: unknown[]) => void): () => void;
        };
      };
      const player = root.__fakeYtLastPlayer;
      // The IFrame API's own PAUSED callback, into youtube/iframe.ts.
      const deliverPaused = (): void => {
        player.__events.onStateChange?.({ data: 2, target: player });
      };

      if (syncPressedBeforeHideMs !== null) {
        // The Sync button: its rendezvous plays at a 1.5 s margin, calibrates
        // for 0.8 s and starts a 3 s cooldown when it is admitted.
        await new Promise<void>((resolve, reject) => {
          const refused = window.setTimeout(() => {
            stop();
            reject(new Error('Sync started no rendezvous'));
          }, 5_000);
          const stop = root.__MUSIXQUARE_BUS__.on('youtube:sync-loading', (loading, owner) => {
            if (loading !== true || owner !== 'rendezvous') return;
            window.clearTimeout(refused);
            stop();
            resolve();
          });
          document.getElementById('btn-sync')!.click();
        });
        await sleep(syncPressedBeforeHideMs);
      }
      setVisibility('hidden');
      await sleep(hiddenMs - stopBeforeVisibleMs);
      // The browser stops the hidden iframe; its callback is not delivered yet.
      if (paused !== null) player.__setState(2, false);
      if (paused === 'before') deliverPaused();
      await sleep(stopBeforeVisibleMs);
      const returnedAt = Date.now();
      setVisibility('visible');
      if (paused === 'at') deliverPaused();
      if (paused === 'after') {
        await sleep(pausedAfterVisibleMs);
        deliverPaused();
      }
      return returnedAt;
    },
    {
      hiddenMs: row.hiddenMs,
      paused: row.paused,
      syncPressedBeforeHideMs: row.syncPressedBeforeHideMs ?? null,
      stopBeforeVisibleMs: STOP_BEFORE_VISIBLE_MS,
      pausedAfterVisibleMs: PAUSED_AFTER_VISIBLE_MS,
    },
  );
}

const SUB_SECOND_MS = DEFAULT_RECOVER_THRESHOLD_MS - 200;
const RETURN_MS = DEFAULT_RECOVER_THRESHOLD_MS + 500;
const AFTER_SYNC_MS = DEFAULT_RECOVER_THRESHOLD_MS + 100;
const SYNC_BEFORE_HIDE_MS = 1_600;
const WHEN: Record<PausedDelivered, string> = {
  before: 'before the visible event',
  at: 'at the visible event',
  after: `${PAUSED_AFTER_VISIBLE_MS} ms after the visible event`,
};
const ORDERINGS: readonly PausedDelivered[] = ['before', 'at', 'after'];

const ROWS: readonly ReturnRow[] = [
  // Control: a sub-second bounce without a stop never left the host.
  { label: `hidden ${SUB_SECOND_MS} ms, no stop (control)`, hiddenMs: SUB_SECOND_MS, paused: null },
  // Stays paused on today's code: no return Sync below 1 s, and the stop is
  // recorded as the participant's own pause.
  ...ORDERINGS.map((paused) => ({
    label: `hidden ${SUB_SECOND_MS} ms, PAUSED ${WHEN[paused]}`,
    hiddenMs: SUB_SECOND_MS,
    paused,
  })),
  // The normal return, which recovers today: the return rendezvous re-aligns
  // the guest.
  ...ORDERINGS.map((paused) => ({
    label: `hidden ${RETURN_MS} ms, PAUSED ${WHEN[paused]}`,
    hiddenMs: RETURN_MS,
    paused,
  })),
  // Sync pressed, the page hidden right after its play and shown again
  // inside its 3 s cooldown: the return chain waits, unowned. Recovers today
  // before and at the visible event; just after it, the stop counts as the
  // participant's pause, ends the waiting chain and stays paused today.
  ...ORDERINGS.map((paused) => ({
    label:
      `Sync pressed ${SYNC_BEFORE_HIDE_MS} ms before hiding, hidden ${AFTER_SYNC_MS} ms, ` +
      `PAUSED ${WHEN[paused]}`,
    hiddenMs: AFTER_SYNC_MS,
    paused,
    syncPressedBeforeHideMs: SYNC_BEFORE_HIDE_MS,
  })),
];

test.describe('YouTube guest return at the moment of the background stop', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
    await installFakeYt(pair.hostPage, { advanceClock: true });
    await installFakeYt(pair.guestPage, { advanceClock: true });
  });

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
      const snapshots = await Promise.allSettled(
        [pair.hostPage, pair.guestPage].map((page) =>
          page.evaluate(() => {
            const w = window as unknown as {
              __MUSIXQUARE_GET_STATE__: (key: string) => unknown;
              __fakeYtLog: unknown[];
            };
            return {
              state: Object.fromEntries(
                ['playback.activity', 'network.isOperator', 'playlist.currentQueueItemId'].map(
                  (key) => [key, w.__MUSIXQUARE_GET_STATE__(key)],
                ),
              ),
              playerLog: w.__fakeYtLog,
            };
          }),
        ),
      );
      await testInfo.attach('background-stop-return-diagnostics', {
        body: JSON.stringify({ snapshots }),
        contentType: 'application/json',
      });
    }
    await cleanupContexts(pair);
  });

  for (const row of ROWS) {
    test(`${row.label}: the guest plays in step without a tap`, async () => {
      test.setTimeout(90_000);
      await prepareRoom();
      await waitForState(pair.guestPage, 'network.isOperator', false);

      const returnedAt = await returnAroundTheStop(row);
      let resumedAfterMs: number | null = null;
      while (Date.now() - returnedAt < WATCH_MS) {
        const reading = await readPlayer(pair.guestPage);
        if (resumedAfterMs === null && reading.state === 1) {
          resumedAfterMs = reading.at - returnedAt;
        }
        await pair.guestPage.waitForTimeout(100);
      }
      const guest = await readPlayer(pair.guestPage);
      const offsetMs = await guestOffsetMs();
      test.info().annotations.push({
        type: 'outcome',
        description: JSON.stringify({ guestState: guest.state, resumedAfterMs, offsetMs }),
      });

      expect(guest.state, 'guest iframe state after the return').toBe(1);
      expect(resumedAfterMs, 'ms from the return until the guest plays').not.toBeNull();
      expect(resumedAfterMs!).toBeLessThanOrEqual(RESUME_DEADLINE_MS);
      expect(Math.abs(offsetMs), 'guest offset from the host in ms').toBeLessThan(IN_STEP_MS);
    });
  }
});
