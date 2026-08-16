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
import type { DataConnection } from '../../types/index.ts';
import { makeFakeYtPlayer, type FakeYtPlayer, mutationOps } from './__helpers__/fake-yt-player.ts';

const QUEUE_ITEM_ID = '22222222-2222-4222-8222-222222222222';
const SECOND_QUEUE_ITEM_ID = '33333333-3333-4333-8333-333333333333';
const ZERO_START_VIDEO_ID = 'M7lc1UVf-VE';
const ZERO_START_GUEST_ID = 'zero-start-guest';

function dataConnection(peer: string, send = vi.fn()): DataConnection {
  return {
    peer,
    open: true,
    send,
    close: vi.fn(),
    on: () => undefined,
  };
}

// ─── Mocks ───────────────────────────────────────────────────────────────

const localYouTubePaused = vi.hoisted(() => ({ value: false }));
const zeroStartFacade = vi.hoisted(() => ({ inFlight: false, active: false }));
const youtubeSessionFacade = vi.hoisted(() => ({ id: 1 }));

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
const capturedHandlers: Record<
  string,
  (data: Record<string, unknown>, conn?: DataConnection) => void
> = {};
vi.mock('../../network/protocol.ts', () => ({
  registerHandlers: vi.fn((handlers: Record<string, unknown>) => {
    for (const [type, h] of Object.entries(handlers)) {
      if (typeof h === 'function')
        capturedHandlers[type] = h as (
          data: Record<string, unknown>,
          conn?: DataConnection,
        ) => void;
    }
  }),
  verifyOperator: vi.fn(() => true),
}));

// Mock hostConn used by handleYouTubeState's guard. Tests that simulate a
// guest receiving a host broadcast call `setState('network.hostConn',
// mockHostConn)` and pass it as the stateHandler's second arg. Host-side
// scheduleYtAutoSync tests intentionally leave hostConn null so the
// broadcast path stays active.
const mockHostConn = dataConnection('mock-host-peer');

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
const getYouTubePlayerMock = vi.fn<() => FakeYtPlayer | null>(() => null);
vi.mock('../_state.ts', () => ({
  getYouTubePlayer: () => getYouTubePlayerMock(),
  isYtPlayerReady: () => getYouTubePlayerMock() !== null,
  setYouTubePlayer: vi.fn(),
  getCurrentSessionId: vi.fn(() => youtubeSessionFacade.id),
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
  hideYouTubeTapToPlayGate: vi.fn(),
}));

vi.mock('../zero-start.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../zero-start.ts')>()),
  isYouTubeZeroStartInFlight: vi.fn(() => zeroStartFacade.inFlight),
  isYouTubeZeroStartProtocolActive: vi.fn(() => zeroStartFacade.active),
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
  configureYouTubeHandlerRuntimeHooks: vi.fn(),
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
  zeroStartFacade.inFlight = false;
  zeroStartFacade.active = false;
  youtubeSessionFacade.id = 1;

  setState('playlist.items', [
    {
      queueItemId: QUEUE_ITEM_ID,
      type: 'youtube',
      name: 'Fake Video',
      videoId: 'FAKE_VIDEO_ID',
      playlistId: null,
    },
  ]);
  setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);

  setPlaybackYouTubePlaying();

  // Initialize sync module so registerHandlers captures handlers.
  const syncMod = await import('../sync.ts');
  syncMod.initYouTubeSync();
  for (const type of [MSG.YOUTUBE_SYNC, MSG.YOUTUBE_STATE]) {
    const rawHandler = capturedHandlers[type];
    if (rawHandler) {
      capturedHandlers[type] = (data, conn) =>
        rawHandler({ queueItemId: QUEUE_ITEM_ID, ...data }, conn);
    }
  }
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

function installLiveZeroStartGuest(peerId = ZERO_START_GUEST_ID): DataConnection {
  const conn = dataConnection(peerId);
  setState('network.activeHostConnByPeerId', new Map([[peerId, conn]]));
  return conn;
}

function advertiseZeroStartCapability(conn: ReturnType<typeof installLiveZeroStartGuest>): void {
  const handler = capturedHandlers[MSG.YOUTUBE_ZERO_START_CAPABILITY];
  expect(handler).toBeDefined();
  handler(
    {
      type: MSG.YOUTUBE_ZERO_START_CAPABILITY,
      version: 2,
      platform: 'other',
      ready: true,
    },
    conn,
  );
}

function emitZeroStartAutoPlay(targetTime = 0, isTrackTransition = true): void {
  bus.emit('youtube:auto-play', {
    zeroStart: true,
    isTrackTransition,
    state: 1,
    targetTime,
    videoId: ZERO_START_VIDEO_ID,
    subIndex: 0,
  });
}

