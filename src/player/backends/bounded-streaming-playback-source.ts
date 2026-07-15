import { loadPcmRingWorklet } from '../../audio/worklet-loader.ts';
import { clearManagedTimer, setManagedTimer } from '../../core/timers.ts';
import type { QueueItemId } from '../../types/index.ts';
import {
  createFilePlaybackCutoverTarget,
  createFilePlaybackRejectedTransitionResult,
  createFilePlaybackScheduledTransitionResult,
  createFilePlaybackSourceSnapshot,
  createFilePlaybackTransitionEvidence,
  createStreamingPlaybackStartEvidence,
  isConsecutiveFilePlaybackTransition,
  readFilePlaybackCancelIntent,
  readFilePlaybackPauseIntent,
  readFilePlaybackPauseTransitionIntent,
  readFilePlaybackSeekIntent,
  readFilePlaybackSeekTransitionIntent,
  sameFilePlaybackTransitionIntent,
  type FilePlaybackCancelIntent,
  type FilePlaybackCutoverArmResult,
  type FilePlaybackCutoverSource,
  type FilePlaybackCutoverTarget,
  type FilePlaybackPauseIntent,
  type FilePlaybackPauseTransitionIntent,
  type FilePlaybackPosition,
  type FilePlaybackSeekIntent,
  type FilePlaybackSeekTransitionIntent,
  type FilePlaybackSourcePhase,
  type FilePlaybackSourceSnapshot,
  type FilePlaybackTransitionEvidence,
  type FilePlaybackTransitionIntent,
  type FilePlaybackTransitionRejectReason,
  type FilePlaybackTransitionResult,
  type StreamingPlaybackStartEvidence,
} from '../file-playback-source.ts';
import {
  PCM_STREAM_MAX_CHANNELS,
  PCM_STREAM_PROTOCOL_VERSION,
  type PcmRingCommand,
  type PcmRingEvent,
  type PcmStreamRunIdentity,
} from '../streaming/pcm-stream-protocol.ts';
import {
  PCM_RING_DEFAULT_MAX_BYTES,
  PCM_RING_TARGET_CAPACITY_SECONDS,
  PCM_RING_TARGET_PRIME_SECONDS,
  planPcmRingCapacity,
} from '../streaming/pcm-ring-capacity.ts';
import {
  createStreamingMediaTimeline,
  mediaFrameAtPosition,
  outputFrameAtMediaFrame,
  outputFrameAtPosition,
  type StreamingMediaTimeline,
} from '../streaming/media-timeline.ts';
import type { StreamingDecoderAdapter } from '../streaming/decoder-adapter.ts';
import {
  acquireFilePlaybackUniversalLifecycleLease,
  type FilePlaybackUniversalLifecycleLease,
  type FilePlaybackUniversalLifecycleRetirement,
} from '../diagnostics/file-playback-universal-lifecycle-diagnostics.ts';
import { isPlaybackRevision } from '../playback-identity.ts';
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

const PROCESSOR_NAME = 'musixquare-pcm-ring-v3';
const DEFAULT_PREPARE_TIMEOUT_MS = 60_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 4_000;
const START_EVIDENCE_GRACE_MS = 2_500;
const MAX_PLATFORM_TIMER_DELAY_MS = 2_147_483_647;
const MAX_IDENTIFIER_LENGTH = 256;

type WorkletNodeFactory = (
  context: AudioContext,
  name: string,
  options: AudioWorkletNodeOptions,
) => AudioWorkletNode;
type MessageChannelFactory = () => MessageChannel;

/** @internal Renderer seams shared by bounded streaming codec adapters. */
export interface BoundedStreamingPlaybackRuntime {
  readonly loadWorklet: (context: AudioContext) => Promise<void>;
  readonly createWorkletNode: WorkletNodeFactory;
  readonly createMessageChannel: MessageChannelFactory;
}

/** @internal Construction contract used only by codec-specific thin wrappers. */
export interface BoundedStreamingPlaybackSourceOptions {
  readonly queueItemId: QueueItemId;
  /**
   * Called exactly once after common validation. Ownership of the returned
   * adapter transfers immediately to this playback source.
   */
  readonly createDecoder: () => StreamingDecoderAdapter;
  readonly audioContext: AudioContext;
  /** Authoritative monotonic room clock. It must not derive from AudioContext.currentTime. */
  readonly nowRoomTimeMs: () => number;
  readonly roomTimeMsToContextTime: (roomTimeMs: number) => number;
  readonly localPerformanceMsToContextTime: (localPerformanceTimeMs: number) => number;
  readonly prepareTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  /** Local monotonic seam used only for bounded post-finalize evidence waits. */
  readonly nowMonotonicMs?: () => number;
  /** Explicit runtime seam for deterministic browser-boundary tests. */
  readonly runtime?: Partial<BoundedStreamingPlaybackRuntime>;
}

