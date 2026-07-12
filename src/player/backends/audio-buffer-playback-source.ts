import type { QueueItemId } from '../../types/index.ts';
import {
  createFilePlaybackSourceSnapshot,
  type FilePlaybackCancelIntent,
  type FilePlaybackPauseIntent,
  type FilePlaybackPosition,
  type FilePlaybackSeekIntent,
  type FilePlaybackSource,
  type FilePlaybackSourcePhase,
  type FilePlaybackSourceSnapshot,
} from '../file-playback-source.ts';
import { isPlaybackRevision } from '../playback-timeline.ts';
import {
  isRendezvousArmIntent,
  isRendezvousFinalizeIntent,
  validateRendezvousFinalization,
  type RendezvousArmIntent,
  type RendezvousArmReceipt,
  type RendezvousFinalizeIntent,
  type RendezvousFinalizeReceipt,
  type RevisionedPlaybackRun,
} from '../rendezvous-contract.ts';

export interface AudioBufferPlaybackSourceOptions {
  readonly queueItemId: QueueItemId;
  readonly audioBuffer: AudioBuffer;
  readonly audioContext: AudioContext;
  /** Authoritative monotonic room clock. It must not derive from AudioContext.currentTime. */
  readonly nowRoomTimeMs: () => number;
  readonly roomTimeMsToContextTime: (roomTimeMs: number) => number;
  readonly localPerformanceMsToContextTime: (localPerformanceTimeMs: number) => number;
}

interface ScheduledTransition {
  readonly kind: 'pause' | 'seek';
  readonly atContextTime: number;
  readonly positionSeconds: number;
}

interface ActiveExecution {
  readonly armIntent: RendezvousArmIntent;
  readonly armReceipt: RendezvousArmReceipt;
  readonly source: AudioBufferSourceNode;
  readonly gate: GainNode;
  readonly startContextTime: number;
  readonly naturalEndContextTime: number;
  readonly offsetSeconds: number;
  readonly playbackRate: number;
  finalized: boolean;
  finalizeIntent: RendezvousFinalizeIntent | null;
  finalizeReceipt: RendezvousFinalizeReceipt | null;
  retired: boolean;
  transition: ScheduledTransition | null;
}

interface PlaybackView {
  readonly phase: FilePlaybackSourcePhase;
  readonly positionSeconds: number;
}

const MAX_IDENTIFIER_LENGTH = 256;

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH;
}

function immutableRun(run: RevisionedPlaybackRun): RevisionedPlaybackRun {
  return Object.freeze({
    queueItemId: run.queueItemId,
    runId: run.runId,
    revision: run.revision,
  });
}

function sameRun(left: RevisionedPlaybackRun | null, right: RevisionedPlaybackRun): boolean {
  return (
    left !== null &&
    left.queueItemId === right.queueItemId &&
    left.runId === right.runId &&
    left.revision === right.revision
  );
}

function sameArmIntent(left: RendezvousArmIntent, right: RendezvousArmIntent): boolean {
  return (
    left.protocolVersion === right.protocolVersion &&
    left.queueItemId === right.queueItemId &&
    left.runId === right.runId &&
    left.revision === right.revision &&
    left.rendezvousId === right.rendezvousId &&
    left.recipientId === right.recipientId &&
    left.positionSeconds === right.positionSeconds &&
    left.playbackRate === right.playbackRate &&
    left.startAtRoomTimeMs === right.startAtRoomTimeMs &&
    left.finalizeByRoomTimeMs === right.finalizeByRoomTimeMs
  );
}

function sameFinalizeIntent(
  left: RendezvousFinalizeIntent,
  right: RendezvousFinalizeIntent,
): boolean {
  return (
    left.protocolVersion === right.protocolVersion &&
    left.queueItemId === right.queueItemId &&
    left.runId === right.runId &&
    left.revision === right.revision &&
    left.rendezvousId === right.rendezvousId &&
    left.recipientId === right.recipientId &&
    left.startAtRoomTimeMs === right.startAtRoomTimeMs &&
    left.finalizedAtRoomTimeMs === right.finalizedAtRoomTimeMs
  );
}

