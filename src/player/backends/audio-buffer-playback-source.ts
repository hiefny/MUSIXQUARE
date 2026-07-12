import type { QueueItemId } from '../../types/index.ts';
import {
  createAudioBufferPlaybackStartEvidence,
  createFilePlaybackCutoverTarget,
  createFilePlaybackSourceSnapshot,
  readFilePlaybackCancelIntent,
  readFilePlaybackPauseIntent,
  readFilePlaybackSeekIntent,
  type FilePlaybackCancelIntent,
  type FilePlaybackCutoverArmResult,
  type FilePlaybackCutoverSource,
  type FilePlaybackCutoverTarget,
  type FilePlaybackPauseIntent,
  type FilePlaybackPosition,
  type FilePlaybackSeekIntent,
  type FilePlaybackSourcePhase,
  type FilePlaybackSourceSnapshot,
  type AudioBufferPlaybackStartEvidence,
} from '../file-playback-source.ts';
import {
  readRendezvousArmIntent,
  readRendezvousFinalizeIntent,
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
  readonly cutoverTarget: FilePlaybackCutoverTarget;
  readonly startEvidence: StartEvidenceDeferred;
  readonly cutoverResult: Extract<FilePlaybackCutoverArmResult, { readonly status: 'armed' }>;
  finalized: boolean;
  finalizeIntent: RendezvousFinalizeIntent | null;
  finalizeReceipt: RendezvousFinalizeReceipt | null;
  retired: boolean;
  transition: ScheduledTransition | null;
  startEvidenceTimerHandle: ReturnType<typeof globalThis.setTimeout> | null;
}

interface StartEvidenceDeferred {
  readonly promise: Promise<AudioBufferPlaybackStartEvidence>;
  readonly resolve: (evidence: AudioBufferPlaybackStartEvidence) => void;
  readonly reject: (error: Error) => void;
  settled: boolean;
}

interface PlaybackView {
  readonly phase: FilePlaybackSourcePhase;
  readonly positionSeconds: number;
}

const MAX_IDENTIFIER_LENGTH = 256;
const START_EVIDENCE_GRACE_MS = 2_500;

function freezeLocalRecord<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function startEvidenceError(code: string): Error {
  const error = new Error(`AudioBuffer playback start evidence unavailable: ${code}`);
  error.name = 'FilePlaybackStartEvidenceError';
  Object.defineProperty(error, 'code', { value: code, enumerable: true });
  return error;
}

function createStartEvidenceDeferred(): StartEvidenceDeferred {
  let resolvePromise!: (evidence: AudioBufferPlaybackStartEvidence) => void;
  let rejectPromise!: (error: Error) => void;
  const deferred: StartEvidenceDeferred = {
    promise: new Promise<AudioBufferPlaybackStartEvidence>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    resolve: (evidence) => {
      if (deferred.settled) return;
      deferred.settled = true;
      resolvePromise(evidence);
    },
    reject: (error) => {
      if (deferred.settled) return;
      deferred.settled = true;
      rejectPromise(error);
    },
    settled: false,
  };
  // Lifecycle retirement is allowed to reject before a manager subscribes.
  // Mark the original promise handled without changing what await observes.
  void deferred.promise.catch(() => undefined);
  return deferred;
}

function rejectedCutoverResult(
  receipt: RendezvousArmReceipt,
): Extract<FilePlaybackCutoverArmResult, { readonly status: 'rejected' }> {
  return freezeLocalRecord({ status: 'rejected' as const, receipt, target: null, started: null });
}

function armedCutoverResult(
  receipt: RendezvousArmReceipt,
  target: FilePlaybackCutoverTarget,
  started: Promise<AudioBufferPlaybackStartEvidence>,
): Extract<FilePlaybackCutoverArmResult, { readonly status: 'armed' }> {
  return freezeLocalRecord({ status: 'armed' as const, receipt, target, started });
}

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
export class AudioBufferPlaybackSource implements FilePlaybackCutoverSource {
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
  #ingressEpoch = 0;

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
    this.#advanceIngressEpoch();
    this.#assertNotDestroyed();
    if (this.#phase === 'new') this.#phase = 'ready';
    return this.getSnapshot();
  }

