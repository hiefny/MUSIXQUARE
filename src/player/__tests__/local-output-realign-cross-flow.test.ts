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
import { clearAllManagedTimers } from '../../core/timers.ts';
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

  it.each([
    ['BUFFERING', 3],
    ['CUED', 5],
  ] as const)(
    'expected today: a return gives up 1,250 ms after it while the host is %s',
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

      // The host plays again at 2 s; nothing re-aligns this return any more.
      await vi.advanceTimersByTimeAsync(2_000 - RETURN_GIVE_UP_MS);
      heartbeat();
      await vi.advanceTimersByTimeAsync(8_000);
      expect(Date.now() - returnedAt).toBe(10_000);
      expect(rendezvousStartedAt).toEqual([]);
      expect(mutationOps(player).filter((op) => op === 'pauseVideo')).toEqual([]);
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
    await returnWhileHost(player, { state: 1, videoId: NEXT_VIDEO_ID });

    await vi.advanceTimersByTimeAsync(RETURN_GIVE_UP_MS);
    expect(returnChainGaveUp()).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(player.getVideoData().video_id).toBe(NEXT_VIDEO_ID);
    heartbeat({ videoId: NEXT_VIDEO_ID });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(rendezvousStartedAt).toEqual([]);
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
