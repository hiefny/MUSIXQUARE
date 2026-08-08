/**
 * YouTube zero-start rendezvous.
 *
 * This module owns only the bounded prepare/arm/commit/release state machine.
 * Network routing, authority, playlist projection, and the shared clock are
 * injected so the same controller can serve a standard-room host or a
 * coordinator-free PRO endpoint without importing either topology.
 */
import { MSG } from '../core/constants.ts';
import type {
  ProtocolMsg,
  YouTubeZeroStartAbortReason,
  YouTubeZeroStartCommitReason,
  YouTubeZeroStartPlatform,
} from '../types/index.ts';

const YOUTUBE_ZERO_START_TIMING = Object.freeze({
  guestTotalWaitMs: 3_000,
  startLeadMs: 700,
  guestDecisionMs: 2_300,
  warmupPlayMs: 260,
  pauseSeekGapMs: 80,
  settlePollMs: 80,
  zeroEpsilonSec: 0.12,
  audibleStateSettleMs: 120,
  audioRestoreMaxAttempts: 8,
  hardMutePollMs: 30,
  hardMuteMaxAttempts: 12,
  prepareTimeoutMs: 10_000,
  releaseAckTimeoutMs: 1_800,
  lateFallbackLeadMs: 800,
  timelinePollMs: 250,
  timelineStopAfterMs: 2_500,
  // Start iOS from the neutral server/host timeline. The former 270ms seed
  // now over-advances the first cross-platform run; stable 0.8s/2.0s samples
  // still learn any real residual for subsequent runs.
  iosRelativeTimelineLeadMs: 0,
  androidRelativeTimelineLeadMs: 0,
  androidAudibleOutputDelayMs: 250,
  androidTimelineCalibrationRate: 0.35,
  androidTimelineDeadbandMs: 15,
  androidCalibrationStabilityMs: 25,
  generalCalibrationStabilityMs: 60,
  maxRelativeStartLeadMs: 600,
} as const);

const YOUTUBE_ZERO_START_PLAYER_STATE = Object.freeze({
  unstarted: -1,
  ended: 0,
  playing: 1,
  paused: 2,
  buffering: 3,
  cued: 5,
} as const);

type YouTubeZeroStartCapabilityMessage = ProtocolMsg<typeof MSG.YOUTUBE_ZERO_START_CAPABILITY>;
type YouTubeZeroStartPrepareMessage = ProtocolMsg<typeof MSG.YOUTUBE_ZERO_START_PREPARE>;
type YouTubeZeroStartArmedMessage = ProtocolMsg<typeof MSG.YOUTUBE_ZERO_START_ARMED>;
type YouTubeZeroStartCommitMessage = ProtocolMsg<typeof MSG.YOUTUBE_ZERO_START_COMMIT>;
type YouTubeZeroStartAbortMessage = ProtocolMsg<typeof MSG.YOUTUBE_ZERO_START_ABORT>;
type YouTubeZeroStartTimelineMessage = ProtocolMsg<typeof MSG.YOUTUBE_ZERO_START_TIMELINE>;

export type YouTubeZeroStartWireMessage =
  | YouTubeZeroStartCapabilityMessage
  | YouTubeZeroStartPrepareMessage
  | YouTubeZeroStartArmedMessage
  | YouTubeZeroStartCommitMessage
  | YouTubeZeroStartAbortMessage
  | YouTubeZeroStartTimelineMessage;

type YouTubeZeroStartRole = 'host' | 'guest';

export interface YouTubeZeroStartPlayer {
  loadVideoById(videoId: string, startSeconds?: number): void;
  cueVideoById?(videoId: string, startSeconds?: number): void;
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  setVolume(volume: number): void;
  getVolume(): number;
  getCurrentTime(): number;
  getPlayerState(): number;
  getVideoLoadedFraction(): number;
  getVideoData(): { video_id?: string };
}

export interface YouTubeZeroStartTargetContext {
  role: YouTubeZeroStartRole;
  queueItemId: string;
  videoId: string;
  subIndex: number | null;
}

type YouTubeZeroStartMediaAction = 'replace-media' | 'resident-reposition';

interface YouTubeZeroStartBeginInput {
  queueItemId: string;
  videoId: string;
  subIndex: number | null;
}

type YouTubeZeroStartPhase =
  | 'idle'
  | 'waiting-ready'
  | 'muting'
  | 'warming'
  | 'settling'
  | 'restoring-audio'
  | 'armed'
  | 'scheduled'
  | 'starting'
  | 'playing'
  | 'fallback'
  | 'error';

interface YouTubeZeroStartSnapshot {
  role: YouTubeZeroStartRole;
  runId: string | null;
  sequence: number | null;
  queueItemId: string | null;
  videoId: string | null;
  mediaAction: YouTubeZeroStartMediaAction | null;
  phase: YouTubeZeroStartPhase;
  inFlight: boolean;
  expectedGuestIds: string[];
  armedGuestIds: string[];
  cohort: string[];
  fallback: boolean;
  releaseLeadMs: number;
  audibleBaseLeadMs: number;
  timelineLeadMs: number;
}

interface YouTubeZeroStartPlaybackStartedEvent {
  runId: string;
  queueItemId: string;
  videoId: string;
  fallback: boolean;
  playCallAt: number;
  playingAt: number;
  startAtHost: number;
  eventErrorMs: number;
  callToPlayingMs: number;
}

interface YouTubeZeroStartFallbackEvent {
  runId: string;
  queueItemId: string;
  videoId: string;
  mediaAction: YouTubeZeroStartMediaAction;
  reason: 'cohort-excluded' | 'clock-uncalibrated' | 'prepare-failed' | 'release-timeout';
  startAtHost: number | null;
  targetPositionSec: number | null;
  /** User-intended audio state captured before zero-start applied its hard mute. */
  desiredMuted: boolean | null;
  desiredVolume: number | null;
  /** True when this exact run already issued loadVideoById for the target. */
  targetLoadIssued: boolean;
  /** Exact iframe instance that accepted that load; never transferable. */
  handedOffPlayer: YouTubeZeroStartPlayer | null;
}

interface YouTubeZeroStartHostFallbackEvent {
  runId: string;
  queueItemId: string;
  videoId: string;
  mediaAction: YouTubeZeroStartMediaAction;
  subIndex: number | null;
  reason: string;
  /** User-intended audio state captured before zero-start applied its hard mute. */
  desiredMuted: boolean | null;
  desiredVolume: number | null;
  /** True when the legacy recovery owner should adopt the in-flight target load. */
  targetLoadIssued: boolean;
  /** Exact iframe instance that accepted that load; never transferable. */
  handedOffPlayer: YouTubeZeroStartPlayer | null;
}

interface YouTubeZeroStartLeadUpdate {
  guestPlatform: YouTubeZeroStartPlatform;
  hostPlatform: YouTubeZeroStartPlatform;
  audibleBaseLeadMs: number;
  previousTimelineLeadMs: number;
  timelineLeadMs: number;
  totalLeadMs: number;
  stableTimelineDriftMs: number;
  estimatedAudibleErrorMs: number;
}

interface YouTubeZeroStartScheduler {
  set(callback: () => void, delayMs: number): ReturnType<typeof globalThis.setTimeout>;
  clear(timer: ReturnType<typeof globalThis.setTimeout>): void;
}

interface YouTubeZeroStartDependencies {
  getRole(): YouTubeZeroStartRole;
  getLocalPeerId(): string;
  getHostPeerId(): string | null;
  getLiveGuestPeerIds(): string[];
  getPlayer(): YouTubeZeroStartPlayer | null;
  isPlayerReady(): boolean;
  isAudioUnlocked(): boolean;
  isClockCalibrated(): boolean;
  getHostNow(): number;
  getClockOffsetMs(): number;
  getLocalPlatform(): YouTubeZeroStartPlatform;
  sendToPeer(peerId: string, message: YouTubeZeroStartWireMessage): boolean;
  sendToHost(message: YouTubeZeroStartWireMessage): boolean;
  /** Resolve canonical room time to this device's intentional local target. */
  resolveLocalTargetSec?(
    canonicalPositionSec: number,
    context: YouTubeZeroStartTargetContext,
  ): number;
  /** Inverse of resolveLocalTargetSec, used to compare canonical timelines. */
  toCanonicalPositionSec?(localPositionSec: number, context: YouTubeZeroStartTargetContext): number;
  getLearnedTimelineLeadMs?(
    guestPlatform: YouTubeZeroStartPlatform,
    hostPlatform: YouTubeZeroStartPlatform,
  ): number | null;
  onLearnedTimelineLeadMs?(update: YouTubeZeroStartLeadUpdate): void;
  /**
   * Project the exact queue occurrence before preparation and optionally choose
   * how this device should arm its iframe. Omitting a result preserves the
   * historical replace-media behavior.
   *
   * Each participant decides locally: a cold or mismatched iframe may replace
   * media while another participant repositions an already-resident target.
   */
  onPrepareSelection?(input: YouTubeZeroStartBeginInput): YouTubeZeroStartMediaAction | void;
  onPhaseChange?(snapshot: YouTubeZeroStartSnapshot): void;
  onBusyChange?(busy: boolean): void;
  onPlaybackStarted?(event: YouTubeZeroStartPlaybackStartedEvent): void;
  onFallbackRequired?(event: YouTubeZeroStartFallbackEvent): void;
  onHostFallbackRequired?(event: YouTubeZeroStartHostFallbackEvent): void;
  onError?(reason: string, error?: unknown): void;
  onDebug?(message: string, detail?: unknown): void;
  now?(): number;
  createRunId?(sequence: number): string;
  scheduler?: YouTubeZeroStartScheduler;
}