interface GenerationReadiness {
  readonly generation: number;
  decoderReady: boolean;
  primed: boolean;
  settled: boolean;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface WorkletRetirementReadiness {
  settled: boolean;
  readonly promise: Promise<boolean>;
  readonly resolve: (confirmed: boolean) => void;
}

type TrackedLifecycleState = 'live' | 'retiring' | 'released' | 'unconfirmed';

interface TrackedLifecycle {
  readonly lease: FilePlaybackUniversalLifecycleLease;
  retirement: FilePlaybackUniversalLifecycleRetirement | null;
  state: TrackedLifecycleState;
}

function acquireTrackedLifecycle(
  kind: 'playbackSources' | 'ports' | 'rings' | 'timers',
): TrackedLifecycle {
  return {
    lease: acquireFilePlaybackUniversalLifecycleLease(kind),
    retirement: null,
    state: 'live',
  };
}

function beginTrackedRetirement(tracked: TrackedLifecycle): void {
  if (tracked.state !== 'live') return;
  tracked.retirement = tracked.lease.beginRetire();
  tracked.state = 'retiring';
}

function releaseTrackedLifecycle(tracked: TrackedLifecycle): void {
  beginTrackedRetirement(tracked);
  if (tracked.state !== 'retiring' || !tracked.retirement) return;
  tracked.retirement.release();
  tracked.state = 'released';
}

function forceTrackedLifecycleUnconfirmed(tracked: TrackedLifecycle): void {
  if (tracked.state === 'released' || tracked.state === 'unconfirmed') return;
  if (tracked.state === 'live') tracked.lease.forceUnconfirmed();
  else tracked.retirement?.forceUnconfirmed();
  tracked.state = 'unconfirmed';
}

interface PendingAck {
  readonly generation: number;
  readonly identity: PcmStreamRunIdentity;
  readonly expectedType: 'armed' | 'finalized';
  readonly expectedTargetFrame: number;
  readonly promise: Promise<PcmRingEvent>;
  readonly resolve: (event: PcmRingEvent) => void;
  readonly timerKey: string;
}

interface ControlOperation {
  readonly epoch: number;
  readonly controller: AbortController;
}

interface PendingArmOperation {
  readonly intent: RendezvousArmIntent;
  readonly operation: ControlOperation;
  readonly promise: Promise<FilePlaybackCutoverArmResult>;
}

type ArmPreflightResult =
  | {
      readonly ok: true;
      readonly observedAtRoomTimeMs: number;
      readonly targetFrame: number;
      readonly requestedMediaFrame: number;
    }
  | { readonly ok: false; readonly result: FilePlaybackCutoverArmResult };

interface StartEvidenceDeferred {
  readonly promise: Promise<StreamingPlaybackStartEvidence>;
  readonly resolve: (evidence: StreamingPlaybackStartEvidence) => void;
  readonly reject: (error: Error) => void;
  settled: boolean;
}

interface ActiveArm {
  readonly intent: RendezvousArmIntent;
  readonly receipt: RendezvousArmReceipt;
  readonly targetFrame: number;
  readonly cutoverTarget: FilePlaybackCutoverTarget;
  readonly startEvidence: StartEvidenceDeferred;
  readonly cutoverResult: Extract<FilePlaybackCutoverArmResult, { readonly status: 'armed' }>;
  readonly startEvidenceDeadlineFrame: number;
  startEvidenceDeadlineMonotonicMs: number | null;
  startEvidenceTimerHandle: ReturnType<typeof globalThis.setTimeout> | null;
  finalizeIssuedIntent: RendezvousFinalizeIntent | null;
  finalized: boolean;
  finalizeIntent: RendezvousFinalizeIntent | null;
  finalizeReceipt: RendezvousFinalizeReceipt | null;
}

interface PendingCommitResolution {
  readonly active: ActiveArm;
  readonly intent: RendezvousFinalizeIntent;
  readonly promise: Promise<RendezvousFinalizeReceipt>;
  readonly resolve: (receipt: RendezvousFinalizeReceipt) => void;
  readonly timerKey: string;
}

interface PendingFinalizeOperation {
  readonly active: ActiveArm;
  readonly intent: RendezvousFinalizeIntent;
  readonly promise: Promise<RendezvousFinalizeReceipt>;
}

interface PendingPause {
  readonly targetFrame: number;
  readonly mediaFrame: number;
  readonly identity: PcmStreamRunIdentity;
}

interface PendingPauseWait {
  readonly operation: ControlOperation;
  readonly targetFrame: number;
  readonly resolve: () => void;
}

interface TransitionEvidenceDeferred {
  readonly promise: Promise<FilePlaybackTransitionEvidence>;
  readonly resolve: (evidence: FilePlaybackTransitionEvidence) => void;
  readonly reject: (error: Error) => void;
  settled: boolean;
}

interface PendingRevisionTransition {
  readonly intent: Readonly<FilePlaybackTransitionIntent>;
  readonly target: FilePlaybackCutoverTarget;
  readonly positionSeconds: number;
  readonly visibleSnapshot: FilePlaybackSourceSnapshot;
  readonly evidence: TransitionEvidenceDeferred;
  readonly result: Extract<FilePlaybackTransitionResult, { readonly status: 'scheduled' }>;
  readonly pauseIdentity: PcmStreamRunIdentity | null;
  stage: 'scheduled' | 'applying-seek' | 'awaiting-seek-status';
  expectedGeneration: number | null;
  controlOperation: ControlOperation | null;
  timerHandle: ReturnType<typeof globalThis.setTimeout> | null;
}

interface CachedRevisionTransition {
  readonly intent: Readonly<FilePlaybackTransitionIntent>;
  readonly result: Extract<FilePlaybackTransitionResult, { readonly status: 'scheduled' }>;
}

const defaultRuntime: BoundedStreamingPlaybackRuntime = {
  loadWorklet: loadPcmRingWorklet,
  createWorkletNode: (context, name, options) => new AudioWorkletNode(context, name, options),
  createMessageChannel: () => new MessageChannel(),
};

let boundedSourceInstanceCounter = 0;

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isFrame(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasStreamIdentity(
  value: unknown,
): value is Record<string, unknown> & PcmStreamRunIdentity {
  if (!isRecord(value)) return false;
  return (
    isPlaybackRevision(value.revision) &&
    isBoundedIdentifier(value.runId) &&
    isBoundedIdentifier(value.rendezvousId)
  );
}

function hasOptionalStreamIdentity(value: Record<string, unknown>): boolean {
  const present =
    value.revision !== undefined || value.runId !== undefined || value.rendezvousId !== undefined;
  return !present || hasStreamIdentity(value);
}

function isPcmRingEventBoundary(value: unknown): value is PcmRingEvent {
  if (!isRecord(value) || !isBoundedIdentifier(value.type)) return false;
  if (value.protocolVersion !== PCM_STREAM_PROTOCOL_VERSION || !isFrame(value.generation)) {
    return false;
  }
  switch (value.type) {
    case 'primed':
      return (
        isFrame(value.bufferedFrames) &&
        isFrame(value.sampleRate) &&
        (value.sampleRate as number) > 0 &&
        isFrame(value.channels) &&
        (value.channels as number) >= 1 &&
        (value.channels as number) <= PCM_STREAM_MAX_CHANNELS
      );
    case 'armed':
    case 'finalized':
      return hasStreamIdentity(value) && isFrame(value.targetFrame);
    case 'started':
      return (
        hasStreamIdentity(value) &&
        isFrame(value.targetFrame) &&
        isFrame(value.actualStartFrame) &&
        isFrame(value.mediaFrame)
      );
    case 'paused':
      return (
        hasStreamIdentity(value) &&
        isFrame(value.targetFrame) &&
        isFrame(value.actualPauseFrame) &&
        isFrame(value.mediaFrame)
      );
    case 'finished':
      return isFrame(value.mediaFrame);
    case 'pcm-port-retired':
    case 'processor-retired':
      return true;
    case 'status':
      return (
        (value.state === 'priming' ||
          value.state === 'ready' ||
          value.state === 'armed' ||
          value.state === 'playing' ||
          value.state === 'paused' ||
          value.state === 'finished' ||
          value.state === 'interrupted' ||
          value.state === 'stopped') &&
        isFrame(value.bufferedFrames) &&
        isFrame(value.mediaFrame) &&
        isFrame(value.renderFrame) &&
        isFrame(value.underruns) &&
        isFrame(value.overflows)
      );
    case 'rejected':
    case 'interrupted':
      return isBoundedIdentifier(value.code) && hasOptionalStreamIdentity(value);
    default:
      return false;
  }
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

function sameCancelAttempt(
  left: RendezvousArmIntent | null | undefined,
  right: FilePlaybackCancelIntent,
): boolean {
  return !!left && sameRun(left, right) && left.rendezvousId === right.rendezvousId;
}

function runIdentity(
  intent: Readonly<{
    revision: number;
    runId: string;
    rendezvousId: string;
  }>,
): PcmStreamRunIdentity {
  return Object.freeze({
    revision: intent.revision,
    runId: intent.runId,
    rendezvousId: intent.rendezvousId,
  });
}

function sameStreamIdentity(
  left: PcmStreamRunIdentity | null | undefined,
  right: PcmStreamRunIdentity | null | undefined,
): boolean {
  return (
    !!left &&
    !!right &&
    left.revision === right.revision &&
    left.runId === right.runId &&
    left.rendezvousId === right.rendezvousId
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

function boundedTimeout(value: number | undefined, fallback: number, label: string): number {
  const timeout = value ?? fallback;
  if (!Number.isFinite(timeout) || timeout < 100 || timeout > 120_000) {
    throw new RangeError(`${label} must be from 100 through 120000 milliseconds`);
  }
  return timeout;
}

function resolveRuntime(
  value: Partial<BoundedStreamingPlaybackRuntime> | undefined,
): BoundedStreamingPlaybackRuntime {
  const runtime = {
    loadWorklet: value?.loadWorklet ?? defaultRuntime.loadWorklet,
    createWorkletNode: value?.createWorkletNode ?? defaultRuntime.createWorkletNode,
    createMessageChannel: value?.createMessageChannel ?? defaultRuntime.createMessageChannel,
  };
  if (
    typeof runtime.loadWorklet !== 'function' ||
    typeof runtime.createWorkletNode !== 'function' ||
    typeof runtime.createMessageChannel !== 'function'
  ) {
    throw new TypeError('Bounded streaming playback runtime is invalid');
  }
  return Object.freeze(runtime);
}

function closeReturnedDecoderBestEffort(value: unknown): void {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return;
  try {
    const close = (value as { readonly close?: unknown }).close;
    if (typeof close !== 'function') return;
    void Promise.resolve(Reflect.apply(close, value, [])).catch(() => undefined);
  } catch {
    // A failed constructor cannot await cleanup; adapter close remains best effort.
  }
}

function validateReturnedDecoder(value: unknown): StreamingDecoderAdapter {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    throw new TypeError('Bounded streaming decoder factory returned an invalid adapter');
  }
  const adapter = value as Partial<StreamingDecoderAdapter>;
  const info = adapter.info;
  if (
    adapter.opened !== false ||
    typeof adapter.open !== 'function' ||
    typeof adapter.startGeneration !== 'function' ||
    typeof adapter.stopGeneration !== 'function' ||
    typeof adapter.close !== 'function' ||
    !info ||
    !Number.isSafeInteger(info.mediaSampleRateHz) ||
    info.mediaSampleRateHz <= 0 ||
    !Number.isSafeInteger(info.channelCount) ||
    info.channelCount < 1 ||
    info.channelCount > PCM_STREAM_MAX_CHANNELS ||
    !Number.isSafeInteger(info.totalMediaFrames) ||
    info.totalMediaFrames <= 0
  ) {
    throw new TypeError('Bounded streaming decoder factory returned an invalid adapter');
  }
  return value as StreamingDecoderAdapter;
}

function abortError(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  return new DOMException('Streaming playback preparation was aborted', 'AbortError');
}

function safeDisconnect(node: AudioNode | null): boolean {
  if (!node) return true;
  try {
    node.disconnect();
    return true;
  } catch {
    return false;
  }
}

function safeClosePort(port: MessagePort | null): boolean {
  if (!port) return true;
  try {
    port.close();
    return true;
  } catch {
    return false;
  }
}

function safeErrorCode(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  return value.slice(0, MAX_IDENTIFIER_LENGTH);
}

function createReadiness(generation: number): GenerationReadiness {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const readiness: GenerationReadiness = {
    generation,
    decoderReady: false,
    primed: false,
    settled: false,
    promise,
    resolve: () => {
      if (readiness.settled) return;
      readiness.settled = true;
      resolvePromise();
    },
    reject: (error) => {
      if (readiness.settled) return;
      readiness.settled = true;
      rejectPromise(error);
    },
  };
  return readiness;
}

function createWorkletRetirementReadiness(): WorkletRetirementReadiness {
  let resolvePromise!: (confirmed: boolean) => void;
  const promise = new Promise<boolean>((resolve) => {
    resolvePromise = resolve;
  });
  const readiness: WorkletRetirementReadiness = {
    settled: false,
    promise,
    resolve: (confirmed) => {
      if (readiness.settled) return;
      readiness.settled = true;
      resolvePromise(confirmed);
    },
  };
  return readiness;
}

class SupersededPlaybackOperationError extends Error {
  constructor() {
    super('Playback operation was superseded');
    this.name = 'AbortError';
  }
}

function freezeLocalRecord<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function startEvidenceError(code: string): Error {
  const error = new Error(`Streaming playback start evidence unavailable: ${code}`);
  error.name = 'FilePlaybackStartEvidenceError';
  Object.defineProperty(error, 'code', { value: code, enumerable: true });
  return error;
}

function createStartEvidenceDeferred(): StartEvidenceDeferred {
  let resolvePromise!: (evidence: StreamingPlaybackStartEvidence) => void;
  let rejectPromise!: (error: Error) => void;
  const deferred: StartEvidenceDeferred = {
    promise: new Promise<StreamingPlaybackStartEvidence>((resolve, reject) => {
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
  void deferred.promise.catch(() => undefined);
  return deferred;
}

function transitionEvidenceError(code: string): Error {
  const error = new Error(`Streaming playback transition evidence unavailable: ${code}`);
  error.name = 'FilePlaybackTransitionEvidenceError';
  Object.defineProperty(error, 'code', { value: code, enumerable: true });
  return error;
}

function createTransitionEvidenceDeferred(): TransitionEvidenceDeferred {
  let resolvePromise!: (evidence: FilePlaybackTransitionEvidence) => void;
  let rejectPromise!: (error: Error) => void;
  const deferred: TransitionEvidenceDeferred = {
    promise: new Promise<FilePlaybackTransitionEvidence>((resolve, reject) => {
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
  started: Promise<StreamingPlaybackStartEvidence>,
): Extract<FilePlaybackCutoverArmResult, { readonly status: 'armed' }> {
  return freezeLocalRecord({ status: 'armed' as const, receipt, target, started });
}

/**
 * @internal Bounded, RAM-only streaming playback state machine.
 *
 * The injected decoder owns encoded parsing/resampling, while the AudioWorklet
 * owns the bounded PCM ring and the exact render-frame commit. Neither is
 * connected to the product graph until prepare() has completed and connect()
 * is explicitly called by the active-source coordinator.
 */
export class BoundedStreamingPlaybackSource implements FilePlaybackCutoverSource {
  readonly queueItemId: QueueItemId;
  readonly backend = 'bounded-stream' as const;

  readonly #decoder: StreamingDecoderAdapter;
  readonly #audioContext: AudioContext;
  readonly #nowRoomTimeMs: () => number;
  readonly #roomTimeMsToContextTime: (roomTimeMs: number) => number;
  readonly #localPerformanceMsToContextTime: (localPerformanceTimeMs: number) => number;
  readonly #prepareTimeoutMs: number;
  readonly #commandTimeoutMs: number;
  readonly #runtime: BoundedStreamingPlaybackRuntime;
  readonly #nowMonotonicMs: () => number;
  readonly #timeline: StreamingMediaTimeline;
  readonly #lifetimeAbort = new AbortController();
  readonly #timerPrefix: string;
  readonly #sourceLifecycle: TrackedLifecycle;

  #phase: FilePlaybackSourcePhase = 'new';
  #ingressEpoch = 0;
  #revision = 0;
  #run: RevisionedPlaybackRun | null = null;
  #currentRendezvousId: string | null = null;
  #errorCode: string | null = null;
  #destination: AudioNode | null = null;
  #node: AudioWorkletNode | null = null;
  #retiringNode: AudioWorkletNode | null = null;
  #teardownPromise: Promise<void> | null = null;
  #ringLifecycle: TrackedLifecycle | null = null;
  #controlPortLifecycle: TrackedLifecycle | null = null;
  readonly #pcmPortLifecycles = new Map<number, TrackedLifecycle>();
  #workletRetirementReadiness: WorkletRetirementReadiness | null = null;
  #workletRetirementTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  #workletRetirementTimerLifecycle: TrackedLifecycle | null = null;
  #workletFaulted = false;
  #sourceCleanupFaulted = false;
  #generation = 0;
  #readiness: GenerationReadiness | null = null;
  #preparePromise: Promise<FilePlaybackSourceSnapshot> | null = null;
  #controlEpoch = 0;
  #controlOperation: ControlOperation | null = null;
  #pendingArmOperation: PendingArmOperation | null = null;
  #pendingFinalizeOperation: PendingFinalizeOperation | null = null;
  #pendingCommitResolution: PendingCommitResolution | null = null;
  #activeArm: ActiveArm | null = null;
  #pendingArmAck: PendingAck | null = null;
  #pendingFinalizeAck: PendingAck | null = null;
  #pendingPause: PendingPause | null = null;
  #pendingPauseWait: PendingPauseWait | null = null;
  #revisionTransition: PendingRevisionTransition | null = null;
  #lastRevisionTransition: CachedRevisionTransition | null = null;
  #mediaFrame = 0;
  #statusRenderFrame = 0;
  #bufferedFrames = 0;
  #underrunCount = 0;
  #cancelRequested = false;
  #timerSerial = 0;

  constructor(options: BoundedStreamingPlaybackSourceOptions) {
    if (!isBoundedIdentifier(options.queueItemId)) {
      throw new TypeError('Bounded streaming queue item ID is invalid');
    }
    if (
      !options.audioContext ||
      !Number.isFinite(options.audioContext.sampleRate) ||
      !Number.isSafeInteger(options.audioContext.sampleRate) ||
      options.audioContext.sampleRate <= 0
    ) {
      throw new TypeError('Bounded streaming AudioContext is invalid');
    }
    if (
      typeof options.nowRoomTimeMs !== 'function' ||
      typeof options.roomTimeMsToContextTime !== 'function' ||
      typeof options.localPerformanceMsToContextTime !== 'function'
    ) {
      throw new TypeError('Bounded streaming clock mappings are invalid');
    }
    if (typeof options.createDecoder !== 'function') {
      throw new TypeError('Bounded streaming decoder factory is invalid');
    }

    const prepareTimeoutMs = boundedTimeout(
      options.prepareTimeoutMs,
      DEFAULT_PREPARE_TIMEOUT_MS,
      'prepareTimeoutMs',
    );
    const commandTimeoutMs = boundedTimeout(
      options.commandTimeoutMs,
      DEFAULT_COMMAND_TIMEOUT_MS,
      'commandTimeoutMs',
    );
    const nowMonotonicMs = options.nowMonotonicMs ?? (() => globalThis.performance.now());
    if (typeof nowMonotonicMs !== 'function') {
      throw new TypeError('Bounded streaming monotonic clock is invalid');
    }
    const runtime = resolveRuntime(options.runtime);
    const sourceInstance = boundedSourceInstanceCounter + 1;
    if (!Number.isSafeInteger(sourceInstance) || sourceInstance <= 0) {
      throw new RangeError('Bounded streaming source lifetime generation is exhausted');
    }

    let returnedDecoder: unknown;
    let decoder: StreamingDecoderAdapter;
    let timeline: StreamingMediaTimeline;
    try {
      returnedDecoder = options.createDecoder();
      decoder = validateReturnedDecoder(returnedDecoder);
      timeline = createStreamingMediaTimeline({
        mediaSampleRateHz: decoder.info.mediaSampleRateHz,
        outputSampleRateHz: options.audioContext.sampleRate,
        totalMediaFrames: decoder.info.totalMediaFrames,
      });
    } catch (error) {
      closeReturnedDecoderBestEffort(returnedDecoder);
      throw error;
    }

    let sourceLifecycle: TrackedLifecycle;
    try {
      sourceLifecycle = acquireTrackedLifecycle('playbackSources');
    } catch (error) {
      closeReturnedDecoderBestEffort(decoder);
      throw error;
    }

    boundedSourceInstanceCounter = sourceInstance;
    this.queueItemId = options.queueItemId;
    this.#timerPrefix = `bounded-streaming-${sourceInstance.toString(36)}`;
    this.#decoder = decoder;
    this.#audioContext = options.audioContext;
    this.#nowRoomTimeMs = options.nowRoomTimeMs;
    this.#timeline = timeline;
    this.#roomTimeMsToContextTime = options.roomTimeMsToContextTime;
    this.#localPerformanceMsToContextTime = options.localPerformanceMsToContextTime;
    this.#prepareTimeoutMs = prepareTimeoutMs;
    this.#commandTimeoutMs = commandTimeoutMs;
    this.#runtime = runtime;
    this.#nowMonotonicMs = nowMonotonicMs;
    this.#sourceLifecycle = sourceLifecycle;
  }

  async prepare(signal?: AbortSignal): Promise<FilePlaybackSourceSnapshot> {
    this.#advanceIngressEpoch();
    this.#assertNotDestroyed();
    if (this.#phase === 'ready' || this.#phase === 'connected') return this.getSnapshot();
    if (this.#preparePromise) return this.#preparePromise;
    if (this.#phase !== 'new') {
      throw new Error(`Streaming source cannot prepare from phase ${this.#phase}`);
    }

    this.#phase = 'preparing';
    this.#preparePromise = this.#initialize(signal)
      .then(() => {
        if (this.#phase === 'preparing') this.#phase = 'ready';
        return this.getSnapshot();
      })
      .catch((error: unknown) => {
        if (this.#phase !== 'destroyed') {
          const code =
            signal?.aborted || this.#lifetimeAbort.signal.aborted
              ? 'prepare-aborted'
              : error instanceof Error && error.name === 'TimeoutError'
                ? 'prepare-timeout'
                : 'prepare-failed';
          this.#fail(code, error);
        }
        throw error;
      });
    return this.#preparePromise;
  }

  async connect(destination: AudioNode): Promise<FilePlaybackSourceSnapshot> {
    this.#advanceIngressEpoch();
    this.#assertNotDestroyed();
    if (this.#phase === 'new' || this.#phase === 'preparing') {
      throw new Error('Streaming source must be prepared before it is connected');
    }
    if (this.#phase === 'failed') throw new Error('Streaming source has failed');
    if (destination.context !== this.#audioContext) {
      throw new TypeError('Streaming destination belongs to another AudioContext');
    }
    if (this.#destination && this.#destination !== destination) {
      throw new Error('Streaming source is already connected to another destination');
    }
    const node = this.#node;
    if (!node) throw new Error('Streaming AudioWorklet is unavailable');
    if (!this.#destination) {
      node.connect(destination);
      this.#destination = destination;
    }
    if (this.#phase === 'ready') this.#phase = 'connected';
    return this.getSnapshot();
  }

  arm(value: RendezvousArmIntent): Promise<RendezvousArmReceipt> {
    return this.armForCutover(value).then((result) => result.receipt);
  }

  armForCutover(value: RendezvousArmIntent): Promise<FilePlaybackCutoverArmResult> {
    const ingressEpoch = this.#advanceIngressEpoch();
    const intent = readRendezvousArmIntent(value);
    if (!intent) {
      return Promise.resolve(
        rejectedCutoverResult(
          this.#armReceipt(null, 'rejected', 'invalid-contract', this.#roomNow() ?? 0),
        ),
      );
    }
    if (ingressEpoch !== this.#ingressEpoch) {
      return Promise.resolve(
        rejectedCutoverResult(
          this.#armReceipt(intent, 'rejected', 'operation-superseded', this.#roomNow() ?? 0),
        ),
      );
    }

    // An exact retransmission owns the already-started operation. Mutable
    // preflight state (render frame, context state, room deadline) may have
    // advanced while the Worklet acknowledgement is in flight, but it must
    // not turn that duplicate into a contradictory new rejection.
    const pendingBeforePreflight = this.#pendingArmOperation;
    if (
      pendingBeforePreflight &&
      sameArmIntent(pendingBeforePreflight.intent, intent) &&
      ingressEpoch === this.#ingressEpoch &&
      this.#pendingArmOperation === pendingBeforePreflight
    ) {
      return pendingBeforePreflight.promise;
    }

    this.#expireUnfinalizedArm();
    const preflight = this.#preflightArm(intent);
    if (ingressEpoch !== this.#ingressEpoch) {
      return Promise.resolve(
        rejectedCutoverResult(
          this.#armReceipt(
            intent,
            'rejected',
            'operation-superseded',
            preflight.ok ? preflight.observedAtRoomTimeMs : (this.#roomNow() ?? 0),
          ),
        ),
      );
    }
    if (!preflight.ok) return Promise.resolve(preflight.result);

    const pending = this.#pendingArmOperation;
    if (pending) {
      if (sameArmIntent(pending.intent, intent)) return pending.promise;
      if (intent.revision <= pending.intent.revision) {
        return Promise.resolve(
          rejectedCutoverResult(
            this.#armReceipt(
              intent,
              'rejected',
              intent.revision < pending.intent.revision ? 'stale-revision' : 'run-already-active',
              preflight.observedAtRoomTimeMs,
            ),
          ),
        );
      }
    }

    const claimsRunWatermark = intent.revision > this.#revision || this.#run === null;
    const operation = this.#beginControlOperation();
    const promise = this.#armWithOperation(
      intent,
      operation,
      preflight,
      claimsRunWatermark,
      pending?.intent ?? null,
    ).finally(() => {
      if (this.#pendingArmOperation?.operation === operation) {
        this.#pendingArmOperation = null;
      }
      this.#finishControlOperation(operation);
    });
    if (!this.#isCurrentOperation(operation)) return promise;
    this.#pendingArmOperation = { intent, operation, promise };
    return promise;
  }

  #preflightArm(intent: RendezvousArmIntent): ArmPreflightResult {
    const roomNow = this.#roomNow();
    const observedAtRoomTimeMs = roomNow ?? 0;
    const reject = (reasonCode: string): ArmPreflightResult => ({
      ok: false,
      result: rejectedCutoverResult(
        this.#armReceipt(intent, 'rejected', reasonCode, observedAtRoomTimeMs),
      ),
    });

    if (this.#phase === 'destroyed') return reject('source-destroyed');
    if (this.#phase === 'failed') return reject(this.#errorCode ?? 'source-failed');
    if (intent.queueItemId !== this.queueItemId) return reject('queue-item-mismatch');
    if (intent.playbackRate !== 1) return reject('unsupported-playback-rate');
    if (intent.positionSeconds >= this.#durationSeconds) return reject('offset-out-of-range');
    if (intent.revision < this.#revision) return reject('stale-revision');
    if (
      intent.revision === this.#revision &&
      this.#run &&
      (this.#run.queueItemId !== intent.queueItemId || this.#run.runId !== intent.runId)
    ) {
      return reject('run-mismatch');
    }
    if (this.#activeArm && sameArmIntent(this.#activeArm.intent, intent)) {
      return { ok: false, result: this.#activeArm.cutoverResult };
    }
    if (!this.#isContextRunning()) return reject('audio-context-not-running');
    if (roomNow === null) return reject('clock-unavailable');
    if (!this.#destination || !this.#node || !this.#decoder.opened) {
      return reject('source-not-connected');
    }

    const targetFrame = this.#roomTimeToRenderFrame(intent.startAtRoomTimeMs);
    if (targetFrame === null || targetFrame <= this.#currentRenderFrame) {
      return reject('start-not-in-future');
    }
    if (observedAtRoomTimeMs > intent.finalizeByRoomTimeMs) {
      return reject('arm-after-deadline');
    }
    if (this.#activeArm) {
      if (intent.revision <= this.#activeArm.intent.revision) {
        return reject(
          intent.revision < this.#activeArm.intent.revision
            ? 'stale-revision'
            : 'run-already-active',
        );
      }
    }

    return {
      ok: true,
      observedAtRoomTimeMs,
      targetFrame,
      requestedMediaFrame: this.#positionToOutputFrame(intent.positionSeconds),
    };
  }

  async #armWithOperation(
    intent: RendezvousArmIntent,
    operation: ControlOperation,
    preflight: Extract<ArmPreflightResult, { readonly ok: true }>,
    claimsRunWatermark: boolean,
    supersededPendingIntent: RendezvousArmIntent | null,
  ): Promise<FilePlaybackCutoverArmResult> {
    let observedAtRoomTimeMs = preflight.observedAtRoomTimeMs;
    const targetFrame = preflight.targetFrame;
    const requestedMediaFrame = preflight.requestedMediaFrame;
    let forceReset = false;
    if (claimsRunWatermark) {
      const previousActive = this.#activeArm;
      this.#revision = intent.revision;
      this.#run = immutableRun(intent);
      this.#currentRendezvousId = null;
      if (supersededPendingIntent) {
        this.#postCancel(runIdentity(supersededPendingIntent));
        forceReset = this.#phase === 'preparing';
      }
      if (previousActive) {
        this.#cancelRequested = true;
        this.#postCancel(runIdentity(previousActive.intent));
        this.#retireActiveArm('operation-superseded', previousActive);
        this.#pendingPause = null;
        forceReset = true;
      }
    }
    if (this.#phase === 'failed' || this.#phase === 'destroyed') {
      return rejectedCutoverResult(
        this.#armReceipt(
          intent,
          'rejected',
          this.#phase === 'failed' ? (this.#errorCode ?? 'source-failed') : 'source-destroyed',
          observedAtRoomTimeMs,
        ),
      );
    }
    if (
      forceReset ||
      this.#phase === 'preparing' ||
      this.#phase === 'cancelled' ||
      this.#phase === 'ended' ||
      Math.abs(requestedMediaFrame - this.#mediaFrame) > 1
    ) {
      try {
        await this.#resetGeneration(intent.positionSeconds, operation, 'connected');
      } catch (error) {
        if (!this.#isCurrentOperation(operation)) {
          return rejectedCutoverResult(
            this.#armReceipt(intent, 'rejected', 'operation-superseded', this.#roomNow() ?? 0),
          );
        }
        return rejectedCutoverResult(
          this.#armReceipt(
            intent,
            'rejected',
            this.#errorCode ??
              (error instanceof Error && error.name === 'AbortError'
                ? 'seek-prepare-aborted'
                : 'seek-prepare-failed'),
            observedAtRoomTimeMs,
          ),
        );
      }
      if (!this.#isCurrentOperation(operation)) {
        return rejectedCutoverResult(
          this.#armReceipt(intent, 'rejected', 'operation-superseded', this.#roomNow() ?? 0),
        );
      }
      observedAtRoomTimeMs = this.#roomNow() ?? 0;
      if (!this.#isCurrentOperation(operation)) {
        return rejectedCutoverResult(
          this.#armReceipt(intent, 'rejected', 'operation-superseded', observedAtRoomTimeMs),
        );
      }
    }
    if (!this.#isContextRunning()) {
      return rejectedCutoverResult(
        this.#armReceipt(intent, 'rejected', 'audio-context-not-running', observedAtRoomTimeMs),
      );
    }
    const currentRoomTimeMs = this.#roomNow();
    if (!this.#isCurrentOperation(operation)) {
      return rejectedCutoverResult(
        this.#armReceipt(
          intent,
          'rejected',
          'operation-superseded',
          currentRoomTimeMs ?? observedAtRoomTimeMs,
        ),
      );
    }
    if (currentRoomTimeMs === null) {
      return rejectedCutoverResult(
        this.#armReceipt(intent, 'rejected', 'clock-unavailable', observedAtRoomTimeMs),
      );
    }
    if (observedAtRoomTimeMs > intent.finalizeByRoomTimeMs) {
      return rejectedCutoverResult(
        this.#armReceipt(intent, 'rejected', 'arm-after-deadline', observedAtRoomTimeMs),
      );
    }

    const identity = runIdentity(intent);
    this.#cancelRequested = false;
    const ack = this.#createAck(
      'arm',
      identity,
      targetFrame,
      Math.min(
        this.#commandTimeoutMs,
        Math.max(0, intent.finalizeByRoomTimeMs - observedAtRoomTimeMs),
      ),
    );
    this.#postWorklet({
      protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
      type: 'arm',
      generation: this.#generation,
      ...identity,
      targetFrame,
      fadeInFrames: 0,
    });
    const event = await ack.promise;
    if (!this.#isCurrentOperation(operation)) {
      return rejectedCutoverResult(
        this.#armReceipt(intent, 'rejected', 'operation-superseded', this.#roomNow() ?? 0),
      );
    }
    if (event.type !== 'armed') {
      const code = event.type === 'rejected' ? event.code : 'worklet-arm-rejected';
      this.#postCancel(identity);
      return rejectedCutoverResult(
        this.#armReceipt(intent, 'rejected', code, this.#observedRoomTimeForArm(intent)),
      );
    }

    observedAtRoomTimeMs = this.#observedRoomTimeForArm(intent);
    if (!this.#isCurrentOperation(operation)) {
      return rejectedCutoverResult(
        this.#armReceipt(intent, 'rejected', 'operation-superseded', observedAtRoomTimeMs),
      );
    }
    if (observedAtRoomTimeMs > intent.finalizeByRoomTimeMs) {
      this.#postCancel(identity);
      return rejectedCutoverResult(
        this.#armReceipt(intent, 'rejected', 'arm-after-deadline', observedAtRoomTimeMs),
      );
    }
    const receipt = this.#armReceipt(intent, 'armed', null, observedAtRoomTimeMs);
    let cutoverTarget: FilePlaybackCutoverTarget;
    try {
      cutoverTarget = createFilePlaybackCutoverTarget(
        this.#audioContext,
        targetFrame / this.#audioContext.sampleRate,
        targetFrame,
      );
    } catch {
      this.#postCancel(identity);
      return rejectedCutoverResult(
        this.#armReceipt(intent, 'rejected', 'invalid-render-target', observedAtRoomTimeMs),
      );
    }
    if (!this.#isCurrentOperation(operation)) {
      this.#postCancel(identity);
      return rejectedCutoverResult(
        this.#armReceipt(intent, 'rejected', 'operation-superseded', observedAtRoomTimeMs),
      );
    }
    const startEvidence = createStartEvidenceDeferred();
    const cutoverResult = armedCutoverResult(receipt, cutoverTarget, startEvidence.promise);
    this.#revision = intent.revision;
    this.#run = immutableRun(intent);
    this.#phase = 'armed';
    this.#activeArm = {
      intent,
      receipt,
      targetFrame,
      cutoverTarget,
      startEvidence,
      cutoverResult,
      startEvidenceDeadlineFrame: Math.min(
        Number.MAX_SAFE_INTEGER,
        targetFrame + Math.ceil((START_EVIDENCE_GRACE_MS * this.#audioContext.sampleRate) / 1_000),
      ),
      startEvidenceDeadlineMonotonicMs: null,
      startEvidenceTimerHandle: null,
      finalizeIssuedIntent: null,
      finalized: false,
      finalizeIntent: null,
      finalizeReceipt: null,
    };
    this.#currentRendezvousId = intent.rendezvousId;
    return cutoverResult;
  }

  finalize(value: RendezvousFinalizeIntent): Promise<RendezvousFinalizeReceipt> {
    const ingressEpoch = this.#advanceIngressEpoch();
    const active = this.#activeArm;
    const roomNow = this.#roomNow();
    const observedAtRoomTimeMs = roomNow ?? 0;
    const intent = readRendezvousFinalizeIntent(value);
    if (!intent) {
      return Promise.resolve(
        this.#finalizeReceipt(null, 'rejected', 'invalid-contract', observedAtRoomTimeMs),
      );
    }
    if (ingressEpoch !== this.#ingressEpoch) {
      return Promise.resolve(
        this.#finalizeReceipt(intent, 'rejected', 'operation-superseded', observedAtRoomTimeMs),
      );
    }
    // Intent canonicalization can invoke Proxy traps. Do not create a finalize
    // operation for an arm that was cancelled or replaced during inspection.
    if (this.#activeArm !== active || this.#isTerminalPhase()) {
      return Promise.resolve(
        this.#finalizeReceipt(
          intent,
          'rejected',
          this.#phase === 'failed' ? (this.#errorCode ?? 'source-failed') : 'operation-superseded',
          observedAtRoomTimeMs,
        ),
      );
    }
    const pendingFinalize = this.#pendingFinalizeOperation;
    if (pendingFinalize) {
      if (sameFinalizeIntent(pendingFinalize.intent, intent)) return pendingFinalize.promise;
      return Promise.resolve(
        this.#finalizeReceipt(intent, 'rejected', 'finalize-mismatch', observedAtRoomTimeMs),
      );
    }
    if (!active) {
      return Promise.resolve(
        this.#finalizeReceipt(intent, 'rejected', 'source-not-armed', observedAtRoomTimeMs),
      );
    }
    if (active.finalized) {
      if (
        active.finalizeIntent &&
        active.finalizeReceipt &&
        sameFinalizeIntent(active.finalizeIntent, intent)
      ) {
        return Promise.resolve(active.finalizeReceipt);
      }
      return Promise.resolve(
        this.#finalizeReceipt(intent, 'rejected', 'finalize-mismatch', observedAtRoomTimeMs),
      );
    }
    const pendingCommit = this.#pendingCommitResolution;
    if (pendingCommit) {
      if (pendingCommit.active === active && sameFinalizeIntent(pendingCommit.intent, intent)) {
        return pendingCommit.promise;
      }
      return Promise.resolve(
        this.#finalizeReceipt(intent, 'rejected', 'finalize-mismatch', observedAtRoomTimeMs),
      );
    }

    const immutableIntent = intent;
    let resolvePromise!: (receipt: RendezvousFinalizeReceipt) => void;
    let rejectPromise!: (error: unknown) => void;
    const promise = new Promise<RendezvousFinalizeReceipt>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const operation: PendingFinalizeOperation = {
      active,
      intent: immutableIntent,
      promise,
    };
    this.#pendingFinalizeOperation = operation;
    void this.#finalizeWithActive(immutableIntent, active, roomNow, observedAtRoomTimeMs).then(
      (receipt) => {
        if (this.#pendingFinalizeOperation === operation) this.#pendingFinalizeOperation = null;
        resolvePromise(receipt);
      },
      (error: unknown) => {
        if (this.#pendingFinalizeOperation === operation) this.#pendingFinalizeOperation = null;
        rejectPromise(error);
      },
    );
    return promise;
  }

  async #finalizeWithActive(
    intent: RendezvousFinalizeIntent,
    active: ActiveArm,
    roomNow: number | null,
    observedAtRoomTimeMs: number,
  ): Promise<RendezvousFinalizeReceipt> {
    if (this.#activeArm !== active || this.#isTerminalPhase()) {
      return this.#finalizeReceipt(
        intent,
        'rejected',
        this.#phase === 'failed' ? (this.#errorCode ?? 'source-failed') : 'operation-superseded',
        this.#roomNow() ?? observedAtRoomTimeMs,
      );
    }
    const contextRunning = this.#isContextRunning();
    if (this.#activeArm !== active || this.#isTerminalPhase()) {
      return this.#finalizeReceipt(
        intent,
        'rejected',
        this.#phase === 'failed' ? (this.#errorCode ?? 'source-failed') : 'operation-superseded',
        this.#roomNow() ?? observedAtRoomTimeMs,
      );
    }
    if (!contextRunning) {
      this.#postCancel(runIdentity(active.intent));
      this.#retireActiveArm('audio-context-not-running', active);
      if (this.#phase !== 'failed' && this.#phase !== 'destroyed') this.#phase = 'paused';
      return this.#finalizeReceipt(
        intent,
        'rejected',
        'audio-context-not-running',
        observedAtRoomTimeMs,
      );
    }
    if (roomNow === null) {
      this.#postCancel(runIdentity(active.intent));
      this.#retireActiveArm('clock-unavailable', active);
      if (this.#phase !== 'failed' && this.#phase !== 'destroyed') this.#phase = 'paused';
      return this.#finalizeReceipt(intent, 'rejected', 'clock-unavailable', observedAtRoomTimeMs);
    }

    const validation = validateRendezvousFinalization(
      active.intent,
      active.receipt,
      intent,
      observedAtRoomTimeMs,
    );
    if (!validation.ok) {
      const missed = validation.code === 'finalization-after-deadline';
      if (missed) {
        this.#postCancel(runIdentity(active.intent));
        this.#retireActiveArm(validation.code, active);
        if (this.#phase !== 'failed' && this.#phase !== 'destroyed') this.#phase = 'paused';
      }
      return this.#finalizeReceipt(
        intent,
        missed ? 'missed-deadline' : 'rejected',
        validation.code,
        observedAtRoomTimeMs,
      );
    }
    const currentRenderFrame = this.#currentRenderFrame;
    if (this.#activeArm !== active || this.#isTerminalPhase()) {
      return this.#finalizeReceipt(
        intent,
        'rejected',
        this.#phase === 'failed' ? (this.#errorCode ?? 'source-failed') : 'operation-superseded',
        this.#roomNow() ?? observedAtRoomTimeMs,
      );
    }
    if (active.targetFrame <= currentRenderFrame) {
      this.#postCancel(runIdentity(active.intent));
      this.#retireActiveArm('start-already-passed', active);
      if (this.#phase !== 'failed' && this.#phase !== 'destroyed') this.#phase = 'paused';
      return this.#finalizeReceipt(
        intent,
        'missed-deadline',
        'start-already-passed',
        observedAtRoomTimeMs,
      );
    }

    const identity = runIdentity(intent);
    const renderGuardMs = (256 / this.#audioContext.sampleRate) * 1000;
    const ack = this.#createAck(
      'finalize',
      identity,
      active.targetFrame,
      Math.min(
        this.#commandTimeoutMs,
        Math.max(0, intent.startAtRoomTimeMs - observedAtRoomTimeMs - renderGuardMs),
      ),
    );
    // This local-only authority is established at the last possible moment:
    // after exact validation and immediately before the command crosses into
    // the Worklet. A merely pending finalize call must never authorize a
    // `started` event.
    active.finalizeIssuedIntent = intent;
    this.#postWorklet({
      protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
      type: 'finalize',
      generation: this.#generation,
      ...identity,
    });
    const event = await ack.promise;
    if (event.type !== 'finalized') {
      const code = event.type === 'rejected' ? event.code : 'worklet-finalize-rejected';
      if (code === 'worklet-target-mismatch') {
        this.#fail(code);
        return this.#finalizeReceipt(
          intent,
          'rejected',
          code,
          this.#roomNow() ?? observedAtRoomTimeMs,
        );
      }
      const rejectedAtRoomTimeMs = this.#roomNow() ?? observedAtRoomTimeMs;
      if (code === 'worklet-command-timeout' && active.finalized && this.#activeArm === active) {
        active.finalizeIntent = intent;
        active.finalizeReceipt ??= this.#finalizeReceipt(
          intent,
          'accepted',
          null,
          Math.min(rejectedAtRoomTimeMs, intent.startAtRoomTimeMs),
        );
        return active.finalizeReceipt;
      }
      const beforeTarget =
        rejectedAtRoomTimeMs < intent.startAtRoomTimeMs &&
        active.targetFrame > this.#currentRenderFrame;
      if (code === 'worklet-command-timeout' && !beforeTarget && this.#activeArm === active) {
        // Main-thread acknowledgement delivery can lag behind the real-time
        // Worklet. Wait for its exact started/fail-silent event instead of
        // returning a receipt that a later audible state would contradict.
        active.finalizeIntent = intent;
        return this.#waitForCommitResolution(active, intent);
      }

      if (beforeTarget) this.#postCancel(identity);
      if (this.#activeArm === active && (beforeTarget || code !== 'worklet-command-timeout')) {
        this.#retireActiveArm(code, active);
        if (
          this.#phase !== 'failed' &&
          this.#phase !== 'destroyed' &&
          this.#phase !== 'cancelled'
        ) {
          this.#phase = 'paused';
        }
      }
      return this.#finalizeReceipt(
        intent,
        code === 'finalize-too-late' ? 'missed-deadline' : 'rejected',
        code,
        rejectedAtRoomTimeMs,
      );
    }

    if (!this.#isContextRunning()) {
      this.#postCancel(identity);
      this.#retireActiveArm('audio-context-not-running', active);
      if (this.#phase !== 'failed' && this.#phase !== 'destroyed') this.#phase = 'paused';
      return this.#finalizeReceipt(
        intent,
        'rejected',
        'audio-context-not-running',
        this.#roomNow() ?? observedAtRoomTimeMs,
      );
    }
    if (this.#activeArm !== active || this.#phase === 'failed' || this.#phase === 'destroyed') {
      return this.#finalizeReceipt(
        intent,
        'rejected',
        this.#phase === 'failed' ? (this.#errorCode ?? 'source-failed') : 'operation-superseded',
        this.#roomNow() ?? observedAtRoomTimeMs,
      );
    }
    const acceptedAtRoomTimeMs = this.#roomNow() ?? observedAtRoomTimeMs;
    const phaseAfterClock = this.#phase as FilePlaybackSourcePhase;
    if (
      this.#activeArm !== active ||
      phaseAfterClock === 'failed' ||
      phaseAfterClock === 'destroyed'
    ) {
      return this.#finalizeReceipt(
        intent,
        'rejected',
        phaseAfterClock === 'failed'
          ? (this.#errorCode ?? 'source-failed')
          : 'operation-superseded',
        acceptedAtRoomTimeMs,
      );
    }
    active.finalized = true;
    active.finalizeIntent = intent;
    active.finalizeReceipt = this.#finalizeReceipt(
      intent,
      'accepted',
      null,
      Math.min(acceptedAtRoomTimeMs, intent.startAtRoomTimeMs),
    );
    // Room-clock freshness authorized this exact FINALIZE. Once accepted, it
    // must not become a second start gate: the fixed render target plus grace
    // is converted once into a local monotonic hard deadline instead.
    this.#scheduleStartEvidenceDeadline(active);
    if (this.#activeArm !== active) {
      return this.#finalizeReceipt(
        intent,
        'rejected',
        'operation-superseded',
        acceptedAtRoomTimeMs,
      );
    }
    return active.finalizeReceipt;
  }

  async cancel(intent: FilePlaybackCancelIntent): Promise<FilePlaybackSourceSnapshot> {
    const canonicalIntent = readFilePlaybackCancelIntent(intent);
    const active = this.#activeArm;
    const pending = this.#pendingArmOperation;
    const matchingActive =
      pending === null && canonicalIntent && sameCancelAttempt(active?.intent, canonicalIntent)
        ? active
        : null;
    const matchingPending =
      canonicalIntent && sameCancelAttempt(pending?.intent, canonicalIntent) ? pending : null;
    const matchingCurrent =
      pending === null &&
      active === null &&
      canonicalIntent !== null &&
      sameRun(this.#run, canonicalIntent) &&
      this.#currentRendezvousId === canonicalIntent.rendezvousId &&
      (this.#phase === 'preparing' ||
        this.#phase === 'armed' ||
        this.#phase === 'playing' ||
        this.#phase === 'paused');
    if (
      !canonicalIntent ||
      (matchingActive === null && matchingPending === null && !matchingCurrent)
    ) {
      return this.#snapshotWithoutReconciliation();
    }

    const ingressEpoch = this.#advanceIngressEpoch();
    const stillOwnsAttempt = (): boolean => {
      if (ingressEpoch !== this.#ingressEpoch) return false;
      if (matchingPending !== null) {
        return this.#pendingArmOperation === matchingPending;
      }
      if (matchingActive !== null) {
        return this.#pendingArmOperation === null && this.#activeArm === matchingActive;
      }
      return (
        this.#pendingArmOperation === null &&
        this.#activeArm === null &&
        sameRun(this.#run, canonicalIntent) &&
        this.#currentRendezvousId === canonicalIntent.rendezvousId &&
        (this.#phase === 'preparing' ||
          this.#phase === 'armed' ||
          this.#phase === 'playing' ||
          this.#phase === 'paused')
      );
    };
    if (!stillOwnsAttempt()) return this.#snapshotWithoutReconciliation();

    this.#cancelRequested = true;
    const identity = runIdentity((matchingActive ?? matchingPending)?.intent ?? canonicalIntent);
    this.#postCancel(identity);
    this.#decoder.stopGeneration(this.#generation);
    if (!stillOwnsAttempt()) return this.#snapshotWithoutReconciliation();

    this.#rejectRevisionTransition('attempt-cancelled');
    this.#supersedeControlOperations('cancelled');
    if (matchingActive !== null) {
      this.#retireActiveArm('cancelled', matchingActive);
    }
    this.#pendingPause = null;
    this.#currentRendezvousId = null;
    if (this.#phase !== 'failed' && this.#phase !== 'destroyed') {
      this.#phase = 'cancelled';
    }
    return this.#snapshotWithoutReconciliation();
  }

  async pause(intent: FilePlaybackPauseIntent): Promise<FilePlaybackSourceSnapshot> {
    const ingressEpoch = this.#advanceIngressEpoch();
    const canonicalIntent = readFilePlaybackPauseIntent(intent);
    if (
      ingressEpoch !== this.#ingressEpoch ||
      !canonicalIntent ||
      !sameRun(this.#run, canonicalIntent) ||
      this.#phase !== 'playing' ||
      !this.#activeArm ||
      !this.#isContextRunning() ||
      this.#revisionTransition !== null
    ) {
      return this.getSnapshot();
    }
    if (this.#pendingPause) return this.getSnapshot();
    this.#schedulePause(
      canonicalIntent.atRoomTimeMs,
      runIdentity(this.#activeArm.intent),
      ingressEpoch,
    );
    return this.getSnapshot();
  }

  async seek(intent: FilePlaybackSeekIntent): Promise<FilePlaybackSourceSnapshot> {
    const ingressEpoch = this.#advanceIngressEpoch();
    const canonicalIntent = readFilePlaybackSeekIntent(intent);
    if (
      ingressEpoch !== this.#ingressEpoch ||
      !canonicalIntent ||
      !sameRun(this.#run, canonicalIntent) ||
      this.#revisionTransition !== null
    ) {
      return this.getSnapshot();
    }
    const operation = this.#beginControlOperation();
    try {
      const positionSeconds = Math.min(this.#durationSeconds, canonicalIntent.positionSeconds);
      if (this.#phase === 'armed' && this.#activeArm) {
        const active = this.#activeArm;
        this.#postCancel(runIdentity(active.intent));
        this.#retireActiveArm('seek-superseded-arm', active);
        if (this.#errorCode === null) this.#phase = 'paused';
      }
      if (this.#phase === 'playing' && this.#activeArm) {
        const target = this.#schedulePause(
          canonicalIntent.atRoomTimeMs,
          runIdentity(this.#activeArm.intent),
          ingressEpoch,
        );
        if (target === null) return this.getSnapshot();
        try {
          await this.#waitForPause(target, operation);
        } catch (error) {
          if (!this.#isCurrentOperation(operation)) return this.getSnapshot();
          throw error;
        }
      }
      if (!this.#isCurrentOperation(operation)) return this.getSnapshot();
      if (this.#phase === 'failed' || this.#phase === 'destroyed') return this.getSnapshot();
      try {
        await this.#resetGeneration(positionSeconds, operation, 'paused');
      } catch (error) {
        if (!this.#isCurrentOperation(operation)) return this.getSnapshot();
        throw error;
      }
      if (!this.#isCurrentOperation(operation)) return this.getSnapshot();
      this.#phase = 'paused';
      return this.getSnapshot();
    } finally {
      this.#finishControlOperation(operation);
    }
  }

  async pauseRevisioned(
    value: FilePlaybackPauseTransitionIntent,
  ): Promise<FilePlaybackTransitionResult> {
    const ingressEpoch = this.#ingressEpoch;
    const intent = readFilePlaybackPauseTransitionIntent(value);
    return this.#scheduleRevisionTransition(intent, ingressEpoch);
  }

  async seekRevisioned(
    value: FilePlaybackSeekTransitionIntent,
  ): Promise<FilePlaybackTransitionResult> {
    const ingressEpoch = this.#ingressEpoch;
    const intent = readFilePlaybackSeekTransitionIntent(value);
    return this.#scheduleRevisionTransition(intent, ingressEpoch);
  }

  async #scheduleRevisionTransition(
    intent: Readonly<FilePlaybackTransitionIntent> | null,
    observedIngressEpoch: number,
  ): Promise<FilePlaybackTransitionResult> {
    if (!intent) return this.#rejectedRevisionTransition(null, 'invalid-contract');
    if (observedIngressEpoch !== this.#ingressEpoch) {
      return this.#rejectedRevisionTransition(intent, 'operation-superseded');
    }
    if (this.#phase === 'destroyed') {
      return this.#rejectedRevisionTransition(intent, 'source-destroyed');
    }
    if (this.#phase === 'failed') {
      return this.#rejectedRevisionTransition(intent, 'source-failed');
    }
    const last = this.#lastRevisionTransition;
    if (last && sameFilePlaybackTransitionIntent(last.intent, intent)) return last.result;
    if (!isConsecutiveFilePlaybackTransition(intent.from, intent.to)) {
      return this.#rejectedRevisionTransition(intent, 'non-consecutive-revision');
    }
    if (!sameRun(this.#run, intent.from)) {
      return this.#rejectedRevisionTransition(intent, 'identity-mismatch');
    }
    if (
      intent.kind === 'file-playback-seek-transition' &&
      intent.positionSeconds > this.#durationSeconds
    ) {
      return this.#rejectedRevisionTransition(intent, 'position-out-of-range');
    }
    const pending = this.#revisionTransition;
    if (pending) {
      return sameFilePlaybackTransitionIntent(pending.intent, intent)
        ? pending.result
        : this.#rejectedRevisionTransition(intent, 'transition-pending');
    }
    if (intent.kind === 'file-playback-seek-transition' && this.#phase === 'playing') {
      return this.#rejectedRevisionTransition(intent, 'playing-seek-requires-cutover');
    }
    if (
      (intent.kind === 'file-playback-pause-transition' &&
        (this.#phase !== 'playing' || !this.#activeArm)) ||
      (intent.kind === 'file-playback-seek-transition' && this.#phase !== 'paused')
    ) {
      return this.#rejectedRevisionTransition(intent, 'wrong-phase');
    }
    if (!this.#isContextRunning()) {
      return this.#rejectedRevisionTransition(intent, 'audio-context-not-running');
    }
    const targetFrame = this.#roomTimeToRenderFrame(intent.atRoomTimeMs);
    if (observedIngressEpoch !== this.#ingressEpoch) {
      return this.#rejectedRevisionTransition(intent, 'operation-superseded');
    }
    if (targetFrame === null) {
      return this.#rejectedRevisionTransition(intent, 'clock-unavailable');
    }
    const currentFrame = this.#currentRenderFrame;
    if (observedIngressEpoch !== this.#ingressEpoch) {
      return this.#rejectedRevisionTransition(intent, 'operation-superseded');
    }
    const minimumLeadFrames = intent.kind === 'file-playback-pause-transition' ? 128 : 1;
    if (targetFrame < currentFrame + minimumLeadFrames) {
      return this.#rejectedRevisionTransition(intent, 'target-not-in-future');
    }

    let target: FilePlaybackCutoverTarget;
    try {
      target = createFilePlaybackCutoverTarget(
        this.#audioContext,
        targetFrame / this.#audioContext.sampleRate,
        targetFrame,
      );
    } catch {
      return this.#rejectedRevisionTransition(intent, 'schedule-failed');
    }
    const positionSeconds =
      intent.kind === 'file-playback-seek-transition'
        ? intent.positionSeconds
        : this.#viewAtRenderFrame(targetFrame).mediaFrame / this.#audioContext.sampleRate;
    const visibleSnapshot = this.#snapshotWithoutReconciliation();
    const evidence = createTransitionEvidenceDeferred();
    let result: Extract<FilePlaybackTransitionResult, { readonly status: 'scheduled' }>;
    try {
      result = createFilePlaybackScheduledTransitionResult(
        intent,
        target,
        visibleSnapshot,
        evidence.promise,
      );
    } catch {
      evidence.reject(transitionEvidenceError('invalid-pre-transition-snapshot'));
      return this.#rejectedRevisionTransition(intent, 'operation-superseded');
    }

    // Everything above is a pure preflight. Claim ingress only for the exact
    // new native operation, then revalidate the authority snapshot.
    const ingressEpoch = this.#advanceIngressEpoch();
    const phaseAfterClaim = this.#phase as FilePlaybackSourcePhase;
    if (
      ingressEpoch !== this.#ingressEpoch ||
      !sameRun(this.#run, intent.from) ||
      this.#revisionTransition !== null ||
      phaseAfterClaim === 'failed' ||
      phaseAfterClaim === 'destroyed' ||
      (intent.kind === 'file-playback-pause-transition' &&
        (phaseAfterClaim !== 'playing' || !this.#activeArm)) ||
      (intent.kind === 'file-playback-seek-transition' && phaseAfterClaim !== 'paused')
    ) {
      evidence.reject(transitionEvidenceError('operation-superseded'));
      return this.#rejectedRevisionTransition(intent, 'operation-superseded');
    }
    const pauseIdentity =
      intent.kind === 'file-playback-pause-transition' && this.#activeArm
        ? runIdentity(this.#activeArm.intent)
        : null;
    if (intent.kind === 'file-playback-pause-transition' && pauseIdentity === null) {
      evidence.reject(transitionEvidenceError('operation-superseded'));
      return this.#rejectedRevisionTransition(intent, 'operation-superseded');
    }
    const transition: PendingRevisionTransition = {
      intent,
      target,
      positionSeconds,
      visibleSnapshot,
      evidence,
      result,
      pauseIdentity,
      stage: 'scheduled',
      expectedGeneration: null,
      controlOperation: null,
      timerHandle: null,
    };
    this.#revisionTransition = transition;

    if (pauseIdentity) {
      this.#pendingPause = {
        targetFrame,
        mediaFrame: this.#viewAtRenderFrame(targetFrame).mediaFrame,
        identity: pauseIdentity,
      };
      this.#postWorklet({
        protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
        type: 'pause',
        generation: this.#generation,
        ...pauseIdentity,
        targetFrame,
      });
      const phaseAfterPost = this.#phase as FilePlaybackSourcePhase;
      if (
        ingressEpoch !== this.#ingressEpoch ||
        this.#revisionTransition !== transition ||
        phaseAfterPost === 'failed' ||
        phaseAfterPost === 'destroyed'
      ) {
        this.#rejectRevisionTransition('operation-superseded');
        return this.#rejectedRevisionTransition(intent, 'operation-superseded');
      }
    }

    this.#lastRevisionTransition = { intent, result };
    this.#scheduleRevisionTransitionTimer(transition);
    return result;
  }

  #rejectedRevisionTransition(
    intent: Readonly<FilePlaybackTransitionIntent> | null,
    reason: FilePlaybackTransitionRejectReason,
  ): Extract<FilePlaybackTransitionResult, { readonly status: 'rejected' }> {
    return createFilePlaybackRejectedTransitionResult(
      intent,
      reason,
      this.#snapshotWithoutReconciliation(),
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
    const transition = this.#revisionTransition;
    if (transition?.intent.kind === 'file-playback-seek-transition') {
      const visible = transition.visibleSnapshot;
      return Object.freeze({
        queueItemId: this.queueItemId,
        run: visible.run ? immutableRun(visible.run) : null,
        phase: visible.phase,
        positionSeconds: visible.positionSeconds,
        bufferedAheadSeconds: visible.bufferedAheadSeconds,
        underrunCount: visible.underrunCount,
      });
    }
    const frame = this.#contextTimeToFrame(contextTime);
    const view = this.#viewAtRenderFrame(frame);
    return Object.freeze({
      queueItemId: this.queueItemId,
      run: this.#run ? immutableRun(this.#run) : null,
      phase: view.phase,
      positionSeconds: view.mediaFrame / this.#audioContext.sampleRate,
      bufferedAheadSeconds: view.bufferedFrames / this.#audioContext.sampleRate,
      underrunCount: this.#underrunCount,
    });
  }

  getSnapshot(): FilePlaybackSourceSnapshot {
    this.#expireUnfinalizedArm();
    return this.#snapshotWithoutReconciliation();
  }

  #snapshotWithoutReconciliation(): FilePlaybackSourceSnapshot {
    const transition = this.#revisionTransition;
    if (transition?.intent.kind === 'file-playback-seek-transition') {
      return createFilePlaybackSourceSnapshot(transition.visibleSnapshot);
    }
    const view = this.#viewAtRenderFrame(this.#currentRenderFrame);
    return createFilePlaybackSourceSnapshot({
      schemaVersion: 1,
      queueItemId: this.queueItemId,
      backend: this.backend,
      phase: view.phase,
      revision: this.#revision,
      run: this.#run,
      durationSeconds: this.#durationSeconds,
      positionSeconds: view.mediaFrame / this.#audioContext.sampleRate,
      bufferedAheadSeconds: view.bufferedFrames / this.#audioContext.sampleRate,
      outputSampleRateHz: this.#audioContext.sampleRate,
      channelCount: this.#decoder.info.channelCount,
      underrunCount: this.#underrunCount,
      errorCode: this.#errorCode,
    });
  }

  async destroy(): Promise<void> {
    this.#advanceIngressEpoch();
    if (this.#phase === 'destroyed') return;
    this.#rejectRevisionTransition('source-destroyed');
    this.#supersedeControlOperations('source-destroyed');
    this.#lifetimeAbort.abort(
      new DOMException('Streaming playback source was destroyed', 'AbortError'),
    );
    this.#clearAcks('source-destroyed');
    this.#readiness?.reject(abortError(this.#lifetimeAbort.signal));
    const teardown = this.#teardownRuntime();
    this.#destination = null;
    this.#run = null;
    this.#currentRendezvousId = null;
    this.#retireActiveArm('source-destroyed');
    this.#pendingPause = null;
    this.#phase = 'destroyed';
    this.#errorCode = null;
    await teardown;
  }

  get #durationSeconds(): number {
    return this.#timeline.durationSeconds;
  }

  get #currentRenderFrame(): number {
    return this.#contextTimeToFrame(this.#audioContext.currentTime);
  }

  async #initialize(externalSignal?: AbortSignal): Promise<void> {
    const operation = this.#operationSignal(externalSignal);
    try {
      await this.#raceAbort(this.#runtime.loadWorklet(this.#audioContext), operation.signal);
      this.#assertOperationOpen(operation.signal);
      await this.#raceAbort(
        this.#decoder.open({
          signal: operation.signal,
          lifetimeSignal: this.#lifetimeAbort.signal,
          onFatal: (code, cause) => this.#fail(code, cause),
          onGenerationStopped: (generation, cause) => {
            if (this.#readiness?.generation === generation) {
              this.#readiness.reject(cause);
            }
          },
        }),
        operation.signal,
      );
      this.#assertOperationOpen(operation.signal);

      this.#generation = 1;
      const ringPlan = planPcmRingCapacity({
        channels: this.#decoder.info.channelCount,
        sampleRate: this.#audioContext.sampleRate,
        capacitySeconds: PCM_RING_TARGET_CAPACITY_SECONDS,
        primeSeconds: PCM_RING_TARGET_PRIME_SECONDS,
        maxRingBytes: PCM_RING_DEFAULT_MAX_BYTES,
      });
      try {
        this.#ringLifecycle = acquireTrackedLifecycle('rings');
        this.#controlPortLifecycle = acquireTrackedLifecycle('ports');
        this.#node = this.#runtime.createWorkletNode(this.#audioContext, PROCESSOR_NAME, {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [this.#decoder.info.channelCount],
          channelCount: this.#decoder.info.channelCount,
          channelCountMode: 'explicit',
          channelInterpretation: 'discrete',
          processorOptions: {
            channels: this.#decoder.info.channelCount,
            generation: this.#generation,
            mediaFrame: 0,
            capacitySeconds: PCM_RING_TARGET_CAPACITY_SECONDS,
            primeSeconds: PCM_RING_TARGET_PRIME_SECONDS,
            maxRingBytes: PCM_RING_DEFAULT_MAX_BYTES,
            ...ringPlan,
          },
        });
      } catch (error) {
        this.#markWorkletFaulted();
        if (this.#ringLifecycle) forceTrackedLifecycleUnconfirmed(this.#ringLifecycle);
        if (this.#controlPortLifecycle) {
          forceTrackedLifecycleUnconfirmed(this.#controlPortLifecycle);
        }
        throw error;
      }
      this.#node.port.onmessage = (event: MessageEvent<unknown>) =>
        this.#handleWorkletEvent(event.data);
      this.#node.port.onmessageerror = () => {
        this.#markWorkletFaulted();
        this.#fail('worklet-message-error');
      };
      this.#node.onprocessorerror = () => {
        this.#markWorkletFaulted();
        this.#fail('worklet-processor-error');
      };
      this.#statusRenderFrame = this.#currentRenderFrame;
      await this.#startGeneration(0, 0, this.#generation, operation.signal);
    } finally {
      operation.cleanup();
    }
  }

  async #resetGeneration(
    positionSeconds: number,
    control: ControlOperation,
    readyPhase: FilePlaybackSourcePhase,
  ): Promise<void> {
    if (!this.#isCurrentOperation(control)) throw new SupersededPlaybackOperationError();
    const operation = this.#operationSignal(control.controller.signal);
    const oldGeneration = this.#generation;
    this.#phase = 'preparing';
    this.#retireActiveArm('generation-reset');
    this.#pendingPause = null;
    this.#clearAcks('generation-reset');
    this.#beginPcmPortRetirement(oldGeneration);
    this.#decoder.stopGeneration(oldGeneration);
    const sourceSample = this.#positionToMediaFrame(positionSeconds);
    const mediaFrame = outputFrameAtMediaFrame(this.#timeline, sourceSample);
    this.#generation += 1;
    const generation = this.#generation;
    this.#postWorklet({
      protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
      type: 'reset',
      generation: this.#generation,
      mediaFrame,
    });
    try {
      await this.#startGeneration(sourceSample, mediaFrame, generation, operation.signal);
      if (!this.#isCurrentOperation(control)) throw new SupersededPlaybackOperationError();
      this.#phase = readyPhase;
    } catch (error) {
      if (this.#isCurrentOperation(control)) {
        this.#fail(
          operation.signal.aborted
            ? 'seek-prepare-aborted'
            : error instanceof Error && error.name === 'TimeoutError'
              ? 'seek-prepare-timeout'
              : 'seek-prepare-failed',
          error,
        );
      }
      throw error;
    } finally {
      operation.cleanup();
    }
  }

  async #startGeneration(
    startSourceSample: number,
    mediaFrame: number,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    const node = this.#node;
    if (!this.#decoder.opened || !node) {
      throw new Error('Streaming runtime is not initialized');
    }
    this.#assertOperationOpen(signal);
    const readiness = createReadiness(generation);
    this.#readiness = readiness;
    this.#mediaFrame = mediaFrame;
    this.#bufferedFrames = 0;
    this.#statusRenderFrame = this.#currentRenderFrame;
    this.#underrunCount = 0;

    const channel = this.#runtime.createMessageChannel();
    let portLifecycle: TrackedLifecycle;
    try {
      portLifecycle = acquireTrackedLifecycle('ports');
    } catch (error) {
      safeClosePort(channel.port1);
      safeClosePort(channel.port2);
      throw error;
    }
    const previousPortLifecycle = this.#pcmPortLifecycles.get(generation);
    if (previousPortLifecycle) forceTrackedLifecycleUnconfirmed(previousPortLifecycle);
    this.#pcmPortLifecycles.set(generation, portLifecycle);
    let transferredToWorklet = false;
    let decoderAcceptedPcmPort = false;
    let decoderPcmPortAcceptanceOpen = true;
    try {
      node.port.postMessage(
        {
          protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
          type: 'bind-pcm-port',
          generation,
          port: channel.port2,
        } satisfies PcmRingCommand,
        [channel.port2],
      );
      transferredToWorklet = true;
      const decoderReady = this.#decoder
        .startGeneration({
          generation,
          targetMediaFrame: startSourceSample,
          outputSampleRateHz: this.#audioContext.sampleRate,
          pcmPort: channel.port1,
          acceptPcmPortOwnership: () => {
            if (!decoderPcmPortAcceptanceOpen) {
              throw new Error('Streaming decoder accepted the PCM port after request settlement');
            }
            if (decoderAcceptedPcmPort) {
              throw new Error('Streaming decoder accepted the PCM port more than once');
            }
            decoderAcceptedPcmPort = true;
          },
          signal,
        })
        .then(
          () => {
            decoderPcmPortAcceptanceOpen = false;
            if (!decoderAcceptedPcmPort) {
              throw new Error('Streaming decoder became ready without accepting the PCM port');
            }
          },
          (error: unknown) => {
            decoderPcmPortAcceptanceOpen = false;
            throw error;
          },
        );
      void decoderReady.then(
        () => {
          if (this.#readiness !== readiness || readiness.generation !== generation) return;
          readiness.decoderReady = true;
          this.#resolveReadiness();
        },
        (error: unknown) => readiness.reject(error),
      );
      await this.#raceAbort(readiness.promise, signal);
    } catch (error) {
      decoderPcmPortAcceptanceOpen = false;
      this.#decoder.stopGeneration(generation);
      if (transferredToWorklet) {
        // port2 is Worklet-owned and retires only through its ACK. Until the
        // explicit decoder commit, port1 remains ours and must be closed here.
        if (!decoderAcceptedPcmPort && !safeClosePort(channel.port1)) {
          this.#sourceCleanupFaulted = true;
        }
        beginTrackedRetirement(portLifecycle);
      } else {
        const decoderPortClosed = safeClosePort(channel.port1);
        const workletPortClosed = safeClosePort(channel.port2);
        if (decoderPortClosed && workletPortClosed) releaseTrackedLifecycle(portLifecycle);
        else {
          forceTrackedLifecycleUnconfirmed(portLifecycle);
          this.#sourceCleanupFaulted = true;
        }
        if (this.#pcmPortLifecycles.get(generation) === portLifecycle) {
          this.#pcmPortLifecycles.delete(generation);
        }
      }
      throw error;
    } finally {
      if (this.#readiness === readiness) this.#readiness = null;
    }
  }

  #handleWorkletEvent(value: unknown): void {
    if (!isRecord(value) || value.protocolVersion !== PCM_STREAM_PROTOCOL_VERSION) {
      return;
    }
    if (!isPcmRingEventBoundary(value)) {
      this.#markWorkletFaulted();
      this.#fail('worklet-invalid-event');
      return;
    }
    if (value.type === 'pcm-port-retired') {
      this.#releasePcmPortLifecycle(value.generation);
      return;
    }
    if (value.type === 'processor-retired') {
      this.#settleWorkletRetirement(this.#pcmPortLifecycles.size === 0);
      return;
    }
    if (value.generation !== this.#generation) return;
    if (this.#phase === 'destroyed' || this.#phase === 'failed') return;
    if (this.#phase === 'cancelled' && value.type !== 'interrupted' && value.type !== 'rejected') {
      return;
    }
    switch (value.type) {
      case 'primed':
        if (
          value.sampleRate !== this.#audioContext.sampleRate ||
          value.channels !== this.#decoder.info.channelCount
        ) {
          this.#readiness?.reject(new Error('PCM ring format mismatch'));
          this.#fail('worklet-format-mismatch');
          return;
        }
        this.#bufferedFrames = value.bufferedFrames;
        if (this.#readiness?.generation === value.generation) {
          this.#readiness.primed = true;
          this.#resolveReadiness();
        }
        break;
      case 'armed':
        this.#resolveAck(this.#pendingArmAck, value);
        break;
      case 'finalized':
        this.#resolveAck(this.#pendingFinalizeAck, value);
        break;
      case 'started':
        if (!this.#activeArm) return;
        {
          const active = this.#activeArm;
          if (!sameStreamIdentity(value, runIdentity(active.intent))) return;
          const finalizeAuthority =
            active.finalizeIssuedIntent ??
            (active.finalizeReceipt?.status === 'accepted' ? active.finalizeIntent : null);
          if (finalizeAuthority === null) {
            this.#fail('worklet-start-without-finalize');
            return;
          }
          if (
            value.targetFrame !== active.targetFrame ||
            value.actualStartFrame !== active.targetFrame
          ) {
            this.#fail('worklet-start-target-mismatch');
            return;
          }
          let observedAtRoomTimeMs: number | null = null;
          if (!active.finalizeReceipt) {
            observedAtRoomTimeMs = this.#roomNow();
            if (this.#activeArm !== active) return;
          }
          this.#phase = 'playing';
          active.finalized = true;
          active.finalizeIntent ??= finalizeAuthority;
          if (!active.finalizeReceipt) {
            active.finalizeReceipt = this.#finalizeReceipt(
              finalizeAuthority,
              'accepted',
              null,
              Math.min(
                observedAtRoomTimeMs ?? active.intent.startAtRoomTimeMs,
                active.intent.startAtRoomTimeMs,
              ),
            );
          }
          if (active.finalizeReceipt) {
            this.#resolvePendingCommit(active, active.finalizeReceipt);
          }
          this.#mediaFrame = value.mediaFrame;
          this.#statusRenderFrame = value.actualStartFrame;
          this.#pendingPause = null;
          this.#resolveStartEvidence(
            active,
            createStreamingPlaybackStartEvidence(active.targetFrame, value.actualStartFrame),
          );
        }
        break;
      case 'paused': {
        if (!this.#pendingPause) return;
        if (!sameStreamIdentity(value, this.#pendingPause.identity)) return;
        if (
          value.targetFrame !== this.#pendingPause.targetFrame ||
          value.actualPauseFrame !== this.#pendingPause.targetFrame
        ) {
          this.#fail('worklet-pause-target-mismatch');
          return;
        }
        this.#phase = 'paused';
        this.#mediaFrame = value.mediaFrame;
        this.#statusRenderFrame = value.actualPauseFrame;
        this.#pendingPause = null;
        const transition = this.#revisionTransition;
        if (
          transition?.intent.kind === 'file-playback-pause-transition' &&
          transition.target.targetFrame === value.targetFrame &&
          sameStreamIdentity(transition.pauseIdentity, value)
        ) {
          if (!this.#applyRevisionTransition(transition, value.actualPauseFrame)) {
            this.#fail('worklet-pause-transition-authority-lost');
            return;
          }
        }
        this.#retireActiveArm('playback-paused');
        const pauseWait = this.#pendingPauseWait;
        if (pauseWait?.targetFrame === value.targetFrame) {
          if (this.#pendingPauseWait === pauseWait) this.#pendingPauseWait = null;
          pauseWait.resolve();
        }
        break;
      }
      case 'finished':
        this.#phase = 'ended';
        this.#currentRendezvousId = null;
        this.#mediaFrame = value.mediaFrame;
        this.#bufferedFrames = 0;
        this.#pendingPause = null;
        this.#retireActiveArm('playback-finished');
        break;
      case 'status':
        this.#mediaFrame = value.mediaFrame;
        this.#statusRenderFrame = value.renderFrame;
        this.#bufferedFrames = value.bufferedFrames;
        this.#underrunCount = value.underruns;
        {
          const transition = this.#revisionTransition;
          if (
            transition?.intent.kind === 'file-playback-seek-transition' &&
            transition.stage === 'awaiting-seek-status' &&
            transition.expectedGeneration === value.generation &&
            value.renderFrame >= transition.target.targetFrame &&
            (value.state === 'ready' || value.state === 'paused')
          ) {
            const expectedMediaFrame = this.#positionToOutputFrame(transition.positionSeconds);
            if (value.mediaFrame !== expectedMediaFrame) {
              this.#fail('worklet-seek-transition-position-mismatch');
              return;
            }
            if (!this.#applyRevisionTransition(transition, value.renderFrame)) {
              this.#fail('worklet-seek-transition-authority-lost');
              return;
            }
          }
        }
        if (value.state === 'playing') this.#phase = 'playing';
        else if (value.state === 'paused') {
          this.#phase = 'paused';
          this.#retireActiveArm('worklet-status-paused');
        } else if (value.state === 'finished') {
          this.#phase = 'ended';
          this.#currentRendezvousId = null;
          this.#retireActiveArm('worklet-status-finished');
        } else if (value.state === 'interrupted') this.#fail('worklet:interrupted');
        break;
      case 'interrupted':
        if (this.#cancelRequested && value.code === 'cancelled-after-start') {
          this.#phase = 'cancelled';
          this.#currentRendezvousId = null;
          this.#cancelRequested = false;
        } else {
          this.#fail(`worklet:${safeErrorCode(value.code, 'interrupted')}`);
        }
        break;
      case 'rejected': {
        if (this.#resolveAck(this.#pendingArmAck, value)) break;
        if (this.#resolveAck(this.#pendingFinalizeAck, value)) break;
        if (
          (value.code === 'arm-not-finalized' || value.code === 'arm-target-missed') &&
          this.#activeArm &&
          hasStreamIdentity(value) &&
          sameStreamIdentity(value, runIdentity(this.#activeArm.intent))
        ) {
          const active = this.#activeArm;
          const pendingCommit = this.#pendingCommitResolution;
          if (pendingCommit?.active === active) {
            const observedAtRoomTimeMs = this.#roomNow() ?? active.intent.startAtRoomTimeMs;
            if (this.#activeArm !== active || this.#pendingCommitResolution !== pendingCommit) {
              break;
            }
            const receipt = this.#finalizeReceipt(
              pendingCommit.intent,
              'missed-deadline',
              value.code,
              observedAtRoomTimeMs,
            );
            active.finalizeReceipt = receipt;
            this.#resolvePendingCommit(active, receipt);
          }
          if (this.#activeArm !== active) break;
          this.#retireActiveArm(value.code, active);
          if (this.#phase !== 'cancelled') {
            this.#phase = 'paused';
          }
        }
        break;
      }
    }
  }

  #resolveReadiness(): void {
    const readiness = this.#readiness;
    if (readiness && readiness.decoderReady && readiness.primed) readiness.resolve();
  }

  #createAck(
    kind: 'arm' | 'finalize',
    identity: PcmStreamRunIdentity,
    expectedTargetFrame: number,
    timeoutMs: number,
  ): PendingAck {
    const previous = kind === 'arm' ? this.#pendingArmAck : this.#pendingFinalizeAck;
    if (previous) {
      clearManagedTimer(previous.timerKey);
      previous.resolve(
        this.#syntheticRejection(previous.generation, previous.identity, 'superseded'),
      );
    }
    let resolvePromise!: (event: PcmRingEvent) => void;
    const promise = new Promise<PcmRingEvent>((resolve) => {
      resolvePromise = resolve;
    });
    const ack = {} as PendingAck;
    const timerKey = this.#nextTimerKey(`${kind}-ack`);
    setManagedTimer(
      timerKey,
      () => {
        resolvePromise(
          this.#syntheticRejection(ack.generation, identity, 'worklet-command-timeout'),
        );
        if (kind === 'arm' && this.#pendingArmAck === ack) this.#pendingArmAck = null;
        if (kind === 'finalize' && this.#pendingFinalizeAck === ack)
          this.#pendingFinalizeAck = null;
      },
      Math.max(0, Math.min(this.#commandTimeoutMs, timeoutMs)),
    );
    Object.assign(ack, {
      generation: this.#generation,
      identity,
      expectedType: kind === 'arm' ? 'armed' : 'finalized',
      expectedTargetFrame,
      promise,
      resolve: resolvePromise,
      timerKey,
    });
    if (kind === 'arm') this.#pendingArmAck = ack;
    else this.#pendingFinalizeAck = ack;
    return ack;
  }

  #resolveAck(ack: PendingAck | null, event: PcmRingEvent): boolean {
    if (!ack || ack.generation !== event.generation) return false;
    if (event.type !== ack.expectedType && event.type !== 'rejected') return false;
    if (!hasStreamIdentity(event)) return false;
    if (
      !sameStreamIdentity(ack.identity, {
        revision: event.revision,
        runId: event.runId,
        rendezvousId: event.rendezvousId,
      })
    )
      return false;
    if (event.type === ack.expectedType && event.targetFrame !== ack.expectedTargetFrame) {
      clearManagedTimer(ack.timerKey);
      ack.resolve(
        this.#syntheticRejection(ack.generation, ack.identity, 'worklet-target-mismatch'),
      );
      if (this.#pendingArmAck === ack) this.#pendingArmAck = null;
      if (this.#pendingFinalizeAck === ack) this.#pendingFinalizeAck = null;
      return true;
    }
    clearManagedTimer(ack.timerKey);
    ack.resolve(event);
    if (this.#pendingArmAck === ack) this.#pendingArmAck = null;
    if (this.#pendingFinalizeAck === ack) this.#pendingFinalizeAck = null;
    return true;
  }

  #syntheticRejection(
    generation: number,
    identity: PcmStreamRunIdentity,
    code: string,
  ): PcmRingEvent {
    return {
      protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
      type: 'rejected',
      generation,
      ...identity,
      code,
    };
  }

  #clearAcks(code: string): void {
    for (const ack of [this.#pendingArmAck, this.#pendingFinalizeAck]) {
      if (!ack) continue;
      clearManagedTimer(ack.timerKey);
      ack.resolve(this.#syntheticRejection(ack.generation, ack.identity, code));
    }
    this.#pendingArmAck = null;
    this.#pendingFinalizeAck = null;
  }

  #waitForCommitResolution(
    active: ActiveArm,
    intent: RendezvousFinalizeIntent,
  ): Promise<RendezvousFinalizeReceipt> {
    const existing = this.#pendingCommitResolution;
    if (existing) {
      if (existing.active === active && sameFinalizeIntent(existing.intent, intent)) {
        return existing.promise;
      }
      return Promise.resolve(
        this.#finalizeReceipt(
          intent,
          'rejected',
          'finalize-mismatch',
          this.#roomNow() ?? intent.startAtRoomTimeMs,
        ),
      );
    }

    let resolvePromise!: (receipt: RendezvousFinalizeReceipt) => void;
    const promise = new Promise<RendezvousFinalizeReceipt>((resolve) => {
      resolvePromise = resolve;
    });
    const timerKey = this.#nextTimerKey('commit-resolution');
    const pending: PendingCommitResolution = {
      active,
      intent,
      promise,
      resolve: resolvePromise,
      timerKey,
    };
    this.#pendingCommitResolution = pending;
    setManagedTimer(
      timerKey,
      () => {
        if (this.#pendingCommitResolution !== pending) return;
        const observedAtRoomTimeMs = this.#roomNow() ?? pending.intent.startAtRoomTimeMs;
        if (this.#pendingCommitResolution !== pending || this.#activeArm !== pending.active) {
          return;
        }
        this.#pendingCommitResolution = null;
        const receipt = this.#finalizeReceipt(
          pending.intent,
          'rejected',
          'commit-status-unknown',
          observedAtRoomTimeMs,
        );
        this.#fail('commit-status-unknown');
        pending.resolve(receipt);
      },
      this.#commandTimeoutMs,
    );
    return promise;
  }

  #resolvePendingCommit(active: ActiveArm, receipt: RendezvousFinalizeReceipt): boolean {
    const pending = this.#pendingCommitResolution;
    if (!pending || pending.active !== active) return false;
    clearManagedTimer(pending.timerKey);
    this.#pendingCommitResolution = null;
    pending.resolve(receipt);
    return true;
  }

  #clearPendingCommit(code: string): void {
    const pending = this.#pendingCommitResolution;
    if (!pending) return;
    clearManagedTimer(pending.timerKey);
    this.#pendingCommitResolution = null;
    pending.resolve(
      this.#finalizeReceipt(
        pending.intent,
        'rejected',
        code,
        // Cleanup must stay callback-free: a clock provider can synchronously
        // start newer work that this supersession path would otherwise erase.
        pending.intent.startAtRoomTimeMs,
      ),
    );
  }

  #scheduleRevisionTransitionTimer(transition: PendingRevisionTransition): void {
    this.#clearRevisionTransitionTimer(transition);
    const currentFrame = this.#currentRenderFrame;
    const remainingMs = Math.max(
      0,
      ((transition.target.targetFrame - currentFrame) / this.#audioContext.sampleRate) * 1_000,
    );
    transition.timerHandle = globalThis.setTimeout(
      () => {
        transition.timerHandle = null;
        this.#watchRevisionTransition(transition);
      },
      Math.min(100, Math.max(4, remainingMs)),
    );
  }

  #watchRevisionTransition(transition: PendingRevisionTransition): void {
    if (this.#revisionTransition !== transition || transition.evidence.settled) return;
    if (this.#phase === 'failed' || this.#phase === 'destroyed') {
      this.#rejectRevisionTransition(
        this.#phase === 'destroyed' ? 'source-destroyed' : 'source-failed',
      );
      return;
    }
    const roomNow = this.#roomNow();
    if (this.#revisionTransition !== transition) return;
    const timeoutMs =
      transition.intent.kind === 'file-playback-seek-transition'
        ? this.#prepareTimeoutMs
        : this.#commandTimeoutMs;
    if (roomNow === null || roomNow > transition.intent.atRoomTimeMs + timeoutMs) {
      this.#rejectRevisionTransition(
        roomNow === null ? 'clock-unavailable' : 'transition-evidence-timeout',
      );
      const phaseAfterRejection = this.#phase as FilePlaybackSourcePhase;
      if (phaseAfterRejection !== 'destroyed' && phaseAfterRejection !== 'failed') {
        this.#fail('worklet-transition-timeout');
      }
      return;
    }
    if (this.#currentRenderFrame < transition.target.targetFrame) {
      this.#scheduleRevisionTransitionTimer(transition);
      return;
    }
    if (transition.intent.kind === 'file-playback-pause-transition') {
      // Only the exact Worklet `paused` event may commit a playing pause.
      this.#scheduleRevisionTransitionTimer(transition);
      return;
    }
    if (transition.stage === 'scheduled') {
      this.#beginRevisionedSeek(transition);
      return;
    }
    this.#scheduleRevisionTransitionTimer(transition);
  }

  #beginRevisionedSeek(transition: PendingRevisionTransition): void {
    if (
      this.#revisionTransition !== transition ||
      transition.intent.kind !== 'file-playback-seek-transition' ||
      transition.stage !== 'scheduled' ||
      !sameRun(this.#run, transition.intent.from)
    ) {
      return;
    }
    transition.stage = 'applying-seek';
    const operation = this.#beginControlOperation();
    transition.controlOperation = operation;
    let resetting: Promise<void>;
    try {
      resetting = this.#resetGeneration(transition.positionSeconds, operation, 'paused');
      transition.expectedGeneration = this.#generation;
    } catch (error) {
      this.#finishControlOperation(operation);
      this.#rejectRevisionTransition('seek-reset-failed');
      this.#fail('seek-transition-failed', error);
      return;
    }
    void resetting.then(
      () => {
        if (
          this.#revisionTransition !== transition ||
          transition.controlOperation !== operation ||
          !this.#isCurrentOperation(operation)
        ) {
          return;
        }
        this.#finishControlOperation(operation);
        transition.controlOperation = null;
        transition.stage = 'awaiting-seek-status';
        this.#scheduleRevisionTransitionTimer(transition);
      },
      (error: unknown) => {
        if (this.#revisionTransition !== transition) return;
        this.#finishControlOperation(operation);
        transition.controlOperation = null;
        this.#rejectRevisionTransition('seek-reset-failed');
        if (this.#phase !== 'destroyed' && this.#phase !== 'failed') {
          this.#fail('seek-transition-failed', error);
        }
      },
    );
  }

  #applyRevisionTransition(transition: PendingRevisionTransition, appliedFrame: number): boolean {
    if (
      this.#revisionTransition !== transition ||
      transition.evidence.settled ||
      appliedFrame < transition.target.targetFrame ||
      !sameRun(this.#run, transition.intent.from)
    ) {
      return false;
    }
    this.#clearRevisionTransitionTimer(transition);
    this.#revisionTransition = null;
    if (transition.controlOperation) this.#finishControlOperation(transition.controlOperation);
    transition.controlOperation = null;
    this.#revision = transition.intent.to.revision;
    this.#run = immutableRun(transition.intent.to);
    this.#phase = 'paused';
    if (transition.intent.kind === 'file-playback-seek-transition') {
      this.#mediaFrame = this.#positionToOutputFrame(transition.positionSeconds);
      this.#statusRenderFrame = appliedFrame;
    }
    transition.evidence.resolve(
      createFilePlaybackTransitionEvidence(
        transition.intent,
        'worklet-observed',
        transition.target.targetFrame,
        appliedFrame,
      ),
    );
    return true;
  }

  #rejectRevisionTransition(code: string): void {
    const transition = this.#revisionTransition;
    this.#lastRevisionTransition = null;
    if (!transition) return;
    this.#revisionTransition = null;
    this.#clearRevisionTransitionTimer(transition);
    if (
      transition.pauseIdentity &&
      this.#pendingPause &&
      sameStreamIdentity(this.#pendingPause.identity, transition.pauseIdentity)
    ) {
      this.#pendingPause = null;
    }
    const operation = transition.controlOperation;
    transition.controlOperation = null;
    if (operation && this.#controlOperation === operation) {
      this.#controlEpoch += 1;
      this.#controlOperation = null;
      if (!operation.controller.signal.aborted) {
        operation.controller.abort(new SupersededPlaybackOperationError());
      }
    }
    transition.evidence.reject(transitionEvidenceError(code));
  }

  #clearRevisionTransitionTimer(transition: PendingRevisionTransition): void {
    if (transition.timerHandle === null) return;
    globalThis.clearTimeout(transition.timerHandle);
    transition.timerHandle = null;
  }

  #schedulePause(
    atRoomTimeMs: number,
    identity: PcmStreamRunIdentity,
    ingressEpoch?: number,
  ): number | null {
    if (!this.#isContextRunning()) return null;
    const mapped = this.#roomTimeToRenderFrame(atRoomTimeMs);
    if (ingressEpoch !== undefined && ingressEpoch !== this.#ingressEpoch) return null;
    if (mapped === null) return null;
    const targetFrame = Math.max(mapped, this.#currentRenderFrame + 128);
    const current = this.#viewAtRenderFrame(targetFrame);
    this.#pendingPause = { targetFrame, mediaFrame: current.mediaFrame, identity };
    this.#postWorklet({
      protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
      type: 'pause',
      generation: this.#generation,
      ...identity,
      targetFrame,
    });
    return targetFrame;
  }

  async #waitForPause(targetFrame: number, operation: ControlOperation): Promise<void> {
    if (this.#phase === 'paused') return;
    const millisecondsUntilTarget = Math.max(
      0,
      ((targetFrame - this.#currentRenderFrame) / this.#audioContext.sampleRate) * 1000,
    );
    const timerKey = this.#nextTimerKey('pause-ack');
    let pauseWait!: PendingPauseWait;
    const pause = new Promise<void>((resolve, reject) => {
      pauseWait = { operation, targetFrame, resolve };
      this.#pendingPauseWait = pauseWait;
      setManagedTimer(
        timerKey,
        () => reject(new Error('PCM ring pause acknowledgement timed out')),
        millisecondsUntilTarget + this.#commandTimeoutMs,
      );
    });
    try {
      await this.#raceAbort(pause, operation.controller.signal);
    } catch (error) {
      if (this.#isCurrentOperation(operation)) this.#fail('worklet-pause-timeout', error);
      throw error;
    } finally {
      clearManagedTimer(timerKey);
      if (this.#pendingPauseWait === pauseWait) this.#pendingPauseWait = null;
    }
  }

  #viewAtRenderFrame(renderFrame: number): {
    phase: FilePlaybackSourcePhase;
    mediaFrame: number;
    bufferedFrames: number;
  } {
    let phase = this.#phase;
    let mediaFrame = this.#mediaFrame;
    let bufferedFrames = this.#bufferedFrames;
    if (phase === 'playing') {
      const elapsed = renderFrame - this.#statusRenderFrame;
      mediaFrame += elapsed;
      bufferedFrames -= Math.max(0, elapsed);
    }
    if (this.#pendingPause && renderFrame >= this.#pendingPause.targetFrame) {
      phase = 'paused';
      mediaFrame = this.#pendingPause.mediaFrame;
    }
    const totalFrames = this.#timeline.totalOutputFrames;
    mediaFrame = Math.min(totalFrames, Math.max(0, Math.round(mediaFrame)));
    bufferedFrames = Math.max(0, Math.round(bufferedFrames));
    if (mediaFrame >= totalFrames && phase === 'playing') phase = 'ended';
    return { phase, mediaFrame, bufferedFrames };
  }

  #expireUnfinalizedArm(): void {
    const active = this.#activeArm;
    if (!active || active.finalized) return;
    if (this.#pendingFinalizeOperation?.active === active) return;
    const observed = this.#roomNow();
    if (
      this.#activeArm !== active ||
      active.finalized ||
      this.#pendingFinalizeOperation?.active === active
    ) {
      return;
    }
    if (
      this.#isContextRunning() &&
      observed !== null &&
      observed <= active.intent.finalizeByRoomTimeMs &&
      this.#currentRenderFrame < active.targetFrame
    ) {
      return;
    }
    this.#postCancel(runIdentity(active.intent));
    this.#retireActiveArm('arm-expired', active);
    if (this.#phase !== 'failed' && this.#phase !== 'destroyed') this.#phase = 'paused';
  }

  #retireActiveArm(code: string, expected?: ActiveArm): ActiveArm | null {
    const active = this.#activeArm;
    if (!active || (expected !== undefined && active !== expected)) return null;
    this.#activeArm = null;
    active.finalizeIssuedIntent = null;
    this.#rejectStartEvidence(active, code);
    return active;
  }

  #scheduleStartEvidenceDeadline(active: ActiveArm): void {
    if (active.startEvidence.settled) {
      this.#clearStartEvidenceTimer(active);
      return;
    }
    if (this.#activeArm !== active || !active.finalized) {
      this.#rejectStartEvidence(active, 'operation-superseded');
      return;
    }

    const monotonicNowMs = this.#monotonicNow();
    if (this.#activeArm !== active || !active.finalized || active.startEvidence.settled) {
      if (!active.startEvidence.settled) {
        this.#rejectStartEvidence(active, 'operation-superseded');
      }
      return;
    }
    if (monotonicNowMs === null) {
      this.#rejectStartEvidence(active, 'start-evidence-timeout');
      return;
    }

    let currentRenderFrame: number;
    try {
      currentRenderFrame = this.#currentRenderFrame;
    } catch {
      this.#rejectStartEvidence(active, 'start-evidence-timeout');
      return;
    }
    if (this.#activeArm !== active || !active.finalized || active.startEvidence.settled) {
      if (!active.startEvidence.settled) {
        this.#rejectStartEvidence(active, 'operation-superseded');
      }
      return;
    }

    const remainingRenderMs =
      (Math.max(0, active.startEvidenceDeadlineFrame - currentRenderFrame) /
        this.#audioContext.sampleRate) *
      1_000;
    const deadlineMonotonicMs = monotonicNowMs + remainingRenderMs;
    if (
      remainingRenderMs <= 0 ||
      !Number.isFinite(deadlineMonotonicMs) ||
      deadlineMonotonicMs < monotonicNowMs
    ) {
      this.#rejectStartEvidence(active, 'start-evidence-timeout');
      return;
    }
    active.startEvidenceDeadlineMonotonicMs = deadlineMonotonicMs;

    this.#clearStartEvidenceTimer(active);
    const delayMs = Math.max(4, Math.ceil(remainingRenderMs));
    if (!Number.isSafeInteger(delayMs) || delayMs > MAX_PLATFORM_TIMER_DELAY_MS) {
      this.#rejectStartEvidence(active, 'start-evidence-timeout');
      return;
    }
    active.startEvidenceTimerHandle = globalThis.setTimeout(() => {
      active.startEvidenceTimerHandle = null;
      if (active.startEvidence.settled) return;
      if (active.startEvidenceDeadlineMonotonicMs !== deadlineMonotonicMs) return;
      if (this.#activeArm !== active || !active.finalized) {
        this.#rejectStartEvidence(active, 'operation-superseded');
        return;
      }
      this.#rejectStartEvidence(active, 'start-evidence-timeout');
    }, delayMs);
  }

  #resolveStartEvidence(active: ActiveArm, evidence: StreamingPlaybackStartEvidence): void {
    this.#clearStartEvidenceTimer(active);
    active.startEvidence.resolve(evidence);
  }

  #rejectStartEvidence(active: ActiveArm, code: string): void {
    this.#clearStartEvidenceTimer(active);
    active.startEvidence.reject(startEvidenceError(code));
  }

  #clearStartEvidenceTimer(active: ActiveArm): void {
    if (active.startEvidenceTimerHandle === null) return;
    globalThis.clearTimeout(active.startEvidenceTimerHandle);
    active.startEvidenceTimerHandle = null;
  }

  #postCancel(identity?: PcmStreamRunIdentity): void {
    if (!this.#node || this.#generation <= 0) return;
    this.#postWorklet({
      protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
      type: 'cancel',
      generation: this.#generation,
      ...identity,
    });
  }

  #postWorklet(command: PcmRingCommand): void {
    try {
      this.#node?.port.postMessage(command);
    } catch (error) {
      this.#markWorkletFaulted();
      this.#fail('worklet-command-failed', error);
    }
  }

  #roomTimeToRenderFrame(roomTimeMs: number): number | null {
    try {
      const contextTime = this.#roomTimeMsToContextTime(roomTimeMs);
      if (!Number.isFinite(contextTime) || contextTime < 0) return null;
      return this.#contextTimeToFrame(contextTime);
    } catch {
      return null;
    }
  }

  #contextTimeToFrame(contextTime: number): number {
    const frame = Math.round(contextTime * this.#audioContext.sampleRate);
    if (!Number.isSafeInteger(frame) || frame < 0) {
      throw new RangeError('AudioContext time exceeds the render-frame range');
    }
    return frame;
  }

  #positionToMediaFrame(positionSeconds: number): number {
    return mediaFrameAtPosition(this.#timeline, positionSeconds);
  }

  #positionToOutputFrame(positionSeconds: number): number {
    return outputFrameAtPosition(this.#timeline, positionSeconds);
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

  #monotonicNow(): number | null {
    try {
      const monotonicTimeMs = this.#nowMonotonicMs();
      return Number.isFinite(monotonicTimeMs) && monotonicTimeMs >= 0 ? monotonicTimeMs : null;
    } catch {
      return null;
    }
  }

  #isContextRunning(): boolean {
    return (this.#audioContext.state as string | undefined) === 'running';
  }

  #isTerminalPhase(): boolean {
    return this.#phase === 'failed' || this.#phase === 'destroyed';
  }

  #advanceIngressEpoch(): number {
    this.#ingressEpoch =
      this.#ingressEpoch === Number.MAX_SAFE_INTEGER ? 0 : this.#ingressEpoch + 1;
    return this.#ingressEpoch;
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
        status === 'armed' ? this.#bufferedFrames / this.#audioContext.sampleRate : 0,
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

  #beginControlOperation(): ControlOperation {
    this.#supersedeControlOperations('superseded');
    const operation: ControlOperation = {
      epoch: this.#controlEpoch,
      controller: new AbortController(),
    };
    this.#controlOperation = operation;
    return operation;
  }

  #finishControlOperation(operation: ControlOperation): void {
    if (this.#controlOperation === operation) this.#controlOperation = null;
  }

  #isCurrentOperation(operation: ControlOperation): boolean {
    return (
      this.#controlOperation === operation &&
      operation.epoch === this.#controlEpoch &&
      !operation.controller.signal.aborted
    );
  }

  #supersedeControlOperations(code: string): void {
    const revisionTransition = this.#revisionTransition;
    if (
      revisionTransition?.pauseIdentity ||
      (revisionTransition?.controlOperation !== null &&
        revisionTransition?.controlOperation === this.#controlOperation)
    ) {
      this.#rejectRevisionTransition(code);
    }
    this.#controlEpoch += 1;
    const operation = this.#controlOperation;
    this.#controlOperation = null;
    if (operation && !operation.controller.signal.aborted) {
      operation.controller.abort(new SupersededPlaybackOperationError());
    }
    this.#clearAcks(code);
    this.#clearPendingCommit(code);
    const pauseWait = this.#pendingPauseWait;
    this.#pendingPauseWait = null;
    pauseWait?.resolve();
    this.#pendingPause = null;
  }

  #operationSignal(externalSignal?: AbortSignal): {
    signal: AbortSignal;
    cleanup: () => void;
  } {
    const controller = new AbortController();
    const timerKey = this.#nextTimerKey('prepare');
    setManagedTimer(
      timerKey,
      () => {
        const error = new Error('Streaming preparation timed out');
        error.name = 'TimeoutError';
        controller.abort(error);
      },
      this.#prepareTimeoutMs,
    );
    const sources = [externalSignal, this.#lifetimeAbort.signal].filter(
      (item): item is AbortSignal => !!item,
    );
    const onAbort = (event: Event) => {
      const source = event.currentTarget as AbortSignal;
      if (!controller.signal.aborted) controller.abort(abortError(source));
    };
    for (const source of sources) {
      if (source.aborted) controller.abort(abortError(source));
      else source.addEventListener('abort', onAbort, { once: true });
    }
    return {
      signal: controller.signal,
      cleanup: () => {
        clearManagedTimer(timerKey);
        for (const source of sources) source.removeEventListener('abort', onAbort);
      },
    };
  }

  async #raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    this.#assertOperationOpen(signal);
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(abortError(signal));
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  #assertOperationOpen(signal: AbortSignal): void {
    if (signal.aborted) throw abortError(signal);
    this.#assertNotDestroyed();
  }

  #fail(code: string, cause?: unknown): void {
    if (this.#phase === 'destroyed' || this.#phase === 'failed') return;
    this.#rejectRevisionTransition(code);
    this.#errorCode = safeErrorCode(code, 'bounded-stream-failed');
    this.#phase = 'failed';
    this.#currentRendezvousId = null;
    this.#retireActiveArm(this.#errorCode);
    this.#supersedeControlOperations(this.#errorCode);
    const error = cause instanceof Error ? cause : new Error(this.#errorCode);
    this.#readiness?.reject(error);
    this.#clearAcks(this.#errorCode);
    const pauseWait = this.#pendingPauseWait;
    this.#pendingPauseWait = null;
    pauseWait?.resolve();
    void this.#teardownRuntime();
  }

  #teardownRuntime(): Promise<void> {
    if (this.#teardownPromise) return this.#teardownPromise;
    beginTrackedRetirement(this.#sourceLifecycle);
    const node = this.#node;
    this.#node = null;
    const workletRetirement = this.#beginWorkletRetirement(node);
    let decoderCleanup: Promise<void>;
    try {
      decoderCleanup = Promise.resolve(this.#decoder.close());
    } catch (error) {
      decoderCleanup = Promise.reject(error);
    }
    let decoderError: unknown;
    const decoderSettlement = decoderCleanup.then(
      () => true,
      (error: unknown) => {
        decoderError = error;
        return false;
      },
    );
    this.#teardownPromise = Promise.all([decoderSettlement, workletRetirement]).then(
      ([decoderConfirmed, workletConfirmed]) => {
        if (decoderConfirmed && workletConfirmed && !this.#sourceCleanupFaulted) {
          releaseTrackedLifecycle(this.#sourceLifecycle);
        } else {
          forceTrackedLifecycleUnconfirmed(this.#sourceLifecycle);
        }
        if (!decoderConfirmed) throw decoderError;
      },
    );
    return this.#teardownPromise;
  }

  #beginPcmPortRetirement(generation: number): void {
    const lifecycle = this.#pcmPortLifecycles.get(generation);
    if (lifecycle) beginTrackedRetirement(lifecycle);
  }

  #releasePcmPortLifecycle(generation: number): void {
    const lifecycle = this.#pcmPortLifecycles.get(generation);
    if (!lifecycle) return;
    releaseTrackedLifecycle(lifecycle);
    this.#pcmPortLifecycles.delete(generation);
  }

  #beginWorkletRetirement(node: AudioWorkletNode | null): Promise<boolean> {
    if (!node) return Promise.resolve(!this.#workletFaulted);
    this.#retiringNode = node;
    if (this.#ringLifecycle) beginTrackedRetirement(this.#ringLifecycle);
    if (this.#controlPortLifecycle) beginTrackedRetirement(this.#controlPortLifecycle);
    for (const lifecycle of this.#pcmPortLifecycles.values()) {
      beginTrackedRetirement(lifecycle);
    }
    const readiness = createWorkletRetirementReadiness();
    this.#workletRetirementReadiness = readiness;
    // Disconnect before posting so even a synchronous test ACK cannot release
    // the graph lease before the page-side physical graph edge is gone.
    if (!safeDisconnect(node)) this.#workletFaulted = true;
    let posted = false;
    try {
      node.port.postMessage({
        protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
        type: 'stop',
        generation: this.#generation,
      } satisfies PcmRingCommand);
      posted = true;
    } catch {
      this.#workletFaulted = true;
    }
    if (!posted || this.#workletFaulted) this.#settleWorkletRetirement(false);
    else if (!readiness.settled) {
      try {
        const timerLifecycle = acquireTrackedLifecycle('timers');
        this.#workletRetirementTimerLifecycle = timerLifecycle;
        this.#workletRetirementTimer = globalThis.setTimeout(() => {
          this.#workletRetirementTimer = null;
          if (this.#workletRetirementTimerLifecycle === timerLifecycle) {
            this.#workletRetirementTimerLifecycle = null;
          }
          releaseTrackedLifecycle(timerLifecycle);
          this.#settleWorkletRetirement(false);
        }, this.#commandTimeoutMs);
      } catch {
        this.#settleWorkletRetirement(false);
      }
    }
    return readiness.promise;
  }

  #settleWorkletRetirement(confirmed: boolean): void {
    const readiness = this.#workletRetirementReadiness;
    if (!readiness || readiness.settled) return;
    this.#clearWorkletRetirementTimer();
    const node = this.#retiringNode;
    this.#retiringNode = null;
    let pageCleanupConfirmed = node !== null;
    if (node) {
      try {
        node.port.onmessage = null;
      } catch {
        pageCleanupConfirmed = false;
      }
      try {
        node.port.onmessageerror = null;
      } catch {
        pageCleanupConfirmed = false;
      }
      try {
        node.onprocessorerror = null;
      } catch {
        pageCleanupConfirmed = false;
      }
      if (!safeClosePort(node.port)) pageCleanupConfirmed = false;
    }
    const exactConfirmation =
      confirmed &&
      !this.#workletFaulted &&
      this.#pcmPortLifecycles.size === 0 &&
      pageCleanupConfirmed;
    if (exactConfirmation) {
      if (this.#ringLifecycle) releaseTrackedLifecycle(this.#ringLifecycle);
      if (this.#controlPortLifecycle) releaseTrackedLifecycle(this.#controlPortLifecycle);
    } else {
      for (const lifecycle of this.#pcmPortLifecycles.values()) {
        forceTrackedLifecycleUnconfirmed(lifecycle);
      }
      this.#pcmPortLifecycles.clear();
      if (this.#ringLifecycle) forceTrackedLifecycleUnconfirmed(this.#ringLifecycle);
      if (this.#controlPortLifecycle) {
        forceTrackedLifecycleUnconfirmed(this.#controlPortLifecycle);
      }
    }
    readiness.resolve(exactConfirmation);
  }

  #clearWorkletRetirementTimer(): void {
    if (this.#workletRetirementTimer !== null) {
      globalThis.clearTimeout(this.#workletRetirementTimer);
      this.#workletRetirementTimer = null;
    }
    const lifecycle = this.#workletRetirementTimerLifecycle;
    this.#workletRetirementTimerLifecycle = null;
    if (lifecycle) releaseTrackedLifecycle(lifecycle);
  }

  #markWorkletFaulted(): void {
    this.#workletFaulted = true;
    if (this.#workletRetirementReadiness) this.#settleWorkletRetirement(false);
  }

  #assertNotDestroyed(): void {
    if (this.#phase === 'destroyed') {
      throw new Error('Streaming playback source has been destroyed');
    }
  }

  #nextTimerKey(label: string): string {
    this.#timerSerial += 1;
    return `${this.#timerPrefix}-${label}-${this.#timerSerial.toString(36)}`;
  }
}
