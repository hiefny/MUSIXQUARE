import type { QueueItemId, YouTubeZeroStartPlatform } from '../types/index.ts';

const PLAYER_STATE = Object.freeze({
  playing: 1,
  paused: 2,
  cued: 5,
} as const);

const TIMING = Object.freeze({
  hardMutePollMs: 30,
  hardMuteMaxAttempts: 12,
  warmPlayMs: 260,
  pauseSeekGapMs: 80,
  settlePollMs: 80,
  settleEpsilonSeconds: 0.12,
  restorePollMs: 120,
  restoreMaxAttempts: 8,
  // Leave the server's 3s transition barrier enough time to receive READY.
  prepareTimeoutMs: 2_300,
  releaseAckTimeoutMs: 1_800,
  catchUpToleranceMs: 40,
} as const);

export interface YouTubeAuthorityArmPlayer {
  loadVideoById(videoId: string, startSeconds?: number): void;
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
  getVideoData(): { video_id?: string };
}

interface YouTubeAuthorityArmScheduler {
  set(callback: () => void, delayMs: number): ReturnType<typeof globalThis.setTimeout>;
  clear(timer: ReturnType<typeof globalThis.setTimeout>): void;
}

interface YouTubeAuthorityArmIdentity {
  authorityKey: string;
  queueItemId: QueueItemId;
  videoId: string;
  subIndex: number | null;
}

type YouTubeAuthorityArmStrategy = 'resident' | 'load';

export type YouTubeAuthorityTimingMode = 'zero-start' | 'scheduled-control';

interface YouTubeAuthorityArmPrepareRequest extends YouTubeAuthorityArmIdentity {
  targetSeconds: number;
  strategy: YouTubeAuthorityArmStrategy;
  timeoutMs?: number;
}

interface YouTubeAuthorityArmPreparedRecord extends YouTubeAuthorityArmIdentity {
  targetSeconds: number;
  strategy: YouTubeAuthorityArmStrategy;
  preparedMs: number;
  warmLatencyMs: number;
}

type YouTubeAuthorityArmPrepareFailureReason =
  | 'superseded'
  | 'player-unavailable'
  | 'identity-mismatch'
  | 'hard-mute-timeout'
  | 'warm-timeout'
  | 'settle-timeout'
  | 'audio-restore-timeout'
  | 'player-command-failed';

type YouTubeAuthorityArmPrepareResult =
  | { status: 'ready'; prepared: YouTubeAuthorityArmPreparedRecord }
  | { status: 'failed' | 'superseded'; reason: YouTubeAuthorityArmPrepareFailureReason };

interface YouTubeAuthorityArmCommitRequest extends YouTubeAuthorityArmIdentity {
  /** Delay from now to the canonical execution instant. */
  executeDelayMs: number;
  /** Only a true fresh start is eligible for platform audio-output lead. */
  timingMode: YouTubeAuthorityTimingMode;
  /**
   * Canonical target rebased by the runtime when COMMIT arrived late. Omit it
   * for an on-time commit that should release the already-settled target.
   */
  targetSeconds?: number;
}

export type YouTubeAuthorityArmCommitResult =
  | {
      status: 'applied';
      playCallAtMs: number;
      playingAtMs: number;
      callToPlayingMs: number;
      platformLeadMs: number;
      catchUpSeconds: number;
    }
  | {
      status: 'failed' | 'superseded';
      reason: 'not-prepared' | 'identity-mismatch' | 'release-timeout' | 'player-command-failed';
    };

interface YouTubeAuthorityArmDependencies {
  getPlayer(): YouTubeAuthorityArmPlayer | null;
  getPlatform(): YouTubeZeroStartPlatform;
  /** Monotonic milliseconds. */
  nowMs?(): number;
  scheduler?: YouTubeAuthorityArmScheduler;
  /** Optional participant-local fence in addition to the exact identity key. */
  isIdentityCurrent?(identity: Readonly<YouTubeAuthorityArmIdentity>): boolean;
  onPhaseChange?(phase: YouTubeAuthorityArmPhase): void;
}

type YouTubeAuthorityArmPhase =
  | 'idle'
  | 'muting'
  | 'warming'
  | 'settling'
  | 'restoring-audio'
  | 'prepared'
  | 'scheduled'
  | 'starting'
  | 'playing'
  | 'failed';

