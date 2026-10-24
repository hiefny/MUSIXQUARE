/**
 * @vitest-environment jsdom
 *
 * C3 cross-flow harness: participant-local YouTube re-alignment.
 *
 * Two flows can re-align one guest iframe: the OS-PLAY rejoin router
 * (local-output-rejoin.ts) and the background-return Sync chain
 * (background-return-sync.ts). Their only shared arbiter is the rendezvous
 * primitive in youtube/sync.ts (in-progress and cooldown busy results), so
 * this harness runs both flows against the real primitive instead of a
 * scripted mock.
 *
 * Real: local-output-rejoin.ts, background-return-sync.ts, the background
 * resume guard and recovery, media-session.ts, the native-control authority,
 * youtube/sync.ts, youtube/_state.ts, the protocol dispatcher and the
 * ownership state. Fakes sit at the edges only: the iframe (fake YT player),
 * the network send and shared clock, the lazy PRO runtime, log, i18n and
 * toasts. One stand-in replaces youtube/player.ts's resume branch, which hands
 * a local PLAY to the router (the same stand-in background-return-sync.test.ts
 * uses).
 *
 * Tests named "expected today" characterize behaviour the Phase 4 owner
 * decisions (2026-10-24) kept unchanged: P4-D7 A and P4-D8 A. They pass on
 * today's code on purpose. A later decision that changes one of these
 * behaviours updates the test in the same change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const edges = vi.hoisted(() => ({
  reconcilePro: vi.fn(
    async (_options?: {
      showLoading?: boolean;
      liveness?: { identity: object; isCurrent: () => boolean };
    }) => true,
  ),
  proBackgroundReturnSync: vi.fn(),
}));

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../i18n/index.ts', () => ({ t: (key: string) => key }));
vi.mock('../../network/peer.ts', () => ({
  broadcast: vi.fn(),
  safeSend: vi.fn(() => true),
  sendToHost: vi.fn(),
  isRemoteGuest: () => false,
}));
vi.mock('../../network/shared-clock.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../network/shared-clock.ts')>()),
  getHostNow: () => Date.now(),
  getClockOffset: () => 0,
  isClockCalibrated: () => true,
  getClockCorrectionQuality: () => ({
    eligible: true,
    epoch: 0,
    offsetMs: 0,
    rttMs: 0,
    uncertaintyMs: 5,
    precisionMs: 5,
  }),
}));
vi.mock('../../pro-room/runtime.ts', () => ({
  requestActiveProRoomPlaybackReconciliation: edges.reconcilePro,
  requestProRoomBackgroundReturnSync: edges.proBackgroundReturnSync,
}));
vi.mock('../../ui/toast.ts', () => ({
  showToast: vi.fn(),
  showLoader: vi.fn(),
  updateLoader: vi.fn(),
}));

import { MSG } from '../../core/constants.ts';
import { initBackgroundResumeGuard } from '../../core/background-resume-guard.ts';
import { runBackgroundResumeRecovery } from '../../core/background-resume-recovery.ts';
import { bus } from '../../core/events.ts';
import { log } from '../../core/log.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers, getManagedTimer } from '../../core/timers.ts';
import { initProtocol, resetInboundRateLimit } from '../../network/protocol.ts';
import { markQueueAuthorityReady } from '../../network/queue-authority.ts';
import type { TransportBackgroundRecoveryResult } from '../../network/transport/types.ts';
import type { DataConnection, PlaylistItem } from '../../types/index.ts';
import {
  isLocalYouTubePaused,
  markYtPlayerReady,
  resetYouTubeModuleState,
  setLocalYouTubePaused,
  setYouTubePlayer,
  setYtAutoplayIntent,
  type YouTubePlayerInstance,
} from '../../youtube/_state.ts';
import { LOCAL_OUTPUT_REALIGN_RETRY_MS, RENDEZVOUS_COOLDOWN_MS } from '../../youtube/constants.ts';
import { initYouTubeSync, resetYouTubeSyncState } from '../../youtube/sync.ts';
import {
  makeFakeYtPlayer,
  mutationOps,
  type FakeYtPlayer,
} from '../../youtube/__tests__/__helpers__/fake-yt-player.ts';
import { runBackgroundReturnSync } from '../background-return-sync.ts';
import { initLocalOutputRejoin } from '../local-output-rejoin.ts';
import { initMediaSession } from '../media-session.ts';
import { setPlaybackYouTubePaused, setPlaybackYouTubePlaying } from '../ownership.ts';

const QUEUE_ITEM_ID = '66666666-6666-4666-8666-666666666666';
const VIDEO_ID = 'CROSSFLOWV1';
const NEXT_VIDEO_ID = 'CROSSFLOWV2';
const HEARTBEAT_MS = 3_000;
/** The return chain polls a busy rendezvous every 250 ms, five times. */
const RETURN_GIVE_UP_MS = 1_250;
/** Sum of the bounded PRO retry delays: 250 + 750 + 1,500 + 3,000 + 5,000. */
const PRO_RETRY_WINDOW_MS = LOCAL_OUTPUT_REALIGN_RETRY_MS.reduce((sum, delay) => sum + delay, 0);

