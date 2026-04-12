/**
 * @vitest-environment jsdom
 *
 * YouTube Sync Integration Tests — Route C of the drift-regression plan.
 *
 * These tests exercise the REAL exported handlers of `src/youtube/sync.ts`
 * and `src/youtube/player.ts` against a fake YT player object under vitest
 * fake timers. Every test pins a specific regression from the recent
 * YouTube-sync fix sequence (commits 73788a3 → 93b8b78). If any of those
 * fixes gets reverted, the corresponding test fails loudly.
 *
 * Key design decisions:
 *   - Real core/timers.ts so `setManagedTimer` / `getManagedTimer` work
 *     under `vi.useFakeTimers()` and behave identically to production.
 *   - Real core/state.ts so `setState('appState', PLAYING_YOUTUBE)` unblocks
 *     the guards at the top of handleYouTubeSync / handleYouTubeState.
 *   - Real core/events.ts (bus) so emits from sync.ts don't error out.
 *   - Mocked `_state.ts::getYouTubePlayer` swapped per test via `.mockReturnValue`.
 *   - Mocked `network/shared-clock.ts::getHostNow` that returns `Date.now()` so
 *     the SharedClock tracks fake-time.
 *   - `registerHandlers` is captured so we can invoke the non-exported
 *     `handleYouTubeSync` / `handleYouTubeState` handlers directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetState, setState, getState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { clearAllManagedTimers, getManagedTimer } from '../../core/timers.ts';
import { APP_STATE, MSG } from '../../core/constants.ts';
import { makeFakeYtPlayer, type FakeYtPlayer, mutationOps } from './__helpers__/fake-yt-player.ts';

// ─── Mocks ───────────────────────────────────────────────────────────────

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../i18n/index.ts', () => ({
  t: vi.fn((k: string) => k),
}));

vi.mock('../../network/peer.ts', () => ({
  broadcast: vi.fn(),
  safeSend: vi.fn(),
  sendToHost: vi.fn(),
  isRemoteGuest: vi.fn(() => false),
}));

// registerHandlers captures the handler map so tests can invoke
// handleYouTubeSync / handleYouTubeState directly (they're not exported).
const capturedHandlers: Record<string, (data: Record<string, unknown>) => void> = {};
vi.mock('../../network/protocol.ts', () => ({
  registerHandlers: vi.fn((handlers: Record<string, any>) => {
    for (const [type, h] of Object.entries(handlers)) {
      if (typeof h === 'function') capturedHandlers[type] = h as (data: Record<string, unknown>) => void;
    }
  }),
  verifyOperator: vi.fn(() => true),
}));

// getHostNow tracks Date.now() so it advances with vitest fake timers.
vi.mock('../../network/shared-clock.ts', () => ({
  getHostNow: vi.fn(() => Date.now()),
  getClockOffset: vi.fn(() => 0),
  getClockBestRtt: vi.fn(() => 0),
  setIsHostClock: vi.fn(),
  registerPing: vi.fn(),
  processSyncPong: vi.fn(),
  resetClockState: vi.fn(),
}));

// fake player swap — each test sets its own via getYouTubePlayerMock.mockReturnValue
const getYouTubePlayerMock = vi.fn<[], FakeYtPlayer | null>(() => null);
vi.mock('../_state.ts', () => ({
  getYouTubePlayer: (...args: unknown[]) => getYouTubePlayerMock(...(args as [])),
  setYouTubePlayer: vi.fn(),
  getCurrentSessionId: vi.fn(() => 1),
  incrementSessionId: vi.fn(),
  isYtScriptLoading: vi.fn(() => false),
  setYtScriptLoading: vi.fn(),
  getYtIOSWatchdog: vi.fn(() => null),
  setYtIOSWatchdog: vi.fn(),
  getYtScope: vi.fn(() => null),
  setYtScope: vi.fn(),
  replaceYtScope: vi.fn(),
  isYtLoadInProgress: vi.fn(() => false),
  setYtLoadInProgress: vi.fn(),
  getYtAutoplayIntent: vi.fn(() => false),
  setYtAutoplayIntent: vi.fn(),
  getCachedYtDuration: vi.fn(() => 0),
  setCachedYtDuration: vi.fn(),
  getCachedYtPlaylistIdx: vi.fn(() => -1),
  setCachedYtPlaylistIdx: vi.fn(),
  setYouTubeSubIndex: vi.fn((idx: number) => setState('youtube.currentSubIndex', idx)),
  updateSubItemIds: vi.fn(),
  updateSubItemTitle: vi.fn(),
  setSubItemsData: vi.fn(),
}));

// iframe.ts — stub out side-effectful exports
vi.mock('../iframe.ts', () => ({
  loadYouTubeVideo: vi.fn(),
  refreshYouTubeDisplay: vi.fn(),
  markYtStateBroadcast: vi.fn(),
}));

// search.ts — stub out fetches
vi.mock('../search.ts', () => ({
  extractYouTubeVideoId: vi.fn(() => null),
  extractYouTubePlaylistId: vi.fn(() => null),
  fetchOEmbedTitle: vi.fn(async () => null),
  fetchYouTubePreview: vi.fn(),
  fetchPlaylistSubTitles: vi.fn(),
}));

// transport.ts — fmtTime + setAppState, both trivial
vi.mock('../../player/transport.ts', () => ({
  fmtTime: vi.fn((s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`),
  setAppState: vi.fn((s: string) => setState('appState', s)),
}));

vi.mock('../../ui/toast.ts', () => ({
  showToast: vi.fn(),
  showLoader: vi.fn(),
}));

// handlers.ts — stub handlers not under test
vi.mock('../handlers.ts', () => ({
  handleYouTubePlay: vi.fn(),
  handleRequestYouTubePlay: vi.fn(),
  handleRequestYouTubePause: vi.fn(),
  handleRequestYouTubeToggle: vi.fn(),
  handleRequestYouTubeSubSeek: vi.fn(),
  handleRequestYouTubePlaylistInfo: vi.fn(),
}));

// ─── Test lifecycle ──────────────────────────────────────────────────────

beforeEach(async () => {
  resetState();
  bus.clear();
  clearAllManagedTimers();
  for (const k of Object.keys(capturedHandlers)) delete capturedHandlers[k];
  vi.useFakeTimers();
  // Pin wall clock so Date.now() === 1_700_000_000_000 at start of each test.
  // Without setSystemTime, fake-timers doesn't advance Date.now() reliably
  // across platforms, and our getHostNow mock depends on Date.now().
  vi.setSystemTime(new Date(1_700_000_000_000));
  getYouTubePlayerMock.mockReset();
  getYouTubePlayerMock.mockReturnValue(null);

  setState('appState', APP_STATE.PLAYING_YOUTUBE);

  // Initialize sync module so registerHandlers captures handlers.
  const syncMod = await import('../sync.ts');
  syncMod.initYouTubeSync();
  // Clear module-level state leaked from prior tests (_autoSyncUntil,
  // _lastHostSyncTime, _hostAdPauseActive, _lastHostSnapshot, etc.).
  // Without this the ad-detection and drift tests are corrupted by the
  // cooldown state set in earlier tests that call handleYouTubeState.
  syncMod.resetYouTubeSyncState();
});

afterEach(() => {
  clearAllManagedTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

// ─── Helpers ─────────────────────────────────────────────────────────────

function installPlayer(init?: Parameters<typeof makeFakeYtPlayer>[0]): FakeYtPlayer {
  const p = makeFakeYtPlayer(init);
  getYouTubePlayerMock.mockReturnValue(p);
  return p;
}

async function importPlayer() {
  return import('../player.ts');
}

async function importSync() {
  return import('../sync.ts');
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('YouTube Sync — Regression Integration', () => {

  // 1. scheduleYtAutoSync force-pauses even when state==PAUSED (regression for 9b0458e)
  describe('scheduleYtAutoSync — force pause (commit 9b0458e)', () => {
    it('calls pauseVideo even when player reports PAUSED state', async () => {
      const player = installPlayer({ __state: 2 /* PAUSED */, __currentTime: 30 });
      const { scheduleYtAutoSync } = await importPlayer();

      scheduleYtAutoSync(42);

      const ops = mutationOps(player);
      // pauseVideo must be called regardless of reported state — otherwise a
      // seek landing in the post-playVideo grace would see a lying PAUSED and
      // skip pausing, causing "spinner up but video is actually playing".
      expect(ops).toContain('pauseVideo');
      expect(ops).toContain('seekTo');
      // seekTo must be called AFTER pauseVideo (pause-then-seek = in-buffer, no rebuffer)
      const pauseIdx = ops.indexOf('pauseVideo');
      const seekIdx = ops.indexOf('seekTo');
      expect(pauseIdx).toBeLessThan(seekIdx);
      expect(player.__log[seekIdx].args).toEqual([42, true]);
    });

    it('broadcasts YOUTUBE_STATE with hostPlayAt ≈ getHostNow()+1000', async () => {
      installPlayer({ __state: 2 });
      const { scheduleYtAutoSync } = await importPlayer();
      const { broadcast } = await import('../../network/peer.ts');

      const tBefore = Date.now();
      scheduleYtAutoSync(10);

      expect(broadcast).toHaveBeenCalledTimes(1);
      const msg = (broadcast as any).mock.calls[0][0];
      expect(msg.type).toBe(MSG.YOUTUBE_STATE);
      expect(msg.state).toBe(1);
      expect(msg.time).toBe(10);
      expect(msg.hostPlayAt).toBeGreaterThanOrEqual(tBefore + 1000);
      expect(msg.hostPlayAt).toBeLessThanOrEqual(tBefore + 1005);
    });
  });

  // 2. scheduleYtAutoSync calls playVideo exactly 1000ms later (happy path)
  describe('scheduleYtAutoSync — 1-second countdown', () => {
    it('does NOT call playVideo before 1000ms', async () => {
      const player = installPlayer({ __state: 2 });
      const { scheduleYtAutoSync } = await importPlayer();

      scheduleYtAutoSync(10);
      player.__log.length = 0; // clear initial pause/seek
      vi.advanceTimersByTime(999);

      expect(player.__log.find(c => c.op === 'playVideo')).toBeUndefined();
    });

    it('calls playVideo at exactly 1000ms', async () => {
      const player = installPlayer({ __state: 2 });
      const { scheduleYtAutoSync } = await importPlayer();

      scheduleYtAutoSync(10);
      vi.advanceTimersByTime(1000);

      expect(player.__log.find(c => c.op === 'playVideo')).toBeDefined();
    });
  });

  // 3. Grace window stays active 500ms after playVideo (regression for c11173f)
  describe('scheduleYtAutoSync — post-play grace window (commit c11173f)', () => {
    it('yt-sync-grace timer is live from T=1000 through T=1499, gone at T=1500', async () => {
      installPlayer({ __state: 2 });
      const { scheduleYtAutoSync } = await importPlayer();

      scheduleYtAutoSync(10);
      // Before play, grace hasn't been set yet
      expect(getManagedTimer('yt-sync-grace')).toBeNull();

      vi.advanceTimersByTime(1000);
      // Immediately after playVideo, grace timer is armed
      expect(getManagedTimer('yt-sync-grace')).not.toBeNull();

      vi.advanceTimersByTime(499);
      // Still live at T=1499
      expect(getManagedTimer('yt-sync-grace')).not.toBeNull();

      vi.advanceTimersByTime(2); // -> T=1501
      // Cleared after 500ms
      expect(getManagedTimer('yt-sync-grace')).toBeNull();
    });

    it('seek during grace window re-routes through scheduleYtAutoSync (not bare seek)', async () => {
      const player = installPlayer({ __state: 2, __duration: 300 });
      const { initYouTube, scheduleYtAutoSync } = await importPlayer();
      initYouTube(); // register bus listeners including youtube:seek-to

      scheduleYtAutoSync(10);
      vi.advanceTimersByTime(1000); // now in grace window
      // Player reports PAUSED (since playVideo is the last mutation but our fake
      // doesn't flip until playVideo is actually called — which it was). Let's
      // emulate the real YT IFrame API lag: the state still reads PAUSED for
      // the first 30-100ms after playVideo. That's exactly the race this fix
      // addresses.
      player.__state = 2;
      const { broadcast } = await import('../../network/peer.ts');
      (broadcast as any).mockClear();
      player.__log.length = 0;

      // Seek in the middle of the grace window via the bus
      bus.emit('youtube:seek-to', 50);

      // Instead of a bare seek, scheduleYtAutoSync should have been invoked:
      // - player.pauseVideo called
      // - player.seekTo(50, true) called
      // - broadcast with state=1 (not state=2)
      const ops = mutationOps(player);
      expect(ops).toContain('pauseVideo');
      expect(ops).toContain('seekTo');
      expect((broadcast as any).mock.calls.length).toBeGreaterThanOrEqual(1);
      const lastMsg = (broadcast as any).mock.calls[0][0];
      expect(lastMsg.state).toBe(1); // state=1 is the tell-tale for scheduleYtAutoSync, bare seek uses state=2
      expect(lastMsg.time).toBe(50);
    });
  });

  // 4. Last-action-wins: rapid scheduleYtAutoSync cancels prior timer (fdaf070)
  describe('scheduleYtAutoSync — last-action-wins (commit fdaf070)', () => {
    it('second scheduleYtAutoSync cancels the first — playVideo fires only once', async () => {
      const player = installPlayer({ __state: 2 });
      const { scheduleYtAutoSync } = await importPlayer();

      scheduleYtAutoSync(10);
      vi.advanceTimersByTime(500);
      scheduleYtAutoSync(20);
      vi.advanceTimersByTime(1500); // 500 + 1500 = 2000, well past both timers

      const playCalls = player.__log.filter(c => c.op === 'playVideo');
      expect(playCalls).toHaveLength(1);

      // Final seek target must be 20, not 10 — "last action wins"
      const seeks = player.__log.filter(c => c.op === 'seekTo');
      expect(seeks.length).toBeGreaterThanOrEqual(2); // one per schedule
      expect(seeks[seeks.length - 1].args).toEqual([20, true]);
    });
  });

  // 5. Host seeks during guest countdown: new handleYouTubeState supersedes prior (cd75008)
  describe('handleYouTubeState — host seeks during countdown (commit cd75008)', () => {
    it('second YOUTUBE_STATE during countdown replaces the first scheduled play', async () => {
      const player = installPlayer({ __state: 2, __duration: 300, __currentTime: 0 });
      const handler = capturedHandlers[MSG.YOUTUBE_STATE];
      expect(handler).toBeDefined();

      // First host command: pause+seek to 5, play at +1000ms
      handler({ state: 1, time: 5, hostPlayAt: Date.now() + 1000, subIndex: 0, videoId: 'FAKE_VIDEO' });
      vi.advanceTimersByTime(400);

      // Second host command 400ms in: should cancel the first and re-schedule to 8
      handler({ state: 1, time: 8, hostPlayAt: Date.now() + 1000, subIndex: 0, videoId: 'FAKE_VIDEO' });
      vi.advanceTimersByTime(1100); // let the second countdown complete

      // playVideo should fire exactly once — the second scheduling
      const playCalls = player.__log.filter(c => c.op === 'playVideo');
      expect(playCalls.length).toBe(1);

      // Last seekTo must be to 8, not 5
      const seeks = player.__log.filter(c => c.op === 'seekTo');
      expect(seeks.length).toBeGreaterThanOrEqual(2);
      expect(seeks[seeks.length - 1].args).toEqual([8, true]);
    });
  });

  // 6. handleYouTubeSync drift > 3s calls seekTo
  describe('handleYouTubeSync — drift correction threshold', () => {
    it('drift > 3s triggers seekTo to compensatedTime', async () => {
      const player = installPlayer({
        __state: 1,
        __currentTime: 10,
        __duration: 300,
      });
      const handler = capturedHandlers[MSG.YOUTUBE_SYNC];
      expect(handler).toBeDefined();

      handler({ time: 14.5, state: 1, subIndex: 0, videoId: 'FAKE_VIDEO' });

      const seeks = player.__log.filter(c => c.op === 'seekTo');
      expect(seeks).toHaveLength(1);
      expect(seeks[0].args).toEqual([14.5, true]);
    });

    it('drift ≤ 3s does NOT trigger seekTo', async () => {
      const player = installPlayer({
        __state: 1,
        __currentTime: 10,
        __duration: 300,
      });
      const handler = capturedHandlers[MSG.YOUTUBE_SYNC];

      handler({ time: 12.5, state: 1, subIndex: 0, videoId: 'FAKE_VIDEO' });

      const seeks = player.__log.filter(c => c.op === 'seekTo');
      expect(seeks).toHaveLength(0);
    });
  });

  // 7. handleYouTubeSync during _autoSyncUntil skips drift
  describe('handleYouTubeSync — _autoSyncUntil cooldown', () => {
    it('drift correction is suppressed during the countdown window', async () => {
      const player = installPlayer({
        __state: 1,
        __currentTime: 10,
        __duration: 300,
      });
      const stateHandler = capturedHandlers[MSG.YOUTUBE_STATE];
      const syncHandler = capturedHandlers[MSG.YOUTUBE_SYNC];

      // Arm the cooldown by triggering a clock-scheduled state change
      stateHandler({ state: 1, time: 10, hostPlayAt: Date.now() + 1000, subIndex: 0, videoId: 'FAKE_VIDEO' });
      // The cooldown is now active until Date.now() + waitMs + 1500

      // Clear the pause/seek from stateHandler to focus on sync behavior
      player.__log.length = 0;

      // Fire a sync with massive drift — should be ignored
      syncHandler({ time: 200, state: 1, subIndex: 0, videoId: 'FAKE_VIDEO' });

      const seeks = player.__log.filter(c => c.op === 'seekTo');
      expect(seeks).toHaveLength(0);
    });
  });

  // 8. Ad detection: 3 stale frames pause, recovery resumes
  describe('handleYouTubeSync — host ad detection', () => {
    it('pauses guest after 3 consecutive stale host-time frames', async () => {
      const player = installPlayer({ __state: 1, __currentTime: 42, __duration: 300 });
      const handler = capturedHandlers[MSG.YOUTUBE_SYNC];

      // First frame establishes baseline
      handler({ time: 42.0, state: 1, subIndex: 0, videoId: 'FAKE_VIDEO' });
      player.__log.length = 0; // ignore any initial ops

      // Frames 2-4 are stale — on frame 4 (counter reaches 3), guest pauses
      handler({ time: 42.01, state: 1, subIndex: 0, videoId: 'FAKE_VIDEO' });
      expect(player.__log.find(c => c.op === 'pauseVideo')).toBeUndefined();

      handler({ time: 42.02, state: 1, subIndex: 0, videoId: 'FAKE_VIDEO' });
      expect(player.__log.find(c => c.op === 'pauseVideo')).toBeUndefined();

      handler({ time: 42.03, state: 1, subIndex: 0, videoId: 'FAKE_VIDEO' });
      expect(player.__log.find(c => c.op === 'pauseVideo')).toBeDefined();
    });

    it('resumes guest when host time starts moving again', async () => {
      const player = installPlayer({ __state: 1, __currentTime: 42, __duration: 300 });
      const handler = capturedHandlers[MSG.YOUTUBE_SYNC];

      // Enter ad-paused state
      handler({ time: 42.0, state: 1, subIndex: 0, videoId: 'FAKE_VIDEO' });
      handler({ time: 42.01, state: 1, subIndex: 0, videoId: 'FAKE_VIDEO' });
      handler({ time: 42.02, state: 1, subIndex: 0, videoId: 'FAKE_VIDEO' });
      handler({ time: 42.03, state: 1, subIndex: 0, videoId: 'FAKE_VIDEO' });
      player.__state = 2; // pauseVideo flipped us
      player.__log.length = 0;

      // Host time moves 5 seconds forward (large delta, ad ended)
      handler({ time: 47.5, state: 1, subIndex: 0, videoId: 'FAKE_VIDEO' });

      expect(player.__log.find(c => c.op === 'playVideo')).toBeDefined();
    });
  });

  // 9. resetYouTubeSyncState clears all managed timers + re-enables drift correction
  describe('resetYouTubeSyncState', () => {
    it('clears rendezvous timers and re-enables drift correction', async () => {
      const player = installPlayer({ __state: 1, __currentTime: 10, __duration: 300 });
      const stateHandler = capturedHandlers[MSG.YOUTUBE_STATE];
      const syncHandler = capturedHandlers[MSG.YOUTUBE_SYNC];
      const { resetYouTubeSyncState } = await importSync();

      // Arm the cooldown
      stateHandler({ state: 1, time: 10, hostPlayAt: Date.now() + 1000, subIndex: 0, videoId: 'FAKE_VIDEO' });

      // Reset
      resetYouTubeSyncState();

      // yt-clock-action shouldn't be cleared by resetYouTubeSyncState per its
      // docstring (only yt-rendezvous-* are cleared + _autoSyncUntil + snapshot).
      // But drift correction should work again. Clear log first.
      player.__log.length = 0;

      // Sync with drift > 3s should now seek
      syncHandler({ time: 200, state: 1, subIndex: 0, videoId: 'FAKE_VIDEO' });

      const seeks = player.__log.filter(c => c.op === 'seekTo');
      expect(seeks).toHaveLength(1);
    });
  });

  // 10. NaN state in handleYouTubeState drops message (commit 93b8b78)
  describe('handleYouTubeState — NaN state guard (commit 93b8b78)', () => {
    it('drops message when state is not a finite number', async () => {
      const player = installPlayer({ __state: 1, __currentTime: 10, __duration: 300 });
      const handler = capturedHandlers[MSG.YOUTUBE_STATE];

      handler({ state: 'garbage', time: 5, hostPlayAt: Date.now() + 1000, subIndex: 0, videoId: 'FAKE_VIDEO' });
      vi.advanceTimersByTime(1500);

      // No player mutations should have happened
      expect(player.__log).toHaveLength(0);
    });

    it('drops message when state is undefined', async () => {
      const player = installPlayer({ __state: 1, __currentTime: 10, __duration: 300 });
      const handler = capturedHandlers[MSG.YOUTUBE_STATE];

      handler({ time: 5, hostPlayAt: Date.now() + 1000, subIndex: 0, videoId: 'FAKE_VIDEO' });
      vi.advanceTimersByTime(1500);

      expect(player.__log).toHaveLength(0);
    });
  });

  // 11. cancelYtAutoSync clears both timers
  describe('cancelYtAutoSync', () => {
    it('clears yt-auto-sync and yt-sync-grace timers', async () => {
      installPlayer({ __state: 2 });
      const { scheduleYtAutoSync, cancelYtAutoSync } = await importPlayer();

      scheduleYtAutoSync(10);
      expect(getManagedTimer('yt-auto-sync')).not.toBeNull();

      cancelYtAutoSync();
      expect(getManagedTimer('yt-auto-sync')).toBeNull();
      expect(getManagedTimer('yt-sync-grace')).toBeNull();
    });
  });
});
