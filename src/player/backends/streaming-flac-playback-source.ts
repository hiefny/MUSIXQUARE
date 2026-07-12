import { loadPcmRingWorklet } from '../../audio/worklet-loader.ts';
import { clearManagedTimer, setManagedTimer } from '../../core/timers.ts';
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
import type { FlacMetadata } from '../flac/metadata.ts';
import { expectedOutputFrames } from '../flac/decoder-helpers.ts';
import {
  FLAC_STREAM_MAX_CHANNELS,
  FLAC_STREAM_PROTOCOL_VERSION,
  type FlacDecoderCommand,
  type FlacStreamDescriptor,
  type FlacStreamRunIdentity,
  type PcmRingCommand,
  type PcmRingEvent,
} from '../flac/stream-protocol.ts';
import { FlacSeekIndex } from '../flac/seek-index.ts';
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

const PROCESSOR_NAME = 'musixquare-pcm-ring-v2';
const DEFAULT_PREPARE_TIMEOUT_MS = 60_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 4_000;
const RING_CAPACITY_SECONDS = 12;
const RING_PRIME_SECONDS = 4;
const MAX_IDENTIFIER_LENGTH = 256;
const DESCRIPTOR_KEYS = [
  'sourceSampleRate',
  'outputSampleRate',
  'channels',
  'bitDepth',
  'totalSourceSamples',
  'firstAudioFrameOffset',
  'targetSourceSample',
  'decodeAnchorByteOffset',
  'decodeAnchorSourceSample',
  'minBlockSize',
  'maxBlockSize',
  'minFrameSize',
  'maxFrameSize',
] as const satisfies readonly (keyof FlacStreamDescriptor)[];

type WorkerFactory = () => Worker;
type WorkletNodeFactory = (
  context: AudioContext,
  name: string,
  options: AudioWorkletNodeOptions,
) => AudioWorkletNode;
type MessageChannelFactory = () => MessageChannel;

export interface StreamingFlacPlaybackRuntime {
  readonly loadWorklet: (context: AudioContext) => Promise<void>;
  readonly createWorker: WorkerFactory;
  readonly createWorkletNode: WorkletNodeFactory;
  readonly createMessageChannel: MessageChannelFactory;
}