/** The fake YT player plus the playlist methods the native-control authority instruments. */
type GuestIframe = FakeYtPlayer & Pick<YouTubePlayerInstance, 'loadPlaylist' | 'cuePlaylist'>;

let host: DataConnection;
/** Fake time at which the host's timeline was at 100 s; it plays in real time. */
let hostTimelineOrigin = 0;
let guard: { dispose: () => void } | null = null;
/** Rendezvous starts (physical pause, seek and timed play) by fake time. */
let rendezvousStartedAt: number[] = [];
const mediaHandlers = new Map<MediaSessionAction, MediaSessionActionHandler>();

function connection(peer: string): DataConnection {
  return {
    peer,
    open: true,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
  } as unknown as DataConnection;
}

function setVisibility(value: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value });
  Object.defineProperty(document, 'hidden', { configurable: true, value: value === 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
}

/** A host frame through the real protocol dispatcher, as guest.ts delivers it. */
function hostFrame(type: string, frame: Record<string, unknown>): void {
  bus.emit(
    'network:data',
    {
      type,
      queueItemId: QUEUE_ITEM_ID,
      videoId: VIDEO_ID,
      subIndex: -1,
      hostClock: Date.now(),
      ...frame,
    },
    host,
  );
}

/** A host heartbeat whose position follows the host's playing timeline. */
function heartbeat(frame: Record<string, unknown> = {}): void {
  hostFrame(MSG.YOUTUBE_SYNC, {
    time: 100 + (Date.now() - hostTimelineOrigin) / 1000,
    state: 1,
    ...frame,
  });
}

function infoMessages(): string[] {
  return vi.mocked(log.info).mock.calls.map(([message]) => String(message));
}

function returnChainGaveUp(): boolean {
  return infoMessages().includes('[BackgroundReturnSync] Guest rendezvous retries exhausted');
}

/**
 * The fake YT player with the full stable-control surface the native-control
 * authority instruments (it also wraps loadPlaylist and cuePlaylist).
 */
function createIframe(state: number, loadReportsVideoAfterMs = 0): GuestIframe {
  const player = makeFakeYtPlayer({
    __state: state,
    __currentTime: 30,
    __duration: 300,
    __videoId: VIDEO_ID,
    __advanceClock: true,
  });
  if (loadReportsVideoAfterMs > 0) {
    // A real iframe keeps reporting the previous video while it loads the next.
    const load = player.loadVideoById;
    player.loadVideoById = (videoId, startSeconds) => {
      const previous = player.__videoId;
      load(videoId, startSeconds);
      player.__videoId = previous;
      player.__setState(3, false);
      setTimeout(() => {
        player.__videoId = videoId;
        player.__setState(1, false);
      }, loadReportsVideoAfterMs);
    };
  }
  return Object.assign(player, {
    loadPlaylist: () => player.__setState(1, false),
    cuePlaylist: () => player.__setState(2, false),
  });
}

function installQueueItem(): void {
  setState('setup.sessionStarted', true);
  setState('playlist.items', [
    {
      queueItemId: QUEUE_ITEM_ID,
      type: 'youtube',
      name: 'Video',
      title: 'Video',
      videoId: VIDEO_ID,
      playlistId: null,
    } as PlaylistItem,
  ]);
  setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
}

function installIframe(player: GuestIframe): void {
  setYouTubePlayer(player);
  markYtPlayerReady(player);
}

/** The app's initialization order for the modules this harness keeps real. */
function initRuntime(): void {
  initProtocol();
  initYouTubeSync();
  resetYouTubeSyncState();
  initMediaSession();
  bus.emit('youtube:player-ready');
  initLocalOutputRejoin();
  // Stand-in for youtube/player.ts's resume branch: a local PLAY never calls
  // playVideo early; it asks the rejoin router to align first.
  bus.on('youtube:set-local-paused', (paused, reason) => {
    if (paused) return;
    bus.emit('playback:local-output-rejoin', {
      reason: reason ?? 'media-session-play',
      mode: 'youtube',
    });
  });
  // The app wiring: guard -> recovery -> background-return Sync.
  guard = initBackgroundResumeGuard({
    recover: ({ hiddenMs }) =>
      runBackgroundResumeRecovery(hiddenMs, {
        recoverPeer: (): TransportBackgroundRecoveryResult => ({ status: 'not-applicable' }),
        reacquireWakeLock: () => undefined,
        recoverAudio: async () => false,
        syncRoom: ({ peer, audio }) => {
          runBackgroundReturnSync({ peerRecovery: peer, fileOutputOwned: audio === true });
        },
      }),
    warn: () => undefined,
    shouldHandle: () => true,
  });
}

/** A Standard guest without playback control, with an open host connection. */
function installStandardGuest(options: {
  iframeState: number;
  locallyPaused: boolean;
  loadReportsVideoAfterMs?: number;
}): GuestIframe {
  installQueueItem();
  setState('network.appRole', 'guest');
  setState('network.hostConn', host);
  setState('network.isOperator', false);
  setState('network.standardRoomCapabilities', []);
  markQueueAuthorityReady(host);
  const player = createIframe(options.iframeState, options.loadReportsVideoAfterMs);
  installIframe(player);
  setLocalYouTubePaused(options.locallyPaused);
  if (options.locallyPaused) setPlaybackYouTubePaused();
  else setPlaybackYouTubePlaying();
  initRuntime();
  return player;
}

/** A PRO listener: a member without playback control, audible in the iframe. */
function installProListener(): GuestIframe {
  installQueueItem();
  setState('network.sessionCode', '000001');
  setState('room.context', {
    kind: 'pro',
    roomId: '000001',
    role: 'member',
    coordinatorId: null,
    epoch: 7,
    snapshotRevision: 11,
    capabilities: [],
  });
  const player = createIframe(1);
  installIframe(player);
  setYtAutoplayIntent(true);
  setPlaybackYouTubePlaying();
  initRuntime();
  return player;
}

/** Locked for `lockedMs` while the host keeps sending playing heartbeats. */
async function stayLocked(lockedMs: number): Promise<void> {
  setVisibility('hidden');
  hostTimelineOrigin = Date.now();
  for (let elapsed = 0; elapsed < lockedMs; elapsed += HEARTBEAT_MS) {
    heartbeat();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
  }
}

async function unlock(): Promise<void> {
  setVisibility('visible');
  await vi.advanceTimersByTimeAsync(0);
}

/** The listener presses pause in the iframe's own controls while visible. */
function pressVisibleIframePause(player: GuestIframe): void {
  player.__state = 2;
  setPlaybackYouTubePaused();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  localStorage.removeItem('musixquare-yt-play-latency');
  resetState();
  bus.clear();
  clearAllManagedTimers();
  vi.clearAllMocks();
  edges.reconcilePro.mockResolvedValue(true);
  resetYouTubeModuleState();
  setLocalYouTubePaused(false);
  setVisibility('visible');
  mediaHandlers.clear();
  Object.defineProperty(navigator, 'mediaSession', {
    configurable: true,
    value: {
      setActionHandler(action: MediaSessionAction, handler: MediaSessionActionHandler | null) {
        if (handler) mediaHandlers.set(action, handler);
        else mediaHandlers.delete(action);
      },
    },
  });
  host = connection('cross-flow-host');
  rendezvousStartedAt = [];
  bus.on('youtube:sync-loading', (loading, owner) => {
    if (loading && owner === 'rendezvous') rendezvousStartedAt.push(Date.now());
  });
});