type LocalRun = {
  runId: string;
  sequence: number;
  queueItemId: string;
  videoId: string;
  mediaAction: YouTubeZeroStartMediaAction;
  subIndex: number | null;
  prepareAtHost: number;
  decisionAtHost: number;
  startDeadlineAtHost: number;
  hostPlatform: YouTubeZeroStartPlatform;
  startedPrepareAtLocal: number;
  phase: Exclude<YouTubeZeroStartPhase, 'idle'>;
  stableChecks: number;
  settleAttempts: number;
  armed: boolean;
  armedReported: boolean;
  warmCallAt: number;
  warmPlayingMs: number;
  preparedMs: number;
  commit: YouTubeZeroStartCommitMessage | null;
  playCallAt: number;
  fallback: boolean;
  sampled08: boolean;
  sampled20: boolean;
  drift08Ms: number | null;
  releaseLeadMs: number;
  audibleBaseLeadMs: number;
  timelineLeadMs: number;
  externalFallbackRequested: boolean;
  hostFallbackEligible: boolean;
  /** True only after this run has captured and begun controlling player audio/playback. */
  ownsPlayerState: boolean;
  audioStateCaptured: boolean;
  targetLoadIssued: boolean;
  targetLoadPlayer: YouTubeZeroStartPlayer | null;
  targetWarmIssued: boolean;
  warmSettlementScheduled: boolean;
  originalMuted: boolean;
  originalVolume: number;
  calibrationEligible: boolean;
};

type HostBarrier = {
  runId: string;
  sequence: number;
  queueItemId: string;
  videoId: string;
  subIndex: number | null;
  prepareAtHost: number;
  decisionAtHost: number;
  startDeadlineAtHost: number;
  expectedGuestIds: Set<string>;
  armedGuestIds: Set<string>;
  hostArmed: boolean;
  committed: boolean;
  commit: YouTubeZeroStartCommitMessage | null;
};

type CapabilityRecord = {
  version: 1 | 2;
  platform: YouTubeZeroStartPlatform;
  ready: boolean;
};

const defaultScheduler: YouTubeZeroStartScheduler = {
  set: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clear: (timer) => globalThis.clearTimeout(timer),
};

