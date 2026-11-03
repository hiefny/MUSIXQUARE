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
 * decision P4-D8 A (2026-10-24) kept unchanged. They pass on today's code on
 * purpose. A later decision that changes one of these behaviours updates the
 * test in the same change. The P4-D7 cases began that way under P4-D7 A; the
 * owner's 2026-10-25 decision P4-D7 B changed that behaviour, and they now
 * state the fixed one.
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
const platform = vi.hoisted(() => ({ ios: false }));

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../i18n/index.ts', () => ({ t: (key: string) => key }));
// Only WebKit on iPhone and iPad stops a hidden iframe; the iOS rows say so.
vi.mock('../../core/platform.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/platform.ts')>()),
  get IS_IOS() {
    return platform.ios;
  },
}));
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
import {
  DEFAULT_RECOVER_THRESHOLD_MS,
  initBackgroundResumeGuard,
} from '../../core/background-resume-guard.ts';
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
  getYtAutoplayIntent,
  isLocalYouTubePaused,
  markYtPlayerReady,
  resetYouTubeModuleState,
  setLocalYouTubePaused,
  setYouTubePlayer,
  setYtAutoplayIntent,
  type YouTubePlayerInstance,
} from '../../youtube/_state.ts';
import {
  HEARTBEAT_INTERVAL_MS,
  LOCAL_OUTPUT_REALIGN_RETRY_MS,
  RENDEZVOUS_CALIBRATE_DELAY_MS,
  RENDEZVOUS_COOLDOWN_MS,
  RENDEZVOUS_MARGIN_SEC,
  STANDARD_AUTO_REALIGN_DRIFT_THRESHOLD_MS,
} from '../../youtube/constants.ts';
import { guestRendezvousSync, initYouTubeSync, resetYouTubeSyncState } from '../../youtube/sync.ts';
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
/** The rejoin router's retry timer key (local-output-rejoin.ts). */
const REJOIN_RETRY_TIMER = 'local-output-rejoin-retry';

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

/**
 * The iframe goes from playing to paused without an application command. While
 * visible, that is the participant pressing pause in the iframe's own controls.
 */
function pressVisibleIframePause(player: GuestIframe): void {
  player.__state = 2;
  setPlaybackYouTubePaused();
}

/**
 * The same unowned transition while the page is hidden: WebKit stops a hidden
 * iframe by itself, so it is not the participant's own pause.
 */