function safeDisconnect(node: AudioNode): void {
  try {
    node.disconnect();
  } catch {
    // A native node may already be disconnected. Cleanup is intentionally idempotent.
  }
}

/**
 * One-shot AudioBuffer implementation of the common file playback contract.
 *
 * Every run is armed behind a private zero-gain gate. Scheduling the native
 * source is therefore not an audible commit: only an exact, on-time finalize
 * opens that run's gate at the agreed AudioContext frame.
 */
export class AudioBufferPlaybackSource implements FilePlaybackSource {
  readonly queueItemId: QueueItemId;
  readonly backend = 'audio-buffer' as const;

  readonly #audioBuffer: AudioBuffer;
  readonly #audioContext: AudioContext;
  readonly #nowRoomTimeMs: () => number;
  readonly #roomTimeMsToContextTime: (roomTimeMs: number) => number;
  readonly #localPerformanceMsToContextTime: (localPerformanceTimeMs: number) => number;

  #phase: FilePlaybackSourcePhase = 'new';
  #revision = 0;
  #run: RevisionedPlaybackRun | null = null;
  #positionSeconds = 0;
  #destination: AudioNode | null = null;
  #active: ActiveExecution | null = null;
  #idleTransition: ScheduledTransition | null = null;

  constructor(options: AudioBufferPlaybackSourceOptions) {
    if (!isBoundedIdentifier(options.queueItemId)) {
      throw new TypeError('AudioBuffer playback queue item ID is invalid');
    }
    if (
      !Number.isFinite(options.audioBuffer.duration) ||
      options.audioBuffer.duration <= 0 ||
      !Number.isFinite(options.audioBuffer.sampleRate) ||
      options.audioBuffer.sampleRate <= 0 ||
      !Number.isSafeInteger(options.audioBuffer.numberOfChannels) ||
      options.audioBuffer.numberOfChannels <= 0 ||
      options.audioBuffer.numberOfChannels > 8
    ) {
      throw new TypeError('AudioBuffer playback media metadata is invalid');
    }
    if (!Number.isFinite(options.audioContext.sampleRate) || options.audioContext.sampleRate <= 0) {
      throw new TypeError('AudioBuffer playback context is invalid');
    }
    if (
      typeof options.nowRoomTimeMs !== 'function' ||
      typeof options.roomTimeMsToContextTime !== 'function' ||
      typeof options.localPerformanceMsToContextTime !== 'function'
    ) {
      throw new TypeError('AudioBuffer playback clock mappings are invalid');
    }

    this.queueItemId = options.queueItemId;
    this.#audioBuffer = options.audioBuffer;
    this.#audioContext = options.audioContext;
    this.#nowRoomTimeMs = options.nowRoomTimeMs;
    this.#roomTimeMsToContextTime = options.roomTimeMsToContextTime;
    this.#localPerformanceMsToContextTime = options.localPerformanceMsToContextTime;
  }