afterEach(() => {
  guard?.dispose();
  guard = null;
  // Release the dispatcher's per-peer rate-limit bucket for the next test.
  resetInboundRateLimit(host.peer);
  resetYouTubeSyncState();
  setYouTubePlayer(null);
  setLocalYouTubePaused(false);
  clearAllManagedTimers();
  setVisibility('visible');
  vi.useRealTimers();
});

describe('P4-D7: a PRO listener pause while a failed OS-PLAY rejoin waits to retry', () => {
  /** Script reconciliation results in call order; record the pause bit and liveness per call. */
  function scriptReconciliation(results: readonly boolean[]) {
    const startedAt = Date.now();
    const calls: { atMs: number; localPaused: boolean; current: boolean }[] = [];
    edges.reconcilePro.mockImplementation(async (options) => {
      calls.push({
        atMs: Date.now() - startedAt,
        localPaused: isLocalYouTubePaused(),
        current: options?.liveness?.isCurrent() === true,
      });
      return results[calls.length - 1] ?? false;
    });
    return calls;
  }

  it('expected today: the next retry releases a visible iframe PAUSE and reconciles again', async () => {
    const player = installProListener();
    const pauseIntent = vi.fn();
    bus.on('youtube:set-local-paused', pauseIntent);
    // Three misses, then the runtime has the canonical timeline again.
    const calls = scriptReconciliation([false, false, false, true]);

    // An OS PLAY reaches the router (the payload youtube/player.ts and the
    // iOS PRO tap gate emit). Its reconciliations miss at 0, 250 and 1,000 ms.
    bus.emit('playback:local-output-rejoin', { reason: 'media-session-play', mode: 'youtube' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls.map((call) => call.atMs)).toEqual([0, 250, 1_000]);

    // During the 1,500 ms wait the listener pauses in the visible iframe.
    pressVisibleIframePause(player);
    expect(infoMessages()).toContain('[YouTube Native Control] Applied endpoint-local pause');
    expect(isLocalYouTubePaused()).toBe(true);
    // PRO records the local pause only; no pause intent reaches the router.
    expect(pauseIntent).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15_000);
    // The retry at 2,500 ms released the pause and asked the PRO runtime to
    // start this listener again under a liveness that still reports current.
    expect(calls).toHaveLength(4);
    expect(calls[3]).toEqual({ atMs: 2_500, localPaused: false, current: true });
    // The successful reconciliation keeps it released: the pause is undone.
    // (The PRO runtime is a fake here. youtube/player.ts drops a PRO commit
    // for a local pause only after a youtube:set-local-paused event, so the
    // real runtime would play the iframe again; that step is read, not run.)
    expect(isLocalYouTubePaused()).toBe(false);
    expect(pauseIntent).not.toHaveBeenCalled();
  });

  it('expected today: the exposure lasts until the bounded schedule ends (about 10.5 s)', async () => {
    const player = installProListener();
    const calls = scriptReconciliation([]);

    bus.emit('playback:local-output-rejoin', { reason: 'media-session-play', mode: 'youtube' });
    await vi.advanceTimersByTimeAsync(2_000);
    pressVisibleIframePause(player);
    await vi.advanceTimersByTimeAsync(20_000);

    // Every remaining retry releases the pause for its reconciliation; a miss
    // puts it back, so a listener whose runtime never answers stays paused.
    expect(PRO_RETRY_WINDOW_MS).toBe(10_500);
    expect(calls.map((call) => call.atMs)).toEqual([0, 250, 1_000, 2_500, 5_500, 10_500]);
    expect(calls.slice(3).map((call) => [call.localPaused, call.current])).toEqual([
      [false, true],
      [false, true],
      [false, true],
    ]);
    expect(isLocalYouTubePaused()).toBe(true);
  });

  it('a lock-screen PAUSE publishes the intent and retires the same retry', async () => {
    installProListener();
    const calls = scriptReconciliation([false, false, false, true]);

    bus.emit('playback:local-output-rejoin', { reason: 'media-session-play', mode: 'youtube' });
    await vi.advanceTimersByTimeAsync(2_000);
    const pauseIntent = vi.fn();
    bus.on('youtube:set-local-paused', pauseIntent);
    mediaHandlers.get('pause')!({ action: 'pause' });
    expect(pauseIntent).toHaveBeenCalledWith(true);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls.map((call) => call.atMs)).toEqual([0, 250, 1_000]);
  });

  it('an automatic trigger retry is declined by the local pause bit the iframe PAUSE wrote', async () => {
    const player = installProListener();
    const calls = scriptReconciliation([false, false, false, true]);

    // Automatic triggers align only a playing room whose output is not paused.
    bus.emit('playback:local-output-rejoin', {
      reason: 'audio-context-recovered',
      mode: 'youtube',
    });
    await vi.advanceTimersByTimeAsync(2_000);
    pressVisibleIframePause(player);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(calls.map((call) => call.atMs)).toEqual([0, 250, 1_000]);
    expect(isLocalYouTubePaused()).toBe(true);
  });
});