function browserStopsHiddenIframe(player: GuestIframe): void {
  expect(document.visibilityState).toBe('hidden');
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

  // P4-D7 B (owner decision 2026-10-25). Under P4-D7 A these two cases were
  // pinned as "expected today": the next retry released the visible PAUSE and
  // asked the PRO runtime to start the listener again, for up to 10.5 s.
  it('a visible iframe PAUSE ends the pending retry, so no later retry releases it', async () => {
    const player = installProListener();
    const pauseIntent = vi.fn();
    bus.on('youtube:set-local-paused', pauseIntent);
    // Three misses, then the runtime would have the canonical timeline again.
    const calls = scriptReconciliation([false, false, false, true]);

    // An OS PLAY reaches the router (the payload youtube/player.ts and the
    // iOS PRO tap gate emit). Its reconciliations miss at 0, 250 and 1,000 ms.
    bus.emit('playback:local-output-rejoin', { reason: 'media-session-play', mode: 'youtube' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls.map((call) => call.atMs)).toEqual([0, 250, 1_000]);
    expect(getManagedTimer(REJOIN_RETRY_TIMER)).not.toBeNull();

    // During the 1,500 ms wait the listener pauses in the visible iframe.
    pressVisibleIframePause(player);
    expect(infoMessages()).toContain('[YouTube Native Control] Applied endpoint-local pause');
    expect(isLocalYouTubePaused()).toBe(true);
    // PRO still publishes no pause intent: its handler would drop autoplay
    // intent and pause back the listener's next iframe PLAY.
    expect(pauseIntent).not.toHaveBeenCalled();
    expect(getYtAutoplayIntent()).toBe(true);
    // The pause ends the wait at once.
    expect(getManagedTimer(REJOIN_RETRY_TIMER)).toBeNull();

    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls).toHaveLength(3);
    expect(isLocalYouTubePaused()).toBe(true);
    expect(pauseIntent).not.toHaveBeenCalled();
  });

  it('a visible iframe PAUSE in a later wait ends the rest of the bounded schedule', async () => {
    const player = installProListener();
    const calls = scriptReconciliation([]);

    bus.emit('playback:local-output-rejoin', { reason: 'media-session-play', mode: 'youtube' });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(calls.map((call) => call.atMs)).toEqual([0, 250, 1_000, 2_500]);
    // The pause comes in the 3,000 ms wait before the retry at 5,500 ms.
    pressVisibleIframePause(player);
    await vi.advanceTimersByTimeAsync(20_000);

    // The schedule would have run to 10.5 s; it ends with the pause instead.
    expect(PRO_RETRY_WINDOW_MS).toBe(10_500);
    expect(calls.map((call) => call.atMs)).toEqual([0, 250, 1_000, 2_500]);
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

  it('while locked, a browser stop of the hidden iframe leaves the lock-screen PLAY retry running', async () => {
    const player = installProListener();
    const calls = scriptReconciliation([false, false, false, true]);
    setVisibility('hidden');

    // The lock-screen PLAY arrives while the page is hidden.
    bus.emit('playback:local-output-rejoin', { reason: 'media-session-play', mode: 'youtube' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls.map((call) => call.atMs)).toEqual([0, 250, 1_000]);

    // The same unowned PAUSE transition is recorded as a local pause only.
    browserStopsHiddenIframe(player);
    expect(infoMessages()).toContain('[YouTube Native Control] Applied endpoint-local pause');
    expect(isLocalYouTubePaused()).toBe(true);
    expect(getManagedTimer(REJOIN_RETRY_TIMER)).not.toBeNull();

    // The retry at 2,500 ms still releases the pause and reconciles; the
    // success keeps it released.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls).toHaveLength(4);
    expect(calls[3]).toEqual({ atMs: 2_500, localPaused: false, current: true });
    expect(isLocalYouTubePaused()).toBe(false);
  });

  it.each([
    // The visible PAUSE ends the wait itself.
    { visibility: 'visible', timerAfterPause: false },
    // A hidden stop leaves the wait; the retry declines on the pause bit.
    { visibility: 'hidden', timerAfterPause: true },
  ] as const)(
    'an automatic trigger retry does not release an iframe PAUSE ($visibility)',
    async ({ visibility, timerAfterPause }) => {
      const player = installProListener();
      const calls = scriptReconciliation([false, false, false, true]);
      setVisibility(visibility);

      // Automatic triggers align only a playing room whose output is not paused.
      bus.emit('playback:local-output-rejoin', {
        reason: 'audio-context-recovered',
        mode: 'youtube',
      });
      await vi.advanceTimersByTimeAsync(2_000);
      if (visibility === 'visible') pressVisibleIframePause(player);
      else browserStopsHiddenIframe(player);
      expect(getManagedTimer(REJOIN_RETRY_TIMER) !== null).toBe(timerAfterPause);
      await vi.advanceTimersByTimeAsync(15_000);

      expect(calls.map((call) => call.atMs)).toEqual([0, 250, 1_000]);
      expect(isLocalYouTubePaused()).toBe(true);
    },
  );
});

describe('P4-D7 guard: a Standard guest keeps the 9.0.1 rule', () => {
  it('a visible iframe PAUSE publishes the pause intent and ends an OS-PLAY rejoin waiting for the host', async () => {
    const player = installStandardGuest({ iframeState: 1, locallyPaused: false });
    // The host is BUFFERING, so the router's rendezvous is busy until the
    // host's next frame.
    heartbeat({ state: 3 });
    await vi.advanceTimersByTimeAsync(100);
    const pauseIntent = vi.fn();
    bus.on('youtube:set-local-paused', pauseIntent);

    bus.emit('playback:local-output-rejoin', { reason: 'media-session-play', mode: 'youtube' });
    await vi.advanceTimersByTimeAsync(100);
    expect(rendezvousStartedAt).toEqual([]);

    pressVisibleIframePause(player);
    expect(infoMessages()).toContain('[YouTube Native Control] Applied endpoint-local pause');
    expect(pauseIntent).toHaveBeenCalledExactlyOnceWith(true);
    expect(isLocalYouTubePaused()).toBe(true);

    // The host plays again. Without the pause, the router would align 10 ms
    // after this frame.
    heartbeat();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(rendezvousStartedAt).toEqual([]);
    expect(isLocalYouTubePaused()).toBe(true);
    expect(pauseIntent).toHaveBeenCalledOnce();
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

/**
 * iOS: a Standard guest returns at the moment WebKit stops its hidden iframe.
 *
 * Device report (2026-11-03): in a Standard room playing YouTube, WebKit
 * stops an iPhone guest's iframe when the page goes to the home screen or the
 * screen turns off, and the return re-aligns the guest by itself. Reopened at
 * the very moment of that stop, the guest stays paused until the participant
 * taps PLAY in the iframe or presses Sync.
 *
 * Each row: the room plays and the guest plays in step with the host, whose
 * heartbeats keep coming every HEARTBEAT_INTERVAL_MS. The page is hidden,
 * WebKit stops the iframe 100 ms before the page is visible again, and the app
 * processes the iframe's PAUSED callback before the visible event (while
 * hidden), in the same task right after it ('at'), or 100 ms after it. The
 * participant does nothing after the return. Expected for every row, as for a
 * normal return: the guest plays again within two heartbeats of the return and
 * ends in step with the host.
 *
 * Tests first. Before the fix the guest stayed paused in the four rows the
 * comments below say so for. Two gaps met there:
 * - The background resume guard runs no recovery for a hidden period under
 *   DEFAULT_RECOVER_THRESHOLD_MS (1 s), so a sub-second return ran no return
 *   Sync at all.
 * - The native-control route took any unowned iframe PAUSE for the
 *   participant's own pause and set the local pause bit, which turns off the
 *   heartbeat's play correction. Its only test for a browser stop was the page
 *   visibility when the PAUSED callback is processed: processed while hidden,
 *   the stop set the bit silently; processed after the visible event, it also
 *   published the pause intent, which ends a return chain that is waiting out
 *   the rendezvous cooldown.
 * With at least 1 s hidden and nothing waiting, the return's own rendezvous
 * owns the iframe and plays it past the bit: the normal return of the report.
 *
 * Only WebKit on iPhone and iPad stops a hidden iframe, so these rows run as
 * an iPhone. The rows after them pin what the fix must not change on a
 * computer or Android phone, and a pause the participant taps after the return.
 */
describe('iOS: return at the moment WebKit stops the hidden iframe', () => {
  /** WebKit stops the hidden iframe this long before the page is visible again. */
  const STOP_BEFORE_VISIBLE_MS = 100;
  /** The 'after' rows process the PAUSED callback this long after the visible event. */
  const PAUSED_AFTER_VISIBLE_MS = 100;
  /** The guest plays again within two host heartbeats of the return. */
  const RESUME_DEADLINE_MS = 2 * HEARTBEAT_INTERVAL_MS;
  /** The rows watch the guest this long after the return. */
  const WATCH_MS = 4 * HEARTBEAT_INTERVAL_MS;
  /** In step: under the drift at which the heartbeat's own realign begins. */
  const IN_STEP_MS = STANDARD_AUTO_REALIGN_DRIFT_THRESHOLD_MS;
  /** A Sync rendezvous owns the iframe this long after it starts: its play margin and calibration. */
  const RENDEZVOUS_OWNED_MS = RENDEZVOUS_MARGIN_SEC * 1000 + RENDEZVOUS_CALIBRATE_DELAY_MS;

  type PausedProcessed = 'before' | 'at' | 'after';
  interface ReturnRow {
    label: string;
    hiddenMs: number;
    /** When the app processes the PAUSED of WebKit's stop; null: no stop (control). */
    paused: PausedProcessed | null;
    /** The participant pressed Sync this long before hiding the page. */
    syncPressedBeforeHideMs?: number;
  }

  let hostHeartbeats: ReturnType<typeof setInterval> | null = null;

  beforeEach(() => {
    platform.ios = true;
  });

  afterEach(() => {
    if (hostHeartbeats !== null) clearInterval(hostHeartbeats);
    hostHeartbeats = null;
    platform.ios = false;
    document.getElementById('youtube-player-container')?.remove();
  });

  /**
   * youtube/iframe.ts projects the iframe's PLAYING and PAUSED callbacks into
   * playback activity. The real IFrame API delivers them over postMessage, so
   * here they arrive 30 ms after the call that caused them.
   */
  function projectIframeCallbacks(player: GuestIframe): void {
    player.__stateNotifyDelayMs = 30;
    player.__onStateChange = (event) => {
      if (event.data === 1) setPlaybackYouTubePlaying();
      else if (event.data === 2) setPlaybackYouTubePaused();
    };
  }

  /** Guest position minus the host's timeline position, in ms. */
  function guestOffsetMs(player: GuestIframe): number {
    const hostPosition = 100 + (Date.now() - hostTimelineOrigin) / 1000;
    return Math.round((player.getCurrentTime() - hostPosition) * 1000);
  }

  /** The host plays from now on and sends a heartbeat now and every heartbeat interval. */
  function hostPlaysWithGuestInStep(player: GuestIframe): void {
    hostTimelineOrigin = Date.now();
    player.seekTo(100);
    player.__log.length = 0;
    heartbeat();
    hostHeartbeats = setInterval(() => heartbeat(), HEARTBEAT_INTERVAL_MS);
  }

  /** WebKit stops the hidden iframe; the app has not processed its PAUSED yet. */
  function webKitStopsHiddenIframe(player: GuestIframe): void {
    expect(document.visibilityState).toBe('hidden');
    player.__setState(2, false);
  }

  /** youtube/iframe.ts processes the PAUSED callback of that stop. */
  function processStopPaused(): void {
    setPlaybackYouTubePaused();
  }

  /** The participant clicks or taps into the YouTube iframe: focus moves into it. */
  function focusIframe(): void {
    let container = document.getElementById('youtube-player-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'youtube-player-container';
      container.append(document.createElement('iframe'));
      document.body.append(container);
    }
    container.querySelector('iframe')!.focus();
    window.dispatchEvent(new Event('blur'));
  }

  /** A guest in step with the playing host, after the row's optional Sync press. */
  async function guestInStep(syncPressedBeforeHideMs?: number): Promise<GuestIframe> {
    const player = installStandardGuest({ iframeState: 1, locallyPaused: false });
    projectIframeCallbacks(player);
    hostPlaysWithGuestInStep(player);
    await vi.advanceTimersByTimeAsync(2_000);
    if (syncPressedBeforeHideMs !== undefined) {
      // The Sync button (ui/manual-sync-overlay-runtime.ts): a rendezvous
      // that plays at its 1.5 s margin and then calibrates for 0.8 s.
      guestRendezvousSync();
      await vi.advanceTimersByTimeAsync(syncPressedBeforeHideMs);
      expect(rendezvousStartedAt).toHaveLength(1);
    }
    expect(player.__state).toBe(1);
    expect(Math.abs(guestOffsetMs(player))).toBeLessThan(IN_STEP_MS);
    return player;
  }

  /** Watch the guest for WATCH_MS after `returnedAt`; when did it play again? */
  async function watchAfterReturn(player: GuestIframe, returnedAt: number) {
    let resumedAfterMs: number | null = null;
    while (Date.now() - returnedAt < WATCH_MS) {
      await vi.advanceTimersByTimeAsync(100);
      if (resumedAfterMs === null && player.__state === 1) {
        resumedAfterMs = Date.now() - returnedAt;
      }
    }
    return {
      iframeState: player.__state,
      resumedAfterMs,
      offsetMs: guestOffsetMs(player),
      localPaused: isLocalYouTubePaused(),
    };
  }

  async function returnAroundTheStop(row: ReturnRow) {
    const player = await guestInStep(row.syncPressedBeforeHideMs);
    const rendezvousBeforeReturn = rendezvousStartedAt.length;

    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(row.hiddenMs - STOP_BEFORE_VISIBLE_MS);
    if (row.paused !== null) webKitStopsHiddenIframe(player);
    if (row.paused === 'before') processStopPaused();
    await vi.advanceTimersByTimeAsync(STOP_BEFORE_VISIBLE_MS);
    const returnedAt = Date.now();
    setVisibility('visible');
    if (row.paused === 'at') processStopPaused();
    if (row.paused === 'after') {
      await vi.advanceTimersByTimeAsync(PAUSED_AFTER_VISIBLE_MS);
      processStopPaused();
    }

    const outcome = await watchAfterReturn(player, returnedAt);
    return { ...outcome, returnRendezvous: rendezvousStartedAt.length - rendezvousBeforeReturn };
  }

  function expectPlaysInStep(outcome: Awaited<ReturnType<typeof watchAfterReturn>>): void {
    const seen = JSON.stringify(outcome);
    expect(outcome.iframeState, `iframe state after the return, ${seen}`).toBe(1);
    expect(outcome.resumedAfterMs, `ms from the return until it plays, ${seen}`).not.toBeNull();
    expect(outcome.resumedAfterMs!).toBeLessThanOrEqual(RESUME_DEADLINE_MS);
    expect(Math.abs(outcome.offsetMs), `offset from the host in ms, ${seen}`).toBeLessThan(
      IN_STEP_MS,
    );
  }

  function returnChainsStarted(): number {
    return infoMessages().filter((message) =>
      message.startsWith('[BackgroundReturnSync] guest-youtube-rendezvous'),
    ).length;
  }

  const SUB_SECOND_MS = DEFAULT_RECOVER_THRESHOLD_MS - 200;
  const RETURN_MS = DEFAULT_RECOVER_THRESHOLD_MS + 500;
  const AFTER_SYNC_MS = DEFAULT_RECOVER_THRESHOLD_MS + 100;
  const SYNC_BEFORE_HIDE_MS = 1_600;
  const when: Record<PausedProcessed, string> = {
    before: 'before the visible event',
    at: 'at the visible event',
    after: `${PAUSED_AFTER_VISIBLE_MS} ms after the visible event`,
  };

  const rows: readonly ReturnRow[] = [
    // Control: a sub-second bounce without a stop never left the host.
    {
      label: `hidden ${SUB_SECOND_MS} ms, no stop (control)`,
      hiddenMs: SUB_SECOND_MS,
      paused: null,
    },
    // Stayed paused before the fix: no return Sync below 1 s, and the stop
    // was recorded as the participant's own pause.
    ...(['before', 'at', 'after'] as const).map((paused) => ({
      label: `hidden ${SUB_SECOND_MS} ms, PAUSED processed ${when[paused]}`,
      hiddenMs: SUB_SECOND_MS,
      paused,
    })),
    // The normal return, which recovered before the fix too: the return
    // rendezvous re-aligns the guest.
    ...(['before', 'at', 'after'] as const).map((paused) => ({
      label: `hidden ${RETURN_MS} ms, PAUSED processed ${when[paused]}`,
      hiddenMs: RETURN_MS,
      paused,
    })),
    // The participant pressed Sync, went home right after its play and came
    // back 1.1 s later, inside the rendezvous' 3 s cooldown but after its
    // owned 2.3 s: the return chain waits out the cooldown, unowned. Before
    // and at the visible event it recovered before the fix; 100 ms after it,
    // the stop counted as the participant's pause, ended the waiting chain
    // and stayed paused.
    ...(['before', 'at', 'after'] as const).map((paused) => ({
      label:
        `Sync pressed ${SYNC_BEFORE_HIDE_MS} ms before hiding, hidden ${AFTER_SYNC_MS} ms, ` +
        `PAUSED processed ${when[paused]}`,
      hiddenMs: AFTER_SYNC_MS,
      paused,
      syncPressedBeforeHideMs: SYNC_BEFORE_HIDE_MS,
    })),
  ];

  it('returns the Sync rows after the Sync rendezvous owns the iframe and inside its cooldown', () => {
    // Measured from the Sync press; the rows above depend on this ordering.
    const returnAfterSyncMs = SYNC_BEFORE_HIDE_MS + AFTER_SYNC_MS;
    expect(returnAfterSyncMs).toBeGreaterThan(RENDEZVOUS_OWNED_MS);
    expect(returnAfterSyncMs).toBeLessThan(RENDEZVOUS_COOLDOWN_MS);
  });

  for (const row of rows) {
    it(`${row.label}: the guest plays in step without a tap`, async () => {
      expectPlaysInStep(await returnAroundTheStop(row));
    });
  }

  it.each([
    { label: 'one below', hiddenMs: DEFAULT_RECOVER_THRESHOLD_MS - 1 },
    { label: 'exactly at', hiddenMs: DEFAULT_RECOVER_THRESHOLD_MS },
  ])(
    'a stop processed at the return $label the guard threshold starts exactly one return chain',
    async ({ hiddenMs }) => {
      // The guard measures the hidden period once; the bounce chain and the
      // return Sync read that one classification, so a return never runs
      // both or neither.
      const player = await guestInStep();
      setVisibility('hidden');
      await vi.advanceTimersByTimeAsync(hiddenMs - STOP_BEFORE_VISIBLE_MS);
      webKitStopsHiddenIframe(player);
      await vi.advanceTimersByTimeAsync(STOP_BEFORE_VISIBLE_MS);
      const returnedAt = Date.now();
      setVisibility('visible');
      processStopPaused();

      const outcome = await watchAfterReturn(player, returnedAt);
      expect(returnChainsStarted()).toBe(1);
      expectPlaysInStep(outcome);
    },
  );

  it('two quick trips home, the second while the first return rendezvous owns the iframe: the guest plays in step', async () => {
    const player = await guestInStep();
    // First trip: WebKit stops the iframe while hidden.
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(SUB_SECOND_MS - STOP_BEFORE_VISIBLE_MS);
    webKitStopsHiddenIframe(player);
    processStopPaused();
    await vi.advanceTimersByTimeAsync(STOP_BEFORE_VISIBLE_MS);
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(DEFAULT_RECOVER_THRESHOLD_MS);
    // Second trip, 1 s later: the return rendezvous plays at its margin while
    // the page is hidden, and WebKit stops the iframe again inside the
    // rendezvous' owned window, so the route never sees that PAUSE.
    const rendezvousBeforeSecondTrip = rendezvousStartedAt.length;
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(SUB_SECOND_MS - STOP_BEFORE_VISIBLE_MS);
    webKitStopsHiddenIframe(player);
    processStopPaused();
    await vi.advanceTimersByTimeAsync(STOP_BEFORE_VISIBLE_MS);
    expect(rendezvousStartedAt.length).toBe(rendezvousBeforeSecondTrip);
    const returnedAt = Date.now();
    setVisibility('visible');

    // The bit went back down at the first return, so the heartbeat's play
    // correction resumes the guest.
    const outcome = await watchAfterReturn(player, returnedAt);
    expectPlaysInStep(outcome);
  });

  describe('a pause the participant taps after the return', () => {
    /** The guest taps pause in the iframe this long after the return. */
    const TAP_AFTER_RETURN_MS = 500;
    const COOLDOWN_TAP_AFTER_RETURN_MS = 300;

    interface TapRow {
      label: string;
      ios: boolean;
      /** The tap moved focus into the iframe before the PAUSE. */
      focused: boolean;
      hiddenMs: number;
      tapAfterReturnMs: number;
      syncPressedBeforeHideMs?: number;
      /** Expected: the pause holds. */
      holds: boolean;
    }

    async function tapPauseAfterReturn(row: TapRow) {
      platform.ios = row.ios;
      const player = await guestInStep(row.syncPressedBeforeHideMs);
      const rendezvousBeforeReturn = rendezvousStartedAt.length;
      const pauseIntent = vi.fn();
      bus.on('youtube:set-local-paused', (paused) => {
        if (paused) pauseIntent();
      });

      // No browser stop: the iframe keeps playing while hidden.
      setVisibility('hidden');
      await vi.advanceTimersByTimeAsync(row.hiddenMs);
      const returnedAt = Date.now();
      setVisibility('visible');
      await vi.advanceTimersByTimeAsync(row.tapAfterReturnMs);
      if (row.focused) focusIframe();
      player.__setState(2, false);
      processStopPaused();

      const outcome = await watchAfterReturn(player, returnedAt);
      return {
        ...outcome,
        returnRendezvous: rendezvousStartedAt.length - rendezvousBeforeReturn,
        pauseIntents: pauseIntent.mock.calls.length,
      };
    }

    const tapRows: readonly TapRow[] = [
      ...([false, true] as const).flatMap((ios) => [
        {
          label: `on ${ios ? 'an iPhone, after a tap into the iframe' : 'a computer or Android phone'}, a sub-second bounce, pause tapped ${TAP_AFTER_RETURN_MS} ms after the return`,
          ios,
          focused: ios,
          hiddenMs: SUB_SECOND_MS,
          tapAfterReturnMs: TAP_AFTER_RETURN_MS,
          holds: true,
        },
        {
          label:
            `on ${ios ? 'an iPhone, after a tap into the iframe' : 'a computer or Android phone'}, Sync pressed ${SYNC_BEFORE_HIDE_MS} ms before hiding, ` +
            `hidden ${AFTER_SYNC_MS} ms, pause tapped ${COOLDOWN_TAP_AFTER_RETURN_MS} ms after the return`,
          ios,
          focused: ios,
          hiddenMs: AFTER_SYNC_MS,
          tapAfterReturnMs: COOLDOWN_TAP_AFTER_RETURN_MS,
          syncPressedBeforeHideMs: SYNC_BEFORE_HIDE_MS,
          holds: true,
        },
      ]),
      // The trade-off put to the owner: on an iPhone a pause inside the grace
      // that moved no focus into the iframe is taken for the browser's stop,
      // and the return aligns over it.
      {
        label: `on an iPhone, without focus moving into the iframe, a sub-second bounce, pause ${TAP_AFTER_RETURN_MS} ms after the return (the trade-off)`,
        ios: true,
        focused: false,
        hiddenMs: SUB_SECOND_MS,
        tapAfterReturnMs: TAP_AFTER_RETURN_MS,
        holds: false,
      },
    ];

    for (const row of tapRows) {
      it(`${row.label}: the pause ${row.holds ? 'holds' : 'is aligned over'}`, async () => {
        const outcome = await tapPauseAfterReturn(row);
        const seen = JSON.stringify(outcome);
        if (row.holds) {
          expect(outcome.iframeState, `iframe state after the return, ${seen}`).toBe(2);
          expect(outcome.localPaused, seen).toBe(true);
          expect(outcome.pauseIntents, seen).toBe(1);
          expect(outcome.returnRendezvous, seen).toBe(0);
        } else {
          expect(outcome.iframeState, `iframe state after the return, ${seen}`).toBe(1);
          expect(outcome.pauseIntents, seen).toBe(0);
        }
      });
    }
  });
});