  async connect(destination: AudioNode): Promise<FilePlaybackSourceSnapshot> {
    this.#advanceIngressEpoch();
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

  arm(value: RendezvousArmIntent): Promise<RendezvousArmReceipt> {
    return this.armForCutover(value).then((result) => result.receipt);
  }

  async armForCutover(value: RendezvousArmIntent): Promise<FilePlaybackCutoverArmResult> {
    const ingressEpoch = this.#advanceIngressEpoch();
    this.#settleCurrentExecution();
    const observedAtRoomTimeMs = this.#observedRoomTimeForArm();
    const intent = readRendezvousArmIntent(value);

    if (ingressEpoch !== this.#ingressEpoch) {
      return rejectedCutoverResult(
        this.#armReceipt(intent, 'rejected', 'operation-superseded', observedAtRoomTimeMs),
      );
    }
    if (!intent) {
      return rejectedCutoverResult(
        this.#armReceipt(null, 'rejected', 'invalid-contract', observedAtRoomTimeMs),
      );
    }
    if (this.#phase === 'destroyed') {
      return rejectedCutoverResult(
        this.#armReceipt(intent, 'rejected', 'source-destroyed', observedAtRoomTimeMs),
      );
    }
    if (this.#active !== null && sameArmIntent(this.#active.armIntent, intent)) {
      return this.#active.cutoverResult;
    }
    if (!this.#isContextRunning()) {
      return rejectedCutoverResult(
        this.#armReceipt(intent, 'rejected', 'audio-context-not-running', observedAtRoomTimeMs),
      );
    }
    const roomNow = this.#roomNow();
    if (ingressEpoch !== this.#ingressEpoch) {
      return rejectedCutoverResult(
        this.#armReceipt(intent, 'rejected', 'operation-superseded', observedAtRoomTimeMs),
      );
    }
    if (roomNow === null) {
      return rejectedCutoverResult(
        this.#armReceipt(intent, 'rejected', 'clock-unavailable', observedAtRoomTimeMs),
      );
    }
    if (this.#destination === null) {
      return rejectedCutoverResult(
        this.#armReceipt(intent, 'rejected', 'source-not-connected', observedAtRoomTimeMs),
      );
    }
    if (intent.queueItemId !== this.queueItemId) {
      return rejectedCutoverResult(
        this.#armReceipt(intent, 'rejected', 'queue-item-mismatch', observedAtRoomTimeMs),
      );
    }
    if (intent.revision < this.#revision) {
      return rejectedCutoverResult(
        this.#armReceipt(intent, 'rejected', 'stale-revision', observedAtRoomTimeMs),
      );
    }
    if (
      intent.revision === this.#revision &&
      this.#run !== null &&
      (this.#run.queueItemId !== intent.queueItemId || this.#run.runId !== intent.runId)
    ) {
      return rejectedCutoverResult(
        this.#armReceipt(intent, 'rejected', 'run-mismatch', observedAtRoomTimeMs),
      );
    }
    if (this.#active !== null) {
      if (intent.revision === this.#revision) {
        return rejectedCutoverResult(
          this.#armReceipt(intent, 'rejected', 'run-already-active', observedAtRoomTimeMs),
        );
      }
    }
    if (this.#idleTransition !== null && intent.revision === this.#revision) {
      return rejectedCutoverResult(
        this.#armReceipt(intent, 'rejected', 'transition-pending', observedAtRoomTimeMs),
      );
    }
    if (intent.positionSeconds >= this.#audioBuffer.duration) {
      return rejectedCutoverResult(
        this.#armReceipt(intent, 'rejected', 'offset-out-of-range', observedAtRoomTimeMs),
      );
    }

    const startContextTime = this.#mapRoomTime(intent.startAtRoomTimeMs);
    if (ingressEpoch !== this.#ingressEpoch) {
      return rejectedCutoverResult(
        this.#armReceipt(intent, 'rejected', 'operation-superseded', observedAtRoomTimeMs),
      );
    }
    if (startContextTime === null || startContextTime <= this.#audioContext.currentTime) {
      return rejectedCutoverResult(
        this.#armReceipt(intent, 'rejected', 'start-not-in-future', observedAtRoomTimeMs),
      );
    }
    if (observedAtRoomTimeMs > intent.finalizeByRoomTimeMs) {
      return rejectedCutoverResult(
        this.#armReceipt(intent, 'rejected', 'arm-after-deadline', observedAtRoomTimeMs),
      );
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
      return rejectedCutoverResult(
        this.#armReceipt(intent, 'rejected', 'schedule-failed', observedAtRoomTimeMs),
      );
    }
    let cutoverTarget: FilePlaybackCutoverTarget;
    try {
      cutoverTarget = createFilePlaybackCutoverTarget(
        this.#audioContext,
        startContextTime,
        Math.round(startContextTime * this.#audioContext.sampleRate),
      );
    } catch {
      safeDisconnect(source);
      safeDisconnect(gate);
      return rejectedCutoverResult(
        this.#armReceipt(intent, 'rejected', 'schedule-failed', observedAtRoomTimeMs),
      );
    }
    const receipt = this.#armReceipt(intent, 'armed', null, observedAtRoomTimeMs);
    const startEvidence = createStartEvidenceDeferred();
    const cutoverResult = armedCutoverResult(receipt, cutoverTarget, startEvidence.promise);
    const execution: ActiveExecution = {
      armIntent: intent,
      armReceipt: receipt,
      source,
      gate,
      startContextTime,
      naturalEndContextTime:
        startContextTime +
        (this.#audioBuffer.duration - intent.positionSeconds) / intent.playbackRate,
      offsetSeconds: intent.positionSeconds,
      playbackRate: intent.playbackRate,
      cutoverTarget,
      startEvidence,
      cutoverResult,
      finalized: false,
      finalizeIntent: null,
      finalizeReceipt: null,
      retired: false,
      transition: null,
      startEvidenceTimerHandle: null,
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
      this.#rejectStartEvidence(execution, 'schedule-failed');
      source.onended = null;
      safeDisconnect(source);
      safeDisconnect(gate);
      return rejectedCutoverResult(
        this.#armReceipt(intent, 'rejected', 'schedule-failed', observedAtRoomTimeMs),
      );
    }

    this.#retireActiveExecution();
    this.#active = execution;
    this.#idleTransition = null;
    this.#phase = 'armed';
    this.#revision = intent.revision;
    this.#run = immutableRun(intent);
    this.#positionSeconds = intent.positionSeconds;
    return cutoverResult;
  }

  async finalize(value: RendezvousFinalizeIntent): Promise<RendezvousFinalizeReceipt> {
    const ingressEpoch = this.#advanceIngressEpoch();
    this.#settleCurrentExecution(false);
    const active = this.#active;
    const roomNow = this.#roomNow();
    const observedAtRoomTimeMs = roomNow ?? 0;
    const intent = readRendezvousFinalizeIntent(value);

    if (!intent) {
      return this.#finalizeReceipt(null, 'rejected', 'invalid-contract', observedAtRoomTimeMs);
    }
    if (ingressEpoch !== this.#ingressEpoch) {
      return this.#finalizeReceipt(
        intent,
        'rejected',
        'operation-superseded',
        observedAtRoomTimeMs,
      );
    }
    // Intent canonicalization can invoke Proxy traps. The active execution
    // captured before that boundary is no longer authoritative if a trap
    // cancelled, replaced, or retired it.
    if (this.#active !== active || active?.retired) {
      return this.#finalizeReceipt(
        intent,
        'rejected',
        'operation-superseded',
        observedAtRoomTimeMs,
      );
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
    const finalizeContextTime = this.#audioContext.currentTime;
    if (active.startContextTime <= finalizeContextTime) {
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
    // AudioParam mutation is a native authority boundary. A test double or a
    // platform callback can synchronously cancel, destroy, or replace this
    // execution from inside setValueAtTime(). Never issue an accepted receipt
    // (or its evidence timer) for the retired outer operation.
    if (
      ingressEpoch !== this.#ingressEpoch ||
      this.#active !== active ||
      active.retired ||
      active.finalized
    ) {
      if (this.#active === active && !active.retired && !active.finalized) {
        this.#retireMissedFinalization(active);
      }
      return this.#finalizeReceipt(
        intent,
        'rejected',
        'operation-superseded',
        observedAtRoomTimeMs,
      );
    }
    active.finalized = true;
    active.finalizeIntent = intent;
    active.finalizeReceipt = this.#finalizeReceipt(intent, 'accepted', null, observedAtRoomTimeMs);
    this.#scheduleStartEvidenceTimer(
      active,
      Math.min(
        50,
        Math.max(
          4,
          Math.min(
            (active.cutoverTarget.contextTimeSeconds - finalizeContextTime) * 1_000,
            active.armIntent.startAtRoomTimeMs + START_EVIDENCE_GRACE_MS - observedAtRoomTimeMs,
          ),
        ),
      ),
    );
    return active.finalizeReceipt;
  }

  async cancel(intent: FilePlaybackCancelIntent): Promise<FilePlaybackSourceSnapshot> {
    const canonicalIntent = readFilePlaybackCancelIntent(intent);
    if (
      !canonicalIntent ||
      this.#active === null ||
      this.#active.retired ||
      !sameRun(this.#active.armIntent, canonicalIntent) ||
      this.#active.armIntent.rendezvousId !== canonicalIntent.rendezvousId
    ) {
      return this.#snapshotWithoutReconciliation();
    }

    const active = this.#active;
    const ingressEpoch = this.#advanceIngressEpoch();
    this.#settleCurrentExecution();
    if (
      ingressEpoch !== this.#ingressEpoch ||
      this.#active !== active ||
      active.retired ||
      !sameRun(active.armIntent, canonicalIntent) ||
      active.armIntent.rendezvousId !== canonicalIntent.rendezvousId
    ) {
      return this.#snapshotWithoutReconciliation();
    }

    const current = this.#viewAtContextTime(this.#audioContext.currentTime);
    if (ingressEpoch !== this.#ingressEpoch || this.#active !== active || active.retired) {
      return this.#snapshotWithoutReconciliation();
    }
    this.#positionSeconds = current.positionSeconds;
    this.#retireActiveExecution();
    this.#idleTransition = null;
    this.#phase = 'cancelled';
    return this.#snapshotWithoutReconciliation();
  }

  async pause(intent: FilePlaybackPauseIntent): Promise<FilePlaybackSourceSnapshot> {
    const ingressEpoch = this.#advanceIngressEpoch();
    const canonicalIntent = readFilePlaybackPauseIntent(intent);
    return ingressEpoch === this.#ingressEpoch && canonicalIntent
      ? this.#scheduleTransition(canonicalIntent, 'pause', null, ingressEpoch)
      : this.getSnapshot();
  }

  async seek(intent: FilePlaybackSeekIntent): Promise<FilePlaybackSourceSnapshot> {
    const ingressEpoch = this.#advanceIngressEpoch();
    const canonicalIntent = readFilePlaybackSeekIntent(intent);
    if (ingressEpoch !== this.#ingressEpoch || !canonicalIntent) return this.getSnapshot();
    return this.#scheduleTransition(
      canonicalIntent,
      'seek',
      this.#clampPosition(canonicalIntent.positionSeconds),
      ingressEpoch,
    );
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
    return this.#snapshotWithoutReconciliation();
  }

  #snapshotWithoutReconciliation(): FilePlaybackSourceSnapshot {
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
    this.#advanceIngressEpoch();
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
    ingressEpoch: number,
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
    if (
      ingressEpoch !== this.#ingressEpoch ||
      !sameRun(this.#run, intent) ||
      this.#active !== active
    ) {
      return this.getSnapshot();
    }
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

  #watchForStartEvidence(execution: ActiveExecution): void {
    if (execution.startEvidence.settled) {
      this.#clearStartEvidenceTimer(execution);
      return;
    }
    if (
      this.#active !== execution ||
      execution.retired ||
      !execution.finalized ||
      this.#phase === 'destroyed'
    ) {
      this.#rejectStartEvidence(execution, 'execution-retired');
      return;
    }

    const contextRunning = this.#isContextRunning();
    const currentContextTime = this.#audioContext.currentTime;
    // Native state/time access is an authority boundary too: a test double or
    // platform callback must not let an older execution settle after reentry.
    if (this.#active !== execution || execution.retired || !execution.finalized) {
      this.#rejectStartEvidence(execution, 'operation-superseded');
      return;
    }
    if (
      contextRunning &&
      Number.isFinite(currentContextTime) &&
      currentContextTime >= execution.cutoverTarget.contextTimeSeconds
    ) {
      this.#clearStartEvidenceTimer(execution);
      execution.startEvidence.resolve(
        createAudioBufferPlaybackStartEvidence(execution.cutoverTarget.targetFrame),
      );
      return;
    }

    const roomNow = this.#roomNow();
    if (this.#active !== execution || execution.retired || !execution.finalized) {
      this.#rejectStartEvidence(execution, 'operation-superseded');
      return;
    }
    if (roomNow === null) {
      this.#rejectStartEvidence(execution, 'clock-unavailable');
      return;
    }
    const evidenceDeadlineRoomTimeMs =
      execution.armIntent.startAtRoomTimeMs + START_EVIDENCE_GRACE_MS;
    if (roomNow > evidenceDeadlineRoomTimeMs) {
      this.#rejectStartEvidence(execution, 'start-evidence-timeout');
      return;
    }

    const remainingMs = Number.isFinite(currentContextTime)
      ? Math.max(0, (execution.cutoverTarget.contextTimeSeconds - currentContextTime) * 1_000)
      : 50;
    const remainingEvidenceMs = Math.max(0, evidenceDeadlineRoomTimeMs - roomNow);
    const delayMs = Math.min(
      50,
      Math.max(
        4,
        contextRunning ? Math.min(remainingMs, remainingEvidenceMs) : remainingEvidenceMs,
      ),
    );
    this.#scheduleStartEvidenceTimer(execution, delayMs);
  }

  #scheduleStartEvidenceTimer(execution: ActiveExecution, delayMs: number): void {
    this.#clearStartEvidenceTimer(execution);
    execution.startEvidenceTimerHandle = globalThis.setTimeout(() => {
      execution.startEvidenceTimerHandle = null;
      this.#watchForStartEvidence(execution);
    }, delayMs);
  }

  #rejectStartEvidence(execution: ActiveExecution, code: string): void {
    this.#clearStartEvidenceTimer(execution);
    execution.startEvidence.reject(startEvidenceError(code));
  }

  #clearStartEvidenceTimer(execution: ActiveExecution): void {
    if (execution.startEvidenceTimerHandle === null) return;
    globalThis.clearTimeout(execution.startEvidenceTimerHandle);
    execution.startEvidenceTimerHandle = null;
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
    if (this.#active !== active || active.retired) return;
    if (active.finalized) {
      this.#watchForStartEvidence(active);
      if (this.#active !== active || active.retired) return;
    }
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
    this.#rejectStartEvidence(active, 'execution-ended');
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

    if (execution.finalized) {
      this.#watchForStartEvidence(execution);
      if (this.#active !== execution || execution.retired) return;
    }
    this.#rejectStartEvidence(execution, 'execution-ended');
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
    this.#rejectStartEvidence(active, 'execution-retired');
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
    intent: Readonly<RendezvousArmIntent> | null,
    status: RendezvousArmReceipt['status'],
    reasonCode: string | null,
    observedAtRoomTimeMs: number,
  ): RendezvousArmReceipt {
    return Object.freeze({
      protocolVersion: 2,
      kind: 'rendezvous-armed',
      queueItemId: intent?.queueItemId ?? this.queueItemId,
      runId: intent?.runId ?? 'invalid-run',
      revision: intent?.revision ?? this.#revision,
      rendezvousId: intent?.rendezvousId ?? 'invalid-rendezvous',
      participantId: intent?.recipientId ?? 'invalid-participant',
      status,
      observedAtRoomTimeMs: Math.max(0, observedAtRoomTimeMs),
      bufferedAheadSeconds:
        status === 'armed' ? this.#bufferedAhead(intent?.positionSeconds ?? 0) : 0,
      reasonCode,
    });
  }

  #finalizeReceipt(
    intent: Readonly<RendezvousFinalizeIntent> | null,
    status: RendezvousFinalizeReceipt['status'],
    reasonCode: string | null,
    observedAtRoomTimeMs: number,
  ): RendezvousFinalizeReceipt {
    return Object.freeze({
      protocolVersion: 2,
      kind: 'rendezvous-finalized',
      queueItemId: intent?.queueItemId ?? this.queueItemId,
      runId: intent?.runId ?? 'invalid-run',
      revision: intent?.revision ?? this.#revision,
      rendezvousId: intent?.rendezvousId ?? 'invalid-rendezvous',
      participantId: intent?.recipientId ?? 'invalid-participant',
      status,
      observedAtRoomTimeMs: Math.max(0, observedAtRoomTimeMs),
      reasonCode,
    });
  }

  #observedRoomTimeForArm(): number {
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

  #advanceIngressEpoch(): number {
    this.#ingressEpoch =
      this.#ingressEpoch === Number.MAX_SAFE_INTEGER ? 0 : this.#ingressEpoch + 1;
    return this.#ingressEpoch;
  }
}