describe('P4-D8 (a): lock-screen PLAY, then unlock within 3 s', () => {
  it.each([
    { unlockAfterMs: 500, alignments: [0], gaveUp: true },
    { unlockAfterMs: 1_200, alignments: [0], gaveUp: true },
    { unlockAfterMs: 1_300, alignments: [0, RENDEZVOUS_COOLDOWN_MS + 10], gaveUp: false },
    { unlockAfterMs: 2_900, alignments: [0, RENDEZVOUS_COOLDOWN_MS + 10], gaveUp: false },
  ])(
    'expected today: unlocking $unlockAfterMs ms after the PLAY aligns at $alignments ms',
    async ({ unlockAfterMs, alignments, gaveUp }) => {
      const player = installStandardGuest({ iframeState: 2, locallyPaused: true });
      await stayLocked(21_000);
      heartbeat();
      const playAt = Date.now();

      // The OS PLAY aligns at once through the router, while still locked.
      mediaHandlers.get('play')!({ action: 'play' });
      expect(rendezvousStartedAt).toEqual([playAt]);

      await vi.advanceTimersByTimeAsync(unlockAfterMs);
      await unlock();
      for (let beats = 0; beats < 4; beats += 1) {
        await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
        heartbeat();
      }

      // The return runs its own rendezvous chain on every return. The
      // router's rendezvous stays in progress for about 2.3 s (1.5 s margin,
      // then 0.8 s calibration). Unlocked less than about 1.3 s after the
      // PLAY, the chain spends its five 250 ms polls on it and gives up.
      // Unlocked later, a poll meets the 3 s cooldown instead, waits it out,
      // and pauses, seeks and plays the iframe a second time.
      expect(rendezvousStartedAt.map((at) => at - playAt)).toEqual(alignments);
      expect(returnChainGaveUp()).toBe(gaveUp);
      expect(mutationOps(player).filter((op) => op === 'pauseVideo')).toHaveLength(
        alignments.length,
      );
      expect(isLocalYouTubePaused()).toBe(false);
      expect(player.__state).toBe(1);
    },
  );
});

