/**
 * Standard-room YouTube start harness: one App device under test (host or
 * guest) on the real wiring, and one scripted remote participant.
 *
 * Factories only. This module declares no vi.mock and keeps no state between
 * rigs: the test file owns every module mock and its afterEach teardown.
 * A suite that uses a rig must
 * - mock network/peer.ts so broadcast, safeSend and sendToHost are vi.fn
 *   (a partial mock that keeps leaveSession real is fine), and pass them in;
 * - mock network/shared-clock.ts so getHostNow reads Date.now() and the
 *   calibration flag is the suite's (the rig reads the clock only through
 *   the App);
 * - keep network/protocol.ts, core/timers.ts, youtube/player.ts,
 *   youtube/iframe.ts, youtube/sync.ts and youtube/zero-start.ts real: the rig
 *   delivers every inbound frame through the real protocol dispatcher
 *   (network:data), as the transport does.
 *
 * The App device runs initPlayback, initYouTube, initYouTubeSync and
 * initProtocol, loads the video through youtube:load and the scripted IFrame
 * API, and completes the iframe handshake. That instant is the rig's t0: the
 * host heartbeat interval is armed then, so heartbeat phase is fixed relative
 * to every instant a row reads.
 *
 * The remote participant is the real zero-start controller
 * (YouTubeZeroStartControllerForTests) with its own fake iframe, so every
 * timing value on the wire comes from zero-start.ts itself and none is
 * retyped here. Frames cross the synthetic link one zero-delay task later in
 * each direction, never synchronously inside the sender.
 */
import { vi, type Mock } from 'vitest';
import { MSG } from '../../../core/constants.ts';
import { bus } from '../../../core/events.ts';
import { setState } from '../../../core/state.ts';
import { initProtocol, resetInboundRateLimit } from '../../../network/protocol.ts';
import { markQueueAuthorityReady } from '../../../network/queue-authority.ts';
import { initPlayback } from '../../../player/playback.ts';
import type { DataConnection, QueueItemId } from '../../../types/index.ts';
import { initYouTube } from '../../player.ts';
import { isYouTubeStartRecoveryActive, isYouTubeStartSyncOwned } from '../../start-ownership.ts';
import { initYouTubeSync } from '../../sync.ts';
import {
  getYouTubeZeroStartSnapshot,
  isYouTubeZeroStartInFlight,
  isYouTubeZeroStartProtocolActive,
  YouTubeZeroStartControllerForTests,
  type YouTubeZeroStartWireMessage,
} from '../../zero-start.ts';
import { makeFakeYtPlayer, type FakeYtPlayer } from './fake-yt-player.ts';
import {
  installScriptedIframeApi,
  type ScriptedIframeApi,
  type ScriptedIframeInit,
} from './scripted-iframe-api.ts';

// ─── Fake clock ────────────────────────────────────────────────────

/**
 * Returns a starter for each test's fake clock. performance.now() restarts at
 * 0 with every fake clock, but youtube/sync.ts keeps the instant of its last
 * manual broadcast, a performance.now() value, from one test to the next; a
 * heartbeat that lands within 500 ms of an earlier test's manual broadcast
 * would be dropped and rows would depend on test order. The starter installs
 * fake timers, moves performance.now() past every earlier test of the same
 * file (1,000 s per test, so the clock stays monotonic), and then fixes
 * Date.now() at systemTimeMs. Rows read only instants relative to their own t0.
 */
export function createFakeClockStarter(systemTimeMs: number): () => void {
  let origin = 0;
  return () => {
    vi.useFakeTimers();
    origin += 1_000_000;
    vi.advanceTimersByTime(origin);
    vi.setSystemTime(systemTimeMs);
  };
}

// ─── Sent-frame recorder ───────────────────────────────────────────

/** The network/peer.ts send functions a suite's mock exposes. */
export interface PeerSends {
  readonly broadcast: Mock;
  readonly safeSend: Mock;
  readonly sendToHost: Mock;
}