async function requestGuestExternalFallbackWhilePlayerMissing(
  runId: string,
  sequence = 1,
): Promise<{
  prepareAtHost: number;
  prepareHandler: (data: Record<string, unknown>, conn?: DataConnection) => void;
  abortHandler: (data: Record<string, unknown>, conn?: DataConnection) => void;
}> {
  setState('network.appRole', 'guest');
  setState('network.hostConn', mockHostConn);
  const { initYouTube } = await importPlayer();
  initYouTube();

  const prepareHandler = capturedHandlers[MSG.YOUTUBE_ZERO_START_PREPARE];
  const commitHandler = capturedHandlers[MSG.YOUTUBE_ZERO_START_COMMIT];
  const abortHandler = capturedHandlers[MSG.YOUTUBE_ZERO_START_ABORT];
  expect(prepareHandler).toBeDefined();
  expect(commitHandler).toBeDefined();
  expect(abortHandler).toBeDefined();
  const prepareAtHost = Date.now();

  prepareHandler(
    {
      type: MSG.YOUTUBE_ZERO_START_PREPARE,
      version: 1,
      runId,
      sequence,
      queueItemId: QUEUE_ITEM_ID,
      videoId: ZERO_START_VIDEO_ID,
      subIndex: 0,
      prepareAtHost,
      decisionAtHost: prepareAtHost + 2_300,
      startDeadlineAtHost: prepareAtHost + 3_000,
      hostPlatform: 'other',
    },
    mockHostConn,
  );
  commitHandler(
    {
      type: MSG.YOUTUBE_ZERO_START_COMMIT,
      version: 1,
      runId,
      sequence,
      queueItemId: QUEUE_ITEM_ID,
      videoId: ZERO_START_VIDEO_ID,
      startAtHost: prepareAtHost + 3_000,
      reason: 'guest-timeout',
      cohort: ['host-only'],
    },
    mockHostConn,
  );

  return { prepareAtHost, prepareHandler, abortHandler };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('YouTube Sync — Regression Integration', () => {
  describe('zero-start player integration boundary', () => {
    it('uses PREPARE and suppresses the immediate legacy state when every live guest advertises support', async () => {
      installPlayer({
        __state: 2,
        __currentTime: 0,
        __videoId: ZERO_START_VIDEO_ID,
      });
      const conn = installLiveZeroStartGuest();
      const { initYouTube } = await importPlayer();
      const { broadcast, safeSend } = await import('../../network/peer.ts');
      const { getYouTubeZeroStartSnapshot } = await import('../zero-start.ts');

      initYouTube();
      advertiseZeroStartCapability(conn);
      vi.mocked(broadcast).mockClear();
      vi.mocked(safeSend).mockClear();

      emitZeroStartAutoPlay();

      expect(safeSend).toHaveBeenCalledWith(
        conn,
        expect.objectContaining({
          type: MSG.YOUTUBE_ZERO_START_PREPARE,
          queueItemId: QUEUE_ITEM_ID,
          videoId: ZERO_START_VIDEO_ID,
        }),
      );
      expect(
        vi.mocked(broadcast).mock.calls.filter(([message]) => message.type === MSG.YOUTUBE_STATE),
      ).toHaveLength(0);
      expect(getYouTubeZeroStartSnapshot()).toMatchObject({
        phase: 'muting',
        expectedGuestIds: [ZERO_START_GUEST_ID],
      });
    });

    it.each([
      ['a live guest without capability', true],
      ['a solo host', false],
    ])('keeps the legacy transition for %s', async (_caseName, hasLiveGuest) => {
      installPlayer({
        __state: 2,
        __currentTime: 0,
        __videoId: ZERO_START_VIDEO_ID,
      });
      if (hasLiveGuest) installLiveZeroStartGuest();
      const { initYouTube } = await importPlayer();
      const { broadcast, safeSend } = await import('../../network/peer.ts');

      initYouTube();
      vi.mocked(broadcast).mockClear();
      vi.mocked(safeSend).mockClear();

      emitZeroStartAutoPlay();

      expect(
        vi
          .mocked(safeSend)
          .mock.calls.filter(([, message]) => message.type === MSG.YOUTUBE_ZERO_START_PREPARE),
      ).toHaveLength(0);
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MSG.YOUTUBE_STATE,
          state: 1,
          time: 0,
          videoId: ZERO_START_VIDEO_ID,
        }),
      );
    });

    it('seeks a reused same-video queue occurrence to zero on the legacy fallback', async () => {
      const player = installPlayer({
        __state: 2,
        __currentTime: 180,
        __videoId: ZERO_START_VIDEO_ID,
      });
      // A solo coordinator intentionally uses the compatible rendezvous path;
      // the same branch also covers mixed/stale client cohorts.
      const { initYouTube } = await importPlayer();
      const { broadcast } = await import('../../network/peer.ts');

      initYouTube();
      vi.mocked(broadcast).mockClear();
      bus.emit('youtube:auto-play', {
        zeroStart: true,
        isTrackTransition: true,
        state: 1,
        targetTime: 0,
        videoId: ZERO_START_VIDEO_ID,
        subIndex: 0,
        skipSeek: false,
      });

      expect(player.__log.some((entry) => entry.op === 'seekTo' && entry.args?.[0] === 0)).toBe(
        true,
      );
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MSG.YOUTUBE_STATE,
          state: 1,
          time: 0,
          videoId: ZERO_START_VIDEO_ID,
        }),
      );
    });

    it.each([
      ['seek', 42],
      ['resume', 12],
    ])('keeps an ordinary %s on the legacy sync path', async (_caseName, targetTime) => {
      installPlayer({
        __state: 2,
        __currentTime: targetTime,
        __videoId: ZERO_START_VIDEO_ID,
      });
      const conn = installLiveZeroStartGuest();
      const { initYouTube } = await importPlayer();
      const { broadcast, safeSend } = await import('../../network/peer.ts');

      initYouTube();
      advertiseZeroStartCapability(conn);
      vi.mocked(broadcast).mockClear();
      vi.mocked(safeSend).mockClear();

      emitZeroStartAutoPlay(targetTime, false);

      expect(
        vi
          .mocked(safeSend)
          .mock.calls.filter(([, message]) => message.type === MSG.YOUTUBE_ZERO_START_PREPARE),
      ).toHaveLength(0);
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MSG.YOUTUBE_STATE,
          state: 1,
          time: targetTime,
          videoId: ZERO_START_VIDEO_ID,
        }),
      );
    });

    it.each([
      ['seek', 42],
      ['skip', 5],
    ] as const)(
      'cancels an active zero-start barrier before a host %s enters the legacy rendezvous',
      async (action, value) => {
        installPlayer({
          __state: 2,
          __currentTime: 0,
          __videoId: ZERO_START_VIDEO_ID,
        });
        const conn = installLiveZeroStartGuest();
        const { initYouTube } = await importPlayer();
        const { broadcast, safeSend } = await import('../../network/peer.ts');
        const { getYouTubeZeroStartSnapshot } = await import('../zero-start.ts');

        initYouTube();
        advertiseZeroStartCapability(conn);
        emitZeroStartAutoPlay();
        expect(getYouTubeZeroStartSnapshot()?.phase).toBe('muting');

        // The real controller owns this run, while the facade models the
        // player.ts mid-sync predicate imported through this test's partial
        // module mock.
        zeroStartFacade.active = true;
        vi.mocked(broadcast).mockClear();
        if (action === 'seek') bus.emit('youtube:seek-to', value);
        else bus.emit('youtube:skip-time', value);

        expect(getYouTubeZeroStartSnapshot()?.phase).toBe('idle');
        expect(safeSend).toHaveBeenCalledWith(
          conn,
          expect.objectContaining({
            type: MSG.YOUTUBE_ZERO_START_ABORT,
            reason: 'superseded',
          }),
        );
        expect(broadcast).toHaveBeenCalledWith(
          expect.objectContaining({
            type: MSG.YOUTUBE_STATE,
            state: 1,
            time: value,
            videoId: ZERO_START_VIDEO_ID,
          }),
        );
        expect(getManagedTimer('yt-auto-sync')).not.toBeNull();
      },
    );

    it('invalidates the advertised capability and active run when a peer connection is replaced', async () => {
      installPlayer({
        __state: 2,
        __currentTime: 0,
        __videoId: ZERO_START_VIDEO_ID,
      });
      const conn = installLiveZeroStartGuest();
      const { initYouTube } = await importPlayer();
      const { canUseYouTubeZeroStart, getYouTubeZeroStartSnapshot } =
        await import('../zero-start.ts');

      initYouTube();
      advertiseZeroStartCapability(conn);
      expect(canUseYouTubeZeroStart()).toBe(true);
      emitZeroStartAutoPlay();
      expect(getYouTubeZeroStartSnapshot()).toMatchObject({
        phase: 'muting',
        expectedGuestIds: [ZERO_START_GUEST_ID],
      });

      const replacement = { peer: ZERO_START_GUEST_ID, open: true, send: vi.fn() };
      setState(
        'network.activeHostConnByPeerId',
        new Map([[ZERO_START_GUEST_ID, replacement as never]]),
      );
      bus.emit('network:peer-connection-replaced', ZERO_START_GUEST_ID);

      expect(canUseYouTubeZeroStart()).toBe(false);
      expect(getYouTubeZeroStartSnapshot()).toMatchObject({
        phase: 'idle',
        expectedGuestIds: [],
      });
    });

    it('does not revive replacement recovery after a newer pause cancels it', async () => {
      const player = installPlayer({
        __state: 2,
        __currentTime: 0,
        __videoId: ZERO_START_VIDEO_ID,
      });
      const conn = installLiveZeroStartGuest();
      const { initYouTube, cancelYtAutoSync } = await importPlayer();
      const { broadcast } = await import('../../network/peer.ts');

      initYouTube();
      advertiseZeroStartCapability(conn);
      emitZeroStartAutoPlay();

      const replacement = { peer: ZERO_START_GUEST_ID, open: true, send: vi.fn() };
      setState(
        'network.activeHostConnByPeerId',
        new Map([[ZERO_START_GUEST_ID, replacement as never]]),
      );
      bus.emit('network:peer-connection-replaced', ZERO_START_GUEST_ID);

      cancelYtAutoSync();
      player.__log.length = 0;
      vi.mocked(broadcast).mockClear();
      bus.emit('network:peer-connected', replacement as never);
      vi.advanceTimersByTime(2_000);

      expect(mutationOps(player)).toEqual([]);
      expect(
        vi.mocked(broadcast).mock.calls.some(([message]) => message.type === MSG.YOUTUBE_STATE),
      ).toBe(false);
    });

    it('invalidates the advertised capability and active run when the room authority epoch changes', async () => {
      installPlayer({
        __state: 2,
        __currentTime: 0,
        __videoId: ZERO_START_VIDEO_ID,
      });
      const conn = installLiveZeroStartGuest();
      const { initYouTube } = await importPlayer();
      const { canUseYouTubeZeroStart, getYouTubeZeroStartSnapshot } =
        await import('../zero-start.ts');

      initYouTube();
      advertiseZeroStartCapability(conn);
      expect(canUseYouTubeZeroStart()).toBe(true);
      emitZeroStartAutoPlay();
      expect(getYouTubeZeroStartSnapshot()?.phase).toBe('muting');

      const room = getState('room.context');
      setState('room.context', { ...room, epoch: room.epoch + 1 });

      expect(canUseYouTubeZeroStart()).toBe(false);
      expect(getYouTubeZeroStartSnapshot()).toMatchObject({
        phase: 'idle',
        expectedGuestIds: [],
      });
    });

    it('falls back to the legacy transition when host preparation fails asynchronously', async () => {
      installPlayer({
        __state: 2,
        __currentTime: 0,
        __videoId: ZERO_START_VIDEO_ID,
        __hardMuteFails: true,
      });
      const conn = installLiveZeroStartGuest();
      const { initYouTube } = await importPlayer();
      const { broadcast, safeSend } = await import('../../network/peer.ts');
      const { getYouTubeZeroStartSnapshot } = await import('../zero-start.ts');

      initYouTube();
      advertiseZeroStartCapability(conn);
      vi.mocked(broadcast).mockClear();
      vi.mocked(safeSend).mockClear();

      emitZeroStartAutoPlay();
      expect(
        vi
          .mocked(safeSend)
          .mock.calls.some(([, message]) => message.type === MSG.YOUTUBE_ZERO_START_PREPARE),
      ).toBe(true);
      expect(
        vi.mocked(broadcast).mock.calls.some(([message]) => message.type === MSG.YOUTUBE_STATE),
      ).toBe(false);

      // Hard-mute polling is bounded. Once preparation fails after begin()
      // already returned true, player.ts must resume the exact transition via
      // the established legacy state + rendezvous path.
      vi.advanceTimersByTime(1_000);

      expect(getYouTubeZeroStartSnapshot()?.phase).toBe('idle');
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MSG.YOUTUBE_STATE,
          state: 1,
          time: 0,
          videoId: ZERO_START_VIDEO_ID,
        }),
      );
    });

    it('waits boundedly for a rebuilt host player before handing off to legacy sync', async () => {
      installPlayer({
        __state: 2,
        __currentTime: 0,
        __videoId: ZERO_START_VIDEO_ID,
      });
      const conn = installLiveZeroStartGuest();
      const { initYouTube } = await importPlayer();
      const { broadcast } = await import('../../network/peer.ts');

      initYouTube();
      advertiseZeroStartCapability(conn);
      emitZeroStartAutoPlay();

      // The controller has already accepted the transition. Simulate an
      // iframe rebuild before its first hard-mute observation.
      getYouTubePlayerMock.mockReturnValue(null);
      vi.advanceTimersByTime(500);
      expect(getManagedTimer('yt-zero-start-host-fallback')).not.toBeNull();
      expect(broadcast).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: MSG.YOUTUBE_STATE, time: 0 }),
      );

      const rebuiltPlayer = installPlayer({
        __state: 2,
        __currentTime: 0,
        __videoId: ZERO_START_VIDEO_ID,
      });
      vi.advanceTimersByTime(100);

      expect(rebuiltPlayer.__log.filter((call) => call.op === 'loadVideoById')).toHaveLength(1);
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MSG.YOUTUBE_STATE,
          state: 1,
          time: 0,
          videoId: ZERO_START_VIDEO_ID,
        }),
      );
      expect(getManagedTimer('yt-zero-start-host-fallback')).toBeNull();
    });

    it('does not transfer an adopted host load to a rebuilt iframe instance', async () => {
      const handedOffPlayer = installPlayer({
        __state: 2,
        __currentTime: 0,
        __videoId: 'OUTGOING_VIDEO',
        __autoPlayOnLoad: false,
      });
      const conn = installLiveZeroStartGuest();
      const { initYouTube } = await importPlayer();

      initYouTube();
      advertiseZeroStartCapability(conn);
      emitZeroStartAutoPlay();
      vi.advanceTimersByTime(1);
      expect(handedOffPlayer.__log.filter((call) => call.op === 'loadVideoById')).toHaveLength(1);

      const rebuiltPlayer = installPlayer({
        __state: 2,
        __currentTime: 0,
        __videoId: 'OUTGOING_VIDEO',
        __autoPlayOnLoad: false,
      });
      vi.advanceTimersByTime(10_200);

      expect(rebuiltPlayer.__log.filter((call) => call.op === 'loadVideoById')).toEqual([
        expect.objectContaining({ args: [ZERO_START_VIDEO_ID, 0] }),
      ]);
    });

    it('settles a nonzero paused resident host iframe without reloading during fallback', async () => {
      const player = installPlayer({
        __state: 2,
        __currentTime: 180,
        __videoId: ZERO_START_VIDEO_ID,
      });
      player.playVideo = () => {
        // The resident warm command is accepted but never reaches PLAYING.
        // Host fallback must still own and reposition this exact iframe.
        player.__log.push({ op: 'playVideo', at: Date.now() });
      };
      const conn = installLiveZeroStartGuest();
      const { initYouTube } = await importPlayer();
      const { broadcast } = await import('../../network/peer.ts');

      initYouTube();
      advertiseZeroStartCapability(conn);
      vi.mocked(broadcast).mockClear();
      emitZeroStartAutoPlay();
      vi.advanceTimersByTime(10_200);

      expect(player.__log.filter((call) => call.op === 'loadVideoById')).toHaveLength(0);
      expect(player.__log).toContainEqual(
        expect.objectContaining({ op: 'seekTo', args: [0, true] }),
      );
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MSG.YOUTUBE_STATE,
          state: 1,
          time: 0,
          videoId: ZERO_START_VIDEO_ID,
        }),
      );
    });

    it('reloads once when a same-video host fallback receives a rebuilt iframe', async () => {
      const handedOffPlayer = installPlayer({
        __state: 2,
        __currentTime: 180,
        __videoId: ZERO_START_VIDEO_ID,
      });
      handedOffPlayer.playVideo = () => {
        handedOffPlayer.__log.push({ op: 'playVideo', at: Date.now() });
      };
      const conn = installLiveZeroStartGuest();
      const { initYouTube } = await importPlayer();

      initYouTube();
      advertiseZeroStartCapability(conn);
      emitZeroStartAutoPlay();
      vi.advanceTimersByTime(1);

      const rebuiltPlayer = installPlayer({
        __state: 2,
        __currentTime: 0,
        __videoId: ZERO_START_VIDEO_ID,
      });
      vi.advanceTimersByTime(10_200);

      expect(handedOffPlayer.__log.filter((call) => call.op === 'loadVideoById')).toHaveLength(0);
      expect(rebuiltPlayer.__log.filter((call) => call.op === 'loadVideoById')).toEqual([
        expect.objectContaining({ args: [ZERO_START_VIDEO_ID, 0] }),
      ]);
    });

    it('retries host audio restoration boundedly after a recovery timeout', async () => {
      const handedOffPlayer = installPlayer({
        __state: 2,
        __currentTime: 0,
        __videoId: 'OUTGOING_VIDEO',
        __muted: false,
        __volume: 73,
        __autoPlayOnLoad: false,
      });
      let unmuteAttempts = 0;
      handedOffPlayer.unMute = () => {
        handedOffPlayer.__log.push({ op: 'unMute', at: Date.now() });
        unmuteAttempts += 1;
        if (unmuteAttempts >= 2) handedOffPlayer.__muted = false;
      };
      const conn = installLiveZeroStartGuest();
      const { initYouTube, isYouTubeZeroStartExternalFallbackActive } = await importPlayer();

      initYouTube();
      advertiseZeroStartCapability(conn);
      emitZeroStartAutoPlay();
      vi.advanceTimersByTime(1);
      getYouTubePlayerMock.mockReturnValue(null);
      vi.advanceTimersByTime(13_500);

      expect(unmuteAttempts).toBeGreaterThan(1);
      expect(handedOffPlayer.isMuted()).toBe(false);
      expect(handedOffPlayer.getVolume()).toBe(73);
      expect(isYouTubeZeroStartExternalFallbackActive()).toBe(false);
      expect(getManagedTimer('yt-zero-start-host-fallback')).toBeNull();
    });

    it('clears host fallback ownership when its queue target is no longer current', async () => {
      installPlayer({
        __state: 2,
        __currentTime: 0,
        __videoId: ZERO_START_VIDEO_ID,
        __hardMuteFails: true,
      });
      const conn = installLiveZeroStartGuest();
      const { initYouTube, isYouTubeZeroStartExternalFallbackActive } = await importPlayer();

      initYouTube();
      advertiseZeroStartCapability(conn);
      emitZeroStartAutoPlay();
      vi.advanceTimersByTime(320);
      getYouTubePlayerMock.mockReturnValue(null);
      vi.advanceTimersByTime(20);
      expect(isYouTubeZeroStartExternalFallbackActive()).toBe(true);

      setState('playlist.currentQueueItemId', SECOND_QUEUE_ITEM_ID);
      vi.advanceTimersByTime(60);

      expect(isYouTubeZeroStartExternalFallbackActive()).toBe(false);
      expect(getManagedTimer('yt-zero-start-host-fallback')).toBeNull();
    });

    it('finishes a host fallback cleanly when the player never returns', async () => {
      installPlayer({
        __state: 2,
        __currentTime: 0,
        __videoId: ZERO_START_VIDEO_ID,
      });
      const conn = installLiveZeroStartGuest();
      const { initYouTube } = await importPlayer();
      const { broadcast } = await import('../../network/peer.ts');
      const loadingStates: boolean[] = [];
      bus.on('youtube:sync-loading', (busy) => loadingStates.push(busy));

      initYouTube();
      advertiseZeroStartCapability(conn);
      emitZeroStartAutoPlay();
      getYouTubePlayerMock.mockReturnValue(null);
      vi.advanceTimersByTime(4_000);

      expect(getManagedTimer('yt-zero-start-host-fallback')).toBeNull();
      expect(loadingStates.at(-1)).toBe(false);
      expect(
        vi
          .mocked(broadcast)
          .mock.calls.some(([message]) => message.type === MSG.YOUTUBE_STATE && message.time === 0),
      ).toBe(false);
    });

    it('lets a newer host seek revoke a pending legacy fallback retry', async () => {
      installPlayer({
        __state: 2,
        __currentTime: 0,
        __videoId: ZERO_START_VIDEO_ID,
      });
      const conn = installLiveZeroStartGuest();
      const { initYouTube, scheduleYtAutoSync } = await importPlayer();
      const { broadcast } = await import('../../network/peer.ts');

      initYouTube();
      advertiseZeroStartCapability(conn);
      emitZeroStartAutoPlay();
      getYouTubePlayerMock.mockReturnValue(null);
      vi.advanceTimersByTime(500);
      expect(getManagedTimer('yt-zero-start-host-fallback')).not.toBeNull();

      const latestPlayer = installPlayer({
        __state: 2,
        __currentTime: 42,
        __videoId: 'dQw4w9WgXcQ',
      });
      vi.mocked(broadcast).mockClear();
      scheduleYtAutoSync(42, { videoId: 'dQw4w9WgXcQ' });
      expect(getManagedTimer('yt-zero-start-host-fallback')).toBeNull();

      vi.advanceTimersByTime(4_000);

      expect(latestPlayer.__log.filter((call) => call.op === 'loadVideoById')).toHaveLength(0);
      expect(
        vi
          .mocked(broadcast)
          .mock.calls.some(
            ([message]) =>
              message.type === MSG.YOUTUBE_STATE &&
              message.time === 0 &&
              message.videoId === ZERO_START_VIDEO_ID,
          ),
      ).toBe(false);
    });

    it('fences an escaped host-fallback callback after teardown transfers ownership', async () => {
      installPlayer({
        __state: 2,
        __currentTime: 0,
        __videoId: ZERO_START_VIDEO_ID,
      });
      const conn = installLiveZeroStartGuest();
      const { cancelYtAutoSync, initYouTube } = await importPlayer();
      const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      initYouTube();
      advertiseZeroStartCapability(conn);
      emitZeroStartAutoPlay();
      getYouTubePlayerMock.mockReturnValue(null);
      vi.advanceTimersByTime(500);
      expect(getManagedTimer('yt-zero-start-host-fallback')).not.toBeNull();

      const escapedFallback = [...timeoutSpy.mock.calls]
        .reverse()
        .map(([callback]) => callback)
        .find((callback): callback is () => void => typeof callback === 'function');
      expect(escapedFallback).toBeTypeOf('function');

      const parkedSuccessor = installPlayer({
        __state: 5,
        __currentTime: 0,
        __videoId: 'r7M_P0FAOtw',
        __muted: true,
      });
      const mutationsBeforeTransfer = mutationOps(parkedSuccessor);
      cancelYtAutoSync(true);
      expect(getManagedTimer('yt-zero-start-host-fallback')).toBeNull();

      escapedFallback?.();

      expect(mutationOps(parkedSuccessor)).toEqual(mutationsBeforeTransfer);
      expect(parkedSuccessor.__log.filter(({ op }) => op === 'unMute')).toHaveLength(0);
      expect(parkedSuccessor.isMuted()).toBe(true);
    });

    it('cancels the previous barrier before preparing a newly selected YouTube occurrence', async () => {
      installPlayer({
        __state: 2,
        __currentTime: 0,
        __videoId: ZERO_START_VIDEO_ID,
      });
      const conn = installLiveZeroStartGuest();
      const { initYouTube } = await importPlayer();
      const { safeSend } = await import('../../network/peer.ts');
      const safeSendMock = vi.mocked(safeSend);

      initYouTube();
      advertiseZeroStartCapability(conn);
      safeSendMock.mockClear();
      emitZeroStartAutoPlay();

      const firstPrepare = safeSendMock.mock.calls.find(
        ([, message]) => message.type === MSG.YOUTUBE_ZERO_START_PREPARE,
      )?.[1];
      expect(firstPrepare).toBeDefined();
      if (!firstPrepare || firstPrepare.type !== MSG.YOUTUBE_ZERO_START_PREPARE) {
        throw new Error('expected the first zero-start prepare frame');
      }

      setState('playlist.items', [
        ...getState('playlist.items'),
        {
          queueItemId: SECOND_QUEUE_ITEM_ID,
          type: 'youtube',
          name: 'Second video',
          videoId: 'dQw4w9WgXcQ',
          playlistId: null,
        },
      ]);
      setState('playlist.currentQueueItemId', SECOND_QUEUE_ITEM_ID);
      safeSendMock.mockClear();
      bus.emit('youtube:auto-play', {
        zeroStart: true,
        isTrackTransition: true,
        state: 1,
        targetTime: 0,
        videoId: 'dQw4w9WgXcQ',
        subIndex: 0,
      });

      const transitionMessages = safeSendMock.mock.calls
        .map(([, message]) => message)
        .filter(
          (message) =>
            message.type === MSG.YOUTUBE_ZERO_START_ABORT ||
            message.type === MSG.YOUTUBE_ZERO_START_PREPARE,
        );
      expect(transitionMessages).toHaveLength(2);
      const secondTransition = transitionMessages[1];
      if (!secondTransition || secondTransition.type !== MSG.YOUTUBE_ZERO_START_PREPARE) {
        throw new Error('expected the replacement zero-start prepare frame');
      }
      expect(transitionMessages[0]).toMatchObject({
        type: MSG.YOUTUBE_ZERO_START_ABORT,
        runId: firstPrepare?.runId,
        queueItemId: QUEUE_ITEM_ID,
        reason: 'superseded',
      });
      expect(transitionMessages[1]).toMatchObject({
        type: MSG.YOUTUBE_ZERO_START_PREPARE,
        queueItemId: SECOND_QUEUE_ITEM_ID,
        videoId: 'dQw4w9WgXcQ',
      });
      expect(secondTransition.runId).not.toBe(firstPrepare.runId);
    });

    it('defers a late-join bootstrap during warm PLAYING and retries after zero-start ends', async () => {
      const player = installPlayer({
        __state: 1,
        __currentTime: 0,
        __videoId: ZERO_START_VIDEO_ID,
      });
      const { initYouTube } = await importPlayer();
      const { safeSend } = await import('../../network/peer.ts');
      const safeSendMock = vi.mocked(safeSend);
      const lateConn = dataConnection('late-zero-start-guest');
      setState('network.activeHostConnByPeerId', new Map([[lateConn.peer, lateConn]]));

      initYouTube();
      // initYouTube resets the previous test's singleton controller. Its
      // best-effort cleanup may pause this shared fake, so establish the live
      // state this case is specifically exercising after initialization.
      player.__state = 1;
      safeSendMock.mockClear();
      zeroStartFacade.active = true;

      bus.emit('network:peer-connected', lateConn);

      expect(
        safeSendMock.mock.calls.some(
          ([target, message]) =>
            target === lateConn && message.type === MSG.YOUTUBE_PLAY && message.autoplay === true,
        ),
      ).toBe(false);

      zeroStartFacade.active = false;
      vi.advanceTimersByTime(10_000);

      expect(safeSend).toHaveBeenCalledWith(
        lateConn,
        expect.objectContaining({
          type: MSG.YOUTUBE_PLAY,
          queueItemId: QUEUE_ITEM_ID,
          videoId: ZERO_START_VIDEO_ID,
          autoplay: true,
        }),
      );
    });

    it('does not let an external fallback timer from an older run play over its successor', async () => {
      const player = installPlayer({
        __state: 2,
        __currentTime: 0,
        __videoId: ZERO_START_VIDEO_ID,
        __hardMuteFails: true,
      });
      setState('network.appRole', 'guest');
      setState('network.hostConn', mockHostConn);
      const { initYouTube } = await importPlayer();

      initYouTube();
      const prepareHandler = capturedHandlers[MSG.YOUTUBE_ZERO_START_PREPARE];
      const commitHandler = capturedHandlers[MSG.YOUTUBE_ZERO_START_COMMIT];
      expect(prepareHandler).toBeDefined();
      expect(commitHandler).toBeDefined();
      const prepareAtHost = Date.now();

      prepareHandler(
        {
          type: MSG.YOUTUBE_ZERO_START_PREPARE,
          version: 1,
          runId: 'external-fallback-old-run',
          sequence: 1,
          queueItemId: QUEUE_ITEM_ID,
          videoId: ZERO_START_VIDEO_ID,
          subIndex: 0,
          prepareAtHost,
          decisionAtHost: prepareAtHost + 2_300,
          startDeadlineAtHost: prepareAtHost + 3_000,
          hostPlatform: 'other',
        },
        mockHostConn,
      );
      vi.advanceTimersByTime(400);
      commitHandler(
        {
          type: MSG.YOUTUBE_ZERO_START_COMMIT,
          version: 1,
          runId: 'external-fallback-old-run',
          sequence: 1,
          queueItemId: QUEUE_ITEM_ID,
          videoId: ZERO_START_VIDEO_ID,
          startAtHost: prepareAtHost + 3_000,
          reason: 'guest-timeout',
          cohort: ['host-only'],
        },
        mockHostConn,
      );

      // The legacy external fallback has been armed, but a newer PREPARE for
      // the same queue occurrence supersedes its run identity before the
      // fallback's delayed seek/play callback is allowed to fire.
      prepareHandler(
        {
          type: MSG.YOUTUBE_ZERO_START_PREPARE,
          version: 1,
          runId: 'external-fallback-new-run',
          sequence: 2,
          queueItemId: QUEUE_ITEM_ID,
          videoId: ZERO_START_VIDEO_ID,
          subIndex: 0,
          prepareAtHost: Date.now(),
          decisionAtHost: Date.now() + 2_300,
          startDeadlineAtHost: Date.now() + 3_000,
          hostPlatform: 'other',
        },
        mockHostConn,
      );
      player.__log.length = 0;
      vi.advanceTimersByTime(400);

      expect(player.__log.filter((call) => call.op === 'playVideo')).toHaveLength(0);
    });

    it('retries a temporarily missing fallback player within bounds and plays exactly once', async () => {
      getYouTubePlayerMock.mockReturnValue(null);
      await requestGuestExternalFallbackWhilePlayerMissing('fallback-player-retry-run');

      const recoveredPlayer = installPlayer({
        __state: 2,
        __currentTime: 0,
        __videoId: ZERO_START_VIDEO_ID,
      });
      vi.advanceTimersByTime(10_000);

      expect(recoveredPlayer.__log.filter((call) => call.op === 'loadVideoById')).toHaveLength(1);
      expect(recoveredPlayer.__log.filter((call) => call.op === 'playVideo')).toHaveLength(1);
    });

    it('reloads a guest target when the controller handed load belongs to a replaced iframe', async () => {
      setState('network.appRole', 'guest');
      setState('network.hostConn', mockHostConn as never);
      const handedOffPlayer = installPlayer({
        __state: 2,
        __currentTime: 0,
        __videoId: 'OUTGOING_VIDEO',
        __autoPlayOnLoad: false,
      });
      const { initYouTube } = await importPlayer();
      initYouTube();
      const prepareHandler = capturedHandlers[MSG.YOUTUBE_ZERO_START_PREPARE];
      const commitHandler = capturedHandlers[MSG.YOUTUBE_ZERO_START_COMMIT];
      const prepareAtHost = Date.now();

      prepareHandler(
        {
          type: MSG.YOUTUBE_ZERO_START_PREPARE,
          version: 1,
          runId: 'guest-exact-handoff-run',
          sequence: 1,
          queueItemId: QUEUE_ITEM_ID,
          videoId: ZERO_START_VIDEO_ID,
          subIndex: 0,
          prepareAtHost,
          decisionAtHost: prepareAtHost + 2_300,
          startDeadlineAtHost: prepareAtHost + 3_000,
          hostPlatform: 'other',
        },
        mockHostConn,
      );
      vi.advanceTimersByTime(1);
      expect(handedOffPlayer.__log.filter((call) => call.op === 'loadVideoById')).toHaveLength(1);

      commitHandler(
        {
          type: MSG.YOUTUBE_ZERO_START_COMMIT,
          version: 1,
          runId: 'guest-exact-handoff-run',
          sequence: 1,
          queueItemId: QUEUE_ITEM_ID,
          videoId: ZERO_START_VIDEO_ID,
          startAtHost: prepareAtHost + 3_000,
          reason: 'guest-timeout',
          cohort: ['host-only'],
        },
        mockHostConn,
      );
      const rebuiltPlayer = installPlayer({
        __state: 2,
        __currentTime: 0,
        __videoId: 'OUTGOING_VIDEO',
        __autoPlayOnLoad: false,
      });
      vi.advanceTimersByTime(3_500);

      expect(rebuiltPlayer.__log.filter((call) => call.op === 'loadVideoById')).toEqual([
        expect.objectContaining({ args: [ZERO_START_VIDEO_ID, 0] }),
      ]);
      expect(rebuiltPlayer.__log.filter((call) => call.op === 'playVideo')).toHaveLength(1);
    });

    it('requires a fresh PLAYING acknowledgement after guest fallback release', async () => {
      getYouTubePlayerMock.mockReturnValue(null);
      await requestGuestExternalFallbackWhilePlayerMissing('fallback-release-watchdog-run');
      const recoveredPlayer = installPlayer({
        __state: 2,
        __currentTime: 0,
        __videoId: ZERO_START_VIDEO_ID,
        __muted: false,
      });
      recoveredPlayer.playVideo = () => {
        recoveredPlayer.__log.push({ op: 'playVideo', at: Date.now() });
        // Simulate WebKit accepting the method call without transitioning.
      };
      const { isYouTubeZeroStartExternalFallbackActive } = await importPlayer();

      vi.advanceTimersByTime(5_000);

      expect(recoveredPlayer.__log.filter((call) => call.op === 'playVideo')).toHaveLength(1);
      expect(recoveredPlayer.getPlayerState()).toBe(2);
      expect(recoveredPlayer.isMuted()).toBe(false);
      expect(isYouTubeZeroStartExternalFallbackActive()).toBe(false);
      expect(getManagedTimer('yt-zero-start-external-fallback')).toBeNull();
    });

    it('retries guest audio restoration boundedly when fallback preparation times out', async () => {
      getYouTubePlayerMock.mockReturnValue(null);
      await requestGuestExternalFallbackWhilePlayerMissing('fallback-audio-cleanup-run');
      const stuckPlayer = installPlayer({
        __state: -1,
        __currentTime: 0,
        __videoId: 'STALE_VIDEO',
        __muted: true,
        __volume: 73,
      });
      let unmuteAttempts = 0;
      stuckPlayer.unMute = () => {
        stuckPlayer.__log.push({ op: 'unMute', at: Date.now() });
        unmuteAttempts += 1;
        if (unmuteAttempts >= 2) stuckPlayer.__muted = false;
      };

      vi.advanceTimersByTime(4_000);

      expect(unmuteAttempts).toBeGreaterThan(1);
      expect(stuckPlayer.isMuted()).toBe(false);
      expect(stuckPlayer.getVolume()).toBe(100);
      expect(getManagedTimer('yt-zero-start-external-fallback')).toBeNull();
    });

    it('transfers an old guest fallback to a new PREPARE without stale player mutations', async () => {
      setState('network.appRole', 'guest');
      setState('network.hostConn', mockHostConn as never);
      setState('audio.masterVolume', 0.73);
      const player = installPlayer({
        __state: 2,
        __currentTime: 0,
        __videoId: 'OUTGOING_VIDEO',
        __muted: false,
        __volume: 73,
        __autoPlayOnLoad: false,
      });
      player.unMute = () => {
        player.__log.push({ op: 'unMute', at: Date.now() });
        setTimeout(() => {
          player.__muted = false;
        }, 250);
      };
      const { initYouTube } = await importPlayer();
      initYouTube();
      const prepareHandler = capturedHandlers[MSG.YOUTUBE_ZERO_START_PREPARE];
      const commitHandler = capturedHandlers[MSG.YOUTUBE_ZERO_START_COMMIT];
      const abortHandler = capturedHandlers[MSG.YOUTUBE_ZERO_START_ABORT];
      const prepareAtHost = Date.now();

      prepareHandler(
        {
          type: MSG.YOUTUBE_ZERO_START_PREPARE,
          version: 1,
          runId: 'fallback-transfer-old',
          sequence: 1,
          queueItemId: QUEUE_ITEM_ID,
          videoId: ZERO_START_VIDEO_ID,
          subIndex: 0,
          prepareAtHost,
          decisionAtHost: prepareAtHost + 2_300,
          startDeadlineAtHost: prepareAtHost + 3_000,
          hostPlatform: 'other',
        },
        mockHostConn,
      );
      vi.advanceTimersByTime(1);
      commitHandler(
        {
          type: MSG.YOUTUBE_ZERO_START_COMMIT,
          version: 1,
          runId: 'fallback-transfer-old',
          sequence: 1,
          queueItemId: QUEUE_ITEM_ID,
          videoId: ZERO_START_VIDEO_ID,
          startAtHost: prepareAtHost + 3_000,
          reason: 'guest-timeout',
          cohort: ['host-only'],
        },
        mockHostConn,
      );
      vi.advanceTimersByTime(0);

      const successorVideoId = 'dQw4w9WgXcQ';
      prepareHandler(
        {
          type: MSG.YOUTUBE_ZERO_START_PREPARE,
          version: 1,
          runId: 'fallback-transfer-new',
          sequence: 2,
          queueItemId: QUEUE_ITEM_ID,
          videoId: successorVideoId,
          subIndex: 0,
          prepareAtHost: Date.now(),
          decisionAtHost: Date.now() + 2_300,
          startDeadlineAtHost: Date.now() + 3_000,
          hostPlatform: 'other',
        },
        mockHostConn,
      );
      player.__log.length = 0;
      // Exceed the simulated WebKit unmute latency. No command owned by the
      // superseded fallback may land after the successor hard-mutes/loads.
      vi.advanceTimersByTime(300);

      const successorLoadIndex = player.__log.findIndex(
        (call) => call.op === 'loadVideoById' && call.args?.[0] === successorVideoId,
      );
      expect(successorLoadIndex).toBeGreaterThanOrEqual(0);
      expect(
        player.__log
          .slice(successorLoadIndex + 1)
          .some((call) => call.op === 'pauseVideo' || call.op === 'seekTo' || call.op === 'unMute'),
      ).toBe(false);

      abortHandler(
        {
          type: MSG.YOUTUBE_ZERO_START_ABORT,
          version: 1,
          runId: 'fallback-transfer-new',
          sequence: 2,
          queueItemId: QUEUE_ITEM_ID,
          reason: 'cancelled',
        },
        mockHostConn,
      );
      vi.advanceTimersByTime(1_000);

      expect(player.isMuted()).toBe(false);
      expect(player.getVolume()).toBe(73);
    });

    it('adopts a slow target load once and verifies delayed unmute before release', async () => {
      setState('network.appRole', 'guest');
      setState('network.hostConn', mockHostConn as never);
      const player = installPlayer({
        __state: 2,
        __currentTime: 41,
        __videoId: 'OUTGOING_VIDEO',
        __muted: false,
        __volume: 73,
        __autoPlayOnLoad: false,
      });
      player.unMute = () => {
        player.__log.push({ op: 'unMute', at: Date.now() });
        setTimeout(() => {
          player.__muted = false;
        }, 250);
      };

      const { initYouTube } = await importPlayer();
      initYouTube();
      const prepareHandler = capturedHandlers[MSG.YOUTUBE_ZERO_START_PREPARE];
      const commitHandler = capturedHandlers[MSG.YOUTUBE_ZERO_START_COMMIT];
      const prepareAtHost = Date.now();
      prepareHandler(
        {
          type: MSG.YOUTUBE_ZERO_START_PREPARE,
          version: 1,
          runId: 'slow-adopt-run',
          sequence: 1,
          queueItemId: QUEUE_ITEM_ID,
          videoId: ZERO_START_VIDEO_ID,
          subIndex: 0,
          prepareAtHost,
          decisionAtHost: prepareAtHost + 2_300,
          startDeadlineAtHost: prepareAtHost + 3_000,
          hostPlatform: 'other',
        },
        mockHostConn,
      );
      vi.advanceTimersByTime(1);
      expect(player.__log.filter((call) => call.op === 'loadVideoById')).toHaveLength(1);
      expect(player.isMuted()).toBe(true);

      commitHandler(
        {
          type: MSG.YOUTUBE_ZERO_START_COMMIT,
          version: 1,
          runId: 'slow-adopt-run',
          sequence: 1,
          queueItemId: QUEUE_ITEM_ID,
          videoId: ZERO_START_VIDEO_ID,
          startAtHost: prepareAtHost + 3_000,
          reason: 'guest-timeout',
          cohort: ['host-peer'],
        },
        mockHostConn,
      );
      vi.advanceTimersByTime(3_500);

      expect(player.__log.filter((call) => call.op === 'loadVideoById')).toHaveLength(1);
      expect(player.__log.filter((call) => call.op === 'unMute').length).toBeGreaterThan(1);
      expect(player.isMuted()).toBe(false);
      expect(player.getVolume()).toBe(73);
      expect(player.__log.filter((call) => call.op === 'playVideo')).toHaveLength(1);
    });

    it('settles and releases a nonzero paused resident guest iframe without reloading', async () => {
      setState('network.appRole', 'guest');
      setState('network.hostConn', mockHostConn as never);
      const player = installPlayer({
        __state: 2,
        __currentTime: 180,
        __videoId: ZERO_START_VIDEO_ID,
        __muted: false,
        __volume: 73,
      });
      player.playVideo = () => {
        // Record both the stalled warm attempt and the later fallback release
        // without manufacturing a PLAYING acknowledgement.
        player.__log.push({ op: 'playVideo', at: Date.now() });
      };
      const { initYouTube } = await importPlayer();
      initYouTube();
      const prepareHandler = capturedHandlers[MSG.YOUTUBE_ZERO_START_PREPARE];
      const commitHandler = capturedHandlers[MSG.YOUTUBE_ZERO_START_COMMIT];
      const prepareAtHost = Date.now();

      prepareHandler(
        {
          type: MSG.YOUTUBE_ZERO_START_PREPARE,
          version: 1,
          runId: 'guest-resident-nonzero-fallback',
          sequence: 1,
          queueItemId: QUEUE_ITEM_ID,
          videoId: ZERO_START_VIDEO_ID,
          subIndex: 0,
          prepareAtHost,
          decisionAtHost: prepareAtHost + 2_300,
          startDeadlineAtHost: prepareAtHost + 3_000,
          hostPlatform: 'other',
        },
        mockHostConn,
      );
      vi.advanceTimersByTime(1);
      commitHandler(
        {
          type: MSG.YOUTUBE_ZERO_START_COMMIT,
          version: 1,
          runId: 'guest-resident-nonzero-fallback',
          sequence: 1,
          queueItemId: QUEUE_ITEM_ID,
          videoId: ZERO_START_VIDEO_ID,
          startAtHost: prepareAtHost + 500,
          reason: 'guest-timeout',
          cohort: ['host-only'],
        },
        mockHostConn,
      );
      vi.advanceTimersByTime(600);

      expect(player.__log.filter((call) => call.op === 'loadVideoById')).toHaveLength(0);
      expect(player.__log).toContainEqual(
        expect.objectContaining({ op: 'seekTo', args: [0, true] }),
      );
      expect(player.__log.filter((call) => call.op === 'playVideo')).toHaveLength(2);
    });

    it('does not release a recovered fallback player before the future COMMIT deadline', async () => {
      getYouTubePlayerMock.mockReturnValue(null);
      await requestGuestExternalFallbackWhilePlayerMissing('fallback-future-release-run');

      const recoveredPlayer = installPlayer({
        __state: 2,
        __currentTime: 0,
        __videoId: ZERO_START_VIDEO_ID,
      });
      vi.advanceTimersByTime(2_999);

      expect(recoveredPlayer.__log.filter((call) => call.op === 'playVideo')).toHaveLength(0);
      // The target stays hard-muted as well as paused until the authoritative
      // COMMIT deadline, preventing an async autoplay event from leaking.
      expect(recoveredPlayer.getPlayerState()).toBe(2);
      expect(recoveredPlayer.isMuted()).toBe(true);

      vi.advanceTimersByTime(1);

      expect(recoveredPlayer.__log.filter((call) => call.op === 'playVideo')).toHaveLength(1);
      expect(recoveredPlayer.isMuted()).toBe(false);
    });

    it('revokes a recovered fallback when the release play command throws', async () => {
      getYouTubePlayerMock.mockReturnValue(null);
      await requestGuestExternalFallbackWhilePlayerMissing('fallback-play-throws-run');

      const recoveredPlayer = installPlayer({
        __state: 2,
        __currentTime: 0,
        __videoId: ZERO_START_VIDEO_ID,
        __muted: false,
        __volume: 73,
      });
      recoveredPlayer.playVideo = () => {
        recoveredPlayer.__log.push({ op: 'playVideo', at: Date.now() });
        throw new Error('simulated play rejection');
      };

      vi.advanceTimersByTime(3_500);

      expect(recoveredPlayer.__log.filter((call) => call.op === 'playVideo')).toHaveLength(1);
      expect(recoveredPlayer.__log.some((call) => call.op === 'pauseVideo')).toBe(true);
      expect(recoveredPlayer.__log.some((call) => call.op === 'cueVideoById')).toBe(false);
      expect(recoveredPlayer.getPlayerState()).toBe(2);
      expect(recoveredPlayer.isMuted()).toBe(false);
      expect(recoveredPlayer.getVolume()).toBe(100);
    });

    it('revokes a fallback load that never becomes ready before its deadline', async () => {
      getYouTubePlayerMock.mockReturnValue(null);
      await requestGuestExternalFallbackWhilePlayerMissing('fallback-player-deadline-run');

      const stuckPlayer = installPlayer({
        __state: -1,
        __currentTime: 0,
        __videoId: 'STALE_VIDEO',
        __muted: false,
        __volume: 73,
      });
      vi.advanceTimersByTime(3_500);

      expect(stuckPlayer.__log.filter((call) => call.op === 'loadVideoById')).toHaveLength(1);
      expect(stuckPlayer.__log.filter((call) => call.op === 'playVideo')).toHaveLength(0);
      expect(stuckPlayer.__log.some((call) => call.op === 'pauseVideo')).toBe(true);
      expect(stuckPlayer.__log.some((call) => call.op === 'cueVideoById')).toBe(false);
      expect(stuckPlayer.getPlayerState()).toBe(2);
      expect(stuckPlayer.isMuted()).toBe(false);
      expect(stuckPlayer.getVolume()).toBe(100);
    });

    it.each(['new PREPARE', 'matching ABORT', 'host connection', 'YouTube session'] as const)(
      'invalidates a pending player retry when superseded by %s',
      async (invalidation) => {
        getYouTubePlayerMock.mockReturnValue(null);
        const runId = `fallback-invalidated-${invalidation.replaceAll(' ', '-').toLowerCase()}`;
        const { prepareAtHost, prepareHandler, abortHandler } =
          await requestGuestExternalFallbackWhilePlayerMissing(runId);

        if (invalidation === 'new PREPARE') {
          prepareHandler(
            {
              type: MSG.YOUTUBE_ZERO_START_PREPARE,
              version: 1,
              runId: 'fallback-successor-run',
              sequence: 2,
              queueItemId: QUEUE_ITEM_ID,
              videoId: 'dQw4w9WgXcQ',
              subIndex: 0,
              prepareAtHost: Date.now(),
              decisionAtHost: Date.now() + 2_300,
              startDeadlineAtHost: Date.now() + 3_000,
              hostPlatform: 'other',
            },
            mockHostConn,
          );
        } else if (invalidation === 'matching ABORT') {
          abortHandler(
            {
              type: MSG.YOUTUBE_ZERO_START_ABORT,
              version: 1,
              runId,
              sequence: 1,
              queueItemId: QUEUE_ITEM_ID,
              reason: 'cancelled',
              prepareAtHost,
            },
            mockHostConn,
          );
        } else if (invalidation === 'host connection') {
          setState('network.hostConn', { peer: 'replacement-host', open: true } as never);
        } else {
          youtubeSessionFacade.id += 1;
        }

        const recoveredPlayer = installPlayer({
          __state: 2,
          __currentTime: 0,
          __videoId: ZERO_START_VIDEO_ID,
        });
        vi.advanceTimersByTime(10_000);

        const mediaCalls = recoveredPlayer.__log.filter(
          (call) => call.op === 'loadVideoById' || call.op === 'playVideo',
        );
        if (invalidation === 'new PREPARE') {
          // The stale fallback stays revoked, while the newer cold PREPARE is
          // allowed to resume against the recovered player.
          expect(mediaCalls).toEqual([
            expect.objectContaining({ op: 'loadVideoById', args: ['dQw4w9WgXcQ', 0] }),
          ]);
        } else {
          expect(mediaCalls).toHaveLength(0);
        }
      },
    );
  });

  describe('zero-start legacy heartbeat barrier', () => {
    it('suppresses periodic and manual legacy sync until the zero-start release completes', async () => {
      installPlayer({ __state: 1, __currentTime: 12, __duration: 120 });
      const { broadcastYouTubeSync } = await importSync();
      const { broadcast } = await import('../../network/peer.ts');
      const broadcastMock = vi.mocked(broadcast);
      broadcastMock.mockClear();
      zeroStartFacade.inFlight = true;
      zeroStartFacade.active = true;

      broadcastYouTubeSync(false);
      broadcastYouTubeSync(true, 1);
      expect(broadcastMock).not.toHaveBeenCalled();

      zeroStartFacade.inFlight = false;
      zeroStartFacade.active = false;
      broadcastYouTubeSync(true, 1);
      expect(broadcastMock).toHaveBeenCalledTimes(1);
      expect(broadcastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: MSG.YOUTUBE_SYNC, state: 1 }),
      );
    });

    it('rejects a guest manual rendezvous without mutating the player while zero-start is active', async () => {
      const player = installPlayer({ __state: 1, __currentTime: 12, __duration: 120 });
      const { guestRendezvousSync } = await importSync();
      setState('network.hostConn', mockHostConn as never);
      zeroStartFacade.active = true;

      const result = guestRendezvousSync({ silent: true });

      expect(result.status).toBe('not-ready');
      expect(mutationOps(player)).toEqual([]);
    });
  });

  describe('identity-aware pending iframe handoff', () => {
    it('does not let a stale B CUED consume the newer C intent', async () => {
      const player = installPlayer({ __state: 5, __videoId: 'VIDEO_BBBBB' });
      const {
        consumePendingAutoSyncOnReady,
        getPendingAutoSyncOnReadyForTests: getPendingAutoSyncOnReady,
        setPendingAutoSyncOnReady,
      } = await importPlayer();

      setPendingAutoSyncOnReady(true, {
        isTrackTransition: true,
        zeroStart: true,
        targetTime: 0,
        videoId: 'VIDEO_BBBBB',
      });

      // B was superseded by queue occurrence C before B's asynchronous CUED
      // callback reached iframe.ts.
      setState('playlist.currentQueueItemId', SECOND_QUEUE_ITEM_ID);
      setPendingAutoSyncOnReady(true, {
        isTrackTransition: true,
        zeroStart: true,
        targetTime: 0,
        videoId: 'VIDEO_CCCCC',
      });

      expect(consumePendingAutoSyncOnReady()).toBeNull();
      expect(getPendingAutoSyncOnReady()).toBe(true);

      // C's own CUED event may now complete the handoff. Only C's intent is
      // returned; the superseded B generation can never be resurrected.
      player.__videoId = 'VIDEO_CCCCC';
      expect(consumePendingAutoSyncOnReady()).toMatchObject({
        isTrackTransition: true,
        zeroStart: true,
        videoId: 'VIDEO_CCCCC',
      });
      expect(getPendingAutoSyncOnReady()).toBe(false);
    });

    it('watchdog completes a handoff when CUED happened synchronously or was missed', async () => {
      installPlayer({ __state: 5, __videoId: 'VIDEO_CCCCC' });
      setState('playlist.currentQueueItemId', SECOND_QUEUE_ITEM_ID);
      const {
        getPendingAutoSyncOnReadyForTests: getPendingAutoSyncOnReady,
        setPendingAutoSyncOnReady,
      } = await importPlayer();
      const autoPlaySpy = vi.fn();
      bus.on('youtube:auto-play', autoPlaySpy);

      // Model cueVideoById firing CUED before setPendingAutoSyncOnReady could
      // be armed: the live player is already CUED and no later state callback
      // will arrive. The bounded readiness poll must provide the handoff.
      setPendingAutoSyncOnReady(true, {
        isTrackTransition: true,
        zeroStart: true,
        targetTime: 0,
        videoId: 'VIDEO_CCCCC',
      });

      vi.advanceTimersByTime(49);
      expect(autoPlaySpy).not.toHaveBeenCalled();
      expect(getPendingAutoSyncOnReady()).toBe(true);

      vi.advanceTimersByTime(1);
      expect(autoPlaySpy).toHaveBeenCalledTimes(1);
      expect(autoPlaySpy).toHaveBeenCalledWith(
        expect.objectContaining({ zeroStart: true, videoId: 'VIDEO_CCCCC' }),
      );
      expect(getPendingAutoSyncOnReady()).toBe(false);

      vi.advanceTimersByTime(1_000);
      expect(autoPlaySpy).toHaveBeenCalledTimes(1);
    });
  });

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
      if (msg.type !== MSG.YOUTUBE_STATE) throw new Error('expected Stage 1 YouTube state');
      expect(msg.state).toBe(1);
      expect(msg.time).toBe(10);
      expect(msg.videoId).toBe('NEW_VID');
      // hostPlayAt=0 signals "act immediately"; precision comes from Stage 2.
      expect(msg.hostPlayAt).toBe(0);
    });

    it('keeps retained legacy rendezvous events from mutating PRO playback', async () => {
      const player = installPlayer({ __state: 2, __currentTime: 10, __duration: 120 });
      setState('sync.youtubeLocalOffset', 0.25);
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'coordinator',
        coordinatorId: 'participant-0',
        epoch: 1,
        snapshotRevision: 1,
        capabilities: ['playback.control'],
      });
      const { scheduleYtAutoSync } = await importPlayer();
      const { broadcast } = await import('../../network/peer.ts');
      const broadcastMock = vi.mocked(broadcast);

      scheduleYtAutoSync(10);

      expect(player.__log.find((entry) => entry.op === 'seekTo')).toBeUndefined();
      expect(broadcastMock).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2000);

      expect(broadcastMock).not.toHaveBeenCalled();
    });

    it('preserves participant-local offset state when rejecting a stale PRO schedule', async () => {
      const player = installPlayer({ __state: 2, __currentTime: 0, __duration: 120 });
      setState('sync.youtubeLocalOffset', -0.25);
      setState('sync.youtubeCoordinatorAppliedOffset', -0.25);
      setState('room.context', {
        kind: 'pro',
        roomId: '000001',
        role: 'coordinator',
        coordinatorId: 'participant-0',
        epoch: 1,
        snapshotRevision: 1,
        capabilities: ['playback.control'],
      });
      const { scheduleYtAutoSync } = await importPlayer();

      scheduleYtAutoSync(0, { skipSeek: true, state: 2 });

      expect(getState('sync.youtubeLocalOffset')).toBe(-0.25);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(-0.25);

      scheduleYtAutoSync(10, { state: 2 });

      expect(player.__log.filter((entry) => entry.op === 'seekTo')).toHaveLength(0);
      expect(getState('sync.youtubeLocalOffset')).toBe(-0.25);
      expect(getState('sync.youtubeCoordinatorAppliedOffset')).toBe(-0.25);
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
      if (stage2.type !== MSG.YOUTUBE_SYNC) throw new Error('expected Stage 2 YouTube sync');
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
      const player = installPlayer({
        __state: 2,
        __currentTime: 37,
        __videoId: 'RECOVERED_VIDEO',
      });
      const {
        initYouTube,
        setPendingAutoSyncOnReady,
        getPendingAutoSyncOnReadyForTests: getPendingAutoSyncOnReady,
      } = await importPlayer();
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
      expect(player.__log.some((c) => c.op === 'seekTo' && c.args?.[0] === 37)).toBe(true);
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

    it('releases a superseded clock-action loading owner before an immediate command', () => {
      installPlayer({
        __state: 2,
        __duration: 300,
        __currentTime: 0,
        __videoId: 'FAKE_VIDEO',
      });
      const handler = capturedHandlers[MSG.YOUTUBE_STATE];
      const loadingEvents: Array<[boolean, string | undefined]> = [];
      bus.on('youtube:sync-loading', (loading, owner) => loadingEvents.push([loading, owner]));
      setState('network.hostConn', mockHostConn as never);

      handler(
        {
          state: 1,
          time: 5,
          hostPlayAt: Date.now() + 1_000,
          subIndex: 0,
          videoId: 'FAKE_VIDEO',
        },
        mockHostConn,
      );
      expect(loadingEvents.at(-1)).toEqual([true, 'clock-action']);
      expect(getManagedTimer('yt-clock-action')).not.toBeNull();

      handler(
        {
          state: 1,
          time: 8,
          hostPlayAt: 0,
          subIndex: 0,
          videoId: 'FAKE_VIDEO',
        },
        mockHostConn,
      );

      expect(getManagedTimer('yt-clock-action')).toBeNull();
      expect(loadingEvents.at(-1)).toEqual([false, 'clock-action']);
    });

    it('keeps the replacement clock-action owner busy until its own countdown completes', () => {
      installPlayer({
        __state: 2,
        __duration: 300,
        __currentTime: 0,
        __videoId: 'FAKE_VIDEO',
      });
      const handler = capturedHandlers[MSG.YOUTUBE_STATE];
      const loadingEvents: Array<[boolean, string | undefined]> = [];
      bus.on('youtube:sync-loading', (loading, owner) => loadingEvents.push([loading, owner]));
      setState('network.hostConn', mockHostConn as never);

      handler(
        {
          state: 1,
          time: 5,
          hostPlayAt: Date.now() + 1_000,
          subIndex: 0,
          videoId: 'FAKE_VIDEO',
        },
        mockHostConn,
      );
      vi.advanceTimersByTime(200);
      handler(
        {
          state: 1,
          time: 8,
          hostPlayAt: Date.now() + 1_000,
          subIndex: 0,
          videoId: 'FAKE_VIDEO',
        },
        mockHostConn,
      );

      expect(loadingEvents.slice(-2)).toEqual([
        [false, 'clock-action'],
        [true, 'clock-action'],
      ]);

      vi.advanceTimersByTime(1_000);
      expect(loadingEvents.at(-1)).toEqual([false, 'clock-action']);
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
    it('a paused YOUTUBE_SYNC clears autoplay intent and the tap gate before readiness', async () => {
      const syncHandler = capturedHandlers[MSG.YOUTUBE_SYNC];
      const stateMod = await import('../_state.ts');
      const bridge = await import('../iframe-runtime-bridge.ts');
      const hideTapToPlayGate = vi.fn();
      bridge.configureYouTubeIframeRuntimeHooks({
        hideTapToPlayGate,
        invalidateDurationCache: vi.fn(),
      });
      setState('network.hostConn', mockHostConn as never);
      setPlaybackIdle();
      getYouTubePlayerMock.mockReturnValue(null);

      syncHandler(
        { time: 42, state: 2, subIndex: 0, videoId: 'FAKE_VIDEO', hostClock: Date.now() },
        mockHostConn,
      );

      expect(stateMod.setYtAutoplayIntent).toHaveBeenCalledWith(false);
      expect(hideTapToPlayGate).toHaveBeenCalledOnce();

      bridge.configureYouTubeIframeRuntimeHooks({
        hideTapToPlayGate: () => undefined,
        invalidateDurationCache: () => undefined,
      });
    });

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
      setState('playlist.items', [
        {
          queueItemId: QUEUE_ITEM_ID,
          type: 'youtube',
          videoId: ids[0],
          playlistId: 'PL_NAV',
          name: 'Playlist',
        },
      ] as never);
      setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
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