export interface StreamingFlacPlaybackSourceOptions {
  readonly queueItemId: QueueItemId;
  /** The exact Blob whose already-validated metadata is supplied below. */
  readonly blob: Blob;
  readonly metadata: FlacMetadata;
  readonly audioContext: AudioContext;
  /** Authoritative monotonic room clock. It must not derive from AudioContext.currentTime. */
  readonly nowRoomTimeMs: () => number;
  readonly roomTimeMsToContextTime: (roomTimeMs: number) => number;
  readonly localPerformanceMsToContextTime: (localPerformanceTimeMs: number) => number;
  readonly prepareTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  /** Explicit runtime seam for deterministic browser-boundary tests. */
  readonly runtime?: Partial<StreamingFlacPlaybackRuntime>;
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

interface PendingAck {
  readonly generation: number;
  readonly identity: FlacStreamRunIdentity;
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
  readonly promise: Promise<RendezvousArmReceipt>;
}

type ArmPreflightResult =
  | {
      readonly ok: true;
      readonly observedAtRoomTimeMs: number;
      readonly targetFrame: number;
      readonly requestedMediaFrame: number;
    }
  | { readonly ok: false; readonly receipt: RendezvousArmReceipt };

interface ActiveArm {
  readonly intent: RendezvousArmIntent;
  readonly receipt: RendezvousArmReceipt;
  readonly targetFrame: number;
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
  readonly identity: FlacStreamRunIdentity;
}

interface PendingPauseWait {
  readonly operation: ControlOperation;
  readonly targetFrame: number;
  readonly resolve: () => void;
}

const defaultRuntime: StreamingFlacPlaybackRuntime = {
  loadWorklet: loadPcmRingWorklet,
  createWorker: () =>
    new Worker(new URL('../../workers/flac-stream.worker.ts', import.meta.url), {
      type: 'module',
      name: 'musixquare-flac-stream-v2',
    }),
  createWorkletNode: (context, name, options) => new AudioWorkletNode(context, name, options),
  createMessageChannel: () => new MessageChannel(),
};

let sourceInstanceCounter = 0;

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
): value is Record<string, unknown> & FlacStreamRunIdentity {
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
  if (value.protocolVersion !== FLAC_STREAM_PROTOCOL_VERSION || !isFrame(value.generation)) {
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
        (value.channels as number) <= FLAC_STREAM_MAX_CHANNELS
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

function sameDescriptor(actual: Record<string, unknown>, expected: FlacStreamDescriptor): boolean {
  return DESCRIPTOR_KEYS.every((key) => actual[key] === expected[key]);
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

function runIdentity(
  intent: RendezvousArmIntent | RendezvousFinalizeIntent,
): FlacStreamRunIdentity {
  return Object.freeze({
    revision: intent.revision,
    runId: intent.runId,
    rendezvousId: intent.rendezvousId,
  });
}

function sameStreamIdentity(
  left: FlacStreamRunIdentity | null | undefined,
  right: FlacStreamRunIdentity | null | undefined,
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

function abortError(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  return new DOMException('FLAC playback preparation was aborted', 'AbortError');
}

function safeDisconnect(node: AudioNode | null): void {
  if (!node) return;
  try {
    node.disconnect();
  } catch {
    // Native graph cleanup is intentionally idempotent.
  }
}

function safeClosePort(port: MessagePort | null): void {
  if (!port) return;
  try {
    port.close();
  } catch {
    // A transferred or previously closed port no longer belongs to this realm.
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

class SupersededPlaybackOperationError extends Error {
  constructor() {
    super('Playback operation was superseded');
    this.name = 'AbortError';
  }
}

/**
 * Bounded, RAM-only FLAC playback source.
 *
 * The decoder Worker owns encoded parsing/resampling, while the AudioWorklet
 * owns the bounded PCM ring and the exact render-frame commit. Neither is
 * connected to the product graph until prepare() has completed and connect()
 * is explicitly called by the active-source coordinator.
 */
export class StreamingFlacPlaybackSource implements FilePlaybackSource {
  readonly queueItemId: QueueItemId;
  readonly backend = 'streaming-flac' as const;

  readonly #blob: Blob;
  readonly #metadata: FlacMetadata;
  readonly #audioContext: AudioContext;
  readonly #nowRoomTimeMs: () => number;
  readonly #roomTimeMsToContextTime: (roomTimeMs: number) => number;
  readonly #localPerformanceMsToContextTime: (localPerformanceTimeMs: number) => number;
  readonly #prepareTimeoutMs: number;
  readonly #commandTimeoutMs: number;
  readonly #runtime: StreamingFlacPlaybackRuntime;
  readonly #seekIndex: FlacSeekIndex;
  readonly #totalOutputFrames: number;
  readonly #lifetimeAbort = new AbortController();
  readonly #timerPrefix: string;

  #phase: FilePlaybackSourcePhase = 'new';
  #revision = 0;
  #run: RevisionedPlaybackRun | null = null;
  #errorCode: string | null = null;
  #destination: AudioNode | null = null;
  #worker: Worker | null = null;
  #node: AudioWorkletNode | null = null;
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
  #mediaFrame = 0;
  #statusRenderFrame = 0;
  #bufferedFrames = 0;
  #underrunCount = 0;
  #currentDescriptor: FlacStreamDescriptor | null = null;
  #cancelRequested = false;
  #timerSerial = 0;

  constructor(options: StreamingFlacPlaybackSourceOptions) {
    if (!isBoundedIdentifier(options.queueItemId)) {
      throw new TypeError('Streaming FLAC queue item ID is invalid');
    }
    if (!(options.blob instanceof Blob) || options.blob.size <= 0) {
      throw new TypeError('Streaming FLAC requires a non-empty Blob');
    }
    const info = options.metadata?.streamInfo;
    if (
      !info ||
      !Number.isSafeInteger(info.sampleRate) ||
      info.sampleRate <= 0 ||
      !Number.isSafeInteger(info.channels) ||
      info.channels < 1 ||
      info.channels > FLAC_STREAM_MAX_CHANNELS ||
      !Number.isSafeInteger(info.bitDepth) ||
      info.bitDepth < 4 ||
      info.bitDepth > 32 ||
      !Number.isSafeInteger(info.totalSamples) ||
      info.totalSamples <= 0 ||
      !Number.isFinite(info.duration) ||
      info.duration <= 0 ||
      !Number.isSafeInteger(options.metadata.firstAudioFrameOffset) ||
      options.metadata.firstAudioFrameOffset < 4 ||
      options.metadata.firstAudioFrameOffset >= options.blob.size
    ) {
      throw new TypeError('Streaming FLAC metadata is invalid');
    }
    if (
      !Number.isFinite(options.audioContext.sampleRate) ||
      !Number.isSafeInteger(options.audioContext.sampleRate) ||
      options.audioContext.sampleRate <= 0
    ) {
      throw new TypeError('Streaming FLAC AudioContext is invalid');
    }
    if (
      typeof options.nowRoomTimeMs !== 'function' ||
      typeof options.roomTimeMsToContextTime !== 'function' ||
      typeof options.localPerformanceMsToContextTime !== 'function'
    ) {
      throw new TypeError('Streaming FLAC clock mappings are invalid');
    }

    this.queueItemId = options.queueItemId;
    sourceInstanceCounter += 1;
    this.#timerPrefix = `streaming-flac-${sourceInstanceCounter.toString(36)}`;
    this.#blob = options.blob;
    this.#metadata = options.metadata;
    this.#seekIndex = new FlacSeekIndex(options.metadata, options.blob.size);
    this.#audioContext = options.audioContext;
    this.#nowRoomTimeMs = options.nowRoomTimeMs;
    this.#totalOutputFrames = expectedOutputFrames(this.#descriptorForSourceSample(0));
    if (this.#totalOutputFrames <= 0) {
      throw new TypeError('Streaming FLAC has no renderable output frames');
    }
    this.#roomTimeMsToContextTime = options.roomTimeMsToContextTime;
    this.#localPerformanceMsToContextTime = options.localPerformanceMsToContextTime;
    this.#prepareTimeoutMs = boundedTimeout(
      options.prepareTimeoutMs,
      DEFAULT_PREPARE_TIMEOUT_MS,
      'prepareTimeoutMs',
    );
    this.#commandTimeoutMs = boundedTimeout(
      options.commandTimeoutMs,
      DEFAULT_COMMAND_TIMEOUT_MS,
      'commandTimeoutMs',
    );
    this.#runtime = {
      loadWorklet: options.runtime?.loadWorklet ?? defaultRuntime.loadWorklet,
      createWorker: options.runtime?.createWorker ?? defaultRuntime.createWorker,
      createWorkletNode: options.runtime?.createWorkletNode ?? defaultRuntime.createWorkletNode,
      createMessageChannel:
        options.runtime?.createMessageChannel ?? defaultRuntime.createMessageChannel,
    };
  }

  async prepare(signal?: AbortSignal): Promise<FilePlaybackSourceSnapshot> {
    this.#assertNotDestroyed();
    if (this.#phase === 'ready' || this.#phase === 'connected') return this.getSnapshot();
    if (this.#preparePromise) return this.#preparePromise;
    if (this.#phase !== 'new') {
      throw new Error(`Streaming FLAC source cannot prepare from phase ${this.#phase}`);
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
    this.#assertNotDestroyed();
    if (this.#phase === 'new' || this.#phase === 'preparing') {
      throw new Error('Streaming FLAC source must be prepared before it is connected');
    }
    if (this.#phase === 'failed') throw new Error('Streaming FLAC source has failed');
    if (destination.context !== this.#audioContext) {
      throw new TypeError('Streaming FLAC destination belongs to another AudioContext');
    }
    if (this.#destination && this.#destination !== destination) {
      throw new Error('Streaming FLAC source is already connected to another destination');
    }
    const node = this.#node;
    if (!node) throw new Error('Streaming FLAC AudioWorklet is unavailable');
    if (!this.#destination) {
      node.connect(destination);
      this.#destination = destination;
    }
    if (this.#phase === 'ready') this.#phase = 'connected';
    return this.getSnapshot();
  }

  async arm(intent: RendezvousArmIntent): Promise<RendezvousArmReceipt> {
    this.#expireUnfinalizedArm();
    if (!isRendezvousArmIntent(intent)) {
      return this.#armReceipt(intent, 'rejected', 'invalid-contract', this.#roomNow() ?? 0);
    }
    const preflight = this.#preflightArm(intent);
    if (!preflight.ok) return preflight.receipt;

    const pending = this.#pendingArmOperation;
    if (pending) {
      if (sameArmIntent(pending.intent, intent)) return pending.promise;
      if (intent.revision <= pending.intent.revision) {
        return this.#armReceipt(
          intent,
          'rejected',
          intent.revision < pending.intent.revision ? 'stale-revision' : 'run-already-active',
          preflight.observedAtRoomTimeMs,
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
    this.#pendingArmOperation = { intent: Object.freeze({ ...intent }), operation, promise };
    return promise;
  }

  #preflightArm(intent: RendezvousArmIntent): ArmPreflightResult {
    const roomNow = this.#roomNow();
    const observedAtRoomTimeMs = roomNow ?? 0;
    const reject = (reasonCode: string): ArmPreflightResult => ({
      ok: false,
      receipt: this.#armReceipt(intent, 'rejected', reasonCode, observedAtRoomTimeMs),
    });

    if (this.#phase === 'destroyed') return reject('source-destroyed');
    if (this.#phase === 'failed') return reject(this.#errorCode ?? 'source-failed');
    if (!this.#isContextRunning()) return reject('audio-context-not-running');
    if (roomNow === null) return reject('clock-unavailable');
    if (!this.#destination || !this.#node || !this.#worker) return reject('source-not-connected');
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

    const targetFrame = this.#roomTimeToRenderFrame(intent.startAtRoomTimeMs);
    if (targetFrame === null || targetFrame <= this.#currentRenderFrame) {
      return reject('start-not-in-future');
    }
    if (observedAtRoomTimeMs > intent.finalizeByRoomTimeMs) {
      return reject('arm-after-deadline');
    }
    if (this.#activeArm) {
      if (sameArmIntent(this.#activeArm.intent, intent)) {
        return { ok: false, receipt: this.#activeArm.receipt };
      }
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
  ): Promise<RendezvousArmReceipt> {
    let observedAtRoomTimeMs = preflight.observedAtRoomTimeMs;
    const targetFrame = preflight.targetFrame;
    const requestedMediaFrame = preflight.requestedMediaFrame;
    let forceReset = false;
    if (claimsRunWatermark) {
      const previousActive = this.#activeArm;
      this.#revision = intent.revision;
      this.#run = immutableRun(intent);
      if (supersededPendingIntent) {
        this.#postCancel(runIdentity(supersededPendingIntent));
        forceReset = this.#phase === 'preparing';
      }
      if (previousActive) {
        this.#cancelRequested = true;
        this.#postCancel(runIdentity(previousActive.intent));
        this.#activeArm = null;
        this.#pendingPause = null;
        forceReset = true;
      }
    }
    if (this.#phase === 'failed' || this.#phase === 'destroyed') {
      return this.#armReceipt(
        intent,
        'rejected',
        this.#phase === 'failed' ? (this.#errorCode ?? 'source-failed') : 'source-destroyed',
        observedAtRoomTimeMs,
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
          return this.#armReceipt(intent, 'rejected', 'operation-superseded', this.#roomNow() ?? 0);
        }
        return this.#armReceipt(
          intent,
          'rejected',
          this.#errorCode ??
            (error instanceof Error && error.name === 'AbortError'
              ? 'seek-prepare-aborted'
              : 'seek-prepare-failed'),
          observedAtRoomTimeMs,
        );
      }
      if (!this.#isCurrentOperation(operation)) {
        return this.#armReceipt(intent, 'rejected', 'operation-superseded', this.#roomNow() ?? 0);
      }
      observedAtRoomTimeMs = this.#roomNow() ?? 0;
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
    if (observedAtRoomTimeMs > intent.finalizeByRoomTimeMs) {
      return this.#armReceipt(intent, 'rejected', 'arm-after-deadline', observedAtRoomTimeMs);
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
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'arm',
      generation: this.#generation,
      ...identity,
      targetFrame,
      fadeInFrames: 0,
    });
    const event = await ack.promise;
    if (!this.#isCurrentOperation(operation)) {
      return this.#armReceipt(intent, 'rejected', 'operation-superseded', this.#roomNow() ?? 0);
    }
    if (event.type !== 'armed') {
      const code = event.type === 'rejected' ? event.code : 'worklet-arm-rejected';
      this.#postCancel(identity);
      return this.#armReceipt(intent, 'rejected', code, this.#observedRoomTimeForArm(intent));
    }

    observedAtRoomTimeMs = this.#observedRoomTimeForArm(intent);
    if (observedAtRoomTimeMs > intent.finalizeByRoomTimeMs) {
      this.#postCancel(identity);
      return this.#armReceipt(intent, 'rejected', 'arm-after-deadline', observedAtRoomTimeMs);
    }
    const receipt = this.#armReceipt(intent, 'armed', null, observedAtRoomTimeMs);
    this.#revision = intent.revision;
    this.#run = immutableRun(intent);
    this.#phase = 'armed';
    this.#activeArm = {
      intent: Object.freeze({ ...intent }),
      receipt,
      targetFrame,
      finalized: false,
      finalizeIntent: null,
      finalizeReceipt: null,
    };
    return receipt;
  }

  finalize(intent: RendezvousFinalizeIntent): Promise<RendezvousFinalizeReceipt> {
    const active = this.#activeArm;
    const roomNow = this.#roomNow();
    const observedAtRoomTimeMs = roomNow ?? 0;
    if (!isRendezvousFinalizeIntent(intent)) {
      return Promise.resolve(
        this.#finalizeReceipt(intent, 'rejected', 'invalid-contract', observedAtRoomTimeMs),
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

    const immutableIntent = Object.freeze({ ...intent });
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
    if (!this.#isContextRunning()) {
      this.#postCancel(runIdentity(active.intent));
      this.#activeArm = null;
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
      this.#activeArm = null;
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
        this.#activeArm = null;
        if (this.#phase !== 'failed' && this.#phase !== 'destroyed') this.#phase = 'paused';
      }
      return this.#finalizeReceipt(
        intent,
        missed ? 'missed-deadline' : 'rejected',
        validation.code,
        observedAtRoomTimeMs,
      );
    }
    if (active.targetFrame <= this.#currentRenderFrame) {
      this.#postCancel(runIdentity(active.intent));
      this.#activeArm = null;
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
    this.#postWorklet({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
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
        active.finalizeIntent = Object.freeze({ ...intent });
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
        active.finalizeIntent = Object.freeze({ ...intent });
        return this.#waitForCommitResolution(active, intent);
      }

      if (beforeTarget) this.#postCancel(identity);
      if (this.#activeArm === active && (beforeTarget || code !== 'worklet-command-timeout')) {
        this.#activeArm = null;
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
      if (this.#activeArm === active) this.#activeArm = null;
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
    active.finalized = true;
    active.finalizeIntent = Object.freeze({ ...intent });
    active.finalizeReceipt = this.#finalizeReceipt(
      intent,
      'accepted',
      null,
      Math.min(this.#roomNow() ?? observedAtRoomTimeMs, intent.startAtRoomTimeMs),
    );
    return active.finalizeReceipt;
  }

  async cancel(intent: FilePlaybackCancelIntent): Promise<FilePlaybackSourceSnapshot> {
    const pendingRun = this.#pendingArmOperation?.intent ?? null;
    if (
      intent.kind !== 'file-playback-cancel' ||
      (!sameRun(this.#run, intent) && !sameRun(pendingRun, intent)) ||
      !isBoundedIdentifier(intent.reasonCode)
    ) {
      return this.getSnapshot();
    }
    this.#cancelRequested = true;
    const identity = this.#activeArm
      ? runIdentity(this.#activeArm.intent)
      : this.#pendingArmOperation
        ? runIdentity(this.#pendingArmOperation.intent)
        : undefined;
    this.#postCancel(identity);
    this.#supersedeControlOperations('cancelled');
    this.#activeArm = null;
    this.#pendingPause = null;
    if (this.#phase !== 'failed' && this.#phase !== 'destroyed') this.#phase = 'cancelled';
    return this.getSnapshot();
  }

  async pause(intent: FilePlaybackPauseIntent): Promise<FilePlaybackSourceSnapshot> {
    if (
      intent.kind !== 'file-playback-pause' ||
      !sameRun(this.#run, intent) ||
      !Number.isFinite(intent.atRoomTimeMs) ||
      intent.atRoomTimeMs < 0 ||
      this.#phase !== 'playing' ||
      !this.#activeArm ||
      !this.#isContextRunning()
    ) {
      return this.getSnapshot();
    }
    if (this.#pendingPause) return this.getSnapshot();
    this.#schedulePause(intent.atRoomTimeMs, runIdentity(this.#activeArm.intent));
    return this.getSnapshot();
  }

  async seek(intent: FilePlaybackSeekIntent): Promise<FilePlaybackSourceSnapshot> {
    if (
      intent.kind !== 'file-playback-seek' ||
      !sameRun(this.#run, intent) ||
      !Number.isFinite(intent.positionSeconds) ||
      intent.positionSeconds < 0 ||
      !Number.isFinite(intent.atRoomTimeMs) ||
      intent.atRoomTimeMs < 0
    ) {
      return this.getSnapshot();
    }
    const operation = this.#beginControlOperation();
    try {
      const positionSeconds = Math.min(this.#durationSeconds, intent.positionSeconds);
      if (this.#phase === 'armed' && this.#activeArm) {
        this.#postCancel(runIdentity(this.#activeArm.intent));
        this.#activeArm = null;
        if (this.#errorCode === null) this.#phase = 'paused';
      }
      if (this.#phase === 'playing' && this.#activeArm) {
        const target = this.#schedulePause(
          intent.atRoomTimeMs,
          runIdentity(this.#activeArm.intent),
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

  positionAt(localPerformanceTimeMs: number): FilePlaybackPosition {
    if (!Number.isFinite(localPerformanceTimeMs) || localPerformanceTimeMs < 0) {
      throw new RangeError('Local performance time must be a finite non-negative number');
    }
    const contextTime = this.#localPerformanceMsToContextTime(localPerformanceTimeMs);
    if (!Number.isFinite(contextTime) || contextTime < 0) {
      throw new RangeError('Local performance time could not be mapped to AudioContext time');
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
      channelCount: this.#metadata.streamInfo.channels,
      underrunCount: this.#underrunCount,
      errorCode: this.#errorCode,
    });
  }

  async destroy(): Promise<void> {
    if (this.#phase === 'destroyed') return;
    this.#supersedeControlOperations('source-destroyed');
    this.#lifetimeAbort.abort(new DOMException('FLAC playback source was destroyed', 'AbortError'));
    this.#clearAcks('source-destroyed');
    this.#readiness?.reject(abortError(this.#lifetimeAbort.signal));
    this.#teardownRuntime();
    this.#destination = null;
    this.#run = null;
    this.#activeArm = null;
    this.#pendingPause = null;
    this.#phase = 'destroyed';
    this.#errorCode = null;
  }

  get #durationSeconds(): number {
    return this.#metadata.streamInfo.totalSamples / this.#metadata.streamInfo.sampleRate;
  }

  get #currentRenderFrame(): number {
    return this.#contextTimeToFrame(this.#audioContext.currentTime);
  }

  async #initialize(externalSignal?: AbortSignal): Promise<void> {
    const operation = this.#operationSignal(externalSignal);
    try {
      await this.#raceAbort(this.#runtime.loadWorklet(this.#audioContext), operation.signal);
      this.#assertOperationOpen(operation.signal);
      this.#worker = this.#runtime.createWorker();
      this.#worker.onmessage = (event: MessageEvent<unknown>) =>
        this.#handleWorkerEvent(event.data);
      this.#worker.onerror = () => this.#fail('decoder-worker-error');
      this.#worker.onmessageerror = () => this.#fail('decoder-message-error');

      this.#generation = 1;
      this.#node = this.#runtime.createWorkletNode(this.#audioContext, PROCESSOR_NAME, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [this.#metadata.streamInfo.channels],
        channelCount: this.#metadata.streamInfo.channels,
        channelCountMode: 'explicit',
        channelInterpretation: 'discrete',
        processorOptions: {
          channels: this.#metadata.streamInfo.channels,
          generation: this.#generation,
          mediaFrame: 0,
          capacitySeconds: RING_CAPACITY_SECONDS,
          primeSeconds: RING_PRIME_SECONDS,
        },
      });
      this.#node.port.onmessage = (event: MessageEvent<unknown>) =>
        this.#handleWorkletEvent(event.data);
      this.#node.port.onmessageerror = () => this.#fail('worklet-message-error');
      this.#node.onprocessorerror = () => this.#fail('worklet-processor-error');
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
    this.#activeArm = null;
    this.#pendingPause = null;
    this.#clearAcks('generation-reset');
    this.#postWorker({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'stop',
      generation: oldGeneration,
    });
    const sourceSample = this.#positionToSourceSample(positionSeconds);
    const mediaFrame = this.#sourceSampleToOutputFrame(sourceSample);
    this.#generation += 1;
    const generation = this.#generation;
    this.#postWorklet({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
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
    const worker = this.#worker;
    const node = this.#node;
    if (!worker || !node) throw new Error('FLAC streaming runtime is not initialized');
    this.#assertOperationOpen(signal);
    const readiness = createReadiness(generation);
    this.#readiness = readiness;
    this.#mediaFrame = mediaFrame;
    this.#bufferedFrames = 0;
    this.#statusRenderFrame = this.#currentRenderFrame;
    this.#underrunCount = 0;

    const channel = this.#runtime.createMessageChannel();
    const descriptor = this.#descriptorForSourceSample(startSourceSample);
    this.#currentDescriptor = descriptor;
    try {
      node.port.postMessage(
        {
          protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
          type: 'bind-pcm-port',
          generation,
          port: channel.port2,
        } satisfies PcmRingCommand,
        [channel.port2],
      );
      worker.postMessage(
        {
          protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
          type: 'init',
          generation,
          blob: this.#blob,
          descriptor,
          pcmPort: channel.port1,
        } satisfies FlacDecoderCommand,
        [channel.port1],
      );
      await this.#raceAbort(readiness.promise, signal);
    } catch (error) {
      try {
        worker.postMessage({
          protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
          type: 'stop',
          generation,
        } satisfies FlacDecoderCommand);
      } catch {
        // A superseded generation may already have lost its worker ownership.
      }
      // Closing a successfully transferred port is harmless in the sender;
      // closing an untransferred port prevents partial initialization leaks.
      safeClosePort(channel.port1);
      safeClosePort(channel.port2);
      throw error;
    } finally {
      if (this.#readiness === readiness) this.#readiness = null;
    }
  }

  #descriptorForSourceSample(startSourceSample: number): FlacStreamDescriptor {
    const info = this.#metadata.streamInfo;
    const anchor = this.#seekIndex.nearestBefore(startSourceSample);
    return Object.freeze({
      sourceSampleRate: info.sampleRate,
      outputSampleRate: this.#audioContext.sampleRate,
      channels: info.channels,
      bitDepth: info.bitDepth,
      totalSourceSamples: info.totalSamples,
      firstAudioFrameOffset: this.#metadata.firstAudioFrameOffset,
      targetSourceSample: startSourceSample,
      decodeAnchorByteOffset: anchor.byteOffset,
      decodeAnchorSourceSample: anchor.sourceSample,
      minBlockSize: info.minBlockSize,
      maxBlockSize: info.maxBlockSize,
      minFrameSize: info.minFrameSize,
      maxFrameSize: info.maxFrameSize,
    });
  }

  #handleWorkerEvent(value: unknown): void {
    if (
      !isRecord(value) ||
      value.protocolVersion !== FLAC_STREAM_PROTOCOL_VERSION ||
      value.generation !== this.#generation
    ) {
      return;
    }
    if (this.#phase === 'destroyed' || this.#phase === 'failed' || this.#phase === 'cancelled') {
      return;
    }
    if (value.type === 'decoder-error') {
      const message = typeof value.message === 'string' ? value.message : 'FLAC decoder failed';
      this.#readiness?.reject(new Error(message));
      this.#fail(`decoder:${safeErrorCode(value.code, 'unknown')}`);
      return;
    }
    if (value.type === 'decoder-stopped') {
      if (this.#readiness && !this.#readiness.settled) {
        this.#readiness.reject(new Error('FLAC decoder stopped before priming'));
      }
      return;
    }
    if (value.type === 'decode-anchor-rejected') {
      if (!isFrame(value.sourceSample) || !isFrame(value.byteOffset)) {
        this.#fail('decoder-invalid-anchor-rejection');
        return;
      }
      this.#seekIndex.rejectUnverifiedCandidate(value.sourceSample, value.byteOffset);
      return;
    }
    if (value.type === 'frame-index-point') {
      if (!isFrame(value.sourceSample) || !isFrame(value.byteOffset)) {
        this.#fail('decoder-invalid-index-point');
        return;
      }
      this.#seekIndex.addVerifiedFrame(value.sourceSample, value.byteOffset);
      return;
    }
    if (value.type !== 'decoder-ready') return;
    if (!isRecord(value.descriptor)) {
      this.#readiness?.reject(new Error('FLAC decoder descriptor is missing'));
      this.#fail('decoder-invalid-event');
      return;
    }
    const expected = this.#currentDescriptor;
    if (!expected || !sameDescriptor(value.descriptor, expected)) {
      this.#readiness?.reject(new Error('FLAC decoder descriptor mismatch'));
      this.#fail('decoder-descriptor-mismatch');
      return;
    }
    if (this.#readiness?.generation === value.generation) {
      this.#readiness.decoderReady = true;
      this.#resolveReadiness();
    }
  }

  #handleWorkletEvent(value: unknown): void {
    if (
      !isRecord(value) ||
      value.protocolVersion !== FLAC_STREAM_PROTOCOL_VERSION ||
      value.generation !== this.#generation
    ) {
      return;
    }
    if (this.#phase === 'destroyed' || this.#phase === 'failed') return;
    if (!isPcmRingEventBoundary(value)) {
      this.#fail('worklet-invalid-event');
      return;
    }
    if (this.#phase === 'cancelled' && value.type !== 'interrupted' && value.type !== 'rejected') {
      return;
    }
    switch (value.type) {
      case 'primed':
        if (
          value.sampleRate !== this.#audioContext.sampleRate ||
          value.channels !== this.#metadata.streamInfo.channels
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
        if (!sameStreamIdentity(value, runIdentity(this.#activeArm.intent))) return;
        if (
          value.targetFrame !== this.#activeArm.targetFrame ||
          value.actualStartFrame !== this.#activeArm.targetFrame
        ) {
          this.#fail('worklet-start-target-mismatch');
          return;
        }
        this.#phase = 'playing';
        this.#activeArm.finalized = true;
        if (this.#activeArm.finalizeIntent && !this.#activeArm.finalizeReceipt) {
          this.#activeArm.finalizeReceipt = this.#finalizeReceipt(
            this.#activeArm.finalizeIntent,
            'accepted',
            null,
            Math.min(
              this.#roomNow() ?? this.#activeArm.intent.startAtRoomTimeMs,
              this.#activeArm.intent.startAtRoomTimeMs,
            ),
          );
        }
        if (this.#activeArm.finalizeReceipt) {
          this.#resolvePendingCommit(this.#activeArm, this.#activeArm.finalizeReceipt);
        }
        this.#mediaFrame = value.mediaFrame;
        this.#statusRenderFrame = value.actualStartFrame;
        this.#pendingPause = null;
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
        this.#activeArm = null;
        const pauseWait = this.#pendingPauseWait;
        if (pauseWait?.targetFrame === value.targetFrame) {
          if (this.#pendingPauseWait === pauseWait) this.#pendingPauseWait = null;
          pauseWait.resolve();
        }
        break;
      }
      case 'finished':
        this.#phase = 'ended';
        this.#mediaFrame = value.mediaFrame;
        this.#bufferedFrames = 0;
        this.#pendingPause = null;
        this.#activeArm = null;
        break;
      case 'status':
        this.#mediaFrame = value.mediaFrame;
        this.#statusRenderFrame = value.renderFrame;
        this.#bufferedFrames = value.bufferedFrames;
        this.#underrunCount = value.underruns;
        if (value.state === 'playing') this.#phase = 'playing';
        else if (value.state === 'paused') {
          this.#phase = 'paused';
          this.#activeArm = null;
        } else if (value.state === 'finished') {
          this.#phase = 'ended';
          this.#activeArm = null;
        } else if (value.state === 'interrupted') this.#fail('worklet:interrupted');
        break;
      case 'interrupted':
        if (this.#cancelRequested && value.code === 'cancelled-after-start') {
          this.#phase = 'cancelled';
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
            const receipt = this.#finalizeReceipt(
              pendingCommit.intent,
              'missed-deadline',
              value.code,
              this.#roomNow() ?? active.intent.startAtRoomTimeMs,
            );
            active.finalizeReceipt = receipt;
            this.#resolvePendingCommit(active, receipt);
          }
          this.#activeArm = null;
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
    identity: FlacStreamRunIdentity,
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
    identity: FlacStreamRunIdentity,
    code: string,
  ): PcmRingEvent {
    return {
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
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
      intent: Object.freeze({ ...intent }),
      promise,
      resolve: resolvePromise,
      timerKey,
    };
    this.#pendingCommitResolution = pending;
    setManagedTimer(
      timerKey,
      () => {
        if (this.#pendingCommitResolution !== pending) return;
        this.#pendingCommitResolution = null;
        const receipt = this.#finalizeReceipt(
          pending.intent,
          'rejected',
          'commit-status-unknown',
          this.#roomNow() ?? pending.intent.startAtRoomTimeMs,
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
        this.#roomNow() ?? pending.intent.startAtRoomTimeMs,
      ),
    );
  }

  #schedulePause(atRoomTimeMs: number, identity: FlacStreamRunIdentity): number | null {
    if (!this.#isContextRunning()) return null;
    const mapped = this.#roomTimeToRenderFrame(atRoomTimeMs);
    if (mapped === null) return null;
    const targetFrame = Math.max(mapped, this.#currentRenderFrame + 128);
    const current = this.#viewAtRenderFrame(targetFrame);
    this.#pendingPause = { targetFrame, mediaFrame: current.mediaFrame, identity };
    this.#postWorklet({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
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
    const totalFrames = this.#totalOutputFrames;
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
      this.#isContextRunning() &&
      observed !== null &&
      observed <= active.intent.finalizeByRoomTimeMs &&
      this.#currentRenderFrame < active.targetFrame
    ) {
      return;
    }
    this.#postCancel(runIdentity(active.intent));
    this.#activeArm = null;
    if (this.#phase !== 'failed' && this.#phase !== 'destroyed') this.#phase = 'paused';
  }

  #postCancel(identity?: FlacStreamRunIdentity): void {
    if (!this.#node || this.#generation <= 0) return;
    this.#postWorklet({
      protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
      type: 'cancel',
      generation: this.#generation,
      ...identity,
    });
  }

  #postWorklet(command: PcmRingCommand): void {
    try {
      this.#node?.port.postMessage(command);
    } catch (error) {
      this.#fail('worklet-command-failed', error);
    }
  }

  #postWorker(command: FlacDecoderCommand): void {
    try {
      this.#worker?.postMessage(command);
    } catch (error) {
      this.#fail('decoder-command-failed', error);
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

  #positionToSourceSample(positionSeconds: number): number {
    const sample = Math.round(positionSeconds * this.#metadata.streamInfo.sampleRate);
    return Math.min(this.#metadata.streamInfo.totalSamples, Math.max(0, sample));
  }

  #positionToOutputFrame(positionSeconds: number): number {
    return this.#sourceSampleToOutputFrame(this.#positionToSourceSample(positionSeconds));
  }

  #sourceSampleToOutputFrame(sourceSample: number): number {
    const remainingOutputFrames = expectedOutputFrames(
      this.#descriptorForSourceSample(sourceSample),
    );
    return this.#totalOutputFrames - remainingOutputFrames;
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

  #isTerminalPhase(): boolean {
    return this.#phase === 'failed' || this.#phase === 'destroyed';
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
        status === 'armed' ? this.#bufferedFrames / this.#audioContext.sampleRate : 0,
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
        const error = new Error('Streaming FLAC preparation timed out');
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
    this.#errorCode = safeErrorCode(code, 'streaming-flac-failed');
    this.#phase = 'failed';
    this.#supersedeControlOperations(this.#errorCode);
    const error = cause instanceof Error ? cause : new Error(this.#errorCode);
    this.#readiness?.reject(error);
    this.#clearAcks(this.#errorCode);
    const pauseWait = this.#pendingPauseWait;
    this.#pendingPauseWait = null;
    pauseWait?.resolve();
    this.#teardownRuntime();
  }

  #teardownRuntime(): void {
    const worker = this.#worker;
    const node = this.#node;
    this.#worker = null;
    this.#node = null;
    this.#currentDescriptor = null;
    if (worker) {
      try {
        worker.postMessage({
          protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
          type: 'stop',
          generation: this.#generation,
        } satisfies FlacDecoderCommand);
      } catch {
        // Worker may already have crossed its terminal boundary.
      }
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    }
    if (node) {
      try {
        node.port.postMessage({
          protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
          type: 'stop',
          generation: this.#generation,
        } satisfies PcmRingCommand);
      } catch {
        // AudioWorklet may already have stopped.
      }
      node.port.onmessage = null;
      node.port.onmessageerror = null;
      node.onprocessorerror = null;
      safeClosePort(node.port);
      safeDisconnect(node);
    }
  }

  #assertNotDestroyed(): void {
    if (this.#phase === 'destroyed') {
      throw new Error('Streaming FLAC playback source has been destroyed');
    }
  }

  #nextTimerKey(label: string): string {
    this.#timerSerial += 1;
    return `${this.#timerPrefix}-${label}-${this.#timerSerial.toString(36)}`;
  }
}