export interface SentFrame {
  /** The network/peer.ts function that sent it: broadcast, safeSend (peer) or sendToHost (host). */
  readonly via: 'broadcast' | 'peer' | 'host';
  /** Peer id of the receiving connection; null for a broadcast. */
  readonly to: string | null;
  readonly type: string;
  readonly frame: Readonly<Record<string, unknown>>;
  /** Milliseconds since the rig's t0 (fake time). */
  readonly at: number;
}

type FrameListener = (frame: SentFrame, conn: DataConnection | null) => void;

/**
 * Spy on the suite's network/peer.ts sends. Every call is recorded with its
 * instant relative to origin(); safeSend and sendToHost report success.
 */
export function recordSentFrames(
  sends: PeerSends,
  origin: () => number,
  getHostConn: () => DataConnection | null = () => null,
) {
  const frames: SentFrame[] = [];
  const listeners = new Set<FrameListener>();
  const push = (via: SentFrame['via'], conn: DataConnection | null, data: unknown) => {
    const frame = (data ?? {}) as Record<string, unknown>;
    const sent: SentFrame = {
      via,
      to: conn?.peer ?? null,
      type: String(frame.type),
      frame: structuredClone(frame),
      at: Date.now() - origin(),
    };
    frames.push(sent);
    for (const listener of listeners) listener(sent, conn);
  };
  sends.broadcast.mockImplementation((data: unknown) => push('broadcast', null, data));
  sends.safeSend.mockImplementation((conn: DataConnection | null, data: unknown) => {
    if (!conn?.open) return false;
    push('peer', conn, data);
    return true;
  });
  sends.sendToHost.mockImplementation((data: unknown) => {
    const conn = getHostConn();
    if (!conn?.open) return false;
    push('host', conn, data);
    return true;
  });
  return {
    frames,
    onSend(listener: FrameListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// ─── Projections ───────────────────────────────────────────────────

function formatArg(value: unknown): string {
  if (typeof value === 'number') return String(Math.round(value * 1_000) / 1_000);
  return String(value);
}

/**
 * The fake's call log as '+<ms since origin> <op>(<args>)' strings. Numbers
 * are rounded to the millisecond (positions to three decimals).
 */
export function opTrace(fake: FakeYtPlayer, origin: number, fromIndex = 0): string[] {
  return fake.__log
    .slice(fromIndex)
    .map(({ op, args, at }) => `+${at - origin} ${op}(${(args ?? []).map(formatArg).join(',')})`);
}

/** The ops only, in call order, from fromIndex. */
export function opNames(fake: FakeYtPlayer, fromIndex = 0): string[] {
  return fake.__log.slice(fromIndex).map(({ op }) => op);
}

/** Map every distinct zero-start runId to 'run-1', 'run-2', … in order of appearance. */
export function runIdAliases(frames: readonly SentFrame[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const { frame } of frames) {
    const runId = frame.runId;
    if (typeof runId === 'string' && !aliases.has(runId)) {
      aliases.set(runId, `run-${aliases.size + 1}`);
    }
  }
  return aliases;
}

/** '<via>:<to> <type>' for each frame, in order; zero-start frames only when zeroStartOnly. */
export function frameRoutes(frames: readonly SentFrame[], zeroStartOnly = false): string[] {
  return frames
    .filter(({ type }) => !zeroStartOnly || type.startsWith('youtube-zero-start-'))
    .map(({ via, to, type }) => `${via}:${to ?? '*'} ${type}`);
}

// ─── Synthetic connections ─────────────────────────────────────────

/** An open DataConnection to a synthetic peer id; send/close are spies. */
export function syntheticConnection(peer: string): DataConnection {
  return {
    open: true,
    peer,
    send: vi.fn(),
    close: vi.fn(),
    on: () => undefined,
  } as unknown as DataConnection;
}

// ─── Predicates ────────────────────────────────────────────────────

export interface StartPredicates {
  readonly syncOwned: boolean;
  readonly inFlight: boolean;
  readonly protocolActive: boolean;
  readonly externalFallbackActive: boolean;
}

/**
 * The four public start-ownership predicates, sampled now: the run's two
 * facades, and since Phase 6 6B-2 the start ledger's sync-owned and
 * recovery-active queries, which the readers ask.
 */
export function sampleStartPredicates(): StartPredicates {
  return {
    syncOwned: isYouTubeStartSyncOwned(),
    inFlight: isYouTubeZeroStartInFlight(),
    protocolActive: isYouTubeZeroStartProtocolActive(),
    externalFallbackActive: isYouTubeStartRecoveryActive(),
  };
}

/** Compact form of sampleStartPredicates for explicit expected arrays. */
export function predicateFlags(sample: StartPredicates = sampleStartPredicates()): string {
  return [
    sample.syncOwned ? 'owned' : '-',
    sample.inFlight ? 'inFlight' : '-',
    sample.protocolActive ? 'protocol' : '-',
    sample.externalFallbackActive ? 'fallback' : '-',
  ].join(' ');
}

// ─── The rig ───────────────────────────────────────────────────────

export interface StandardRigOptions {
  readonly role: 'host' | 'guest';
  readonly sends: PeerSends;
  /** A synthetic Standard room code; isActiveStandardRoomCoordinator needs /^[1-9]\d{5}$/. */
  readonly roomCode: string;
  readonly queueItemId: QueueItemId;
  readonly videoId: string;
  /** A second queue occurrence after the first (a next track the remote host can start). */
  readonly nextQueueItemId?: QueueItemId;
  readonly nextVideoId?: string;
  readonly hostPeerId: string;
  readonly guestPeerId: string;
  /** The App device's manual YouTube offset (sync.youtubeLocalOffset), seconds. */
  readonly localOffsetSeconds?: number;
  readonly masterVolume?: number;
  /** Init for each iframe the App creates (see scripted-iframe-api.ts). */
  readonly iframeInit?: ScriptedIframeInit;
  /** Fake init for the remote participant's iframe. */
  readonly remoteIframeInit?: Partial<FakeYtPlayer>;
  /** Advertise the remote guest's capability to an App host at setup (default true). */
  readonly remoteGuestAdvertises?: boolean;
}

export interface LoadingEvent {
  readonly busy: boolean;
  readonly owner: string | undefined;
  readonly at: number;
}

export interface StandardRig {
  readonly role: 'host' | 'guest';
  readonly localPeerId: string;
  readonly remotePeerId: string;
  /** The remote participant's connection as the App device holds it. */
  conn: DataConnection;
  readonly api: ScriptedIframeApi;
  /** Every frame the App sent from t0 on (frames before t0 are in preT0Sent). */
  readonly sent: SentFrame[];
  readonly preT0Sent: SentFrame[];
  /** youtube:sync-loading emissions from t0 on. */
  readonly loading: LoadingEvent[];
  /** The scripted remote participant (real zero-start controller). */
  readonly remote: YouTubeZeroStartControllerForTests;
  readonly remoteFake: FakeYtPlayer;
  /** Fake time of the App iframe's handshake; every recorded instant is relative to it. */
  readonly t0: number;
  /** The App iframe (the last one the scripted API built). */
  iframe(): FakeYtPlayer;
  /** Milliseconds since t0. */
  now(): number;
  /** Advance fake time to t0 + relativeMs in bounded steps (default 10 ms). */
  advanceTo(relativeMs: number, stepMs?: number): Promise<void>;
  /** Deliver a frame from the remote participant through the protocol dispatcher. */
  deliver(frame: Record<string, unknown>): void;
  /** Stop forwarding App frames to the remote participant and remote frames to the App. */
  cutLink(): void;
  /** Disposes listeners and the remote controller (call in afterEach or finally). */
  dispose(): void;
}

/**
 * Build the App device and its remote participant, load the occurrence, and
 * complete the App iframe's handshake at t0. On return the App host has the
 * remote guest's capability (unless remoteGuestAdvertises is false); an App
 * guest has advertised its own capability to the remote host.
 */
export async function setUpStandardRig(options: StandardRigOptions): Promise<StandardRig> {
  const isHost = options.role === 'host';
  const localPeerId = isHost ? options.hostPeerId : options.guestPeerId;
  const remotePeerId = isHost ? options.guestPeerId : options.hostPeerId;
  let t0 = Date.now();
  let linkOpen = true;
  const conn = syntheticConnection(remotePeerId);
  const rig = { conn } as { conn: DataConnection };

  setState('network.appRole', options.role);
  setState('network.myId', localPeerId);
  setState('network.sessionCode', options.roomCode);
  setState('setup.sessionStarted', true);
  setState('audio.masterVolume', options.masterVolume ?? 1);
  setState('playlist.items', [
    {
      queueItemId: options.queueItemId,
      type: 'youtube',
      name: 'Synthetic video',
      videoId: options.videoId,
      playlistId: null,
    },
    ...(options.nextQueueItemId && options.nextVideoId
      ? [
          {
            queueItemId: options.nextQueueItemId,
            type: 'youtube' as const,
            name: 'Synthetic next video',
            videoId: options.nextVideoId,
            playlistId: null,
          },
        ]
      : []),
  ]);
  if (isHost) {
    setState('network.activeHostConnByPeerId', new Map([[remotePeerId, conn]]));
  } else {
    setState('network.hostConn', conn);
    markQueueAuthorityReady(conn);
  }

  const recorder = recordSentFrames(
    options.sends,
    () => t0,
    () => (isHost ? null : rig.conn),
  );
  const loading: LoadingEvent[] = [];

  initPlayback();
  initYouTube();
  initYouTubeSync();
  initProtocol();
  // The dispatcher's per-peer inbound bucket is module state that refills on
  // Date.now(). Suites restart fake time at a fixed instant, so start every
  // rig with a full bucket for the synthetic remote peer.
  resetInboundRateLimit(remotePeerId);
  // The App's manual offset is a room-owner setting for a Standard host:
  // apply it after initYouTubeSync has reconciled the endpoint identity.
  setState('sync.youtubeLocalOffset', options.localOffsetSeconds ?? 0);

  const remoteFake = makeFakeYtPlayer({
    __videoId: options.videoId,
    __state: 5,
    __duration: 240,
    __advanceClock: true,
    __autoPlayOnLoad: true,
    ...options.remoteIframeInit,
  });

  const deliverToApp = (frame: Record<string, unknown>) => {
    bus.emit('network:data', frame, rig.conn);
  };
  const viaLink = (send: () => void): boolean => {
    if (!linkOpen) return false;
    setTimeout(() => {
      if (linkOpen) send();
    }, 0);
    return true;
  };

  const remote = new YouTubeZeroStartControllerForTests({
    getRole: () => (isHost ? 'guest' : 'host'),
    getLocalPeerId: () => remotePeerId,
    getHostPeerId: () => (isHost ? localPeerId : null),
    getLiveGuestPeerIds: () => (isHost ? [] : [localPeerId]),
    getPlayer: () => remoteFake,
    isPlayerReady: () => true,
    isAudioUnlocked: () => true,
    isClockCalibrated: () => true,
    getHostNow: () => Date.now(),
    getClockOffsetMs: () => 0,
    getLocalPlatform: () => 'other',
    getDesiredAudioState: () => ({ muted: false, volume: 100 }),
    sendToPeer: (_peerId: string, message: YouTubeZeroStartWireMessage) =>
      viaLink(() => deliverToApp(message as unknown as Record<string, unknown>)),
    sendToHost: (message: YouTubeZeroStartWireMessage) =>
      viaLink(() => deliverToApp(message as unknown as Record<string, unknown>)),
  });
  remoteFake.__onStateChange = ({ data }) => {
    remote.handlePlayerStateChange(data);
  };

  const unforward = recorder.onSend((sent, target) => {
    if (target !== rig.conn) return;
    const message = sent.frame as unknown as YouTubeZeroStartWireMessage;
    viaLink(() => {
      switch (message.type) {
        case MSG.YOUTUBE_ZERO_START_CAPABILITY:
          remote.handleCapability(localPeerId, message);
          break;
        case MSG.YOUTUBE_ZERO_START_PREPARE:
          remote.handlePrepare(localPeerId, message);
          break;
        case MSG.YOUTUBE_ZERO_START_ARMED:
          remote.handleArmed(localPeerId, message);
          break;
        case MSG.YOUTUBE_ZERO_START_COMMIT:
          remote.handleCommit(localPeerId, message);
          break;
        case MSG.YOUTUBE_ZERO_START_ABORT:
          remote.handleAbort(localPeerId, message);
          break;
        case MSG.YOUTUBE_ZERO_START_TIMELINE:
          remote.handleTimeline(localPeerId, message);
          break;
        default:
          break;
      }
    });
  });

  const api = installScriptedIframeApi(options.iframeInit ?? {});
  if (isHost && options.remoteGuestAdvertises !== false) {
    remote.advertiseCapability();
    await vi.advanceTimersByTimeAsync(0);
  }
  if (!isHost) bus.emit('network:peer-connected', conn);

  setState('playlist.currentQueueItemId', options.queueItemId);
  bus.emit('youtube:load', options.videoId, null, options.queueItemId, false, 0);
  const iframe = api.iframes.at(-1);
  if (!iframe) throw new Error('youtube:load built no scripted iframe');
  t0 = Date.now();
  iframe.ready();
  const preT0Sent = recorder.frames.splice(0);
  // Frames sent while the handshake completes belong to t0.
  const offLoading = bus.on('youtube:sync-loading', (busy: boolean, owner?: string) => {
    loading.push({ busy, owner, at: Date.now() - t0 });
  });
  await vi.advanceTimersByTimeAsync(0);

  return {
    role: options.role,
    localPeerId,
    remotePeerId,
    get conn() {
      return rig.conn;
    },
    set conn(next: DataConnection) {
      rig.conn = next;
    },
    api,
    sent: recorder.frames,
    preT0Sent,
    loading,
    remote,
    remoteFake,
    t0,
    iframe: () => {
      const last = api.iframes.at(-1);
      if (!last) throw new Error('no scripted iframe');
      return last.fake;
    },
    now: () => Date.now() - t0,
    async advanceTo(relativeMs: number, stepMs = 10) {
      while (Date.now() - t0 < relativeMs) {
        await vi.advanceTimersByTimeAsync(Math.min(stepMs, relativeMs - (Date.now() - t0)));
      }
    },
    deliver: deliverToApp,
    cutLink: () => {
      linkOpen = false;
    },
    dispose: () => {
      linkOpen = false;
      unforward();
      offLoading();
      remote.reset();
    },
  };
}

/** The App's zero-start phase now ('idle' when no controller exists). */
export function appZeroStartPhase(): string {
  return getYouTubeZeroStartSnapshot()?.phase ?? 'idle';
}

// ─── Named Standard scenario scripts ───────────────────────────────

/** One scripted action at an instant relative to the rig's t0. */
export interface ScenarioStep {
  readonly at: number;
  readonly run: (rig: StandardRig) => void;
}

export interface StandardScenario {
  readonly name: string;
  readonly role: 'host' | 'guest';
  /** Rig options the scenario needs beyond the suite's identity (fault knobs, offset). */
  readonly rig?: Partial<StandardRigOptions>;
  /** Optional setup once the rig is built, before the first step (for example a clock flag). */
  readonly prepare?: (rig: StandardRig) => void;
  readonly steps: readonly ScenarioStep[];
  /** The instant the script stops advancing, relative to t0. */
  readonly endAt: number;
}

/**
 * Run a scenario's steps at their instants, advancing in 10 ms steps, and
 * return '<ms> <phase> <predicate flags>' at t0 and at every change of the
 * App's zero-start phase or of the four predicates (sampled after each step).
 */
export async function runStandardScenario(
  rig: StandardRig,
  scenario: StandardScenario,
): Promise<string[]> {
  scenario.prepare?.(rig);
  const marks: string[] = [];
  const mark = () => {
    const state = `${appZeroStartPhase()} ${predicateFlags()}`;
    const last = marks.at(-1);
    if (!last || last.slice(last.indexOf(' ') + 1) !== state) marks.push(`${rig.now()} ${state}`);
  };
  mark();
  const steps = [...scenario.steps].sort((a, b) => a.at - b.at);
  let next = 0;
  while (rig.now() < scenario.endAt) {
    while (next < steps.length && steps[next]!.at <= rig.now()) {
      steps[next]!.run(rig);
      next += 1;
      mark();
    }
    const target = Math.min(
      scenario.endAt,
      next < steps.length ? steps[next]!.at : scenario.endAt,
      rig.now() + 10,
    );
    await vi.advanceTimersByTimeAsync(target - rig.now());
    mark();
  }
  while (next < steps.length && steps[next]!.at <= rig.now()) {
    steps[next]!.run(rig);
    next += 1;
    mark();
  }
  return marks;
}

/** The Standard host presses play at 0:00, the App's toggle-play path. */
function hostPressesPlay(at: number): ScenarioStep {
  return { at, run: () => bus.emit('youtube:toggle-play') };
}

/** The remote host starts a zero-start transition for the given occurrence. */
function remoteHostBegins(
  at: number,
  target: { queueItemId: string; videoId: string },
): ScenarioStep {
  return {
    at,
    run: (rig) => {
      if (!rig.remote.beginHostTransition({ ...target, subIndex: null })) {
        throw new Error('the remote host could not begin a zero-start transition');
      }
    },
  };
}

/**
 * Make an App fake's media commands slow, as a real iframe on a slow network
 * is: cueVideoById is logged and never completes (a later load supersedes
 * it), and loadVideoById keeps reporting the outgoing video until
 * readyAfterMs has passed, then reports the new video and autoplays
 * (PLAYING, notified).
 */
export function makeMediaCommandsSlow(fake: FakeYtPlayer, readyAfterMs: number): void {
  fake.cueVideoById = (videoId: string, startSeconds = 0) => {
    fake.__log.push({ op: 'cueVideoById', args: [videoId, startSeconds], at: Date.now() });
  };
  fake.loadVideoById = (videoId: string, startSeconds?: number) => {
    fake.__log.push({
      op: 'loadVideoById',
      args: startSeconds === undefined ? [videoId] : [videoId, startSeconds],
      at: Date.now(),
    });
    setTimeout(() => {
      fake.__videoId = videoId;
      fake.__currentTime = startSeconds ?? 0;
      fake.__setState(1);
    }, readyAfterMs);
  };
}

/**
 * Make the next release playVideo() of an App fake buffer without ever
 * reporting PLAYING; later calls behave normally.
 */
export function makeReleaseStall(fake: FakeYtPlayer, fromCall: number): void {
  const play = fake.playVideo;
  let calls = 0;
  fake.playVideo = () => {
    calls += 1;
    if (calls !== fromCall) {
      play();
      return;
    }
    fake.__log.push({ op: 'playVideo', at: Date.now() });
    fake.__setState(3);
  };
}

/** The identity every named scenario runs on (synthetic ids and room code). */
export interface StandardScenarioIdentity {
  readonly queueItemId: QueueItemId;
  readonly videoId: string;
  /** A second queue occurrence the remote host can start next (replace-media on the App). */
  readonly nextQueueItemId: QueueItemId;
  readonly nextVideoId: string;
}

/**
 * The named Standard start scenarios of the C2-0 boundary (design
 * increment 0). PR 3's wire golden runs the same scripts. Instants are
 * relative to t0; the end instant leaves every fallback deadline behind.
 */
export function standardScenarios(identity: StandardScenarioIdentity) {
  const current = { queueItemId: identity.queueItemId, videoId: identity.videoId };
  const next = { queueItemId: identity.nextQueueItemId, videoId: identity.nextVideoId };
  return {
    /** Host: one guest advertised; the host presses play at 0:00; all ARMED in time. */
    hostAllReady: {
      name: 'host all-ready release',
      role: 'host',
      steps: [hostPressesPlay(100)],
      endAt: 9_000,
    },
    /** Guest: the remote host starts; this guest arms in time and is in the cohort. */
    guestAllReady: {
      name: 'guest all-ready release',
      role: 'guest',
      steps: [remoteHostBegins(100, current)],
      endAt: 9_000,
    },
    /**
     * Guest: the remote host starts the next occurrence, so this guest issues
     * loadVideoById; its iframe reports the new video only after readyAfterMs,
     * past the host's 2.3 s decision. The host commits without it.
     */
    guestCohortExcluded: (readyAfterMs: number) =>
      ({
        name: `guest cohort-excluded, load ready ${readyAfterMs} ms after PREPARE`,
        role: 'guest',
        prepare: (rig: StandardRig) => makeMediaCommandsSlow(rig.iframe(), readyAfterMs),
        steps: [remoteHostBegins(100, next)],
        endAt: 14_000,
      }) satisfies StandardScenario,
    /** Guest: this guest's clock is uncalibrated, so it never reports ARMED. */
    guestClockUncalibrated: (setCalibrated: (calibrated: boolean) => void) =>
      ({
        name: 'guest clock uncalibrated',
        role: 'guest',
        prepare: () => setCalibrated(false),
        steps: [remoteHostBegins(100, current)],
        endAt: 9_000,
      }) satisfies StandardScenario,
    /** Guest: the release playVideo buffers and never reports PLAYING. */
    guestReleaseAckTimeout: {
      name: 'guest release-ack timeout',
      role: 'guest',
      // The warm-up is the first playVideo; the release is the second.
      prepare: (rig: StandardRig) => makeReleaseStall(rig.iframe(), 2),
      steps: [remoteHostBegins(100, current)],
      endAt: 12_000,
    },
    /**
     * Host: the iframe never confirms the hard mute, so the host's prepare
     * fails and hands the start to the legacy recovery (Stage-1 YOUTUBE_STATE,
     * then Stage-2 YOUTUBE_SYNC).
     */
    hostPrepareFailure: {
      name: 'host prepare failure and legacy recovery',
      role: 'host',
      rig: { iframeInit: { __hardMuteFails: true } },
      steps: [hostPressesPlay(100)],
      endAt: 9_000,
    },
    /**
     * Host: the guest's connection is replaced during warm-up; after the
     * 1.5 s replacement fallback the legacy recovery owns the start.
     */
    hostPeerReplaced: {
      name: 'host peer connection replaced',
      role: 'host',
      steps: [
        hostPressesPlay(100),
        {
          at: 400,
          run: (rig: StandardRig) => {
            const replacement = syntheticConnection(rig.remotePeerId);
            rig.conn = replacement;
            setState('network.activeHostConnByPeerId', new Map([[rig.remotePeerId, replacement]]));
            bus.emit('network:peer-connection-replaced', rig.remotePeerId);
          },
        },
      ],
      endAt: 9_000,
    },
  } satisfies Record<string, StandardScenario | ((...args: never[]) => StandardScenario)>;
}