describe('P4-D8 (b): the host is BUFFERING, CUED or on another video when the guest acts', () => {
  async function returnWhileHost(
    player: GuestIframe,
    frame: Record<string, unknown>,
  ): Promise<number> {
    await stayLocked(21_000);
    heartbeat(frame);
    await vi.advanceTimersByTimeAsync(100);
    player.__log.length = 0;
    const returnedAt = Date.now();
    await unlock();
    return returnedAt;
  }

  /** Host heartbeats every 3 s, the first one now; returns the fake times they went out. */
  async function heartbeatsEvery3s(beats: number, frame: Record<string, unknown> = {}) {
    const sentAt: number[] = [];
    for (let beat = 0; beat < beats; beat += 1) {
      sentAt.push(Date.now());
      heartbeat(frame);
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    }
    return sentAt;
  }

  /** Guest position minus the host's timeline position, in ms. */
  function guestOffsetMs(player: GuestIframe): number {
    const hostPosition = 100 + (Date.now() - hostTimelineOrigin) / 1000;
    return Math.round((player.getCurrentTime() - hostPosition) * 1000);
  }

  /**
   * The host iframe's own BUFFERING or CUED -> PLAYING change. A Standard
   * host broadcasts it as raw feedback, a YOUTUBE_STATE without hostPlayAt
   * (youtube/iframe.ts onStateChange). It skips it in a PRO room, while its
   * own scheduled sync or zero-start protocol is in flight, and for a repeat
   * of the same state within 300 ms. The heartbeat-only cases below stand for
   * a skipped or lost frame.
   */
  function hostResumeStateFrame(): void {
    hostFrame(MSG.YOUTUBE_STATE, {
      state: 1,
      time: 100 + (Date.now() - hostTimelineOrigin) / 1000,
    });
  }

  /** The iframe's pause, seek and play calls, each with its time after the return. */
  function alignmentOps(player: GuestIframe, returnedAt: number): string[] {
    return player.__log
      .filter(({ op }) => op === 'pauseVideo' || op === 'seekTo' || op === 'playVideo')
      .map(({ op, at }) => `${op}@${at - returnedAt}`);
  }

  it.each([
    ['BUFFERING', 3],
    ['CUED', 5],
  ] as const)(
    'expected today: the return chain stops 1,250 ms after a return while the host is %s and nothing retries it',
    async (_name, hostState) => {
      const player = installStandardGuest({ iframeState: 1, locallyPaused: false });
      const returnedAt = await returnWhileHost(player, { state: hostState });

      await vi.advanceTimersByTimeAsync(RETURN_GIVE_UP_MS - 1);
      expect(returnChainGaveUp()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(vi.mocked(log.info)).toHaveBeenCalledWith(
        '[BackgroundReturnSync] Guest rendezvous retries exhausted',
        { status: 'busy' },
      );
      expect(getManagedTimer('background-return-sync-rendezvous-retry')).toBeNull();

      // The host plays again at 2 s. The chain does not come back for it.
      // Heartbeats only here: this guest is still on the host timeline (the
      // heartbeat drift seeks while locked kept it there), so no heartbeat
      // correction fires either. The cases below add a residual offset, with
      // and without the host's own resume state frame.
      await vi.advanceTimersByTimeAsync(2_000 - RETURN_GIVE_UP_MS);
      await heartbeatsEvery3s(3);
      expect(Date.now() - returnedAt).toBe(11_000);
      expect(rendezvousStartedAt).toEqual([]);
      expect(alignmentOps(player, returnedAt)).toEqual([]);
      expect(guestOffsetMs(player)).toBe(0);
      expect(
        infoMessages().filter(
          (message) => message === '[BackgroundReturnSync] Guest rendezvous retries exhausted',
        ),
      ).toHaveLength(1);
    },
  );

  it.each([
    { host: 'BUFFERING', state: 3, stallMs: 100 },
    { host: 'BUFFERING', state: 3, stallMs: 1_000 },
    { host: 'CUED', state: 5, stallMs: 1_000 },
    { host: 'BUFFERING', state: 3, stallMs: 4_000 },
  ])(
    'expected today: after the give-up, the host resume state frame re-aligns a $stallMs ms $host stall at once',
    async ({ state, stallMs }) => {
      const player = installStandardGuest({ iframeState: 1, locallyPaused: false });
      const returnedAt = await returnWhileHost(player, { state });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(returnChainGaveUp()).toBe(true);

      hostTimelineOrigin += stallMs;
      expect(guestOffsetMs(player)).toBe(stallMs);
      // The host plays again at 2 s; its iframe's PLAYING goes out first.
      hostResumeStateFrame();
      await heartbeatsEvery3s(1);
      // Whatever the residual, the frame paused, sought and played the guest
      // at once. The play waits the 150 ms seek-play gap, so the guest trails
      // by that much, and the 3 s cooldown after it drops the 2 s heartbeat.
      expect(guestOffsetMs(player)).toBe(-150);
      await heartbeatsEvery3s(3);

      // The heartbeats at 5 s and 8 s confirm the lag and admit the automatic
      // precision rendezvous, 6 s after the resume; it plays at its 1.5 s margin.
      expect(alignmentOps(player, returnedAt)).toEqual([
        'pauseVideo@2000',
        'seekTo@2000',
        'playVideo@2150',
        'pauseVideo@8000',
        'seekTo@8000',
        'playVideo@9500',
      ]);
      expect(rendezvousStartedAt.map((at) => at - returnedAt)).toEqual([8_000]);
      expect(guestOffsetMs(player)).toBe(0);
    },
  );

  // When the host's resume state frame is lost or suppressed, only the
  // heartbeat backstops remain: the drift seek above 3 s, and the automatic
  // precision rendezvous from 150 ms to 3 s (two confirming heartbeats, at
  // most 3 per occurrence, a 30 s cooldown). That rendezvous also needs an
  // eligible clock with the drift above twice its uncertainty, runway (past
  // 1 s, more than 5 s left) and a Standard room; this harness's clock is
  // eligible at 5 ms, so those gates pass here. The times are heartbeat-only:
  // a raw host state frame (the host's stall-start BUFFERING among them)
  // suppresses drift correction for the next 3 s, which moves a correction to
  // a later heartbeat.
  it.each([
    // Below the 150 ms automatic trigger: no heartbeat correction acts on it.
    { host: 'BUFFERING', state: 3, stallMs: 100, ops: [], rendezvous: [], offsetMs: 100 },
    // 150 ms to 3 s: two confirming PLAYING heartbeats (2 s, 5 s) admit the
    // automatic precision rendezvous; it plays at its 1.5 s margin.
    {
      host: 'BUFFERING',
      state: 3,
      stallMs: 1_000,
      ops: ['pauseVideo@5000', 'seekTo@5000', 'playVideo@6500'],
      rendezvous: [5_000],
      offsetMs: 0,
    },
    {
      host: 'CUED',
      state: 5,
      stallMs: 1_000,
      ops: ['pauseVideo@5000', 'seekTo@5000', 'playVideo@6500'],
      rendezvous: [5_000],
      offsetMs: 0,
    },
    // Above 3 s: the first PLAYING heartbeat's drift seek.
    {
      host: 'BUFFERING',
      state: 3,
      stallMs: 4_000,
      ops: ['seekTo@2000'],
      rendezvous: [],
      offsetMs: 0,
    },
  ])(
    'expected today: without the host resume state frame, the heartbeat backstops act on a $stallMs ms $host stall',
    async ({ state, stallMs, ops, rendezvous, offsetMs }) => {
      const player = installStandardGuest({ iframeState: 1, locallyPaused: false });
      const returnedAt = await returnWhileHost(player, { state });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(returnChainGaveUp()).toBe(true);

      // The host's timeline stood still for the stall while this guest kept
      // playing, so the guest is that far ahead when the host plays again.
      hostTimelineOrigin += stallMs;
      expect(guestOffsetMs(player)).toBe(stallMs);
      await heartbeatsEvery3s(4);

      expect(alignmentOps(player, returnedAt)).toEqual(ops);
      expect(rendezvousStartedAt.map((at) => at - returnedAt)).toEqual(rendezvous);
      expect(guestOffsetMs(player)).toBe(offsetMs);
    },
  );

  it('expected today: a return gives up the same way while the iframe still reports the previous video', async () => {
    const player = installStandardGuest({
      iframeState: 1,
      locallyPaused: false,
      loadReportsVideoAfterMs: 2_000,
    });
    // The heartbeat naming the next video also starts loading it (the
    // heartbeat's own mismatch branch); the iframe reports it after 2 s.
    const returnedAt = await returnWhileHost(player, { state: 1, videoId: NEXT_VIDEO_ID });

    await vi.advanceTimersByTimeAsync(RETURN_GIVE_UP_MS);
    expect(returnChainGaveUp()).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(player.getVideoData().video_id).toBe(NEXT_VIDEO_ID);
    // The load left the guest 2 s behind. The chain does not come back for
    // it; the heartbeats do. The load's 5 s drift suppression drops the one
    // at 3.25 s, and those at 6.25 s and 9.25 s confirm the drift and admit
    // the automatic precision rendezvous. Heartbeats only: the host's own
    // track-change and resume state frames are not modelled here.
    expect(guestOffsetMs(player)).toBe(-2_000);
    await heartbeatsEvery3s(4, { videoId: NEXT_VIDEO_ID });
    expect(rendezvousStartedAt.map((at) => at - returnedAt)).toEqual([9_250]);
    expect(guestOffsetMs(player)).toBe(0);
  });

  it('aligns at once when the iframe already reports the host video at the return', async () => {
    const player = installStandardGuest({ iframeState: 1, locallyPaused: false });
    const returnedAt = await returnWhileHost(player, { state: 1, videoId: NEXT_VIDEO_ID });

    expect(rendezvousStartedAt).toEqual([returnedAt]);
    expect(returnChainGaveUp()).toBe(false);
  });

  it.each([
    ['BUFFERING', 3],
    ['CUED', 5],
  ] as const)(
    'by contrast an OS PLAY waits for host frames without a deadline while the host is %s',
    async (_name, hostState) => {
      installStandardGuest({ iframeState: 2, locallyPaused: true });
      await stayLocked(21_000);
      heartbeat({ state: hostState });
      const playAt = Date.now();
      mediaHandlers.get('play')!({ action: 'play' });

      await vi.advanceTimersByTimeAsync(8_000);
      heartbeat({ state: hostState });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(rendezvousStartedAt).toEqual([]);
      heartbeat();
      await vi.advanceTimersByTimeAsync(1_000);

      // The router retries 10 ms after each host frame and aligns once one
      // reports PLAYING, here 10 s after the PLAY.
      expect(rendezvousStartedAt.map((at) => at - playAt)).toEqual([10_010]);
      expect(isLocalYouTubePaused()).toBe(false);
    },
  );
});
