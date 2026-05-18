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
import { setPlaybackIdle, setPlaybackYouTubePlaying } from '../../player/ownership.ts';
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
      const broadcastMock = vi.mocked(broadcast);

      // videoId override marks this as a transition → Path B
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

  describe('zero-start barrier', () => {
    it('starts from 0 as soon as all connected guests report ready', async () => {
      const peerConn = { peer: 'guest-1', open: true, send: vi.fn() };
      setState('network.connectedPeers', [
        {
          id: 'guest-1',
          conn: peerConn,
          status: 'connected',
          label: 'Guest',
          isDataTarget: true,
        },
      ] as never);
      const player = installPlayer({ __state: 2, __currentTime: 0, __videoId: 'ZERO_VIDEO' });
      const { initYouTube } = await importPlayer();
      const { broadcast } = await import('../../network/peer.ts');
      const broadcastMock = vi.mocked(broadcast);

      initYouTube();
      bus.emit('youtube:auto-play');

      const prepare = broadcastMock.mock.calls.find(
        (c) => c[0]?.type === MSG.YOUTUBE_ZERO_START_PREPARE,
      )?.[0];
      expect(prepare).toMatchObject({
        type: MSG.YOUTUBE_ZERO_START_PREPARE,
        videoId: 'ZERO_VIDEO',
        timeoutMs: 3000,
      });
      expect(player.__log.some((c) => c.op === 'pauseVideo')).toBe(true);
      expect(player.__log.some((c) => c.op === 'seekTo' && c.args?.[0] === 0)).toBe(true);
      const preparePauseCount = player.__log.filter((c) => c.op === 'pauseVideo').length;
      const prepareSeekCount = player.__log.filter((c) => c.op === 'seekTo').length;

      const readyHandler = capturedHandlers[MSG.YOUTUBE_ZERO_START_READY];
      expect(readyHandler).toBeDefined();
      readyHandler(
        {
          type: MSG.YOUTUBE_ZERO_START_READY,
          token: prepare?.token,
          videoId: 'ZERO_VIDEO',
          subIndex: 0,
        },
        peerConn,
      );

      expect(player.__log.filter((c) => c.op === 'pauseVideo')).toHaveLength(preparePauseCount);
      expect(player.__log.filter((c) => c.op === 'seekTo')).toHaveLength(prepareSeekCount);

      const state = broadcastMock.mock.calls.find((c) => c[0]?.type === MSG.YOUTUBE_STATE)?.[0];
      expect(state).toMatchObject({
        type: MSG.YOUTUBE_STATE,
        state: 1,
        time: 0,
        videoId: 'ZERO_VIDEO',
        zeroStart: true,
        zeroStartToken: prepare?.token,
      });

      vi.advanceTimersByTime(999);
      expect(player.__log.some((c) => c.op === 'playVideo')).toBe(false);

      vi.advanceTimersByTime(1);
      expect(player.__log.some((c) => c.op === 'playVideo')).toBe(true);
    });

    it('guest prepare pauses/seeks to 0 and sends ready to host', async () => {
      const player = installPlayer({ __state: 1, __currentTime: 0.4, __videoId: 'ZERO_VIDEO' });
      const { initYouTube } = await importPlayer();
      const { safeSend } = await import('../../network/peer.ts');
      const safeSendMock = vi.mocked(safeSend);
      setState('network.hostConn', mockHostConn as never);

      initYouTube();
      const prepareHandler = capturedHandlers[MSG.YOUTUBE_ZERO_START_PREPARE];
      expect(prepareHandler).toBeDefined();
      prepareHandler(
        {
          type: MSG.YOUTUBE_ZERO_START_PREPARE,
          token: 'zero-token',
          videoId: 'ZERO_VIDEO',
          subIndex: 0,
          timeoutMs: 3000,
        },
        mockHostConn,
      );

      expect(player.__log.some((c) => c.op === 'pauseVideo')).toBe(true);
      expect(player.__log.some((c) => c.op === 'seekTo' && c.args?.[0] === 0)).toBe(true);
      expect(safeSendMock).toHaveBeenCalledWith(
        mockHostConn,
        expect.objectContaining({
          type: MSG.YOUTUBE_ZERO_START_READY,
          token: 'zero-token',
          videoId: 'ZERO_VIDEO',
        }),
      );
    });

    it('guest final zero-start launch is play-only after prepare already seeked to 0', async () => {
      const player = installPlayer({ __state: 2, __currentTime: 0, __videoId: 'ZERO_VIDEO' });
      const { initYouTube } = await importPlayer();
      setState('network.hostConn', mockHostConn as never);
      setState('youtube.guestPlayLatency', 250);

      initYouTube();
      const prepareHandler = capturedHandlers[MSG.YOUTUBE_ZERO_START_PREPARE];
      const stateHandler = capturedHandlers[MSG.YOUTUBE_STATE];
      expect(prepareHandler).toBeDefined();
      expect(stateHandler).toBeDefined();

      prepareHandler(
        {
          type: MSG.YOUTUBE_ZERO_START_PREPARE,
          token: 'zero-token',
          videoId: 'ZERO_VIDEO',
          subIndex: 0,
          timeoutMs: 3000,
        },
        mockHostConn,
      );

      player.__log.length = 0;
      stateHandler(
        {
          state: 1,
          time: 0,
          hostPlayAt: Date.now() + 1000,
          subIndex: 0,
          videoId: 'ZERO_VIDEO',
          zeroStart: true,
          zeroStartToken: 'zero-token',
        },
        mockHostConn,
      );

      expect(player.__log.some((c) => c.op === 'pauseVideo')).toBe(false);
      expect(player.__log.some((c) => c.op === 'seekTo')).toBe(false);

      vi.advanceTimersByTime(999);
      expect(player.__log.some((c) => c.op === 'playVideo')).toBe(false);
      vi.advanceTimersByTime(1);
      expect(player.__log.some((c) => c.op === 'playVideo')).toBe(true);
    });

    it('guest ignores zero-start prepare from a closed host connection', async () => {
      const player = installPlayer({ __state: 1, __currentTime: 0.4, __videoId: 'ZERO_VIDEO' });
      const { initYouTube } = await importPlayer();
      const { safeSend } = await import('../../network/peer.ts');
      const safeSendMock = vi.mocked(safeSend);
      const closedHostConn = { peer: 'mock-host-peer', open: false };
      setState('network.hostConn', closedHostConn as never);

      initYouTube();
      const prepareHandler = capturedHandlers[MSG.YOUTUBE_ZERO_START_PREPARE];
      expect(prepareHandler).toBeDefined();
      prepareHandler(
        {
          type: MSG.YOUTUBE_ZERO_START_PREPARE,
          token: 'zero-token',
          videoId: 'ZERO_VIDEO',
          subIndex: 0,
          timeoutMs: 3000,
        },
        closedHostConn,
      );

      expect(player.__log.some((c) => c.op === 'pauseVideo')).toBe(false);
      expect(player.__log.some((c) => c.op === 'seekTo')).toBe(false);
      expect(safeSendMock).not.toHaveBeenCalled();
      expect(getManagedTimer('yt-zero-start-ready-poll')).toBeNull();
    });

    it('guest keeps polling zero-start readiness when the ready send fails', async () => {
      const player = installPlayer({ __state: 1, __currentTime: 0.4, __videoId: 'ZERO_VIDEO' });
      const { initYouTube } = await importPlayer();
      const { safeSend } = await import('../../network/peer.ts');
      const safeSendMock = vi.mocked(safeSend);
      safeSendMock.mockReturnValueOnce(false);
      setState('network.hostConn', mockHostConn as never);

      initYouTube();
      const prepareHandler = capturedHandlers[MSG.YOUTUBE_ZERO_START_PREPARE];
      expect(prepareHandler).toBeDefined();
      prepareHandler(
        {
          type: MSG.YOUTUBE_ZERO_START_PREPARE,
          token: 'zero-token',
          videoId: 'ZERO_VIDEO',
          subIndex: 0,
          timeoutMs: 3000,
        },
        mockHostConn,
      );

      expect(player.__log.some((c) => c.op === 'pauseVideo')).toBe(true);
      expect(player.__log.some((c) => c.op === 'seekTo' && c.args?.[0] === 0)).toBe(true);
      expect(safeSendMock).toHaveBeenCalledTimes(1);
      expect(getManagedTimer('yt-zero-start-ready-poll')).toBeDefined();

      vi.advanceTimersByTime(100);

      expect(safeSendMock).toHaveBeenCalledTimes(2);
      expect(safeSendMock).toHaveBeenLastCalledWith(
        mockHostConn,
        expect.objectContaining({
          type: MSG.YOUTUBE_ZERO_START_READY,
          token: 'zero-token',
          videoId: 'ZERO_VIDEO',
        }),
      );
    });

    it('zero-start scheduled play keeps manual nudge without learned latency pre-roll', async () => {
      const player = installPlayer({ __state: 2, __duration: 300, __videoId: 'FAKE_VIDEO' });
      const handler = capturedHandlers[MSG.YOUTUBE_STATE];
      expect(handler).toBeDefined();
      setState('network.hostConn', mockHostConn as never);
      setState('sync.youtubeLocalOffset', 0.25);
      setState('youtube.guestPlayLatency', 200);

      handler(
        {
          state: 1,
          time: 0,
          hostPlayAt: Date.now() + 500,
          subIndex: 0,
          videoId: 'FAKE_VIDEO',
          zeroStart: true,
        },
        mockHostConn,
      );

      expect(player.__log.some((c) => c.op === 'pauseVideo')).toBe(true);
      expect(player.__log.some((c) => c.op === 'seekTo' && c.args?.[0] === 0.25)).toBe(true);

      player.__log.length = 0;
      vi.advanceTimersByTime(499);
      expect(player.__log.some((c) => c.op === 'playVideo')).toBe(false);

      vi.advanceTimersByTime(1);
      expect(player.__log.some((c) => c.op === 'playVideo')).toBe(true);
    });
  });

  // 5. Host seeks during guest countdown: new handleYouTubeState supersedes prior (cd75008)
  describe('handleYouTubeState — host seeks during countdown (commit cd75008)', () => {
    it('second YOUTUBE_STATE during countdown replaces the first scheduled play', async () => {
      const player = installPlayer({ __state: 2, __duration: 300, __currentTime: 0 });
      const handler = capturedHandlers[MSG.YOUTUBE_STATE];
      expect(handler).toBeDefined();
      // Simulate guest receiving host broadcast — handleYouTubeState's
      // hostConn guard (sync.ts:751) requires conn === network.hostConn.
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

  // 10. NaN state in handleYouTubeState drops message (commit 93b8b78)
  describe('handleYouTubeState — NaN state guard (commit 93b8b78)', () => {
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