function defaultRunId(sequence: number): string {
  const values = new Uint32Array(1);
  globalThis.crypto?.getRandomValues(values);
  const random = values[0] || Math.floor(Math.random() * 0xffff_ffff);
  return `${Date.now().toString(36)}-${sequence}-${random.toString(36)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function getYouTubeZeroStartTimelineBiasMs(platform: YouTubeZeroStartPlatform): number {
  if (platform === 'ios') return YOUTUBE_ZERO_START_TIMING.iosRelativeTimelineLeadMs;
  if (platform === 'android') return YOUTUBE_ZERO_START_TIMING.androidRelativeTimelineLeadMs;
  return 0;
}

function getYouTubeZeroStartAudibleOutputDelayMs(platform: YouTubeZeroStartPlatform): number {
  return platform === 'android' ? YOUTUBE_ZERO_START_TIMING.androidAudibleOutputDelayMs : 0;
}

function getYouTubeZeroStartRelativeLead(
  guestPlatform: YouTubeZeroStartPlatform,
  hostPlatform: YouTubeZeroStartPlatform,
  learnedTimelineLeadMs?: number | null,
): { audibleBaseLeadMs: number; timelineLeadMs: number; totalLeadMs: number } {
  const audibleBaseLeadMs =
    getYouTubeZeroStartAudibleOutputDelayMs(guestPlatform) -
    getYouTubeZeroStartAudibleOutputDelayMs(hostPlatform);
  const seededTimelineLeadMs =
    getYouTubeZeroStartTimelineBiasMs(guestPlatform) -
    getYouTubeZeroStartTimelineBiasMs(hostPlatform);
  const requestedTimelineLeadMs = clamp(
    Number.isFinite(learnedTimelineLeadMs)
      ? (learnedTimelineLeadMs as number)
      : seededTimelineLeadMs,
    -YOUTUBE_ZERO_START_TIMING.maxRelativeStartLeadMs,
    YOUTUBE_ZERO_START_TIMING.maxRelativeStartLeadMs,
  );
  const totalLeadMs = Math.round(
    clamp(
      audibleBaseLeadMs + requestedTimelineLeadMs,
      -YOUTUBE_ZERO_START_TIMING.maxRelativeStartLeadMs,
      YOUTUBE_ZERO_START_TIMING.maxRelativeStartLeadMs,
    ),
  );
  return {
    audibleBaseLeadMs,
    timelineLeadMs: totalLeadMs - audibleBaseLeadMs,
    totalLeadMs,
  };
}

class YouTubeZeroStartController {
  readonly #deps: YouTubeZeroStartDependencies;
  readonly #scheduler: YouTubeZeroStartScheduler;
  readonly #timers = new Set<ReturnType<typeof globalThis.setTimeout>>();
  readonly #capabilities = new Map<string, CapabilityRecord>();
  readonly #learnedTimelineLeads = new Map<string, number>();
  #localRun: LocalRun | null = null;
  #hostBarrier: HostBarrier | null = null;
  #sequence = 0;
  #lastGuestSequence = 0;
  #lastBusy = false;
  #detachedAudioRestoreTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  #detachedAudioRestoreGeneration = 0;
  #lastAdvertisedCapability: {
    hostPeerId: string;
    platform: YouTubeZeroStartPlatform;
    ready: boolean;
  } | null = null;

  constructor(dependencies: YouTubeZeroStartDependencies) {
    this.#deps = dependencies;
    this.#scheduler = dependencies.scheduler ?? defaultScheduler;
  }

  advertiseCapability(): boolean {
    if (this.#deps.getRole() !== 'guest') return false;
    const hostPeerId = this.#deps.getHostPeerId();
    if (!hostPeerId) return false;
    const platform = this.#deps.getLocalPlatform();
    const ready =
      this.#deps.isPlayerReady() &&
      this.#deps.isAudioUnlocked() &&
      this.#deps.isClockCalibrated() &&
      this.#deps.getPlayer() !== null;
    const previous = this.#lastAdvertisedCapability;
    if (
      previous?.hostPeerId === hostPeerId &&
      previous.platform === platform &&
      previous.ready === ready
    ) {
      return true;
    }
    const sent = this.#deps.sendToHost({
      type: MSG.YOUTUBE_ZERO_START_CAPABILITY,
      version: 2,
      platform,
      ready,
    });
    if (sent) this.#lastAdvertisedCapability = { hostPeerId, platform, ready };
    return sent;
  }

  handleCapability(senderPeerId: string, message: YouTubeZeroStartCapabilityMessage): boolean {
    if (this.#deps.getRole() !== 'host') return false;
    if (!this.#deps.getLiveGuestPeerIds().includes(senderPeerId)) return false;
    const ready = message.version === 2 ? message.ready : false;
    this.#capabilities.set(senderPeerId, {
      version: message.version,
      platform: message.platform,
      ready,
    });
    this.#debug('capability', {
      senderPeerId,
      version: message.version,
      platform: message.platform,
      ready,
    });
    return true;
  }

  canBeginHostTransition(): boolean {
    if (this.#deps.getRole() !== 'host') return false;
    if (!this.#deps.isPlayerReady() || !this.#deps.isAudioUnlocked()) return false;
    const liveGuests = this.#uniqueLiveGuestIds();
    if (liveGuests.length === 0 || liveGuests.length > 99) return false;
    return liveGuests.every((peerId) => {
      const capability = this.#capabilities.get(peerId);
      // v2 proves that the guest understands the runtime-readiness contract
      // and can hold an early PREPARE while its cold iframe/clock settles.
      // `ready` remains useful for diagnostics and stale-state downgrades, but
      // the bounded guest wait lets the very first transition succeed instead
      // of forcing one legacy warm-up cycle first.
      return capability?.version === 2;
    });
  }

  beginHostTransition(input: YouTubeZeroStartBeginInput): boolean {
    if (!this.canBeginHostTransition()) return false;
    const player = this.#deps.getPlayer();
    if (!player) return false;

    if (this.#localRun || this.#hostBarrier) this.cancel('superseded', true);
    // A new exact run owns player audio from this point onward. Revoke any
    // detached cleanup retry left by the superseded run before capturing the
    // new desired state.
    this.#cancelDetachedAudioRestore();

    const expectedGuestIds = new Set(this.#uniqueLiveGuestIds());
    if (expectedGuestIds.size === 0) return false;

    this.#sequence += 1;
    const now = this.#now();
    const prepare: YouTubeZeroStartPrepareMessage = {
      type: MSG.YOUTUBE_ZERO_START_PREPARE,
      version: 1,
      runId: (this.#deps.createRunId ?? defaultRunId)(this.#sequence),
      sequence: this.#sequence,
      queueItemId: input.queueItemId,
      videoId: input.videoId,
      subIndex: input.subIndex,
      prepareAtHost: now,
      decisionAtHost: now + YOUTUBE_ZERO_START_TIMING.guestDecisionMs,
      startDeadlineAtHost: now + YOUTUBE_ZERO_START_TIMING.guestTotalWaitMs,
      hostPlatform: this.#deps.getLocalPlatform(),
    };

    this.#hostBarrier = {
      runId: prepare.runId,
      sequence: prepare.sequence,
      queueItemId: prepare.queueItemId,
      videoId: prepare.videoId,
      subIndex: prepare.subIndex,
      prepareAtHost: prepare.prepareAtHost,
      decisionAtHost: prepare.decisionAtHost,
      startDeadlineAtHost: prepare.startDeadlineAtHost,
      expectedGuestIds,
      armedGuestIds: new Set(),
      hostArmed: false,
      committed: false,
      commit: null,
    };

    const sentPeerIds: string[] = [];
    for (const peerId of expectedGuestIds) {
      if (!this.#deps.sendToPeer(peerId, prepare)) {
        const abort: YouTubeZeroStartAbortMessage = {
          type: MSG.YOUTUBE_ZERO_START_ABORT,
          version: 1,
          runId: prepare.runId,
          sequence: prepare.sequence,
          queueItemId: prepare.queueItemId,
          reason: 'cancelled',
        };
        for (const sentPeerId of sentPeerIds) this.#deps.sendToPeer(sentPeerId, abort);
        this.#hostBarrier = null;
        this.#emitState();
        this.#debug('prepare-send-failed', { peerId });
        return false;
      }
      sentPeerIds.push(peerId);
    }

    const mediaAction = this.#deps.onPrepareSelection?.(input) ?? 'replace-media';
    if (!this.#beginLocalPrepare(prepare, undefined, mediaAction)) {
      this.cancel('player-unavailable', true);
      return false;
    }
    if (this.#localRun?.runId === prepare.runId) {
      // From here onward failures happen asynchronously, after callers have
      // already committed to the zero-start path and therefore need an
      // explicit legacy handoff.
      this.#localRun.hostFallbackEligible = true;
    }
    this.#later(() => this.#maybeCommit(), YOUTUBE_ZERO_START_TIMING.guestDecisionMs);
    this.#debug('prepare-host', {
      runId: prepare.runId,
      expectedGuestIds: [...expectedGuestIds],
    });
    return true;
  }

  handlePrepare(senderPeerId: string, message: YouTubeZeroStartPrepareMessage): boolean {
    if (this.#deps.getRole() !== 'guest' || senderPeerId !== this.#deps.getHostPeerId())
      return false;
    if (message.sequence <= this.#lastGuestSequence) return false;
    // The accepted successor immediately takes ownership of this exact
    // player. Do not issue the old run's asynchronous audio restore between
    // its hard mute and the new PREPARE; player.ts transfers canonical intent
    // into the successor instead.
    this.#cancelLocalOnly(true, true);
    this.#cancelDetachedAudioRestore();
    this.#lastGuestSequence = message.sequence;
    const selection = {
      queueItemId: message.queueItemId,
      videoId: message.videoId,
      subIndex: message.subIndex,
    };
    const mediaAction = this.#deps.onPrepareSelection?.(selection) ?? 'replace-media';
    if (!this.#isPrepareRuntimeReady()) {
      const run = this.#createFailedRun(message, mediaAction);
      run.phase = 'waiting-ready';
      this.#localRun = run;
      this.#emitState();
      this.#debug('waiting-ready', {
        runId: message.runId,
        playerReady: this.#deps.isPlayerReady(),
        audioUnlocked: this.#deps.isAudioUnlocked(),
        clockCalibrated: this.#deps.isClockCalibrated(),
      });
      this.#later(() => this.#waitForRuntimeReady(run, message), 0);
      return true;
    }
    return this.#beginLocalPrepare(message, undefined, mediaAction);
  }

  handleArmed(senderPeerId: string, message: YouTubeZeroStartArmedMessage): boolean {
    if (this.#deps.getRole() !== 'host') return false;
    const barrier = this.#hostBarrier;
    if (
      !barrier ||
      barrier.committed ||
      !barrier.expectedGuestIds.has(senderPeerId) ||
      message.runId !== barrier.runId ||
      message.sequence !== barrier.sequence ||
      message.queueItemId !== barrier.queueItemId ||
      message.videoId !== barrier.videoId
    ) {
      return false;
    }
    barrier.armedGuestIds.add(senderPeerId);
    this.#debug('armed-guest', {
      peerId: senderPeerId,
      preparedMs: message.preparedMs,
      leadMs: message.startLeadMs,
    });
    this.#emitState();
    this.#maybeCommit();
    return true;
  }

  handleCommit(senderPeerId: string, message: YouTubeZeroStartCommitMessage): boolean {
    if (this.#deps.getRole() !== 'guest' || senderPeerId !== this.#deps.getHostPeerId())
      return false;
    const run = this.#localRun;
    if (!run || !this.#sameRun(run, message)) return false;
    run.commit = message;
    // A bounded local prepare/COMMIT-wait failure keeps identity only for an
    // eventual authoritative COMMIT. It must not re-enter the normal 0-second
    // release path with a deadline that may already be far in the past; the
    // external recovery owner recomputes the live canonical target instead.
    if (run.phase === 'error') {
      this.#requestExternalFallback(run, message, 'prepare-failed');
      return true;
    }
    const included = message.cohort.includes(this.#deps.getLocalPeerId());
    if (included) {
      if (run.armed && this.#deps.isClockCalibrated()) {
        this.#scheduleCommittedStart(run, message);
      } else if (run.armed) {
        this.#requestExternalFallback(run, message, 'clock-uncalibrated');
      }
    } else if (run.armed) {
      this.#runLateFallback(run, message);
    } else {
      // The host has made its bounded decision and explicitly excluded this
      // still-preparing guest. Waiting for the longer local prepare watchdog
      // would keep the guest silent well after the room starts. Hand recovery
      // to the application immediately; it owns a bounded player retry and
      // preserves the authoritative future COMMIT deadline when applicable.
      this.#requestExternalFallback(run, message, 'cohort-excluded');
    }
    return true;
  }

  handleAbort(senderPeerId: string, message: YouTubeZeroStartAbortMessage): boolean {
    if (this.#deps.getRole() !== 'guest' || senderPeerId !== this.#deps.getHostPeerId())
      return false;
    const run = this.#localRun;
    if (!run || !this.#sameRun(run, message)) return false;
    // A host can fail after COMMIT, when an early-lead guest has already
    // called playVideo(). Stop that orphaned release before the legacy
    // recovery snapshot arrives.
    this.#cancelLocalOnly(true);
    return true;
  }

  handleTimeline(senderPeerId: string, message: YouTubeZeroStartTimelineMessage): boolean {
    if (this.#deps.getRole() !== 'guest' || senderPeerId !== this.#deps.getHostPeerId())
      return false;
    const run = this.#localRun;
    const player = this.#deps.getPlayer();
    if (!run || !player || run.phase !== 'playing' || !this.#sameRun(run, message)) return false;

    try {
      const nowAtHost = this.#deps.getHostNow();
      const predictedCanonical =
        message.positionSec +
        (message.playerState === YOUTUBE_ZERO_START_PLAYER_STATE.playing
          ? (nowAtHost - message.hostTime) / 1_000
          : 0);
      const localCanonical = this.#toCanonicalPosition(player.getCurrentTime(), run);
      const timelineDriftMs = (localCanonical - predictedCanonical) * 1_000;
      const estimatedAudibleErrorMs = timelineDriftMs - run.audibleBaseLeadMs;
      const elapsedSec = run.commit ? (nowAtHost - run.commit.startAtHost) / 1_000 : 0;

      if (elapsedSec >= 0.8 && !run.sampled08) {
        run.sampled08 = true;
        run.drift08Ms = timelineDriftMs;
        this.#debug('timeline-0.8s', { timelineDriftMs, estimatedAudibleErrorMs });
      }
      if (elapsedSec >= 2 && !run.sampled20) {
        run.sampled20 = true;
        this.#debug('timeline-2.0s', { timelineDriftMs, estimatedAudibleErrorMs });
        this.#calibrateLead(run, timelineDriftMs);
      }
      return true;
    } catch (error) {
      this.#debug('timeline-read-failed', error);
      return false;
    }
  }

  /**
   * Consume transient warm-up state changes before the ordinary IFrame state
   * handler sees them. `true` means the caller must suppress normal handling.
   * The real post-release PLAYING/BUFFERING events intentionally return false.
   */
  handlePlayerStateChange(state: number): boolean {
    const run = this.#localRun;
    const player = this.#deps.getPlayer();
    if (!run || !player || run.phase === 'error' || run.phase === 'playing') return false;

    if (run.phase === 'warming' && state === YOUTUBE_ZERO_START_PLAYER_STATE.playing) {
      // A same-video PLAYING can arrive late from the previous occurrence.
      // Never accept it before this exact run has issued its own warm command.
      // Resident reposition intentionally has no target load command.
      if (!run.targetWarmIssued) return true;
      if (run.targetLoadPlayer !== player) return true;
      if (this.#currentVideoId(player) !== run.videoId) return true;
      this.#scheduleWarmSettlement(run, player);
      return true;
    }

    if (run.phase === 'starting' && state === YOUTUBE_ZERO_START_PLAYER_STATE.playing) {
      const currentVideoId = this.#currentVideoId(player);
      if (currentVideoId !== run.videoId) {
        this.#failLocalPrepare(run, 'release-video-mismatch', {
          expectedVideoId: run.videoId,
          currentVideoId,
        });
        return true;
      }
      run.phase = 'playing';
      const playingAt = this.#now();
      const commit = run.commit;
      if (commit) {
        const localReleaseAt = this.#hostTimeToLocal(commit.startAtHost);
        this.#deps.onPlaybackStarted?.({
          runId: run.runId,
          queueItemId: run.queueItemId,
          videoId: run.videoId,
          fallback: run.fallback,
          playCallAt: run.playCallAt,
          playingAt,
          startAtHost: commit.startAtHost,
          eventErrorMs: playingAt - localReleaseAt,
          callToPlayingMs: playingAt - run.playCallAt,
        });
      }
      this.#emitState();
      if (this.#deps.getRole() === 'host') this.#startTimelineBroadcast(run);
      // Keep the run identity only through the short calibration window. UI
      // projection resumes immediately at PLAYING, while callers can suppress
      // legacy room broadcasts until the zero-start timeline samples finish.
      this.#later(() => {
        if (!this.#isCurrentRun(run) || run.phase !== 'playing') return;
        this.#localRun = null;
        if (this.#hostBarrier?.runId === run.runId) this.#hostBarrier = null;
        this.#emitState();
      }, YOUTUBE_ZERO_START_TIMING.timelineStopAfterMs + YOUTUBE_ZERO_START_TIMING.timelinePollMs);
      return false;
    }

    return run.phase !== 'starting';
  }

  handlePeerDisconnected(peerId: string): void {
    this.#capabilities.delete(peerId);
    if (this.#deps.getRole() !== 'host') return;
    const barrier = this.#hostBarrier;
    if (!barrier || barrier.committed) return;
    barrier.expectedGuestIds.delete(peerId);
    barrier.armedGuestIds.delete(peerId);
    this.#emitState();
    this.#maybeCommit();
  }

  handlePeerConnectionReplaced(peerId: string): void {
    this.#capabilities.delete(peerId);
    if (this.#deps.getRole() !== 'host') return;
    if (this.#localRun?.phase === 'playing') {
      // Playback is already established; only the short calibration window
      // still owns protocol state. End it locally without ABORT, otherwise
      // unaffected guests would pause a healthy release. The replacement
      // connection joins through the ordinary canonical late-join bootstrap.
      this.cancel('authority-changed', false);
      return;
    }
    if (this.#localRun || this.#hostBarrier) {
      // Reconnect is a new exact DataConnection. Never shrink the frozen
      // cohort and commit around it as if the participant had left.
      this.cancel('authority-changed', true);
    }
  }

  updateDesiredAudioState(update: { muted?: boolean; volume?: number }): void {
    const run = this.#localRun;
    if (!run || run.phase === 'playing' || run.phase === 'error') return;
    if (typeof update.muted === 'boolean') run.originalMuted = update.muted;
    if (typeof update.volume === 'number' && Number.isFinite(update.volume)) {
      run.originalVolume = clamp(Math.round(update.volume), 0, 100);
    }
    if (
      !run.audioStateCaptured &&
      typeof update.muted === 'boolean' &&
      typeof update.volume === 'number' &&
      Number.isFinite(update.volume)
    ) {
      run.audioStateCaptured = true;
    }
  }

  cancel(
    reason: YouTubeZeroStartAbortReason = 'cancelled',
    broadcast = true,
    transferPlayerState = false,
  ): void {
    const barrier = this.#hostBarrier;
    const run = this.#localRun;
    if (broadcast && this.#deps.getRole() === 'host' && barrier) {
      const abort: YouTubeZeroStartAbortMessage = {
        type: MSG.YOUTUBE_ZERO_START_ABORT,
        version: 1,
        runId: barrier.runId,
        sequence: barrier.sequence,
        queueItemId: barrier.queueItemId,
        reason,
      };
      for (const peerId of barrier.expectedGuestIds) this.#deps.sendToPeer(peerId, abort);
    }
    this.#debug('cancel', { runId: run?.runId ?? barrier?.runId, reason });
    if (run?.ownsPlayerState && run.phase !== 'playing' && run.phase !== 'error') {
      // WARMING uses a hard mute, not a paused iframe. Restoring the user's
      // audio state before stopping would leak the warm-up audio whenever
      // authority/reconnect/supersede cancels the run.
      this.#stopPlaybackBestEffort();
    }
    this.#clearTimers();
    this.#localRun = null;
    this.#hostBarrier = null;
    this.#emitState();
    if (run && !transferPlayerState) this.#restoreOriginalAudioBounded(run);
  }

  reset(): void {
    this.cancel('authority-changed', false);
    this.#capabilities.clear();
    this.#learnedTimelineLeads.clear();
    this.#lastAdvertisedCapability = null;
    this.#sequence = 0;
    this.#lastGuestSequence = 0;
  }

  isInFlight(): boolean {
    const phase = this.#localRun?.phase;
    return Boolean(phase && phase !== 'playing' && phase !== 'error');
  }

  isProtocolActive(): boolean {
    return Boolean(this.#localRun && this.#localRun.phase !== 'error');
  }

  getSnapshot(): YouTubeZeroStartSnapshot {
    const run = this.#localRun;
    const barrier = this.#hostBarrier;
    return {
      role: this.#deps.getRole(),
      runId: run?.runId ?? barrier?.runId ?? null,
      sequence: run?.sequence ?? barrier?.sequence ?? null,
      queueItemId: run?.queueItemId ?? barrier?.queueItemId ?? null,
      videoId: run?.videoId ?? barrier?.videoId ?? null,
      mediaAction: run?.mediaAction ?? null,
      phase: run?.phase ?? 'idle',
      inFlight: this.isInFlight(),
      expectedGuestIds: barrier ? [...barrier.expectedGuestIds] : [],
      armedGuestIds: barrier ? [...barrier.armedGuestIds] : [],
      cohort: run?.commit?.cohort ?? barrier?.commit?.cohort ?? [],
      fallback: run?.fallback ?? false,
      releaseLeadMs: run?.releaseLeadMs ?? 0,
      audibleBaseLeadMs: run?.audibleBaseLeadMs ?? 0,
      timelineLeadMs: run?.timelineLeadMs ?? 0,
    };
  }

  #beginLocalPrepare(
    message: YouTubeZeroStartPrepareMessage,
    startedPrepareAtLocal = this.#now(),
    mediaAction: YouTubeZeroStartMediaAction = 'replace-media',
  ): boolean {
    this.#cancelDetachedAudioRestore();
    const player = this.#deps.getPlayer();
    if (!player || !this.#deps.isPlayerReady() || !this.#deps.isAudioUnlocked()) return false;

    const role = this.#deps.getRole();
    const localPlatform = this.#deps.getLocalPlatform();
    const lead =
      role === 'guest'
        ? this.#relativeLead(localPlatform, message.hostPlatform)
        : { audibleBaseLeadMs: 0, timelineLeadMs: 0, totalLeadMs: 0 };

    let originalMuted: boolean;
    let originalVolume: number;
    try {
      originalMuted = player.isMuted();
      originalVolume = clamp(Math.round(finiteOr(player.getVolume(), 100)), 0, 100);
    } catch (error) {
      this.#deps.onError?.('player-audio-state-unavailable', error);
      return false;
    }

    const run: LocalRun = {
      runId: message.runId,
      sequence: message.sequence,
      queueItemId: message.queueItemId,
      videoId: message.videoId,
      mediaAction,
      subIndex: message.subIndex,
      prepareAtHost: message.prepareAtHost,
      decisionAtHost: message.decisionAtHost,
      startDeadlineAtHost: message.startDeadlineAtHost,
      hostPlatform: message.hostPlatform,
      startedPrepareAtLocal,
      phase: 'muting',
      stableChecks: 0,
      settleAttempts: 0,
      armed: false,
      armedReported: false,
      warmCallAt: 0,
      warmPlayingMs: 0,
      preparedMs: 0,
      commit: null,
      playCallAt: 0,
      fallback: false,
      sampled08: false,
      sampled20: false,
      drift08Ms: null,
      releaseLeadMs: lead.totalLeadMs,
      audibleBaseLeadMs: lead.audibleBaseLeadMs,
      timelineLeadMs: lead.timelineLeadMs,
      externalFallbackRequested: false,
      hostFallbackEligible: false,
      ownsPlayerState: true,
      audioStateCaptured: true,
      targetLoadIssued: false,
      targetLoadPlayer: null,
      targetWarmIssued: false,
      warmSettlementScheduled: false,
      originalMuted,
      originalVolume,
      calibrationEligible:
        !this.#deps.resolveLocalTargetSec || Boolean(this.#deps.toCanonicalPositionSec),
    };
    this.#localRun = run;
    this.#emitState();

    try {
      player.mute();
    } catch (error) {
      this.#failLocalPrepare(run, 'hard-mute-command-failed', error);
      return false;
    }
    this.#later(() => this.#waitForHardMute(run, 0), 0);
    return true;
  }

  #createFailedRun(
    message: YouTubeZeroStartPrepareMessage,
    mediaAction: YouTubeZeroStartMediaAction = 'replace-media',
  ): LocalRun {
    const localPlatform = this.#deps.getLocalPlatform();
    const lead = this.#relativeLead(localPlatform, message.hostPlatform);
    const player = this.#deps.getPlayer();
    let originalMuted = false;
    let originalVolume = 100;
    let audioStateCaptured = false;
    try {
      if (player) {
        originalMuted = player.isMuted();
        originalVolume = clamp(Math.round(finiteOr(player.getVolume(), 100)), 0, 100);
        audioStateCaptured = true;
      }
    } catch {
      // This run exists only to correlate the later COMMIT fallback.
    }
    return {
      runId: message.runId,
      sequence: message.sequence,
      queueItemId: message.queueItemId,
      videoId: message.videoId,
      mediaAction,
      subIndex: message.subIndex,
      prepareAtHost: message.prepareAtHost,
      decisionAtHost: message.decisionAtHost,
      startDeadlineAtHost: message.startDeadlineAtHost,
      hostPlatform: message.hostPlatform,
      startedPrepareAtLocal: this.#now(),
      phase: 'error',
      stableChecks: 0,
      settleAttempts: 0,
      armed: false,
      armedReported: false,
      warmCallAt: 0,
      warmPlayingMs: 0,
      preparedMs: 0,
      commit: null,
      playCallAt: 0,
      fallback: false,
      sampled08: false,
      sampled20: false,
      drift08Ms: null,
      releaseLeadMs: lead.totalLeadMs,
      audibleBaseLeadMs: lead.audibleBaseLeadMs,
      timelineLeadMs: lead.timelineLeadMs,
      externalFallbackRequested: false,
      hostFallbackEligible: false,
      ownsPlayerState: false,
      audioStateCaptured,
      targetLoadIssued: false,
      targetLoadPlayer: null,
      targetWarmIssued: false,
      warmSettlementScheduled: false,
      originalMuted,
      originalVolume,
      calibrationEligible: false,
    };
  }

  #waitForRuntimeReady(run: LocalRun, message: YouTubeZeroStartPrepareMessage): void {
    if (!this.#isCurrentRun(run) || run.phase !== 'waiting-ready') return;
    if (this.#isPrepareRuntimeReady()) {
      const startedPrepareAtLocal = run.startedPrepareAtLocal;
      if (!this.#beginLocalPrepare(message, startedPrepareAtLocal, run.mediaAction)) {
        this.#failLocalPrepare(run, 'player-unavailable');
      }
      return;
    }
    if (this.#now() - run.startedPrepareAtLocal >= YOUTUBE_ZERO_START_TIMING.guestTotalWaitMs) {
      this.#failLocalPrepare(run, 'player-unavailable');
      return;
    }
    this.#later(() => this.#waitForRuntimeReady(run, message), 50);
  }

  #waitForHardMute(run: LocalRun, attempt: number): void {
    if (!this.#isCurrentRun(run) || run.phase !== 'muting') return;
    const player = this.#deps.getPlayer();
    if (!player) {
      this.#failLocalPrepare(run, 'player-unavailable');
      return;
    }

    let muted: boolean;
    try {
      muted = player.isMuted() === true;
    } catch {
      muted = false;
    }
    if (muted) {
      try {
        player.setVolume(run.originalVolume);
        player.mute();
        run.phase = 'warming';
        run.warmCallAt = this.#now();
        this.#emitState();
        // `resident-reposition` deliberately keeps the decoder/buffer attached
        // to the current iframe. If the caller's optimistic resident decision
        // is stale on this participant, degrade locally to the established
        // replace path instead of arming the wrong video.
        if (
          run.mediaAction === 'resident-reposition' &&
          this.#currentVideoId(player) !== run.videoId
        ) {
          run.mediaAction = 'replace-media';
          this.#debug('resident-media-mismatch', {
            runId: run.runId,
            expectedVideoId: run.videoId,
            currentVideoId: this.#currentVideoId(player),
          });
        }

        run.targetWarmIssued = true;
        run.targetLoadPlayer = player;
        try {
          if (run.mediaAction === 'resident-reposition') {
            // Warm the already-resident decoder under hard mute without
            // cueVideoById/loadVideoById. The normal warm PLAYING boundary is
            // retained, so release timing and platform lead calibration remain
            // identical to a fresh media replacement.
            player.playVideo();
          } else {
            run.targetLoadIssued = true;
            player.loadVideoById(run.videoId, this.#resolveLocalTarget(0, run));
          }
        } catch (error) {
          run.targetLoadIssued = false;
          run.targetLoadPlayer = null;
          run.targetWarmIssued = false;
          throw error;
        }

        // An already-playing resident may not emit a second PLAYING event for
        // idempotent playVideo(). Observe it synchronously, but use the same
        // bounded warm duration and settle sequence as the event-driven path.
        if (
          this.#currentVideoId(player) === run.videoId &&
          player.getPlayerState() === YOUTUBE_ZERO_START_PLAYER_STATE.playing
        ) {
          this.#scheduleWarmSettlement(run, player);
        }
        this.#armWarmWatchdog(run);
      } catch (error) {
        this.#failLocalPrepare(run, 'youtube-load-failed', error);
      }
      return;
    }

    if (attempt + 1 >= YOUTUBE_ZERO_START_TIMING.hardMuteMaxAttempts) {
      this.#failLocalPrepare(run, 'hard-mute-timeout');
      return;
    }
    try {
      player.mute();
    } catch {
      // The bounded poll either observes the command or fails safely.
    }
    this.#later(
      () => this.#waitForHardMute(run, attempt + 1),
      YOUTUBE_ZERO_START_TIMING.hardMutePollMs,
    );
  }

  #armWarmWatchdog(run: LocalRun): void {
    // A media command can return without ever producing PLAYING (offline
    // iframe, blocked media, stalled embed). The settle loop starts only after
    // the warm boundary, so this phase retains its own bounded watchdog.
    this.#later(
      () => {
        if (!this.#isCurrentRun(run) || run.phase !== 'warming') return;
        this.#failLocalPrepare(run, 'prepare-timeout', {
          phase: 'warming',
          videoId: run.videoId,
          mediaAction: run.mediaAction,
        });
      },
      run.startedPrepareAtLocal + YOUTUBE_ZERO_START_TIMING.prepareTimeoutMs - this.#now(),
    );
  }

  #scheduleWarmSettlement(run: LocalRun, player: YouTubeZeroStartPlayer): void {
    if (
      !this.#isCurrentRun(run) ||
      run.phase !== 'warming' ||
      run.warmSettlementScheduled ||
      !run.targetWarmIssued ||
      run.targetLoadPlayer !== player ||
      this.#deps.getPlayer() !== player ||
      this.#currentVideoId(player) !== run.videoId
    ) {
      return;
    }
    run.warmSettlementScheduled = true;
    run.warmPlayingMs = this.#now() - run.warmCallAt;
    this.#later(() => {
      if (!this.#isCurrentRun(run) || run.phase !== 'warming') return;
      if (this.#deps.getPlayer() !== player) {
        run.ownsPlayerState = false;
        this.#failLocalPrepare(run, 'player-replaced');
        return;
      }
      try {
        player.pauseVideo();
        run.phase = 'settling';
        this.#emitState();
        this.#later(() => {
          if (!this.#isCurrentRun(run) || run.phase !== 'settling') return;
          if (this.#deps.getPlayer() !== player) {
            run.ownsPlayerState = false;
            this.#failLocalPrepare(run, 'player-replaced');
            return;
          }
          player.seekTo(this.#resolveLocalTarget(0, run), true);
          this.#later(() => this.#pollSettledAtTarget(run), YOUTUBE_ZERO_START_TIMING.settlePollMs);
        }, YOUTUBE_ZERO_START_TIMING.pauseSeekGapMs);
      } catch (error) {
        this.#failLocalPrepare(run, 'warm-pause-failed', error);
      }
    }, YOUTUBE_ZERO_START_TIMING.warmupPlayMs);
  }

  #pollSettledAtTarget(run: LocalRun): void {
    if (!this.#isCurrentRun(run) || run.phase !== 'settling') return;
    const player = this.#deps.getPlayer();
    if (!player) {
      this.#failLocalPrepare(run, 'player-unavailable');
      return;
    }
    if (player !== run.targetLoadPlayer) {
      run.ownsPlayerState = false;
      this.#failLocalPrepare(run, 'player-replaced');
      return;
    }

    run.settleAttempts += 1;
    let state: number = YOUTUBE_ZERO_START_PLAYER_STATE.unstarted;
    let position = Number.POSITIVE_INFINITY;
    const target = this.#resolveLocalTarget(0, run);
    try {
      state = player.getPlayerState();
      position = player.getCurrentTime();
      const isStopped =
        state === YOUTUBE_ZERO_START_PLAYER_STATE.paused ||
        state === YOUTUBE_ZERO_START_PLAYER_STATE.cued;
      if (
        this.#currentVideoId(player) === run.videoId &&
        isStopped &&
        Math.abs(position - target) <= YOUTUBE_ZERO_START_TIMING.zeroEpsilonSec
      ) {
        run.stableChecks += 1;
      } else {
        run.stableChecks = 0;
        if (state === YOUTUBE_ZERO_START_PLAYER_STATE.playing) player.pauseVideo();
        if (run.settleAttempts % 6 === 0) {
          player.pauseVideo();
          this.#later(() => {
            if (!this.#isCurrentRun(run)) return;
            if (this.#deps.getPlayer() !== player) {
              run.ownsPlayerState = false;
              this.#failLocalPrepare(run, 'player-replaced');
              return;
            }
            player.seekTo(this.#resolveLocalTarget(0, run), true);
          }, YOUTUBE_ZERO_START_TIMING.pauseSeekGapMs);
        }
      }
    } catch {
      run.stableChecks = 0;
    }

    if (run.stableChecks >= 2) {
      this.#restoreAudioState(run);
      return;
    }
    if (this.#now() - run.startedPrepareAtLocal > YOUTUBE_ZERO_START_TIMING.prepareTimeoutMs) {
      this.#failLocalPrepare(run, 'prepare-timeout', { state, position, target });
      return;
    }
    this.#later(() => this.#pollSettledAtTarget(run), YOUTUBE_ZERO_START_TIMING.settlePollMs);
  }

  #restoreAudioState(run: LocalRun): void {
    if (!this.#isCurrentRun(run)) return;
    run.phase = 'restoring-audio';
    this.#emitState();
    this.#attemptRunAudioRestore(run, 0);
  }

  #attemptRunAudioRestore(run: LocalRun, attempt: number): void {
    if (!this.#isCurrentRun(run) || run.phase !== 'restoring-audio') return;
    const player = this.#deps.getPlayer();
    if (!player) {
      this.#failLocalPrepare(run, 'player-unavailable');
      return;
    }

    let commandError: unknown;
    try {
      player.setVolume(run.originalVolume);
      if (run.originalMuted) player.mute();
      else player.unMute();
    } catch (error) {
      commandError = error;
    }

    this.#later(() => {
      if (!this.#isCurrentRun(run) || run.phase !== 'restoring-audio') return;
      const currentPlayer = this.#deps.getPlayer();
      if (!currentPlayer) {
        this.#failLocalPrepare(run, 'player-unavailable');
        return;
      }
      let actualMuted: boolean | null = null;
      let actualVolume: number | null = null;
      let verificationError: unknown;
      try {
        actualMuted = currentPlayer.isMuted();
        actualVolume = finiteOr(currentPlayer.getVolume(), run.originalVolume);
      } catch (error) {
        verificationError = error;
      }
      const restored =
        actualMuted === run.originalMuted &&
        actualVolume !== null &&
        Math.abs(actualVolume - run.originalVolume) <= 1;
      if (restored) {
        this.#markArmed(run);
        return;
      }
      if (attempt + 1 >= YOUTUBE_ZERO_START_TIMING.audioRestoreMaxAttempts) {
        this.#failLocalPrepare(run, 'audio-restore-timeout', {
          expectedMuted: run.originalMuted,
          actualMuted,
          expectedVolume: run.originalVolume,
          actualVolume,
          commandError,
          verificationError,
        });
        return;
      }
      this.#attemptRunAudioRestore(run, attempt + 1);
    }, YOUTUBE_ZERO_START_TIMING.audibleStateSettleMs);
  }

  #markArmed(run: LocalRun): void {
    if (!this.#isCurrentRun(run) || run.armed) return;
    run.armed = true;
    run.phase = 'armed';
    run.preparedMs = this.#now() - run.startedPrepareAtLocal;
    this.#emitState();

    if (this.#deps.getRole() === 'host') {
      const barrier = this.#hostBarrier;
      if (barrier && barrier.runId === run.runId) {
        barrier.hostArmed = true;
        this.#maybeCommit();
      }
    } else {
      this.#reportGuestArmedWhenClockReady(run);
      // Reliable ordered delivery makes a missing COMMIT unusual, but a
      // transient send failure must not leave an armed guest suppressing its
      // UI and ordinary sync path forever. Do not invent a release without
      // host authority: end the busy phase after the advertised guest wait,
      // retain exact run identity, and let a late valid COMMIT recover through
      // the existing external fallback path.
      this.#later(
        () => {
          if (!this.#isCurrentRun(run) || run.phase !== 'armed' || run.commit) return;
          this.#failLocalPrepare(run, 'commit-wait-timeout');
        },
        run.startedPrepareAtLocal + YOUTUBE_ZERO_START_TIMING.guestTotalWaitMs - this.#now(),
      );
    }

    if (run.commit) {
      if (run.commit.cohort.includes(this.#deps.getLocalPeerId())) {
        if (this.#deps.isClockCalibrated()) this.#scheduleCommittedStart(run, run.commit);
      } else {
        this.#runLateFallback(run, run.commit);
      }
    }
  }

  #reportGuestArmedWhenClockReady(run: LocalRun): void {
    if (!this.#isCurrentRun(run) || run.armedReported || this.#deps.getRole() !== 'guest') return;
    if (!this.#deps.isClockCalibrated()) {
      if (run.commit) {
        this.#requestExternalFallback(run, run.commit, 'clock-uncalibrated');
        return;
      }
      if (this.#now() - run.startedPrepareAtLocal < YOUTUBE_ZERO_START_TIMING.guestTotalWaitMs) {
        this.#later(() => this.#reportGuestArmedWhenClockReady(run), 50);
      }
      return;
    }

    const player = this.#deps.getPlayer();
    if (!player) return;
    let positionSec = 0;
    let playerState: number = YOUTUBE_ZERO_START_PLAYER_STATE.unstarted;
    let muted = run.originalMuted;
    let volume = run.originalVolume;
    let loadedFraction = 0;
    try {
      positionSec = clamp(finiteOr(player.getCurrentTime(), 0), 0, 31_536_000);
      const reportedState = player.getPlayerState();
      playerState = this.#isKnownPlayerState(reportedState)
        ? reportedState
        : YOUTUBE_ZERO_START_PLAYER_STATE.unstarted;
      muted = player.isMuted();
      volume = clamp(finiteOr(player.getVolume(), run.originalVolume), 0, 100);
      loadedFraction = clamp(finiteOr(player.getVideoLoadedFraction(), 0), 0, 1);
    } catch {
      // Diagnostics stay bounded even when the IFrame omits optional values.
    }
    const message: YouTubeZeroStartArmedMessage = {
      type: MSG.YOUTUBE_ZERO_START_ARMED,
      version: 1,
      runId: run.runId,
      sequence: run.sequence,
      queueItemId: run.queueItemId,
      videoId: run.videoId,
      preparedMs: clamp(run.preparedMs, 0, 60_000),
      warmLatencyMs: clamp(run.warmPlayingMs, 0, 60_000),
      positionSec,
      playerState,
      audioUnlocked: this.#deps.isAudioUnlocked(),
      muted,
      volume,
      loadedFraction,
      startLeadMs: run.releaseLeadMs,
      audibleBaseLeadMs: run.audibleBaseLeadMs,
      timelineLeadMs: run.timelineLeadMs,
      platform: this.#deps.getLocalPlatform(),
    };
    run.armedReported = this.#deps.sendToHost(message);
  }

  #maybeCommit(): void {
    const barrier = this.#hostBarrier;
    const run = this.#localRun;
    if (!barrier || !run || barrier.committed || !barrier.hostArmed) return;
    const now = this.#now();
    const allReady = [...barrier.expectedGuestIds].every((id) => barrier.armedGuestIds.has(id));
    if (!allReady && now < barrier.decisionAtHost) return;

    const hostWasDelayed = now > barrier.startDeadlineAtHost;
    const reason: YouTubeZeroStartCommitReason = allReady
      ? 'all-ready'
      : hostWasDelayed
        ? 'host-delayed'
        : 'guest-timeout';
    const startAtHost = allReady
      ? now + YOUTUBE_ZERO_START_TIMING.startLeadMs
      : Math.max(barrier.startDeadlineAtHost, now + YOUTUBE_ZERO_START_TIMING.startLeadMs);
    const cohort = [this.#deps.getLocalPeerId()];
    for (const peerId of barrier.expectedGuestIds) {
      if (barrier.armedGuestIds.has(peerId)) cohort.push(peerId);
    }
    const commit: YouTubeZeroStartCommitMessage = {
      type: MSG.YOUTUBE_ZERO_START_COMMIT,
      version: 1,
      runId: barrier.runId,
      sequence: barrier.sequence,
      queueItemId: barrier.queueItemId,
      videoId: barrier.videoId,
      startAtHost,
      reason,
      cohort,
    };
    barrier.committed = true;
    barrier.commit = commit;
    run.commit = commit;
    let commitDeliveredToAll = true;
    for (const peerId of barrier.expectedGuestIds) {
      // Continue across the frozen cohort even after one failure. Peers that
      // accepted COMMIT must receive the following ordered ABORT before the
      // host hands the whole room to the legacy rendezvous path.
      if (!this.#deps.sendToPeer(peerId, commit)) commitDeliveredToAll = false;
    }
    if (!commitDeliveredToAll) {
      this.#failLocalPrepare(run, 'commit-send-failed');
      return;
    }
    this.#scheduleCommittedStart(run, commit);
    this.#emitState();
  }

  #scheduleCommittedStart(run: LocalRun, commit: YouTubeZeroStartCommitMessage): void {
    if (
      !this.#isCurrentRun(run) ||
      run.phase === 'scheduled' ||
      run.phase === 'starting' ||
      run.phase === 'playing'
    )
      return;
    if (!run.armed) return;
    if (this.#deps.getRole() === 'guest' && !this.#deps.isClockCalibrated()) {
      this.#requestExternalFallback(run, commit, 'clock-uncalibrated');
      return;
    }
    const localStartAt = this.#hostTimeToLocal(commit.startAtHost);
    const callAt = localStartAt - (this.#deps.getRole() === 'guest' ? run.releaseLeadMs : 0);
    run.phase = 'scheduled';
    run.commit = commit;
    this.#emitState();
    this.#later(() => {
      if (!this.#isCurrentRun(run) || run.phase !== 'scheduled') return;
      const player = this.#deps.getPlayer();
      if (!player) {
        this.#failLocalPrepare(run, 'player-unavailable');
        return;
      }
      try {
        run.playCallAt = this.#now();
        run.phase = 'starting';
        this.#emitState();
        player.playVideo();
        this.#later(() => {
          if (!this.#isCurrentRun(run) || run.phase !== 'starting') return;
          this.#failLocalPrepare(run, 'release-ack-timeout');
        }, YOUTUBE_ZERO_START_TIMING.releaseAckTimeoutMs);
      } catch (error) {
        this.#failLocalPrepare(run, 'play-command-failed', error);
      }
    }, callAt - this.#now());
  }

  #runLateFallback(run: LocalRun, commit: YouTubeZeroStartCommitMessage): void {
    if (!this.#isCurrentRun(run) || run.fallback) return;
    if (!this.#deps.isClockCalibrated()) {
      this.#requestExternalFallback(run, commit, 'clock-uncalibrated');
      return;
    }
    const player = this.#deps.getPlayer();
    if (!player) {
      this.#requestExternalFallback(run, commit, 'prepare-failed');
      return;
    }
    const nowAtHost = this.#deps.getHostNow();
    const canonicalTarget =
      Math.max(0, (nowAtHost - commit.startAtHost) / 1_000) +
      YOUTUBE_ZERO_START_TIMING.lateFallbackLeadMs / 1_000;
    const fallbackCommit: YouTubeZeroStartCommitMessage = {
      ...commit,
      startAtHost: nowAtHost + YOUTUBE_ZERO_START_TIMING.lateFallbackLeadMs,
      cohort: [this.#deps.getLocalPeerId()],
      reason: 'guest-timeout',
    };
    run.fallback = true;
    run.phase = 'fallback';
    run.commit = fallbackCommit;
    this.#emitState();
    try {
      player.pauseVideo();
      this.#later(() => {
        if (!this.#isCurrentRun(run)) return;
        player.seekTo(this.#resolveLocalTarget(canonicalTarget, run), true);
        this.#later(() => {
          if (this.#isCurrentRun(run)) player.pauseVideo();
        }, 100);
      }, YOUTUBE_ZERO_START_TIMING.pauseSeekGapMs);
      run.armed = true;
      this.#scheduleCommittedStart(run, fallbackCommit);
    } catch (error) {
      this.#requestExternalFallback(run, commit, 'prepare-failed');
      this.#deps.onError?.('late-fallback-failed', error);
    }
  }

  #requestExternalFallback(
    run: LocalRun,
    commit: YouTubeZeroStartCommitMessage,
    reason: YouTubeZeroStartFallbackEvent['reason'],
  ): void {
    if (run.externalFallbackRequested) return;
    run.externalFallbackRequested = true;
    const nowAtHost = this.#deps.isClockCalibrated() ? this.#deps.getHostNow() : null;
    const targetPositionSec =
      nowAtHost === null ? null : Math.max(0, (nowAtHost - commit.startAtHost) / 1_000);
    // The application now owns playback recovery. End the controller's busy
    // state first so a missing iframe cannot leave the play button and UI loop
    // blocked forever. Do not unmute between owners: the fallback receives
    // the pre-warm desired state and can adopt an already-issued target load
    // without exposing warm-up audio or recapturing the transient hard mute.
    this.#clearTimers();
    if (run.ownsPlayerState) this.#stopPlaybackBestEffort();
    this.#cancelDetachedAudioRestore();
    run.phase = 'error';
    this.#emitState();
    const fallback = this.#deps.onFallbackRequired;
    if (!fallback) {
      this.#restoreOriginalAudioBounded(run);
      return;
    }
    fallback({
      runId: run.runId,
      queueItemId: run.queueItemId,
      videoId: run.videoId,
      mediaAction: run.mediaAction,
      reason,
      startAtHost: commit.startAtHost,
      targetPositionSec,
      desiredMuted: run.audioStateCaptured ? run.originalMuted : null,
      desiredVolume: run.audioStateCaptured ? run.originalVolume : null,
      targetLoadIssued: run.targetLoadIssued,
      handedOffPlayer: run.targetLoadPlayer,
    });
  }

  #startTimelineBroadcast(run: LocalRun): void {
    const sendSample = () => {
      if (!this.#isCurrentRun(run) || run.phase !== 'playing' || !run.commit) return;
      const player = this.#deps.getPlayer();
      const barrier = this.#hostBarrier;
      if (!player || !barrier) return;
      const hostTime = this.#now();
      if (hostTime - run.commit.startAtHost > YOUTUBE_ZERO_START_TIMING.timelineStopAfterMs) return;
      try {
        const reportedState = player.getPlayerState();
        const message: YouTubeZeroStartTimelineMessage = {
          type: MSG.YOUTUBE_ZERO_START_TIMELINE,
          version: 1,
          runId: run.runId,
          sequence: run.sequence,
          queueItemId: run.queueItemId,
          videoId: run.videoId,
          hostTime,
          positionSec: clamp(
            finiteOr(this.#toCanonicalPosition(player.getCurrentTime(), run), 0),
            0,
            31_536_000,
          ),
          playerState: this.#isKnownPlayerState(reportedState)
            ? reportedState
            : YOUTUBE_ZERO_START_PLAYER_STATE.unstarted,
        };
        for (const peerId of barrier.expectedGuestIds) this.#deps.sendToPeer(peerId, message);
      } catch (error) {
        this.#debug('timeline-send-failed', error);
      }
      this.#later(sendSample, YOUTUBE_ZERO_START_TIMING.timelinePollMs);
    };
    this.#later(sendSample, YOUTUBE_ZERO_START_TIMING.timelinePollMs);
  }

  #calibrateLead(run: LocalRun, timelineDriftMs: number): void {
    if (
      this.#deps.getRole() !== 'guest' ||
      run.fallback ||
      !run.calibrationEligible ||
      run.drift08Ms === null
    ) {
      return;
    }
    const localPlatform = this.#deps.getLocalPlatform();
    const androidPair = localPlatform === 'android' || run.hostPlatform === 'android';
    const stabilityLimit = androidPair
      ? YOUTUBE_ZERO_START_TIMING.androidCalibrationStabilityMs
      : YOUTUBE_ZERO_START_TIMING.generalCalibrationStabilityMs;
    if (Math.abs(run.drift08Ms - timelineDriftMs) > stabilityLimit) return;

    const stableTimelineDriftMs = (run.drift08Ms + timelineDriftMs) / 2;
    const estimatedAudibleErrorMs = stableTimelineDriftMs - run.audibleBaseLeadMs;
    const previousTimelineLeadMs = run.timelineLeadMs;
    const insideDeadband =
      androidPair &&
      Math.abs(estimatedAudibleErrorMs) < YOUTUBE_ZERO_START_TIMING.androidTimelineDeadbandMs;
    const requestedTimelineLeadMs = insideDeadband
      ? previousTimelineLeadMs
      : previousTimelineLeadMs -
        estimatedAudibleErrorMs *
          (androidPair ? YOUTUBE_ZERO_START_TIMING.androidTimelineCalibrationRate : 1);
    const boundedTimelineLeadMs = clamp(
      requestedTimelineLeadMs,
      -YOUTUBE_ZERO_START_TIMING.maxRelativeStartLeadMs,
      YOUTUBE_ZERO_START_TIMING.maxRelativeStartLeadMs,
    );
    const totalLeadMs = Math.round(
      clamp(
        run.audibleBaseLeadMs + boundedTimelineLeadMs,
        -YOUTUBE_ZERO_START_TIMING.maxRelativeStartLeadMs,
        YOUTUBE_ZERO_START_TIMING.maxRelativeStartLeadMs,
      ),
    );
    run.releaseLeadMs = totalLeadMs;
    run.timelineLeadMs = totalLeadMs - run.audibleBaseLeadMs;
    this.#learnedTimelineLeads.set(
      this.#platformPairKey(localPlatform, run.hostPlatform),
      run.timelineLeadMs,
    );
    this.#deps.onLearnedTimelineLeadMs?.({
      guestPlatform: localPlatform,
      hostPlatform: run.hostPlatform,
      audibleBaseLeadMs: run.audibleBaseLeadMs,
      previousTimelineLeadMs,
      timelineLeadMs: run.timelineLeadMs,
      totalLeadMs,
      stableTimelineDriftMs,
      estimatedAudibleErrorMs,
    });
    this.#emitState();
  }

  #relativeLead(
    guestPlatform: YouTubeZeroStartPlatform,
    hostPlatform: YouTubeZeroStartPlatform,
  ): { audibleBaseLeadMs: number; timelineLeadMs: number; totalLeadMs: number } {
    const key = this.#platformPairKey(guestPlatform, hostPlatform);
    let learned = this.#learnedTimelineLeads.get(key);
    if (learned === undefined) {
      learned = this.#deps.getLearnedTimelineLeadMs?.(guestPlatform, hostPlatform) ?? undefined;
      if (learned !== undefined && Number.isFinite(learned)) {
        this.#learnedTimelineLeads.set(key, learned);
      }
    }
    return getYouTubeZeroStartRelativeLead(guestPlatform, hostPlatform, learned);
  }

  #resolveLocalTarget(canonicalPositionSec: number, run: LocalRun): number {
    const context = this.#targetContext(run);
    const resolved = this.#deps.resolveLocalTargetSec?.(canonicalPositionSec, context);
    return Math.max(0, finiteOr(resolved ?? canonicalPositionSec, canonicalPositionSec));
  }

  #toCanonicalPosition(localPositionSec: number, run: LocalRun): number {
    const canonical = this.#deps.toCanonicalPositionSec?.(
      localPositionSec,
      this.#targetContext(run),
    );
    return finiteOr(canonical ?? localPositionSec, localPositionSec);
  }

  #targetContext(run: LocalRun): YouTubeZeroStartTargetContext {
    return {
      role: this.#deps.getRole(),
      queueItemId: run.queueItemId,
      videoId: run.videoId,
      subIndex: run.subIndex,
    };
  }

  #failLocalPrepare(run: LocalRun, reason: string, error?: unknown): void {
    if (!this.#isCurrentRun(run)) return;
    this.#clearTimers();
    this.#deps.onError?.(reason, error);
    this.#debug('prepare-failed', { reason, error });
    if (this.#deps.getRole() === 'host') {
      if (run.ownsPlayerState) this.#stopPlaybackBestEffort();
      const shouldHandoff =
        run.hostFallbackEligible && typeof this.#deps.onHostFallbackRequired === 'function';
      const fallbackEvent: YouTubeZeroStartHostFallbackEvent = {
        runId: run.runId,
        queueItemId: run.queueItemId,
        videoId: run.videoId,
        mediaAction: run.mediaAction,
        subIndex: run.subIndex,
        reason,
        desiredMuted: run.audioStateCaptured ? run.originalMuted : null,
        desiredVolume: run.audioStateCaptured ? run.originalVolume : null,
        targetLoadIssued: run.targetLoadIssued,
        handedOffPlayer: run.targetLoadPlayer,
      };
      run.phase = 'error';
      this.#emitState();
      this.cancel('prepare-failed', true, shouldHandoff);
      if (shouldHandoff) this.#deps.onHostFallbackRequired?.(fallbackEvent);
      return;
    }
    if (run.commit) {
      this.#requestExternalFallback(
        run,
        run.commit,
        reason === 'release-ack-timeout' ? 'release-timeout' : 'prepare-failed',
      );
      return;
    }
    if (run.ownsPlayerState) this.#stopPlaybackBestEffort();
    run.phase = 'error';
    this.#emitState();
    // A run that exhausted the bounded restore loop has already made every
    // safe attempt. Other failures still need detached verified cleanup while
    // the exact run identity remains available for a later COMMIT.
    if (reason !== 'audio-restore-timeout') this.#restoreOriginalAudioBounded(run);
  }

  #cancelLocalOnly(stopPlayback = false, transferPlayerState = false): void {
    const run = this.#localRun;
    if (stopPlayback && run?.ownsPlayerState) this.#stopPlaybackBestEffort();
    this.#clearTimers();
    this.#localRun = null;
    this.#hostBarrier = null;
    this.#emitState();
    if (run && !transferPlayerState) this.#restoreOriginalAudioBounded(run);
  }

  #stopPlaybackBestEffort(): void {
    try {
      this.#deps.getPlayer()?.pauseVideo();
    } catch {
      // ABORT cleanup is best-effort; the following legacy snapshot remains
      // authoritative even if the iframe is currently rebuilding.
    }
  }

  #hostTimeToLocal(hostTime: number): number {
    return this.#deps.getRole() === 'host' ? hostTime : hostTime - this.#deps.getClockOffsetMs();
  }

  #restoreOriginalAudioBounded(run: LocalRun): void {
    if (!run.ownsPlayerState || !run.audioStateCaptured || run.phase === 'playing') return;
    const player = this.#deps.getPlayer();
    if (!player) return;
    this.#cancelDetachedAudioRestore();
    const generation = this.#detachedAudioRestoreGeneration;

    const attemptRestore = (attempt: number): void => {
      if (
        generation !== this.#detachedAudioRestoreGeneration ||
        this.#deps.getPlayer() !== player
      ) {
        return;
      }
      let commandError: unknown;
      try {
        player.setVolume(run.originalVolume);
        if (run.originalMuted) player.mute();
        else player.unMute();
      } catch (error) {
        commandError = error;
      }

      this.#detachedAudioRestoreTimer = this.#scheduler.set(() => {
        this.#detachedAudioRestoreTimer = null;
        if (
          generation !== this.#detachedAudioRestoreGeneration ||
          this.#deps.getPlayer() !== player
        ) {
          return;
        }
        let actualMuted: boolean | null = null;
        let actualVolume: number | null = null;
        let verificationError: unknown;
        try {
          actualMuted = player.isMuted();
          actualVolume = finiteOr(player.getVolume(), run.originalVolume);
        } catch (error) {
          verificationError = error;
        }
        const restored =
          actualMuted === run.originalMuted &&
          actualVolume !== null &&
          Math.abs(actualVolume - run.originalVolume) <= 1;
        if (restored) {
          this.#debug('audio-restore-complete', { runId: run.runId, attempts: attempt + 1 });
          return;
        }
        if (attempt + 1 >= YOUTUBE_ZERO_START_TIMING.audioRestoreMaxAttempts) {
          this.#deps.onError?.('audio-restore-timeout', {
            runId: run.runId,
            expectedMuted: run.originalMuted,
            actualMuted,
            expectedVolume: run.originalVolume,
            actualVolume,
            commandError,
            verificationError,
          });
          return;
        }
        attemptRestore(attempt + 1);
      }, YOUTUBE_ZERO_START_TIMING.audibleStateSettleMs);
    };

    attemptRestore(0);
  }

  #cancelDetachedAudioRestore(): void {
    this.#detachedAudioRestoreGeneration += 1;
    if (this.#detachedAudioRestoreTimer !== null) {
      this.#scheduler.clear(this.#detachedAudioRestoreTimer);
      this.#detachedAudioRestoreTimer = null;
    }
  }

  #currentVideoId(player: YouTubeZeroStartPlayer): string {
    try {
      return player.getVideoData().video_id ?? '';
    } catch {
      return '';
    }
  }

  #isPrepareRuntimeReady(): boolean {
    return (
      this.#deps.isPlayerReady() && this.#deps.isAudioUnlocked() && this.#deps.getPlayer() !== null
    );
  }

  #isKnownPlayerState(state: number): boolean {
    return (
      state === YOUTUBE_ZERO_START_PLAYER_STATE.unstarted ||
      state === YOUTUBE_ZERO_START_PLAYER_STATE.ended ||
      state === YOUTUBE_ZERO_START_PLAYER_STATE.playing ||
      state === YOUTUBE_ZERO_START_PLAYER_STATE.paused ||
      state === YOUTUBE_ZERO_START_PLAYER_STATE.buffering ||
      state === YOUTUBE_ZERO_START_PLAYER_STATE.cued
    );
  }

  #sameRun(
    run: LocalRun,
    message:
      | YouTubeZeroStartCommitMessage
      | YouTubeZeroStartAbortMessage
      | YouTubeZeroStartTimelineMessage,
  ): boolean {
    return (
      message.runId === run.runId &&
      message.sequence === run.sequence &&
      message.queueItemId === run.queueItemId &&
      (!('videoId' in message) || message.videoId === run.videoId)
    );
  }

  #isCurrentRun(run: LocalRun): boolean {
    return this.#localRun === run;
  }

  #uniqueLiveGuestIds(): string[] {
    const localPeerId = this.#deps.getLocalPeerId();
    return [
      ...new Set(
        this.#deps
          .getLiveGuestPeerIds()
          .filter((peerId) => Boolean(peerId) && peerId !== localPeerId),
      ),
    ];
  }

  #platformPairKey(
    guestPlatform: YouTubeZeroStartPlatform,
    hostPlatform: YouTubeZeroStartPlatform,
  ): string {
    return `${guestPlatform}->${hostPlatform}`;
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)();
  }

  #later(callback: () => void, delayMs: number): ReturnType<typeof globalThis.setTimeout> {
    const timer = this.#scheduler.set(
      () => {
        this.#timers.delete(timer);
        callback();
      },
      Math.max(0, delayMs),
    );
    this.#timers.add(timer);
    return timer;
  }

  #clearTimers(): void {
    for (const timer of this.#timers) this.#scheduler.clear(timer);
    this.#timers.clear();
  }

  #emitState(): void {
    const busy = this.isInFlight();
    if (busy !== this.#lastBusy) {
      this.#lastBusy = busy;
      this.#deps.onBusyChange?.(busy);
    }
    this.#deps.onPhaseChange?.(this.getSnapshot());
  }

  #debug(message: string, detail?: unknown): void {
    this.#deps.onDebug?.(message, detail);
  }
}

export type YouTubeZeroStartDependenciesForTests = YouTubeZeroStartDependencies;
export {
  YouTubeZeroStartController as YouTubeZeroStartControllerForTests,
  getYouTubeZeroStartRelativeLead as getYouTubeZeroStartRelativeLeadForTests,
};

let defaultController: YouTubeZeroStartController | null = null;

export function initYouTubeZeroStart(
  dependencies: YouTubeZeroStartDependencies,
): YouTubeZeroStartController {
  defaultController?.reset();
  defaultController = new YouTubeZeroStartController(dependencies);
  return defaultController;
}

export function advertiseYouTubeZeroStartCapability(): boolean {
  return defaultController?.advertiseCapability() ?? false;
}

export function canUseYouTubeZeroStart(): boolean {
  return defaultController?.canBeginHostTransition() ?? false;
}

export function beginYouTubeZeroStart(input: YouTubeZeroStartBeginInput): boolean {
  return defaultController?.beginHostTransition(input) ?? false;
}

export function handleYouTubeZeroStartCapability(
  senderPeerId: string,
  message: YouTubeZeroStartCapabilityMessage,
): boolean {
  return defaultController?.handleCapability(senderPeerId, message) ?? false;
}

export function handleYouTubeZeroStartPrepare(
  senderPeerId: string,
  message: YouTubeZeroStartPrepareMessage,
): boolean {
  return defaultController?.handlePrepare(senderPeerId, message) ?? false;
}

export function handleYouTubeZeroStartArmed(
  senderPeerId: string,
  message: YouTubeZeroStartArmedMessage,
): boolean {
  return defaultController?.handleArmed(senderPeerId, message) ?? false;
}

export function handleYouTubeZeroStartCommit(
  senderPeerId: string,
  message: YouTubeZeroStartCommitMessage,
): boolean {
  return defaultController?.handleCommit(senderPeerId, message) ?? false;
}

export function handleYouTubeZeroStartAbort(
  senderPeerId: string,
  message: YouTubeZeroStartAbortMessage,
): boolean {
  return defaultController?.handleAbort(senderPeerId, message) ?? false;
}

export function handleYouTubeZeroStartTimeline(
  senderPeerId: string,
  message: YouTubeZeroStartTimelineMessage,
): boolean {
  return defaultController?.handleTimeline(senderPeerId, message) ?? false;
}

export function handleYouTubeZeroStartPlayerState(state: number): boolean {
  return defaultController?.handlePlayerStateChange(state) ?? false;
}

export function handleYouTubeZeroStartPeerDisconnected(peerId: string): void {
  defaultController?.handlePeerDisconnected(peerId);
}

export function handleYouTubeZeroStartPeerConnectionReplaced(peerId: string): void {
  defaultController?.handlePeerConnectionReplaced(peerId);
}

export function updateYouTubeZeroStartDesiredAudioState(update: {
  muted?: boolean;
  volume?: number;
}): void {
  defaultController?.updateDesiredAudioState(update);
}

export function cancelYouTubeZeroStart(
  reason: YouTubeZeroStartAbortReason = 'cancelled',
  broadcast = true,
): void {
  defaultController?.cancel(reason, broadcast);
}

export function resetYouTubeZeroStart(): void {
  defaultController?.reset();
}

export function isYouTubeZeroStartInFlight(): boolean {
  return defaultController?.isInFlight() ?? false;
}

export function isYouTubeZeroStartProtocolActive(): boolean {
  return defaultController?.isProtocolActive() ?? false;
}

export function getYouTubeZeroStartSnapshot(): YouTubeZeroStartSnapshot | null {
  return defaultController?.getSnapshot() ?? null;
}
