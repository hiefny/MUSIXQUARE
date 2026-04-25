/**
 * @vitest-environment jsdom
 *
 * YouTube Sync Integration Tests — Route C of the drift-regression plan.
 *
 * These tests exercise the REAL exported handlers of `src/youtube/sync.ts`
 * and `src/youtube/player.ts` against a fake YT player object under vitest
 * fake timers. The sync protocol has two paths in `scheduleYtAutoSync`:
 *   - Path A (immediate-rendezvous): pure PLAY/SEEK on the same video —
 *     skips Stage 1 entirely and fires YOUTUBE_SYNC{isManual:true}
 *     immediately so guests run a single guestRendezvousSync().
 *   - Path B (2-stage, post-85ad164): transitions (videoId/subIndex/
 *     rendezvousDelayMs override) or pause — broadcasts YOUTUBE_STATE
 *     with hostPlayAt=0 immediately, then YOUTUBE_SYNC{isManual:true}
 *     at Stage 2 after STAGE2_RENDEZVOUS_BROADCAST_MS so guests have
 *     time to loadVideoById before precision sync.
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
  isClockCalibrated: vi.fn(() => true),
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

  // All scheduleYtAutoSync calls now flow through the 2-stage protocol
  // (Stage 1 YOUTUBE_STATE → wait → Stage 2 YOUTUBE_SYNC{isManual:true}).
  // A previous Path A "immediate rendezvous" optimization for same-video
  // PLAY/SEEK was reverted — the iframe's getPlayerState/getCurrentTime
  // async race plus variable seek-buffer time made the immediate broadcast
  // carry stale data on slower devices/networks.
  describe('scheduleYtAutoSync — 2-stage broadcast', () => {
    it('Stage 1 broadcast is YOUTUBE_STATE with hostPlayAt=0 when videoId override is set', async () => {
      installPlayer({ __state: 2 });
      const { scheduleYtAutoSync } = await importPlayer();
      const { broadcast } = await import('../../network/peer.ts');

      // videoId override marks this as a transition → Path B
      scheduleYtAutoSync(10, { videoId: 'NEW_VID' });

      // Stage 1 only at this point — Stage 2 fires after STAGE2_RENDEZVOUS_BROADCAST_MS.
      expect(broadcast).toHaveBeenCalledTimes(1);
      const msg = (broadcast as any).mock.calls[0][0];
      expect(msg.type).toBe(MSG.YOUTUBE_STATE);
      expect(msg.state).toBe(1);
      expect(msg.time).toBe(10);
      expect(msg.videoId).toBe('NEW_VID');
      // hostPlayAt=0 signals "act immediately"; precision comes from Stage 2.
      expect(msg.hostPlayAt).toBe(0);
    });

    it('does NOT broadcast Stage 2 before STAGE2_RENDEZVOUS_BROADCAST_MS (=2000ms)', async () => {
      installPlayer({ __state: 2 });
      const { scheduleYtAutoSync } = await importPlayer();
      const { broadcast } = await import('../../network/peer.ts');

      scheduleYtAutoSync(10, { videoId: 'NEW_VID' });
      (broadcast as any).mockClear(); // drop Stage 1

      vi.advanceTimersByTime(1999);
      expect(broadcast).not.toHaveBeenCalled();
    });

    it('broadcasts YOUTUBE_SYNC{isManual:true} at Stage 2', async () => {
      installPlayer({ __state: 1, __currentTime: 10 });
      const { scheduleYtAutoSync } = await importPlayer();
      const { broadcast } = await import('../../network/peer.ts');

      scheduleYtAutoSync(10, { videoId: 'NEW_VID' });
      (broadcast as any).mockClear(); // drop Stage 1

      vi.advanceTimersByTime(2000);
      expect(broadcast).toHaveBeenCalled();
      const stage2 = (broadcast as any).mock.calls[0][0];
      expect(stage2.type).toBe(MSG.YOUTUBE_SYNC);
      expect(stage2.isManual).toBe(true);
    });

    it('rapid transitions debounce Stage 2 — only ONE YOUTUBE_SYNC fires', async () => {
      const player = installPlayer({ __state: 2 });
      const { scheduleYtAutoSync } = await importPlayer();
      const { broadcast } = await import('../../network/peer.ts');

      scheduleYtAutoSync(10, { videoId: 'NEW_VID' });
      vi.advanceTimersByTime(500);
      scheduleYtAutoSync(20, { videoId: 'NEW_VID' });
      (broadcast as any).mockClear(); // drop Stage 1s

      vi.advanceTimersByTime(2500); // well past Stage 2 deadline for the second schedule

      // Stage 2 (YOUTUBE_SYNC) should fire exactly once — the first schedule's
      // Stage 2 timer is canceled via clearManagedTimer('yt-auto-sync').
      const stage2Calls = (broadcast as any).mock.calls.filter(
        (c: any[]) => c[0]?.type === MSG.YOUTUBE_SYNC,
      );
      expect(stage2Calls).toHaveLength(1);

      // Final seek target must be 20, not 10 — "last action wins"
      const seeks = player.__log.filter(c => c.op === 'seekTo');
      expect(seeks.length).toBeGreaterThanOrEqual(2);
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

  // 11. cancelYtAutoSync clears the auto-sync timer
  // Path A doesn't set the yt-auto-sync timer at all, so this test exercises
  // Path B (transition) where the Stage 2 timer is what cancelYtAutoSync targets.
  describe('cancelYtAutoSync', () => {
    it('clears the yt-auto-sync timer set by Path B (transition)', async () => {
      installPlayer({ __state: 2 });
      const { scheduleYtAutoSync, cancelYtAutoSync } = await importPlayer();

      scheduleYtAutoSync(10, { videoId: 'NEW_VID' });
      expect(getManagedTimer('yt-auto-sync')).not.toBeNull();

      cancelYtAutoSync();
      expect(getManagedTimer('yt-auto-sync')).toBeNull();
    });
  });
});