  async prepare(): Promise<FilePlaybackSourceSnapshot> {
    this.#assertNotDestroyed();
    if (this.#phase === 'new') this.#phase = 'ready';
    return this.getSnapshot();
  }

  async connect(destination: AudioNode): Promise<FilePlaybackSourceSnapshot> {
    this.#assertNotDestroyed();
    if (this.#phase === 'new') {
      throw new Error('AudioBuffer playback source must be prepared before it is connected');
    }
    if (destination.context !== this.#audioContext) {
      throw new TypeError('AudioBuffer playback destination belongs to another AudioContext');
    }
    if (this.#destination !== null && this.#destination !== destination) {
      throw new Error('AudioBuffer playback source is already connected to another destination');
    }
    this.#destination = destination;
    if (this.#phase === 'ready') this.#phase = 'connected';
    return this.getSnapshot();
  }

  async arm(intent: RendezvousArmIntent): Promise<RendezvousArmReceipt> {
    this.#settleCurrentExecution();
    const observedAtRoomTimeMs = this.#observedRoomTimeForArm(intent);

    if (!isRendezvousArmIntent(intent)) {
      return this.#armReceipt(intent, 'rejected', 'invalid-contract', observedAtRoomTimeMs);
    }
    if (this.#phase === 'destroyed') {
      return this.#armReceipt(intent, 'rejected', 'source-destroyed', observedAtRoomTimeMs);
    }
    if (!this.#isContextRunning()) {
      return this.#armReceipt(
        intent,
        'rejected',
        'audio-context-not-running',
        observedAtRoomTimeMs,
      );
    }
    if (this.#roomNow() === null) {
      return this.#armReceipt(intent, 'rejected', 'clock-unavailable', observedAtRoomTimeMs);
    }
    if (this.#destination === null) {
      return this.#armReceipt(intent, 'rejected', 'source-not-connected', observedAtRoomTimeMs);
    }
    if (intent.queueItemId !== this.queueItemId) {
      return this.#armReceipt(intent, 'rejected', 'queue-item-mismatch', observedAtRoomTimeMs);
    }
    if (intent.revision < this.#revision) {
      return this.#armReceipt(intent, 'rejected', 'stale-revision', observedAtRoomTimeMs);
    }
    if (
      intent.revision === this.#revision &&
      this.#run !== null &&
      (this.#run.queueItemId !== intent.queueItemId || this.#run.runId !== intent.runId)
    ) {
      return this.#armReceipt(intent, 'rejected', 'run-mismatch', observedAtRoomTimeMs);
    }
    if (this.#active !== null) {
      if (sameArmIntent(this.#active.armIntent, intent)) return this.#active.armReceipt;
      if (intent.revision === this.#revision) {
        return this.#armReceipt(intent, 'rejected', 'run-already-active', observedAtRoomTimeMs);
      }
    }
    if (this.#idleTransition !== null && intent.revision === this.#revision) {
      return this.#armReceipt(intent, 'rejected', 'transition-pending', observedAtRoomTimeMs);
    }
    if (intent.positionSeconds >= this.#audioBuffer.duration) {
      return this.#armReceipt(intent, 'rejected', 'offset-out-of-range', observedAtRoomTimeMs);
    }

    const startContextTime = this.#mapRoomTime(intent.startAtRoomTimeMs);
    if (startContextTime === null || startContextTime <= this.#audioContext.currentTime) {
      return this.#armReceipt(intent, 'rejected', 'start-not-in-future', observedAtRoomTimeMs);
    }
    if (observedAtRoomTimeMs > intent.finalizeByRoomTimeMs) {
      return this.#armReceipt(intent, 'rejected', 'arm-after-deadline', observedAtRoomTimeMs);
    }

    const claimsRunWatermark = intent.revision > this.#revision || this.#run === null;
    if (claimsRunWatermark) {
      const previous = this.#viewAtContextTime(this.#audioContext.currentTime);
      this.#positionSeconds = previous.positionSeconds;
      this.#retireActiveExecution();
      this.#idleTransition = null;
      this.#revision = intent.revision;
      this.#run = immutableRun(intent);
      this.#phase = 'connected';
    }

    let source: AudioBufferSourceNode;
    let gate: GainNode;
    try {
      source = this.#audioContext.createBufferSource();
      gate = this.#audioContext.createGain();
    } catch {
      return this.#armReceipt(intent, 'rejected', 'schedule-failed', observedAtRoomTimeMs);
    }
    const receipt = this.#armReceipt(intent, 'armed', null, observedAtRoomTimeMs);
    const execution: ActiveExecution = {
      armIntent: Object.freeze({ ...intent }),
      armReceipt: receipt,
      source,
      gate,
      startContextTime,
      naturalEndContextTime:
        startContextTime +
        (this.#audioBuffer.duration - intent.positionSeconds) / intent.playbackRate,
      offsetSeconds: intent.positionSeconds,
      playbackRate: intent.playbackRate,
      finalized: false,
      finalizeIntent: null,
      finalizeReceipt: null,
      retired: false,
      transition: null,
    };

    try {
      source.buffer = this.#audioBuffer;
      source.playbackRate.value = intent.playbackRate;
      gate.gain.setValueAtTime(0, this.#audioContext.currentTime);
      source.connect(gate);
      gate.connect(this.#destination);
      source.onended = () => this.#handleEnded(execution);
      source.start(startContextTime, intent.positionSeconds);
    } catch {
      execution.retired = true;
      source.onended = null;
      safeDisconnect(source);
      safeDisconnect(gate);
      return this.#armReceipt(intent, 'rejected', 'schedule-failed', observedAtRoomTimeMs);
    }

    this.#retireActiveExecution();
    this.#active = execution;
    this.#idleTransition = null;
    this.#phase = 'armed';
    this.#revision = intent.revision;
    this.#run = immutableRun(intent);
    this.#positionSeconds = intent.positionSeconds;
    return receipt;
  }

  async finalize(intent: RendezvousFinalizeIntent): Promise<RendezvousFinalizeReceipt> {
    this.#settleCurrentExecution(false);
    const active = this.#active;
    const roomNow = this.#roomNow();
    const observedAtRoomTimeMs = roomNow ?? 0;

    if (!isRendezvousFinalizeIntent(intent)) {
      return this.#finalizeReceipt(intent, 'rejected', 'invalid-contract', observedAtRoomTimeMs);
    }
    if (active === null || active.retired) {
      return this.#finalizeReceipt(intent, 'rejected', 'source-not-armed', observedAtRoomTimeMs);
    }
    if (active.finalized) {
      if (
        active.finalizeIntent !== null &&
        active.finalizeReceipt !== null &&
        sameFinalizeIntent(active.finalizeIntent, intent)
      ) {
        return active.finalizeReceipt;
      }
      return this.#finalizeReceipt(intent, 'rejected', 'finalize-mismatch', observedAtRoomTimeMs);
    }
    if (!this.#isContextRunning()) {
      const receipt = this.#finalizeReceipt(
        intent,
        'rejected',
        'audio-context-not-running',
        observedAtRoomTimeMs,
      );
      this.#retireMissedFinalization(active);
      return receipt;
    }
    if (roomNow === null) {
      const receipt = this.#finalizeReceipt(
        intent,
        'rejected',
        'clock-unavailable',
        observedAtRoomTimeMs,
      );
      this.#retireMissedFinalization(active);
      return receipt;
    }
    const validation = validateRendezvousFinalization(
      active.armIntent,
      active.armReceipt,
      intent,
      observedAtRoomTimeMs,
    );
    if (!validation.ok) {
      const missed = validation.code === 'finalization-after-deadline';
      const receipt = this.#finalizeReceipt(
        intent,
        missed ? 'missed-deadline' : 'rejected',
        validation.code,
        observedAtRoomTimeMs,
      );
      if (missed) this.#retireMissedFinalization(active);
      return receipt;
    }
    if (active.startContextTime <= this.#audioContext.currentTime) {
      const receipt = this.#finalizeReceipt(
        intent,
        'missed-deadline',
        'start-already-passed',
        observedAtRoomTimeMs,
      );
      this.#retireMissedFinalization(active);
      return receipt;
    }

    active.gate.gain.setValueAtTime(1, active.startContextTime);
    active.finalized = true;
    active.finalizeIntent = Object.freeze({ ...intent });
    active.finalizeReceipt = this.#finalizeReceipt(intent, 'accepted', null, observedAtRoomTimeMs);
    return active.finalizeReceipt;
  }

  async cancel(intent: FilePlaybackCancelIntent): Promise<FilePlaybackSourceSnapshot> {
    this.#settleCurrentExecution();
    if (
      intent.kind !== 'file-playback-cancel' ||
      !sameRun(this.#run, intent) ||
      !isBoundedIdentifier(intent.reasonCode)
    ) {
      return this.getSnapshot();
    }

    const current = this.#viewAtContextTime(this.#audioContext.currentTime);
    this.#positionSeconds = current.positionSeconds;
    this.#retireActiveExecution();
    this.#idleTransition = null;
    this.#phase = 'cancelled';
    return this.getSnapshot();
  }

  async pause(intent: FilePlaybackPauseIntent): Promise<FilePlaybackSourceSnapshot> {
    return this.#scheduleTransition(intent, 'pause', null);
  }

  async seek(intent: FilePlaybackSeekIntent): Promise<FilePlaybackSourceSnapshot> {
    const requestedPosition =
      Number.isFinite(intent.positionSeconds) && intent.positionSeconds >= 0
        ? this.#clampPosition(intent.positionSeconds)
        : null;
    return this.#scheduleTransition(intent, 'seek', requestedPosition);
  }

  positionAt(localPerformanceTimeMs: number): FilePlaybackPosition {
    if (!Number.isFinite(localPerformanceTimeMs) || localPerformanceTimeMs < 0) {
      throw new RangeError('Local performance time must be a finite non-negative number');
    }
    const contextTime = this.#localPerformanceMsToContextTime(localPerformanceTimeMs);
    if (!Number.isFinite(contextTime) || contextTime < 0) {
      throw new RangeError('Local performance time could not be mapped to AudioContext time');
    }
    const view = this.#viewAtContextTime(contextTime);
    return Object.freeze({
      queueItemId: this.queueItemId,
      run: this.#run ? immutableRun(this.#run) : null,
      phase: view.phase,
      positionSeconds: view.positionSeconds,
      bufferedAheadSeconds: this.#bufferedAhead(view.positionSeconds),
      underrunCount: 0,
    });
  }

  getSnapshot(): FilePlaybackSourceSnapshot {
    this.#settleCurrentExecution();
    const view = this.#viewAtContextTime(this.#audioContext.currentTime);
    return createFilePlaybackSourceSnapshot({
      schemaVersion: 1,
      queueItemId: this.queueItemId,
      backend: this.backend,
      phase: view.phase,
      revision: this.#revision,
      run: this.#run,
      durationSeconds: this.#audioBuffer.duration,
      positionSeconds: view.positionSeconds,
      bufferedAheadSeconds: this.#bufferedAhead(view.positionSeconds),
      outputSampleRateHz: this.#audioContext.sampleRate,
      channelCount: this.#audioBuffer.numberOfChannels,
      underrunCount: 0,
      errorCode: null,
    });
  }

  async destroy(): Promise<void> {
    if (this.#phase === 'destroyed') return;
    const current = this.#viewAtContextTime(this.#audioContext.currentTime);
    this.#positionSeconds = current.positionSeconds;
    this.#retireActiveExecution();
    this.#idleTransition = null;
    this.#destination = null;
    this.#run = null;
    this.#phase = 'destroyed';
  }

  async #scheduleTransition(
    intent: FilePlaybackPauseIntent | FilePlaybackSeekIntent,
    kind: ScheduledTransition['kind'],
    requestedPosition: number | null,
  ): Promise<FilePlaybackSourceSnapshot> {
    this.#settleCurrentExecution();
    const active = this.#active;
    if (
      (kind === 'pause' && intent.kind !== 'file-playback-pause') ||
      (kind === 'seek' && intent.kind !== 'file-playback-seek') ||
      !sameRun(this.#run, intent) ||
      !Number.isFinite(intent.atRoomTimeMs) ||
      intent.atRoomTimeMs < 0 ||
      (kind === 'seek' && requestedPosition === null)
    ) {
      return this.getSnapshot();
    }
    const mappedContextTime = this.#mapRoomTime(intent.atRoomTimeMs);
    if (mappedContextTime === null) return this.getSnapshot();
    const transitionContextTime = Math.max(this.#audioContext.currentTime, mappedContextTime);
    if (active === null) {
      if (kind === 'pause') return this.getSnapshot();
      this.#idleTransition = {
        kind,
        atContextTime: transitionContextTime,
        positionSeconds: requestedPosition as number,
      };
      this.#settleCurrentExecution();
      return this.getSnapshot();
    }
    if (active.transition !== null) return this.getSnapshot();

    const viewAtTransition = this.#viewAtContextTime(transitionContextTime);
    const transitionPosition =
      kind === 'seek' ? (requestedPosition as number) : viewAtTransition.positionSeconds;

    active.transition = {
      kind,
      atContextTime: transitionContextTime,
      positionSeconds: transitionPosition,
    };
    active.gate.gain.setValueAtTime(0, transitionContextTime);
    try {
      active.source.stop(transitionContextTime);
    } catch {
      // An already-ended native source is reconciled by the deterministic view below.
    }
    this.#settleCurrentExecution();
    return this.getSnapshot();
  }

  #viewAtContextTime(contextTime: number): PlaybackView {
    const active = this.#active;
    if (active === null || active.retired) {
      if (this.#idleTransition !== null && contextTime >= this.#idleTransition.atContextTime) {
        return {
          phase: 'paused',
          positionSeconds: this.#idleTransition.positionSeconds,
        };
      }
      return { phase: this.#phase, positionSeconds: this.#positionSeconds };
    }

    const transition = active.transition;
    if (
      transition !== null &&
      transition.atContextTime <= active.naturalEndContextTime &&
      contextTime >= transition.atContextTime
    ) {
      return { phase: 'paused', positionSeconds: transition.positionSeconds };
    }
    if (!active.finalized) {
      if (contextTime >= active.naturalEndContextTime) {
        return { phase: 'paused', positionSeconds: active.offsetSeconds };
      }
      return { phase: 'armed', positionSeconds: active.offsetSeconds };
    }
    if (contextTime < active.startContextTime) {
      return { phase: 'armed', positionSeconds: active.offsetSeconds };
    }
    if (contextTime >= active.naturalEndContextTime) {
      return { phase: 'ended', positionSeconds: this.#audioBuffer.duration };
    }
    return {
      phase: 'playing',
      positionSeconds: this.#clampPosition(
        active.offsetSeconds + (contextTime - active.startContextTime) * active.playbackRate,
      ),
    };
  }

  #settleCurrentExecution(expireUnfinalized = true): void {
    const active = this.#active;
    if (active === null || active.retired) {
      if (
        this.#idleTransition !== null &&
        this.#audioContext.currentTime >= this.#idleTransition.atContextTime
      ) {
        this.#phase = 'paused';
        this.#positionSeconds = this.#idleTransition.positionSeconds;
        this.#idleTransition = null;
      }
      return;
    }
    const roomNow = this.#roomNow();
    if (
      expireUnfinalized &&
      !active.finalized &&
      (roomNow === null || roomNow > active.armIntent.finalizeByRoomTimeMs)
    ) {
      this.#retireMissedFinalization(active);
      return;
    }
    const view = this.#viewAtContextTime(this.#audioContext.currentTime);
    const transitionPassed =
      active.transition !== null &&
      active.transition.atContextTime <= active.naturalEndContextTime &&
      this.#audioContext.currentTime >= active.transition.atContextTime;
    const naturalEndPassed = this.#audioContext.currentTime >= active.naturalEndContextTime;
    if (!transitionPassed && !naturalEndPassed) {
      this.#phase = view.phase;
      this.#positionSeconds = view.positionSeconds;
      return;
    }

    this.#phase = view.phase;
    this.#positionSeconds = view.positionSeconds;
    active.retired = true;
    active.source.onended = null;
    safeDisconnect(active.source);
    safeDisconnect(active.gate);
    this.#active = null;
  }

  #handleEnded(execution: ActiveExecution): void {
    safeDisconnect(execution.source);
    safeDisconnect(execution.gate);
    if (execution.retired || this.#active !== execution) return;

    execution.retired = true;
    this.#active = null;
    if (execution.transition !== null) {
      this.#phase = 'paused';
      this.#positionSeconds = execution.transition.positionSeconds;
      return;
    }
    if (execution.finalized) {
      this.#phase = 'ended';
      this.#positionSeconds = this.#audioBuffer.duration;
      return;
    }

    // A source that reached its end without finalization remained behind the
    // closed gate. It did not audibly end; retain its original paused offset.
    this.#phase = 'paused';
    this.#positionSeconds = execution.offsetSeconds;
  }

  #retireMissedFinalization(execution: ActiveExecution): void {
    if (this.#active !== execution || execution.retired) return;
    this.#phase = 'paused';
    this.#positionSeconds = execution.offsetSeconds;
    this.#retireActiveExecution();
  }

  #retireActiveExecution(): void {
    const active = this.#active;
    if (active === null) return;
    active.retired = true;
    active.source.onended = null;
    try {
      active.source.stop();
    } catch {
      // A one-shot source may already have ended or received a scheduled stop.
    }
    safeDisconnect(active.source);
    safeDisconnect(active.gate);
    this.#active = null;
  }

  #armReceipt(
    intent: RendezvousArmIntent,
    status: RendezvousArmReceipt['status'],
    reasonCode: string | null,
    observedAtRoomTimeMs: number,
  ): RendezvousArmReceipt {
    const candidate = intent as unknown as Record<string, unknown>;
    return Object.freeze({
      protocolVersion: 2,
      kind: 'rendezvous-armed',
      queueItemId: isBoundedIdentifier(candidate.queueItemId)
        ? (candidate.queueItemId as QueueItemId)
        : this.queueItemId,
      runId: isBoundedIdentifier(candidate.runId) ? candidate.runId : 'invalid-run',
      revision: isPlaybackRevision(candidate.revision) ? candidate.revision : this.#revision,
      rendezvousId: isBoundedIdentifier(candidate.rendezvousId)
        ? candidate.rendezvousId
        : 'invalid-rendezvous',
      participantId: isBoundedIdentifier(candidate.recipientId)
        ? candidate.recipientId
        : 'invalid-participant',
      status,
      observedAtRoomTimeMs: Math.max(0, observedAtRoomTimeMs),
      bufferedAheadSeconds:
        status === 'armed'
          ? this.#bufferedAhead(
              typeof candidate.positionSeconds === 'number' ? candidate.positionSeconds : 0,
            )
          : 0,
      reasonCode,
    });
  }

  #finalizeReceipt(
    intent: RendezvousFinalizeIntent,
    status: RendezvousFinalizeReceipt['status'],
    reasonCode: string | null,
    observedAtRoomTimeMs: number,
  ): RendezvousFinalizeReceipt {
    const candidate = intent as unknown as Record<string, unknown>;
    return Object.freeze({
      protocolVersion: 2,
      kind: 'rendezvous-finalized',
      queueItemId: isBoundedIdentifier(candidate.queueItemId)
        ? (candidate.queueItemId as QueueItemId)
        : this.queueItemId,
      runId: isBoundedIdentifier(candidate.runId) ? candidate.runId : 'invalid-run',
      revision: isPlaybackRevision(candidate.revision) ? candidate.revision : this.#revision,
      rendezvousId: isBoundedIdentifier(candidate.rendezvousId)
        ? candidate.rendezvousId
        : 'invalid-rendezvous',
      participantId: isBoundedIdentifier(candidate.recipientId)
        ? candidate.recipientId
        : 'invalid-participant',
      status,
      observedAtRoomTimeMs: Math.max(0, observedAtRoomTimeMs),
      reasonCode,
    });
  }

  #observedRoomTimeForArm(_intent: RendezvousArmIntent): number {
    return this.#roomNow() ?? 0;
  }

  #roomNow(): number | null {
    try {
      const roomTimeMs = this.#nowRoomTimeMs();
      return Number.isFinite(roomTimeMs) && roomTimeMs >= 0 ? roomTimeMs : null;
    } catch {
      return null;
    }
  }

  #isContextRunning(): boolean {
    return (this.#audioContext.state as string | undefined) === 'running';
  }

  #mapRoomTime(roomTimeMs: number): number | null {
    try {
      const mapped = this.#roomTimeMsToContextTime(roomTimeMs);
      return Number.isFinite(mapped) && mapped >= 0 ? mapped : null;
    } catch {
      return null;
    }
  }

  #bufferedAhead(positionSeconds: number): number {
    return Math.max(0, this.#audioBuffer.duration - this.#clampPosition(positionSeconds));
  }

  #clampPosition(positionSeconds: number): number {
    return Math.min(this.#audioBuffer.duration, Math.max(0, positionSeconds));
  }

  #assertNotDestroyed(): void {
    if (this.#phase === 'destroyed') {
      throw new Error('AudioBuffer playback source has been destroyed');
    }
  }
}
