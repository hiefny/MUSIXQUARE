/**
 * @vitest-environment jsdom
 *
 * YouTube sync integration tests.
 *
 * These tests exercise the REAL exported handlers of `src/youtube/sync.ts`
 * and `src/youtube/player.ts` against a fake YT player object under vitest
 * fake timers. Every `scheduleYtAutoSync` call uses the two-stage protocol:
 * Stage 1 broadcasts YOUTUBE_STATE with hostPlayAt=0, then Stage 2 sends
 * YOUTUBE_SYNC{isManual:true} after STAGE2_RENDEZVOUS_BROADCAST_MS. The delay
 * lets guests apply state or load a new video before precision rendezvous.
 *
 * Key design decisions:
 *   - Real core/timers.ts so `setManagedTimer` / `getManagedTimer` work
 *     under `vi.useFakeTimers()` and behave identically to production.
 *   - Real playback ownership writes so YouTube mode/activity slots
 *     unblock the guards at the top of handleYouTubeSync / handleYouTubeState.
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
import { MSG } from '../../core/constants.ts';
import { isClockCalibrated } from '../../network/shared-clock.ts';
import { setPlaybackIdle, setPlaybackYouTubePlaying } from '../../player/ownership.ts';
import { makeFakeYtPlayer, type FakeYtPlayer, mutationOps } from './__helpers__/fake-yt-player.ts';

// ─── Mocks ───────────────────────────────────────────────────────────────

const localYouTubePaused = vi.hoisted(() => ({ value: false }));

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../i18n/index.ts', () => ({
  t: vi.fn((k: string) => k),
}));

vi.mock('../../network/peer.ts', () => ({
  broadcast: vi.fn(),
  safeSend: vi.fn(() => true),
  sendToHost: vi.fn(),
  isRemoteGuest: vi.fn(() => false),
}));

// registerHandlers captures the handler map so tests can invoke
// handleYouTubeSync / handleYouTubeState directly (they're not exported).
// Handlers accept an optional `conn` second arg — handleYouTubeState's
// hostConn guard requires the test to pass the mocked hostConn.
const capturedHandlers: Record<string, (data: Record<string, unknown>, conn?: unknown) => void> =
  {};
vi.mock('../../network/protocol.ts', () => ({
  registerHandlers: vi.fn((handlers: Record<string, unknown>) => {
    for (const [type, h] of Object.entries(handlers)) {
      if (typeof h === 'function')
        capturedHandlers[type] = h as (data: Record<string, unknown>, conn?: unknown) => void;
    }
  }),
  verifyOperator: vi.fn(() => true),
}));

// Mock hostConn used by handleYouTubeState's guard. Tests that simulate a
// guest receiving a host broadcast call `setState('network.hostConn',
// mockHostConn)` and pass it as the stateHandler's second arg. Host-side
// scheduleYtAutoSync tests intentionally leave hostConn null so the
// broadcast path stays active.
const mockHostConn: unknown = { peer: 'mock-host-peer', open: true };

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
  isLocalYouTubePaused: vi.fn(() => localYouTubePaused.value),
  setLocalYouTubePaused: vi.fn((paused: boolean) => {
    localYouTubePaused.value = paused;
  }),
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
  invalidateYtDurationCache: vi.fn(),
}));

// search.ts — stub out fetches
vi.mock('../search.ts', () => ({
  extractYouTubeVideoId: vi.fn(() => null),
  extractYouTubePlaylistId: vi.fn(() => null),
  fetchYouTubePreview: vi.fn(),
  fetchPlaylistSubTitles: vi.fn(),
}));

// player.ts imports the oEmbed fetcher from the oembed.ts leaf (not search.ts).
vi.mock('../oembed.ts', () => ({
  fetchOEmbedTitle: vi.fn(async () => null),
}));

// transport.ts — fmtTime is the only runtime helper needed here.
vi.mock('../../player/transport.ts', () => ({
  fmtTime: vi.fn(
    (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`,
  ),
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
  localYouTubePaused.value = false;

  setPlaybackYouTubePlaying();

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
  // All scheduleYtAutoSync calls flow through the 2-stage protocol
  // (Stage 1 YOUTUBE_STATE → wait → Stage 2 YOUTUBE_SYNC{isManual:true}).
  // Same-video PLAY/SEEK must also use both stages: the iframe's
  // getPlayerState/getCurrentTime race and variable seek-buffer time can make
  // an immediate broadcast carry stale data on slower devices or networks.
  describe('scheduleYtAutoSync — 2-stage broadcast', () => {
    it('Stage 1 broadcast is YOUTUBE_STATE with hostPlayAt=0 when videoId override is set', async () => {
      installPlayer({ __state: 2 });
      const { scheduleYtAutoSync } = await importPlayer();
      const { broadcast } = await import('../../network/peer.ts');
      const broadcastMock = vi.mocked(broadcast);

      // A videoId override exercises the new-video transition within Stage 1.
      scheduleYtAutoSync(10, { videoId: 'NEW_VID' });

      // Stage 1 only at this point — Stage 2 fires after STAGE2_RENDEZVOUS_BROADCAST_MS.
      expect(broadcast).toHaveBeenCalledTimes(1);
      const msg = broadcastMock.mock.calls[0][0];
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
      const broadcastMock = vi.mocked(broadcast);

      scheduleYtAutoSync(10, { videoId: 'NEW_VID' });
      broadcastMock.mockClear(); // drop Stage 1

      vi.advanceTimersByTime(1999);
      expect(broadcast).not.toHaveBeenCalled();
    });

    it('broadcasts YOUTUBE_SYNC{isManual:true} at Stage 2', async () => {
      installPlayer({ __state: 1, __currentTime: 10 });
      const { scheduleYtAutoSync } = await importPlayer();
      const { broadcast } = await import('../../network/peer.ts');
      const broadcastMock = vi.mocked(broadcast);

      scheduleYtAutoSync(10, { videoId: 'NEW_VID' });
      broadcastMock.mockClear(); // drop Stage 1

      vi.advanceTimersByTime(2000);
      expect(broadcast).toHaveBeenCalled();
      const stage2 = broadcastMock.mock.calls[0][0];
      expect(stage2.type).toBe(MSG.YOUTUBE_SYNC);
      expect(stage2.isManual).toBe(true);
    });

    it('rapid transitions debounce Stage 2 — only ONE YOUTUBE_SYNC fires', async () => {
      const player = installPlayer({ __state: 2 });
      const { scheduleYtAutoSync } = await importPlayer();
      const { broadcast } = await import('../../network/peer.ts');
      const broadcastMock = vi.mocked(broadcast);

      scheduleYtAutoSync(10, { videoId: 'NEW_VID' });
      vi.advanceTimersByTime(500);
      scheduleYtAutoSync(20, { videoId: 'NEW_VID' });
      broadcastMock.mockClear(); // drop Stage 1s

      vi.advanceTimersByTime(2500); // well past Stage 2 deadline for the second schedule

      // Stage 2 (YOUTUBE_SYNC) should fire exactly once — the first schedule's
      // Stage 2 timer is canceled via clearManagedTimer('yt-auto-sync').
      const stage2Calls = broadcastMock.mock.calls.filter((c) => c[0]?.type === MSG.YOUTUBE_SYNC);
      expect(stage2Calls).toHaveLength(1);

      // Final seek target must be 20, not 10 — "last action wins"
      const seeks = player.__log.filter((c) => c.op === 'seekTo');
      expect(seeks.length).toBeGreaterThanOrEqual(2);
      expect(seeks[seeks.length - 1].args).toEqual([20, true]);
    });

    it('player-ready pending sync can resume a recovered iframe from the last known position', async () => {
      const player = installPlayer({ __state: 2, __currentTime: 37 });
      const { initYouTube, setPendingAutoSyncOnReady, getPendingAutoSyncOnReady } =
        await importPlayer();
      const { broadcast } = await import('../../network/peer.ts');
      const broadcastMock = vi.mocked(broadcast);

      initYouTube();
      setPendingAutoSyncOnReady(true, {
        targetTime: 37,
        videoId: 'RECOVERED_VIDEO',
        subIndex: 2,
        skipSeek: false,
      });

      bus.emit('youtube:player-ready');

      expect(getPendingAutoSyncOnReady()).toBe(false);
      expect(player.__log.some((c) => c.op === 'seekTo' && c.args[0] === 37)).toBe(true);
      expect(player.__log.some((c) => c.op === 'playVideo')).toBe(true);

      const stage1 = broadcastMock.mock.calls.find((c) => c[0]?.type === MSG.YOUTUBE_STATE)?.[0];
      expect(stage1).toMatchObject({
        type: MSG.YOUTUBE_STATE,
        state: 1,
        time: 37,
        videoId: 'RECOVERED_VIDEO',
        subIndex: 2,
      });
    });
  });

  // 5. Host seeks during guest countdown: new state supersedes the prior countdown.
  describe('handleYouTubeState — host seeks during countdown', () => {
    it('second YOUTUBE_STATE during countdown replaces the first scheduled play', async () => {
      const player = installPlayer({ __state: 2, __duration: 300, __currentTime: 0 });
      const handler = capturedHandlers[MSG.YOUTUBE_STATE];
      expect(handler).toBeDefined();
      // Simulate guest receiving host broadcast — handleYouTubeState's
      // The sync.ts hostConn guard requires conn === network.hostConn.
      setState('network.hostConn', mockHostConn as never);

      // First host command: pause+seek to 5, play at +1000ms
      handler(
        {
          state: 1,
          time: 5,
          hostPlayAt: Date.now() + 1000,
          subIndex: 0,
          videoId: 'FAKE_VIDEO',
        },
        mockHostConn,
      );
      vi.advanceTimersByTime(400);

      // Second host command 400ms in: should cancel the first and re-schedule to 8
      handler(
        {
          state: 1,
          time: 8,
          hostPlayAt: Date.now() + 1000,
          subIndex: 0,
          videoId: 'FAKE_VIDEO',
        },
        mockHostConn,
      );
      vi.advanceTimersByTime(1100); // let the second countdown complete

      // playVideo should fire exactly once — the second scheduling
      const playCalls = player.__log.filter((c) => c.op === 'playVideo');
      expect(playCalls.length).toBe(1);

      // Last seekTo must be to 8, not 5
      const seeks = player.__log.filter((c) => c.op === 'seekTo');
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
      setState('network.hostConn', mockHostConn as never);

      handler({ time: 14.5, state: 1, subIndex: 0, videoId: 'FAKE_VIDEO' }, mockHostConn);

      const seeks = player.__log.filter((c) => c.op === 'seekTo');
      expect(seeks).toHaveLength(1);
      expect(seeks[0].args).toEqual([14.5, true]);
    });

    it('local YouTube pause suppresses heartbeat seek and resume', async () => {
      const player = installPlayer({
        __state: 2,
        __currentTime: 10,
        __duration: 300,
      });
      const handler = capturedHandlers[MSG.YOUTUBE_SYNC];
      expect(handler).toBeDefined();
      setState('network.hostConn', mockHostConn as never);
      localYouTubePaused.value = true;

      handler({ time: 30, state: 1, subIndex: 0, videoId: 'FAKE_VIDEO' }, mockHostConn);

      expect(player.__log.filter((c) => c.op === 'seekTo')).toHaveLength(0);
      expect(player.__log.filter((c) => c.op === 'playVideo')).toHaveLength(0);
    });

    it('adds the YouTube manual offset to drift correction seeks', async () => {
      const player = installPlayer({
        __state: 1,
        __currentTime: 10,
        __duration: 300,
      });
      const handler = capturedHandlers[MSG.YOUTUBE_SYNC];
      expect(handler).toBeDefined();
      setState('network.hostConn', mockHostConn as never);
      setState('sync.youtubeLocalOffset', 1.25);

      handler({ time: 14.5, state: 1, subIndex: 0, videoId: 'FAKE_VIDEO' }, mockHostConn);

      const seeks = player.__log.filter((c) => c.op === 'seekTo');
      expect(seeks).toHaveLength(1);
      expect(seeks[0].args).toEqual([15.75, true]);
    });

    it('drift ≤ 3s does NOT trigger seekTo', async () => {
      const player = installPlayer({
        __state: 1,
        __currentTime: 10,
        __duration: 300,
      });
      const handler = capturedHandlers[MSG.YOUTUBE_SYNC];
      setState('network.hostConn', mockHostConn as never);

      handler({ time: 12.5, state: 1, subIndex: 0, videoId: 'FAKE_VIDEO' }, mockHostConn);

      const seeks = player.__log.filter((c) => c.op === 'seekTo');
      expect(seeks).toHaveLength(0);
    });
  });

  describe('handleYouTubeSync - manual rendezvous readiness retry', () => {
    it('defers a manual sync that arrives before the YouTube iframe is ready', async () => {
      const handler = capturedHandlers[MSG.YOUTUBE_SYNC];
      expect(handler).toBeDefined();
      setState('network.hostConn', mockHostConn as never);
      setPlaybackIdle();
      getYouTubePlayerMock.mockReturnValue(null);

      handler(
        {
          time: 42,
          state: 1,
          subIndex: 0,
          videoId: 'FAKE_VIDEO',
          hostClock: Date.now(),
          isManual: true,
        },
        mockHostConn,
      );

      expect(getManagedTimer('yt-manual-rendezvous-retry')).not.toBeNull();

      const player = installPlayer({ __state: 2, __currentTime: 0, __duration: 300 });
      setPlaybackYouTubePlaying();
      bus.emit('youtube:player-ready');

      expect(getManagedTimer('yt-manual-rendezvous-retry')).toBeNull();
      expect(player.__log.find((c) => c.op === 'pauseVideo')).toBeDefined();
      expect(player.__log.find((c) => c.op === 'seekTo')).toBeDefined();
    });

    it('clears a pending manual rendezvous retry on sync reset', async () => {
      const handler = capturedHandlers[MSG.YOUTUBE_SYNC];
      const { resetYouTubeSyncState } = await importSync();
      setState('network.hostConn', mockHostConn as never);
      setPlaybackIdle();
      getYouTubePlayerMock.mockReturnValue(null);

      handler(
        {
          time: 12,
          state: 1,
          hostClock: Date.now(),
          isManual: true,
        },
        mockHostConn,
      );

      expect(getManagedTimer('yt-manual-rendezvous-retry')).not.toBeNull();

      resetYouTubeSyncState();

      expect(getManagedTimer('yt-manual-rendezvous-retry')).toBeNull();
    });
  });

  describe('guestRendezvousSync completion callback', () => {
    it('does not start without an open host connection', async () => {
      const player = installPlayer({ __state: 2, __currentTime: 10, __duration: 300 });
      const { guestRendezvousSync } = await importSync();
      setState('network.hostConn', { peer: 'mock-host-peer', open: false } as never);

      const result = guestRendezvousSync({ silent: true });

      expect(result.status).toBe('not-ready');
      expect(player.__log).toEqual([]);
    });

    it('fires onComplete after a successful paused-host alignment', async () => {
      const player = installPlayer({ __state: 2, __currentTime: 10, __duration: 300 });
      const handler = capturedHandlers[MSG.YOUTUBE_SYNC];
      const { guestRendezvousSync } = await importSync();
      setState('network.hostConn', mockHostConn as never);

      handler(
        {
          time: 42,
          state: 2,
          subIndex: 0,
          videoId: 'FAKE_VIDEO',
          hostClock: Date.now(),
        },
        mockHostConn,
      );
      player.__log.length = 0;

      const onComplete = vi.fn();
      guestRendezvousSync({ silent: true, onComplete });

      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(player.__log.find((c) => c.op === 'seekTo')?.args).toEqual([42, true]);
      expect(player.__log.find((c) => c.op === 'pauseVideo')).toBeDefined();
    });

    it('applies the current YouTube manual offset to paused-host alignment', async () => {
      const player = installPlayer({ __state: 2, __currentTime: 10, __duration: 300 });
      const handler = capturedHandlers[MSG.YOUTUBE_SYNC];
      const { guestRendezvousSync } = await importSync();
      setState('network.hostConn', mockHostConn as never);
      setState('sync.youtubeLocalOffset', 0.4);

      handler(
        {
          time: 42,
          state: 2,
          subIndex: 0,
          videoId: 'FAKE_VIDEO',
          hostClock: Date.now(),
        },
        mockHostConn,
      );
      player.__log.length = 0;

      const result = guestRendezvousSync({ silent: true });

      expect(result.status).toBe('completed');
      expect(player.__log.find((c) => c.op === 'seekTo')?.args).toEqual([42.4, true]);
    });

    it('retries manual-offset application when rendezvous is busy', async () => {
      const player = installPlayer({ __state: 1, __currentTime: 10, __duration: 300 });
      const handler = capturedHandlers[MSG.YOUTUBE_SYNC];
      const { guestRendezvousSync } = await importSync();
      setState('network.hostConn', mockHostConn as never);

      handler(
        {
          time: 10,
          state: 1,
          subIndex: 0,
          videoId: 'FAKE_VIDEO',
          hostClock: Date.now(),
        },
        mockHostConn,
      );
      player.__log.length = 0;

      const first = guestRendezvousSync({ silent: true });
      expect(first.status).toBe('started');
      setState('sync.youtubeLocalOffset', 0.75);

      bus.emit('youtube:apply-manual-sync');
      expect(getManagedTimer('yt-manual-offset-apply-retry')).not.toBeNull();

      vi.advanceTimersByTime(3050);

      expect(getManagedTimer('yt-manual-offset-apply-retry')).toBeNull();
      const seeks = player.__log.filter((c) => c.op === 'seekTo');
      expect(seeks.length).toBeGreaterThanOrEqual(2);
      expect(seeks[seeks.length - 1].args?.[0]).toBeCloseTo(15.25, 2);
      expect(seeks[seeks.length - 1].args?.[1]).toBe(true);
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
      // Simulate guest — handleYouTubeState guard requires hostConn match.
      setState('network.hostConn', mockHostConn as never);

      // Arm the cooldown by triggering a clock-scheduled state change
      stateHandler(
        {
          state: 1,
          time: 10,
          hostPlayAt: Date.now() + 1000,
          subIndex: 0,
          videoId: 'FAKE_VIDEO',
        },
        mockHostConn,
      );
      // The cooldown is now active until Date.now() + waitMs + 1500

      // Clear the pause/seek from stateHandler to focus on sync behavior
      player.__log.length = 0;

      // Fire a sync with massive drift — should be ignored
      syncHandler({ time: 200, state: 1, subIndex: 0, videoId: 'FAKE_VIDEO' }, mockHostConn);

      const seeks = player.__log.filter((c) => c.op === 'seekTo');
      expect(seeks).toHaveLength(0);
    });
  });

  // 8. Ad detection: 3 stale frames pause, recovery resumes
  describe('handleYouTubeSync — host ad detection', () => {
    it('pauses guest after 3 consecutive stale host-time frames', async () => {
      const player = installPlayer({ __state: 1, __currentTime: 42, __duration: 300 });
      const handler = capturedHandlers[MSG.YOUTUBE_SYNC];
      setState('network.hostConn', mockHostConn as never);

      // First frame establishes baseline
      handler({ time: 42.0, state: 1, subIndex: 0, videoId: 'FAKE_VIDEO' }, mockHostConn);
      player.__log.length = 0; // ignore any initial ops

      // Frames 2-4 are stale — on frame 4 (counter reaches 3), guest pauses
      handler({ time: 42.01, state: 1, subIndex: 0, videoId: 'FAKE_VIDEO' }, mockHostConn);
      expect(player.__log.find((c) => c.op === 'pauseVideo')).toBeUndefined();

      handler({ time: 42.02, state: 1, subIndex: 0, videoId: 'FAKE_VIDEO' }, mockHostConn);
      expect(player.__log.find((c) => c.op === 'pauseVideo')).toBeUndefined();

      handler({ time: 42.03, state: 1, subIndex: 0, videoId: 'FAKE_VIDEO' }, mockHostConn);
      expect(player.__log.find((c) => c.op === 'pauseVideo')).toBeDefined();
    });

    it('resumes guest when host time starts moving again', async () => {
      const player = installPlayer({ __state: 1, __currentTime: 42, __duration: 300 });
      const handler = capturedHandlers[MSG.YOUTUBE_SYNC];
      setState('network.hostConn', mockHostConn as never);

      // Enter ad-paused state
      handler({ time: 42.0, state: 1, subIndex: 0, videoId: 'FAKE_VIDEO' }, mockHostConn);
      handler({ time: 42.01, state: 1, subIndex: 0, videoId: 'FAKE_VIDEO' }, mockHostConn);
      handler({ time: 42.02, state: 1, subIndex: 0, videoId: 'FAKE_VIDEO' }, mockHostConn);
      handler({ time: 42.03, state: 1, subIndex: 0, videoId: 'FAKE_VIDEO' }, mockHostConn);
      player.__state = 2; // pauseVideo flipped us
      player.__log.length = 0;

      // Host time moves 5 seconds forward (large delta, ad ended)
      handler({ time: 47.5, state: 1, subIndex: 0, videoId: 'FAKE_VIDEO' }, mockHostConn);

      expect(player.__log.find((c) => c.op === 'playVideo')).toBeDefined();
    });
  });

  // 9. resetYouTubeSyncState clears all managed timers + re-enables drift correction
  describe('resetYouTubeSyncState', () => {
    it('clears rendezvous timers and re-enables drift correction', async () => {
      const player = installPlayer({ __state: 1, __currentTime: 10, __duration: 300 });
      const stateHandler = capturedHandlers[MSG.YOUTUBE_STATE];
      const syncHandler = capturedHandlers[MSG.YOUTUBE_SYNC];
      const { resetYouTubeSyncState } = await importSync();
      // Simulate guest — handleYouTubeState guard requires hostConn match.
      setState('network.hostConn', mockHostConn as never);

      // Arm the cooldown
      stateHandler(
        {
          state: 1,
          time: 10,
          hostPlayAt: Date.now() + 1000,
          subIndex: 0,
          videoId: 'FAKE_VIDEO',
        },
        mockHostConn,
      );

      // Reset
      resetYouTubeSyncState();

      // yt-clock-action shouldn't be cleared by resetYouTubeSyncState per its
      // docstring (only yt-rendezvous-* are cleared + _autoSyncUntil + snapshot).
      // But drift correction should work again. Clear log first.
      player.__log.length = 0;

      // Sync with drift > 3s should now seek
      syncHandler({ time: 200, state: 1, subIndex: 0, videoId: 'FAKE_VIDEO' }, mockHostConn);

      const seeks = player.__log.filter((c) => c.op === 'seekTo');
      expect(seeks).toHaveLength(1);
    });
  });

  // 10. NaN state in handleYouTubeState drops the message.
  describe('handleYouTubeState — NaN state guard', () => {
    it('drops message when state is not a finite number', async () => {
      const player = installPlayer({ __state: 1, __currentTime: 10, __duration: 300 });
      const handler = capturedHandlers[MSG.YOUTUBE_STATE];
      // Simulate guest — handleYouTubeState guard requires hostConn match.
      setState('network.hostConn', mockHostConn as never);

      handler(
        {
          state: 'garbage',
          time: 5,
          hostPlayAt: Date.now() + 1000,
          subIndex: 0,
          videoId: 'FAKE_VIDEO',
        },
        mockHostConn,
      );
      vi.advanceTimersByTime(1500);

      // No player mutations should have happened
      expect(player.__log).toHaveLength(0);
    });

    it('drops message when state is undefined', async () => {
      const player = installPlayer({ __state: 1, __currentTime: 10, __duration: 300 });
      const handler = capturedHandlers[MSG.YOUTUBE_STATE];
      // Simulate guest — handleYouTubeState guard requires hostConn match.
      setState('network.hostConn', mockHostConn as never);

      handler(
        { time: 5, hostPlayAt: Date.now() + 1000, subIndex: 0, videoId: 'FAKE_VIDEO' },
        mockHostConn,
      );
      vi.advanceTimersByTime(1500);

      expect(player.__log).toHaveLength(0);
    });
  });

  // 11. cancelYtAutoSync clears the pending Stage 2 timer.
  describe('cancelYtAutoSync', () => {
    it('clears the pending Stage 2 yt-auto-sync timer', async () => {
      installPlayer({ __state: 2 });
      const { scheduleYtAutoSync, cancelYtAutoSync } = await importPlayer();

      scheduleYtAutoSync(10, { videoId: 'NEW_VID' });
      expect(getManagedTimer('yt-auto-sync')).not.toBeNull();

      cancelYtAutoSync();
      expect(getManagedTimer('yt-auto-sync')).toBeNull();
    });
  });

  // 12. Late-join snapshot capture BEFORE the readiness guard. Both handlers
  // deliberately call updateHostSnapshot ahead of the player/mode guard so a
  // bootstrap frame that lands while the guest is still inside
  // loadYouTubeVideo (player null, mode not yet YouTube) is not lost — without
  // it the user's first manual rendezvous hits "No host playback data" until
  // the next heartbeat seconds later. Both handleYouTubeSync and
  // handleYouTubeState must apply the same snapshot rule.
  describe('late-join host snapshot — recorded before player/mode readiness', () => {
    it('a YOUTUBE_SYNC heartbeat arriving before the player exists still feeds the next rendezvous', async () => {
      const syncHandler = capturedHandlers[MSG.YOUTUBE_SYNC];
      const { guestRendezvousSync } = await importSync();
      setState('network.hostConn', mockHostConn as never);
      setPlaybackIdle();
      getYouTubePlayerMock.mockReturnValue(null);

      // Paused-host heartbeat lands mid-bootstrap: side-effect paths must be
      // skipped (no player), but the position snapshot must persist.
      syncHandler(
        { time: 42, state: 2, subIndex: 0, videoId: 'FAKE_VIDEO', hostClock: Date.now() },
        mockHostConn,
      );

      // Player + mode become ready; the user hits Sync. The paused-host
      // alignment must run off the pre-readiness snapshot, not bail no-data.
      const player = installPlayer({ __state: 2, __currentTime: 10, __duration: 300 });
      setPlaybackYouTubePlaying();
      const result = guestRendezvousSync({ silent: true });

      expect(result.status).toBe('completed');
      expect(player.__log.find((c) => c.op === 'seekTo')?.args).toEqual([42, true]);
      expect(player.__log.find((c) => c.op === 'pauseVideo')).toBeDefined();
    });

    it('a YOUTUBE_STATE bootstrap frame arriving before the player exists still feeds the next rendezvous', async () => {
      const stateHandler = capturedHandlers[MSG.YOUTUBE_STATE];
      const { guestRendezvousSync } = await importSync();
      setState('network.hostConn', mockHostConn as never);
      setPlaybackIdle();
      getYouTubePlayerMock.mockReturnValue(null);

      stateHandler(
        { state: 2, time: 33, subIndex: 0, videoId: 'FAKE_VIDEO', hostClock: Date.now() },
        mockHostConn,
      );

      const player = installPlayer({ __state: 2, __currentTime: 10, __duration: 300 });
      setPlaybackYouTubePlaying();
      const result = guestRendezvousSync({ silent: true });

      expect(result.status).toBe('completed');
      expect(player.__log.find((c) => c.op === 'seekTo')?.args).toEqual([33, true]);
    });
  });

  // 13. Out-of-order host commands: "last action wins" + "PAUSE/STOP always
  // takes priority" (handleYouTubeState). A scheduled play from an earlier
  // command must never fire after a newer command replaced it.
  describe('handleYouTubeState — out-of-order host commands', () => {
    it('a PAUSE arriving during a scheduled-play countdown cancels the pending play entirely', async () => {
      const player = installPlayer({ __state: 2, __currentTime: 0, __duration: 300 });
      const handler = capturedHandlers[MSG.YOUTUBE_STATE];
      setState('network.hostConn', mockHostConn as never);

      // Host PLAY with a 1s countdown — guest pauses, seeks to 5, arms the timer.
      handler(
        { state: 1, time: 5, hostPlayAt: Date.now() + 1000, subIndex: 0, videoId: 'FAKE_VIDEO' },
        mockHostConn,
      );
      vi.advanceTimersByTime(400);

      // Host PAUSE before the countdown completes — supersedes the play.
      handler(
        { state: 2, time: 6, hostPlayAt: 0, subIndex: 0, videoId: 'FAKE_VIDEO' },
        mockHostConn,
      );
      vi.advanceTimersByTime(2000); // well past the original countdown deadline

      // The orphaned yt-clock-action must NOT have fired playVideo.
      expect(player.__log.filter((c) => c.op === 'playVideo')).toHaveLength(0);
      // The pause command's own seek (to 6) is the final position.
      const seeks = player.__log.filter((c) => c.op === 'seekTo');
      expect(seeks[seeks.length - 1].args).toEqual([6, true]);
    });

    it('a videoId mismatch loads the host video and defers play to the hostPlayAt instant', async () => {
      const player = installPlayer({ __state: 2, __currentTime: 0, __duration: 300 });
      const handler = capturedHandlers[MSG.YOUTUBE_STATE];
      setState('network.hostConn', mockHostConn as never);

      handler(
        {
          state: 1,
          time: 0,
          hostPlayAt: Date.now() + 1000,
          subIndex: 2,
          videoId: 'NEW_VIDEO',
        },
        mockHostConn,
      );

      // Load fires immediately so the iframe can buffer during the countdown;
      // the tracked sub-index follows the host's payload.
      expect(player.__log.filter((c) => c.op === 'loadVideoById')).toHaveLength(1);
      expect(player.__log.find((c) => c.op === 'loadVideoById')?.args).toEqual(['NEW_VIDEO']);
      expect(getState('youtube.currentSubIndex')).toBe(2);

      // Play waits for the host-clock instant, not the load completion.
      vi.advanceTimersByTime(999);
      expect(player.__log.filter((c) => c.op === 'playVideo')).toHaveLength(0);
      vi.advanceTimersByTime(1);
      expect(player.__log.filter((c) => c.op === 'playVideo')).toHaveLength(1);
    });
  });

  // 14. handleYouTubeState scheduling boundary values. The three branches
  // (auto-sync wait / short wait / immediate) are selected by waitMs against
  // SHORT_WAIT_THRESHOLD_MS (300, inclusive on the short side) and
  // AUTO_SYNC_MAX_WAIT_MS (3000, exclusive on the auto-sync side).
  describe('handleYouTubeState — scheduling boundary values', () => {
    it('waitMs exactly at the short-wait threshold (300ms) seeks to the wait-compensated position', async () => {
      const player = installPlayer({ __state: 1, __currentTime: 10, __duration: 300 });
      const handler = capturedHandlers[MSG.YOUTUBE_STATE];
      setState('network.hostConn', mockHostConn as never);

      // waitMs = 300 → `> SHORT_WAIT_THRESHOLD_MS` is false → short-wait path.
      handler(
        { state: 1, time: 10, hostPlayAt: Date.now() + 300, subIndex: 0, videoId: 'FAKE_VIDEO' },
        mockHostConn,
      );

      // Short-wait defers ALL player ops to the scheduled instant.
      expect(player.__log).toHaveLength(0);

      // At +300ms: pause-seek with the target compensated by the wait
      // (time + waitMs/1000) so the guest lands where the host IS, not was.
      vi.advanceTimersByTime(300);
      expect(player.__log.find((c) => c.op === 'pauseVideo')).toBeDefined();
      const seek = player.__log.find((c) => c.op === 'seekTo');
      expect(seek?.args?.[0]).toBeCloseTo(10.3, 5);
      expect(player.__log.filter((c) => c.op === 'playVideo')).toHaveLength(0);

      // playVideo fires SEEK_PLAY_GAP_MS (150ms) after the seek commits.
      vi.advanceTimersByTime(150);
      expect(player.__log.filter((c) => c.op === 'playVideo')).toHaveLength(1);
    });

    it('waitMs at the auto-sync cap (3000ms) falls through to immediate execution', async () => {
      const player = installPlayer({ __state: 2, __currentTime: 0, __duration: 300 });
      const handler = capturedHandlers[MSG.YOUTUBE_STATE];
      setState('network.hostConn', mockHostConn as never);

      // waitMs = 3000 → `< AUTO_SYNC_MAX_WAIT_MS` is false → the rendezvous
      // window has effectively expired; executeImmediate runs now instead of
      // holding the guest paused for 3 more seconds.
      handler(
        { state: 1, time: 10, hostPlayAt: Date.now() + 3000, subIndex: 0, videoId: 'FAKE_VIDEO' },
        mockHostConn,
      );

      expect(player.__log.find((c) => c.op === 'seekTo')?.args).toEqual([10, true]);
      vi.advanceTimersByTime(150); // SEEK_PLAY_GAP_MS, not the 3s hostPlayAt wait
      expect(player.__log.filter((c) => c.op === 'playVideo')).toHaveLength(1);
    });

    it('an uncalibrated shared clock ignores hostPlayAt and executes immediately (late-join, no pongs yet)', async () => {
      const player = installPlayer({ __state: 2, __currentTime: 0, __duration: 300 });
      const handler = capturedHandlers[MSG.YOUTUBE_STATE];
      setState('network.hostConn', mockHostConn as never);

      // Freshly joined guest: getHostNow() is raw Date.now() (offset 0), so a
      // hostPlayAt countdown would be meaningless — play now, let the periodic
      // pong calibrate and drift correction clean up.
      vi.mocked(isClockCalibrated).mockReturnValueOnce(false);
      handler(
        { state: 1, time: 10, hostPlayAt: Date.now() + 1000, subIndex: 0, videoId: 'FAKE_VIDEO' },
        mockHostConn,
      );

      expect(player.__log.find((c) => c.op === 'seekTo')?.args).toEqual([10, true]);
      vi.advanceTimersByTime(150); // SEEK_PLAY_GAP_MS only — no 1s countdown
      expect(player.__log.filter((c) => c.op === 'playVideo')).toHaveLength(1);
    });
  });

  // 15. handleYouTubeSync videoId/subIndex reconciliation. Single-video mode:
  // the guest is always driven via loadVideoById (never the native playlist
  // engine), and the LOAD_DRIFT_SUPPRESS_MS window keeps the next heartbeats
  // from interrupting the load they themselves triggered.
  describe('handleYouTubeSync — videoId/subIndex reconciliation', () => {
    it('reloads on host videoId mismatch, holds drift during the load window, then resumes correction', async () => {
      const player = installPlayer({ __state: 1, __currentTime: 10, __duration: 300 });
      const handler = capturedHandlers[MSG.YOUTUBE_SYNC];
      setState('network.hostConn', mockHostConn as never);

      // Phase 1 — heartbeat carries a different videoId: single-video-mode
      // reload, and NO drift seek for this frame (the reload supersedes it).
      handler({ time: 50, state: 1, subIndex: 0, videoId: 'OTHER_VIDEO' }, mockHostConn);
      expect(player.__log.filter((c) => c.op === 'loadVideoById')).toHaveLength(1);
      expect(player.__log.find((c) => c.op === 'loadVideoById')?.args).toEqual(['OTHER_VIDEO']);
      expect(player.__log.filter((c) => c.op === 'seekTo')).toHaveLength(0);

      // Phase 2 — next heartbeat inside LOAD_DRIFT_SUPPRESS_MS (5s): fully
      // ignored, even with a fresh mismatch — re-calling loadVideoById would
      // reset buffering and extend the transition window.
      vi.advanceTimersByTime(1000);
      handler({ time: 51, state: 1, subIndex: 0, videoId: 'YET_ANOTHER' }, mockHostConn);
      expect(player.__log.filter((c) => c.op === 'loadVideoById')).toHaveLength(1);
      expect(player.__log.filter((c) => c.op === 'seekTo')).toHaveLength(0);

      // Phase 3 — window elapsed: normal drift correction is live again
      // (guest at 0 after the load, host at 60 → corrective seek).
      vi.advanceTimersByTime(4001);
      handler({ time: 60, state: 1, subIndex: 0, videoId: 'OTHER_VIDEO' }, mockHostConn);
      const seeks = player.__log.filter((c) => c.op === 'seekTo');
      expect(seeks).toHaveLength(1);
      expect(seeks[0].args).toEqual([60, true]);
    });

    it('aligns a drifted sub-index by state write alone when the videoId already matches', async () => {
      const player = installPlayer({ __state: 1, __currentTime: 10, __duration: 300 });
      const handler = capturedHandlers[MSG.YOUTUBE_SYNC];
      setState('network.hostConn', mockHostConn as never);
      setState('youtube.currentSubIndex', 0);

      handler({ time: 10.2, state: 1, subIndex: 4, videoId: 'FAKE_VIDEO' }, mockHostConn);

      // State repaired; the iframe is already on the right video, so no
      // loadVideoById round-trip (and drift is tiny, so no seek either).
      expect(getState('youtube.currentSubIndex')).toBe(4);
      expect(player.__log.filter((c) => c.op === 'loadVideoById')).toHaveLength(0);
      expect(player.__log.filter((c) => c.op === 'seekTo')).toHaveLength(0);
    });

    it('skips the corrective seek while duration is unreported but still applies play-state sync', async () => {
      const player = installPlayer({ __state: 2, __currentTime: 10, __duration: 0 });
      const handler = capturedHandlers[MSG.YOUTUBE_SYNC];
      setState('network.hostConn', mockHostConn as never);

      // duration=0 → the video hasn't buffered enough to trust positions, so
      // no seek even with 190s of apparent drift; but the host PLAYING vs
      // guest PAUSED mismatch is corrected unconditionally.
      handler({ time: 200, state: 1, subIndex: 0, videoId: 'FAKE_VIDEO' }, mockHostConn);

      expect(player.__log.filter((c) => c.op === 'seekTo')).toHaveLength(0);
      expect(player.__log.filter((c) => c.op === 'playVideo')).toHaveLength(1);
    });
  });

  // 16. Host-side sub-video navigation (single-video mode). A navigation
  // broadcast missing the new subIndex/videoId
  // leaves guests on the old video. Both broadcast stages must carry the
  // post-navigation pair, and out-of-range navigation must hand control back
  // to the queue-level playlist logic via callback(false).
  describe('sub-video navigation — subIndex/videoId broadcast parity', () => {
    function seedPlaylistTrack(ids: string[]): void {
      setState('playlist.currentTrackIndex', 0);
      setState('playlist.items', [
        { type: 'youtube', videoId: ids[0], playlistId: 'PL_NAV', name: 'Playlist' },
      ] as never);
      setState('youtube.subItemsMap', { PL_NAV: { ids, titles: [] } });
    }

    it('next sub-video loads by id and both sync stages broadcast the new subIndex + videoId', async () => {
      // __playlistIdx -1 mirrors single-video mode: after loadVideoById the
      // iframe loses playlist context, so OUR managed index is authoritative.
      const player = installPlayer({
        __state: 1,
        __currentTime: 5,
        __duration: 200,
        __videoId: 'vidA',
        __playlistIdx: -1,
      });
      const { initYouTube } = await importPlayer();
      const { broadcast } = await import('../../network/peer.ts');
      const broadcastMock = vi.mocked(broadcast);
      initYouTube();
      seedPlaylistTrack(['vidA', 'vidB', 'vidC']);
      setState('youtube.currentSubIndex', 0);

      const callback = vi.fn();
      bus.emit('youtube:try-next-internal', callback);

      expect(callback).toHaveBeenCalledWith(true);
      expect(player.__log.find((c) => c.op === 'loadVideoById')?.args).toEqual(['vidB']);
      expect(getState('youtube.currentSubIndex')).toBe(1);

      // Stage 1 (YOUTUBE_STATE): guests must learn the new pair immediately.
      const stage1 = broadcastMock.mock.calls.find((c) => c[0]?.type === MSG.YOUTUBE_STATE)?.[0];
      expect(stage1).toMatchObject({ state: 1, time: 0, subIndex: 1, videoId: 'vidB' });

      // Stage 2 (YOUTUBE_SYNC manual): the precision rendezvous fires after the
      // track-transition delay (4s), longer than the 2s STAGE2 default
      // because a sub-video Next loads a DIFFERENT video — and must carry the
      // SAME pair, read back from the live player + managed index.
      const { TRACK_TRANSITION_RENDEZVOUS_MS } = await import('../constants.ts');
      vi.advanceTimersByTime(TRACK_TRANSITION_RENDEZVOUS_MS);
      const stage2 = broadcastMock.mock.calls.find((c) => c[0]?.type === MSG.YOUTUBE_SYNC)?.[0];
      expect(stage2).toMatchObject({ isManual: true, subIndex: 1, videoId: 'vidB' });
    });

    it('prev past the 3s threshold restarts the current video through the synced auto-sync path', async () => {
      const player = installPlayer({ __state: 1, __currentTime: 10, __duration: 200 });
      const { initYouTube } = await importPlayer();
      const { broadcast } = await import('../../network/peer.ts');
      const broadcastMock = vi.mocked(broadcast);
      initYouTube();

      const callback = vi.fn();
      bus.emit('youtube:try-prev-internal', callback);

      // Standard music-player UX: >3s in, "prev" = restart — and the restart
      // is broadcast (time 0) instead of a local-only seek.
      expect(callback).toHaveBeenCalledWith(true);
      expect(player.__log.find((c) => c.op === 'seekTo')?.args).toEqual([0, true]);
      expect(player.__log.find((c) => c.op === 'playVideo')).toBeDefined();
      const stage1 = broadcastMock.mock.calls.find((c) => c[0]?.type === MSG.YOUTUBE_STATE)?.[0];
      expect(stage1).toMatchObject({ state: 1, time: 0 });
    });

    it('prev on the first sub-video within 3s reports failure so queue-level navigation takes over', async () => {
      const player = installPlayer({ __state: 1, __currentTime: 1, __duration: 200 });
      const { initYouTube } = await importPlayer();
      const { broadcast } = await import('../../network/peer.ts');
      initYouTube();
      seedPlaylistTrack(['vidA', 'vidB']);
      setState('youtube.currentSubIndex', 0);

      const callback = vi.fn();
      bus.emit('youtube:try-prev-internal', callback);

      // No sub-video to go back to: decline (callback(false)) WITHOUT touching
      // the player, so playlist.ts runs its own prev/shuffle queue logic.
      expect(callback).toHaveBeenCalledWith(false);
      expect(player.__log.filter((c) => c.op === 'loadVideoById')).toHaveLength(0);
      expect(broadcast).not.toHaveBeenCalled();
    });
  });
});