type ActiveRun = {
  generation: number;
  identity: YouTubeAuthorityArmIdentity;
  strategy: YouTubeAuthorityArmStrategy;
  player: YouTubeAuthorityArmPlayer;
  targetSeconds: number;
  startedAtMs: number;
  deadlineAtMs: number;
  phase: Exclude<YouTubeAuthorityArmPhase, 'idle'>;
  originalMuted: boolean;
  originalVolume: number;
  warmCallAtMs: number;
  warmLatencyMs: number;
  preparedMs: number;
  warmObserved: boolean;
  stableChecks: number;
  settleAttempts: number;
  prepareSettled: boolean;
  prepareResolve: (result: YouTubeAuthorityArmPrepareResult) => void;
  commitSettled: boolean;
  commitResolve: ((result: YouTubeAuthorityArmCommitResult) => void) | null;
  playCallAtMs: number;
  platformLeadMs: number;
  catchUpSeconds: number;
};

type DetachedAudioRestore = {
  generation: number;
  player: YouTubeAuthorityArmPlayer;
  muted: boolean;
  volume: number;
  attempt: number;
};

const defaultScheduler: YouTubeAuthorityArmScheduler = {
  set: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clear: (timer) => globalThis.clearTimeout(timer),
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function sameIdentity(
  left: Readonly<YouTubeAuthorityArmIdentity>,
  right: Readonly<YouTubeAuthorityArmIdentity>,
): boolean {
  return (
    left.authorityKey === right.authorityKey &&
    left.queueItemId === right.queueItemId &&
    left.videoId === right.videoId &&
    left.subIndex === right.subIndex
  );
}

/** Fixed audible-output lead against the server timeline. */
function getYouTubeAuthorityPlatformLeadMs(platform: YouTubeZeroStartPlatform): number {
  // PRO's fully armed iOS iframe already follows the canonical release. The
  // old 270ms ordinary-room timeline seed made every iOS zero-start early.
  if (platform === 'ios') return 0;
  if (platform === 'android') return 250;
  return 0;
}

export const getYouTubeAuthorityPlatformLeadMsForTests = getYouTubeAuthorityPlatformLeadMs;

/**
 * Participant-local media arming for coordinator-free PRO playback.
 *
 * This class deliberately has no room or transport knowledge. The server owns
 * the barrier; this object proves that one exact iframe occurrence is silent,
 * warm, settled, and ready for the server's execution instant.
 */
export class YouTubeAuthorityArmController {
  readonly #deps: YouTubeAuthorityArmDependencies;
  readonly #scheduler: YouTubeAuthorityArmScheduler;
  readonly #timers = new Set<ReturnType<typeof globalThis.setTimeout>>();
  readonly #detachedRestoreTimers = new Set<ReturnType<typeof globalThis.setTimeout>>();
  #generation = 0;
  #detachedRestoreGeneration = 0;
  #detachedRestore: DetachedAudioRestore | null = null;
  #run: ActiveRun | null = null;

  constructor(dependencies: YouTubeAuthorityArmDependencies) {
    this.#deps = dependencies;
    this.#scheduler = dependencies.scheduler ?? defaultScheduler;
  }

  get phase(): YouTubeAuthorityArmPhase {
    return this.#run?.phase ?? 'idle';
  }

  getPreparedRecord(): YouTubeAuthorityArmPreparedRecord | null {
    const run = this.#run;
    if (!run || run.phase !== 'prepared') return null;
    return this.#preparedRecord(run);
  }

  prepare(
    request: Readonly<YouTubeAuthorityArmPrepareRequest>,
  ): Promise<YouTubeAuthorityArmPrepareResult> {
    this.cancel();

    const identity = this.#normalizeIdentity(request);
    const player = this.#deps.getPlayer();
    if (!player) return Promise.resolve({ status: 'failed', reason: 'player-unavailable' });
    if (!this.#identityIsCurrent(identity)) {
      return Promise.resolve({ status: 'superseded', reason: 'superseded' });
    }
    if (request.strategy === 'resident' && this.#currentVideoId(player) !== identity.videoId) {
      return Promise.resolve({ status: 'failed', reason: 'identity-mismatch' });
    }

    const transferredAudioIntent =
      this.#detachedRestore?.player === player ? this.#detachedRestore : null;
    let originalMuted = transferredAudioIntent?.muted;
    let originalVolume = transferredAudioIntent?.volume;
    if (originalMuted === undefined || originalVolume === undefined) {
      try {
        originalMuted = player.isMuted();
        originalVolume = clamp(Math.round(finiteOr(player.getVolume(), 100)), 0, 100);
      } catch {
        return Promise.resolve({ status: 'failed', reason: 'player-command-failed' });
      }
    }

    const generation = ++this.#generation;
    return new Promise<YouTubeAuthorityArmPrepareResult>((resolve) => {
      const now = this.#now();
      const timeoutMs = clamp(
        finiteOr(request.timeoutMs ?? TIMING.prepareTimeoutMs, 0),
        500,
        20_000,
      );
      const run: ActiveRun = {
        generation,
        identity,
        strategy: request.strategy,
        player,
        targetSeconds: Math.max(0, finiteOr(request.targetSeconds, 0)),
        startedAtMs: now,
        deadlineAtMs: now + timeoutMs,
        phase: 'muting',
        originalMuted,
        originalVolume,
        warmCallAtMs: 0,
        warmLatencyMs: 0,
        preparedMs: 0,
        warmObserved: false,
        stableChecks: 0,
        settleAttempts: 0,
        prepareSettled: false,
        prepareResolve: resolve,
        commitSettled: false,
        commitResolve: null,
        playCallAtMs: 0,
        platformLeadMs: 0,
        catchUpSeconds: 0,
      };
      // `cancel()` restores once synchronously. Once the successor has safely
      // inherited that user audio intent, fence the predecessor's delayed
      // WebKit retries before this run takes ownership and hard-mutes again.
      this.#cancelDetachedAudioRestore();
      this.#run = run;
      this.#emitPhase(run);
      try {
        player.mute();
      } catch {
        this.#failPrepare(run, 'player-command-failed');
        return;
      }
      this.#later(run, () => this.#waitForHardMute(run, 0), 0);
      this.#later(run, () => this.#onPrepareDeadline(run), timeoutMs);
    });
  }

  commit(
    request: Readonly<YouTubeAuthorityArmCommitRequest>,
  ): Promise<YouTubeAuthorityArmCommitResult> {
    const run = this.#run;
    if (!run || run.phase !== 'prepared') {
      return Promise.resolve({ status: 'failed', reason: 'not-prepared' });
    }
    if (!this.#ensurePlayerCurrent(run)) {
      return Promise.resolve({ status: 'superseded', reason: 'identity-mismatch' });
    }
    const identity = this.#normalizeIdentity(request);
    if (!sameIdentity(run.identity, identity) || !this.#identityIsCurrent(identity)) {
      return Promise.resolve({ status: 'superseded', reason: 'identity-mismatch' });
    }

    const executeDelayMs = Math.max(0, finiteOr(request.executeDelayMs, 0));
    run.platformLeadMs =
      request.timingMode === 'zero-start'
        ? getYouTubeAuthorityPlatformLeadMs(this.#deps.getPlatform())
        : 0;
    const committedTargetSeconds = Math.max(
      0,
      finiteOr(request.targetSeconds ?? run.targetSeconds, run.targetSeconds),
    );
    const targetDeltaSeconds = committedTargetSeconds - run.targetSeconds;
    run.catchUpSeconds =
      targetDeltaSeconds * 1_000 > TIMING.catchUpToleranceMs ? targetDeltaSeconds : 0;
    run.phase = 'scheduled';
    this.#emitPhase(run);

    const promise = new Promise<YouTubeAuthorityArmCommitResult>((resolve) => {
      run.commitResolve = resolve;
    });
    const callDelayMs = Math.max(0, executeDelayMs - run.platformLeadMs);
    this.#later(run, () => this.#release(run), callDelayMs);
    return promise;
  }

  /**
   * Returns true only for preparation-owned transitions that the ordinary
   * iframe state handler must suppress. The real release PLAYING event is
   * observed here first, then deliberately returned to the ordinary handler.
   */
  handlePlayerStateChange(state: number): boolean {
    const run = this.#run;
    if (!run) return false;
    if (!this.#ensurePlayerCurrent(run)) return false;

    if (run.phase === 'warming') {
      if (
        state === PLAYER_STATE.playing &&
        this.#currentVideoId(run.player) === run.identity.videoId
      ) {
        this.#observeWarmPlaying(run);
      }
      return true;
    }

    if (run.phase === 'starting') {
      if (
        state === PLAYER_STATE.playing &&
        this.#currentVideoId(run.player) === run.identity.videoId
      ) {
        this.#finishCommit(run);
      }
      return false;
    }

    return (
      run.phase === 'muting' ||
      run.phase === 'settling' ||
      run.phase === 'restoring-audio' ||
      run.phase === 'prepared' ||
      run.phase === 'scheduled'
    );
  }

  cancel(authorityKey?: string): boolean {
    const run = this.#run;
    if (!run || (authorityKey !== undefined && run.identity.authorityKey !== authorityKey)) {
      return false;
    }
    this.#generation += 1;
    this.#clearTimers();
    this.#run = null;
    try {
      run.player.pauseVideo();
    } catch {
      // The exact iframe may have been destroyed; restoration is identity-fenced below.
    }
    this.#beginDetachedAudioRestore(run);
    if (!run.prepareSettled) {
      run.prepareSettled = true;
      run.prepareResolve({ status: 'superseded', reason: 'superseded' });
    }
    if (run.commitResolve && !run.commitSettled) {
      run.commitSettled = true;
      run.commitResolve({ status: 'superseded', reason: 'identity-mismatch' });
    }
    this.#deps.onPhaseChange?.('idle');
    return true;
  }

  /**
   * Teardown/direct-control fence. Unlike prepare-to-prepare supersession,
   * this also revokes detached WebKit audio retries because no successor arm
   * is allowed to inherit their captured intent.
   */
  cancelAll(): boolean {
    const hadDetachedRestore =
      this.#detachedRestore !== null || this.#detachedRestoreTimers.size > 0;
    const cancelledRun = this.cancel();
    this.#cancelDetachedAudioRestore();
    return cancelledRun || hadDetachedRestore;
  }

  #waitForHardMute(run: ActiveRun, attempt: number): void {
    if (!this.#isCurrent(run) || run.phase !== 'muting') return;
    if (!this.#ensurePlayerCurrent(run)) return;
    let muted = false;
    try {
      muted = run.player.isMuted() === true;
    } catch {
      // Retry within the bounded mute window.
    }
    if (!muted) {
      if (attempt + 1 >= TIMING.hardMuteMaxAttempts) {
        this.#failPrepare(run, 'hard-mute-timeout');
        return;
      }
      try {
        run.player.mute();
      } catch {
        // The final bounded poll owns failure reporting.
      }
      this.#later(run, () => this.#waitForHardMute(run, attempt + 1), TIMING.hardMutePollMs);
      return;
    }

    try {
      run.player.setVolume(run.originalVolume);
      run.player.mute();
      run.phase = 'warming';
      run.warmCallAtMs = this.#now();
      this.#emitPhase(run);
      if (run.strategy === 'load') {
        run.player.loadVideoById(run.identity.videoId, run.targetSeconds);
      } else {
        if (this.#currentVideoId(run.player) !== run.identity.videoId) {
          this.#failPrepare(run, 'identity-mismatch');
          return;
        }
        // Establish a fresh state-event boundary without replacing resident media.
        run.player.pauseVideo();
        run.player.playVideo();
      }
      // Some IFrame implementations expose PLAYING synchronously without a
      // callback. Accept the observable state, but never a mere command return.
      if (
        run.player.getPlayerState() === PLAYER_STATE.playing &&
        this.#currentVideoId(run.player) === run.identity.videoId
      ) {
        this.#observeWarmPlaying(run);
      }
    } catch {
      this.#failPrepare(run, 'player-command-failed');
    }
  }

  #observeWarmPlaying(run: ActiveRun): void {
    if (!this.#isCurrent(run) || run.phase !== 'warming' || run.warmObserved) return;
    if (!this.#ensurePlayerCurrent(run)) return;
    run.warmObserved = true;
    run.warmLatencyMs = Math.max(0, this.#now() - run.warmCallAtMs);
    this.#later(run, () => this.#beginSettling(run), TIMING.warmPlayMs);
  }

  #beginSettling(run: ActiveRun): void {
    if (!this.#isCurrent(run) || run.phase !== 'warming') return;
    if (!this.#ensurePlayerCurrent(run)) return;
    try {
      run.player.pauseVideo();
      run.phase = 'settling';
      this.#emitPhase(run);
      this.#later(
        run,
        () => {
          if (!this.#isCurrent(run) || run.phase !== 'settling') return;
          try {
            run.player.seekTo(run.targetSeconds, true);
          } catch {
            this.#failPrepare(run, 'player-command-failed');
            return;
          }
          this.#later(run, () => this.#pollSettled(run), TIMING.settlePollMs);
        },
        TIMING.pauseSeekGapMs,
      );
    } catch {
      this.#failPrepare(run, 'player-command-failed');
    }
  }

  #pollSettled(run: ActiveRun): void {
    if (!this.#isCurrent(run) || run.phase !== 'settling') return;
    if (!this.#ensurePlayerCurrent(run)) return;
    run.settleAttempts += 1;
    try {
      const state = run.player.getPlayerState();
      const stopped = state === PLAYER_STATE.paused || state === PLAYER_STATE.cued;
      const settled =
        this.#currentVideoId(run.player) === run.identity.videoId &&
        stopped &&
        Math.abs(run.player.getCurrentTime() - run.targetSeconds) <= TIMING.settleEpsilonSeconds;
      run.stableChecks = settled ? run.stableChecks + 1 : 0;
      if (!settled) {
        if (state === PLAYER_STATE.playing) run.player.pauseVideo();
        if (run.settleAttempts % 6 === 0) {
          run.player.pauseVideo();
          run.player.seekTo(run.targetSeconds, true);
        }
      }
    } catch {
      run.stableChecks = 0;
    }

    if (run.stableChecks >= 2) {
      this.#beginAudioRestore(run);
      return;
    }
    if (this.#now() >= run.deadlineAtMs) {
      this.#failPrepare(run, 'settle-timeout');
      return;
    }
    this.#later(run, () => this.#pollSettled(run), TIMING.settlePollMs);
  }

  #beginAudioRestore(run: ActiveRun): void {
    if (!this.#isCurrent(run)) return;
    run.phase = 'restoring-audio';
    this.#emitPhase(run);
    this.#attemptAudioRestore(run, 0);
  }

  #attemptAudioRestore(run: ActiveRun, attempt: number): void {
    if (!this.#isCurrent(run) || run.phase !== 'restoring-audio') return;
    if (!this.#ensurePlayerCurrent(run)) return;
    this.#restoreCapturedAudio(run);
    this.#later(
      run,
      () => {
        if (!this.#isCurrent(run) || run.phase !== 'restoring-audio') return;
        let restored: boolean;
        try {
          restored =
            run.player.isMuted() === run.originalMuted &&
            Math.abs(run.player.getVolume() - run.originalVolume) <= 1;
        } catch {
          restored = false;
        }
        if (restored) {
          this.#markPrepared(run);
          return;
        }
        if (attempt + 1 >= TIMING.restoreMaxAttempts) {
          this.#failPrepare(run, 'audio-restore-timeout');
          return;
        }
        this.#attemptAudioRestore(run, attempt + 1);
      },
      TIMING.restorePollMs,
    );
  }

  #markPrepared(run: ActiveRun): void {
    if (!this.#isCurrent(run) || run.prepareSettled) return;
    if (!this.#ensurePlayerCurrent(run)) return;
    run.phase = 'prepared';
    run.prepareSettled = true;
    run.preparedMs = Math.max(0, this.#now() - run.startedAtMs);
    this.#clearTimers();
    this.#emitPhase(run);
    run.prepareResolve({ status: 'ready', prepared: this.#preparedRecord(run) });
  }

  #release(run: ActiveRun): void {
    if (!this.#isCurrent(run) || run.phase !== 'scheduled') return;
    if (!this.#ensurePlayerCurrent(run)) return;
    if (
      !this.#identityIsCurrent(run.identity) ||
      this.#currentVideoId(run.player) !== run.identity.videoId
    ) {
      this.#finishCommitFailure(run, 'identity-mismatch', 'superseded');
      return;
    }
    try {
      if (run.catchUpSeconds > 0) {
        run.player.seekTo(run.targetSeconds + run.catchUpSeconds, true);
      }
      run.phase = 'starting';
      run.playCallAtMs = this.#now();
      this.#emitPhase(run);
      run.player.playVideo();
      if (
        run.phase === 'starting' &&
        run.player.getPlayerState() === PLAYER_STATE.playing &&
        this.#currentVideoId(run.player) === run.identity.videoId
      ) {
        this.#finishCommit(run);
      }
      if (this.#isCurrent(run) && run.phase === 'starting') {
        this.#later(
          run,
          () => this.#finishCommitFailure(run, 'release-timeout', 'failed'),
          TIMING.releaseAckTimeoutMs,
        );
      }
    } catch {
      this.#finishCommitFailure(run, 'player-command-failed', 'failed');
    }
  }

  #finishCommit(run: ActiveRun): void {
    if (!this.#isCurrent(run) || run.phase !== 'starting' || run.commitSettled) return;
    run.phase = 'playing';
    run.commitSettled = true;
    const playingAtMs = this.#now();
    this.#clearTimers();
    this.#emitPhase(run);
    run.commitResolve?.({
      status: 'applied',
      playCallAtMs: run.playCallAtMs,
      playingAtMs,
      callToPlayingMs: Math.max(0, playingAtMs - run.playCallAtMs),
      platformLeadMs: run.platformLeadMs,
      catchUpSeconds: run.catchUpSeconds,
    });
    this.#run = null;
    this.#deps.onPhaseChange?.('idle');
  }

  #finishCommitFailure(
    run: ActiveRun,
    reason: 'identity-mismatch' | 'release-timeout' | 'player-command-failed',
    status: 'failed' | 'superseded',
  ): void {
    if (!this.#isCurrent(run) || run.commitSettled) return;
    run.commitSettled = true;
    this.#clearTimers();
    try {
      run.player.pauseVideo();
    } catch {
      // Best effort; the release result still resolves deterministically.
    }
    run.commitResolve?.({ status, reason });
    this.#run = null;
    this.#beginDetachedAudioRestore(run);
    this.#deps.onPhaseChange?.('idle');
  }

  #onPrepareDeadline(run: ActiveRun): void {
    if (!this.#isCurrent(run) || run.prepareSettled) return;
    const reason = run.phase === 'warming' ? 'warm-timeout' : 'settle-timeout';
    this.#failPrepare(run, reason);
  }

  #failPrepare(run: ActiveRun, reason: YouTubeAuthorityArmPrepareFailureReason): void {
    if (!this.#isCurrent(run) || run.prepareSettled) return;
    run.phase = 'failed';
    run.prepareSettled = true;
    this.#clearTimers();
    try {
      run.player.pauseVideo();
    } catch {
      // Best effort only.
    }
    this.#emitPhase(run);
    run.prepareResolve({ status: reason === 'superseded' ? 'superseded' : 'failed', reason });
    this.#run = null;
    this.#beginDetachedAudioRestore(run);
    this.#deps.onPhaseChange?.('idle');
  }

  #restoreCapturedAudio(run: ActiveRun): void {
    try {
      run.player.setVolume(run.originalVolume);
      if (run.originalMuted) run.player.mute();
      else run.player.unMute();
    } catch {
      // Cancellation/failure cleanup cannot throw through an authority fence.
    }
  }

  /**
   * Failure and supersede can happen exactly while WebKit is applying a hard
   * mute. A single unMute/setVolume pair is not reliable on that boundary.
   * Retry only against the exact iframe instance, and let any successor run
   * revoke the detached retries before it takes ownership.
   */
  #beginDetachedAudioRestore(run: ActiveRun): void {
    this.#cancelDetachedAudioRestore();
    const restore: DetachedAudioRestore = {
      generation: this.#detachedRestoreGeneration,
      player: run.player,
      muted: run.originalMuted,
      volume: run.originalVolume,
      attempt: 0,
    };
    this.#detachedRestore = restore;
    this.#attemptDetachedAudioRestore(restore);
  }

  #attemptDetachedAudioRestore(restore: DetachedAudioRestore): void {
    if (
      this.#detachedRestore !== restore ||
      restore.generation !== this.#detachedRestoreGeneration
    ) {
      return;
    }
    let currentPlayer: YouTubeAuthorityArmPlayer | null;
    try {
      currentPlayer = this.#deps.getPlayer();
    } catch {
      currentPlayer = null;
    }
    if (currentPlayer !== restore.player) {
      this.#finishDetachedAudioRestore(restore);
      return;
    }

    try {
      restore.player.setVolume(restore.volume);
      if (restore.muted) restore.player.mute();
      else restore.player.unMute();
    } catch {
      // The bounded verification below decides whether another attempt is useful.
    }
    restore.attempt += 1;

    let restored: boolean;
    try {
      restored =
        restore.player.isMuted() === restore.muted &&
        Math.abs(restore.player.getVolume() - restore.volume) <= 1;
    } catch {
      restored = false;
    }
    if (restored || restore.attempt >= TIMING.restoreMaxAttempts) {
      this.#finishDetachedAudioRestore(restore);
      return;
    }

    const timer = this.#scheduler.set(() => {
      this.#detachedRestoreTimers.delete(timer);
      this.#attemptDetachedAudioRestore(restore);
    }, TIMING.restorePollMs);
    this.#detachedRestoreTimers.add(timer);
  }

  #finishDetachedAudioRestore(restore: DetachedAudioRestore): void {
    if (this.#detachedRestore === restore) this.#detachedRestore = null;
  }

  #cancelDetachedAudioRestore(): void {
    this.#detachedRestoreGeneration += 1;
    for (const timer of this.#detachedRestoreTimers) this.#scheduler.clear(timer);
    this.#detachedRestoreTimers.clear();
    this.#detachedRestore = null;
  }

  #preparedRecord(run: ActiveRun): YouTubeAuthorityArmPreparedRecord {
    return {
      ...run.identity,
      targetSeconds: run.targetSeconds,
      strategy: run.strategy,
      preparedMs: run.preparedMs,
      warmLatencyMs: run.warmLatencyMs,
    };
  }

  #normalizeIdentity(identity: Readonly<YouTubeAuthorityArmIdentity>): YouTubeAuthorityArmIdentity {
    return {
      authorityKey: identity.authorityKey.trim(),
      queueItemId: identity.queueItemId,
      videoId: identity.videoId.trim(),
      subIndex: identity.subIndex,
    };
  }

  #identityIsCurrent(identity: Readonly<YouTubeAuthorityArmIdentity>): boolean {
    return this.#deps.isIdentityCurrent?.(identity) ?? true;
  }

  #currentVideoId(player: YouTubeAuthorityArmPlayer): string {
    try {
      return player.getVideoData()?.video_id ?? '';
    } catch {
      return '';
    }
  }

  #isCurrent(run: ActiveRun): boolean {
    return this.#run === run && run.generation === this.#generation;
  }

  /**
   * An iframe instance is part of the arm identity. Queue/video IDs alone are
   * insufficient because a rebuilt player can expose the same video while the
   * detached instance still accepts commands. Supersede the old run before it
   * can report READY or release against a player the UI no longer owns.
   */
  #ensurePlayerCurrent(run: ActiveRun): boolean {
    let current: YouTubeAuthorityArmPlayer | null;
    try {
      current = this.#deps.getPlayer();
    } catch {
      current = null;
    }
    if (current === run.player) return true;
    this.cancel(run.identity.authorityKey);
    return false;
  }

  #emitPhase(run: ActiveRun): void {
    if (this.#run === run) this.#deps.onPhaseChange?.(run.phase);
  }

  #now(): number {
    return this.#deps.nowMs?.() ?? globalThis.performance.now();
  }

  #later(run: ActiveRun, callback: () => void, delayMs: number): void {
    const timer = this.#scheduler.set(
      () => {
        this.#timers.delete(timer);
        if (this.#isCurrent(run)) callback();
      },
      Math.max(0, finiteOr(delayMs, 0)),
    );
    this.#timers.add(timer);
  }

  #clearTimers(): void {
    for (const timer of this.#timers) this.#scheduler.clear(timer);
    this.#timers.clear();
  }
}
