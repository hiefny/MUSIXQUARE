import type {
  StreamingDecoderAdapter,
  StreamingDecoderFatalHandler,
  StreamingDecoderGenerationRequest,
  StreamingDecoderGenerationStoppedHandler,
  StreamingDecoderMediaInfo,
  StreamingDecoderOpenOptions,
} from '../streaming/decoder-adapter.ts';
import {
  PCM_STREAM_PROTOCOL_VERSION,
  parsePcmDemandMessage,
  type PcmSupplyMessage,
} from '../streaming/pcm-stream-protocol.ts';
import {
  type EncodedAudioSource,
  type EncodedAudioSourceKind,
  isEncodedAudioSourceIdentity,
  throwIfAborted,
  validateExactRead,
} from '../sources/encoded-audio-source.ts';
import {
  EncodedAudioSourceLifetime,
  type EncodedAudioSourceLease,
} from '../sources/encoded-audio-source-lifetime.ts';
import {
  acquireFilePlaybackUniversalLifecycleLease,
  type FilePlaybackUniversalLifecycleLease,
} from '../diagnostics/file-playback-universal-lifecycle-diagnostics.ts';
import { confirmFilePlaybackUniversalLifecycleRetirement } from '../diagnostics/file-playback-universal-lifecycle-retirement.ts';
import { EncodedSourcePortBroker } from '../sources/encoded-source-port.ts';
import {
  createAacDecoderDescriptor,
  createAacDecoderDescriptorFromTimelineEvidence,
  expectedAacOutputFrames,
  rebuildAacDecoderPlanningState,
  rebuildAacDecoderTimelinePlanningState,
} from './decoder-helpers.js';
import type { AdtsDecoderTimelineEvidence } from './decoder-timeline-evidence.js';
import {
  AAC_DECODER_MAX_OUTPUT_SAMPLE_RATE_HZ,
  AAC_DECODER_PROTOCOL_VERSION,
  aacDecoderCommandTransferables,
  isAacDecoderGeneration,
  parseAacDecoderEvent,
  sameAacDecoderDescriptor,
  type AacDecoderBackendId,
  type AacDecoderDescriptor,
  type AacDecoderEvent,
  type AacDecoderOpenCommand,
  type AacDecoderStopCommand,
} from './decoder-protocol.js';
import type { AdtsFrameScanResult } from './frame-scanner.js';
import { ADTS_CORE_FRAMES_PER_ACCESS_UNIT } from './timeline.js';

const MAX_FATAL_CODE_LENGTH = 256;
const SOURCE_KINDS = new Set<EncodedAudioSourceKind>(['blob', 'peer-range', 'r2-records']);

export interface AacDecoderAdapterRuntime {
  /** A fresh Worker must be returned for every invocation. */
  readonly createWorker: () => Worker;
  readonly createMessageChannel: () => MessageChannel;
}

interface AacDecoderAdapterCommonOptions {
  /** Ownership transfers only after this constructor validates successfully. */
  readonly encodedSource: EncodedAudioSource;
  /** Exact room/cohort decoder choice. This adapter never substitutes another backend. */
  readonly backendId: AacDecoderBackendId;
  readonly runtime: AacDecoderAdapterRuntime;
}

export interface AacDecoderAdapterScanOptions extends AacDecoderAdapterCommonOptions {
  /** Complete same-source scanner evidence. Encoded access-unit bodies are not retained. */
  readonly scan: Readonly<AdtsFrameScanResult>;
  readonly timelineEvidence?: never;
}

export interface AacDecoderAdapterTimelineEvidenceOptions extends AacDecoderAdapterCommonOptions {
  /** Externally admitted decoder-only evidence; it carries no scanner/sealer authority. */
  readonly timelineEvidence: Readonly<AdtsDecoderTimelineEvidence>;
  readonly scan?: never;
}

export type AacDecoderAdapterOptions =
  | AacDecoderAdapterScanOptions
  | AacDecoderAdapterTimelineEvidenceOptions;

interface Deferred {
  settled: boolean;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface GenerationBase {
  readonly generation: number;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  retired: boolean;
}

interface WorkerRealm extends GenerationBase {
  readonly kind: 'worker';
  readonly sourceLifetimeGeneration: number;
  readonly descriptor: Readonly<AacDecoderDescriptor>;
  readonly expectedOutputFrames: number;
  readonly worker: Worker;
  readonly lease: EncodedAudioSourceLease;
  readonly broker: EncodedSourcePortBroker;
  readonly sourcePort: MessagePort;
  readonly pcmPort: MessagePort;
  readonly readiness: Deferred;
  readonly decoderRetired: Deferred;
  readonly workerRetired: Deferred;
  readonly generationLifecycle: FilePlaybackUniversalLifecycleLease;
  readonly workerLifecycle: FilePlaybackUniversalLifecycleLease;
  readonly sourcePortLifecycle: FilePlaybackUniversalLifecycleLease;
  readonly pcmPortLifecycle: FilePlaybackUniversalLifecycleLease;
  readonly retryWaitLifecycles: Array<{
    readonly wait: FilePlaybackUniversalLifecycleLease;
    readonly timer: FilePlaybackUniversalLifecycleLease;
  }>;
  portOwnership: 'local' | 'posting' | 'worker';
  cleanupStarted: boolean;
  transferUncertain: boolean;
  stopSent: boolean;
  decoderRetiredAcknowledged: boolean;
  workerRetiredAcknowledged: boolean;
  retryWaitSequence: number;
  readonly cleanupCompletion: Deferred;
  cleanupPromise: Promise<void> | null;
  retirementFaulted: boolean;
  ready: boolean;
  eof: boolean;
  decodedInputBytes: number;
  decodedCoreFrames: number;
  producedOutputFrames: number;
}

interface EofGeneration extends GenerationBase {
  readonly kind: 'eof';
  readonly port: MessagePort;
  replied: boolean;
  terminal: { readonly cause: unknown } | null;
  readonly generationLifecycle: FilePlaybackUniversalLifecycleLease;
  readonly portLifecycle: FilePlaybackUniversalLifecycleLease;
}

type ActiveGeneration = WorkerRealm | EofGeneration;

interface AdapterScanOptionSnapshot {
  readonly kind: 'scan';
  readonly encodedSource: unknown;
  readonly scan: unknown;
  readonly backendId: unknown;
  readonly runtime: unknown;
}

interface AdapterTimelineEvidenceOptionSnapshot {
  readonly kind: 'timeline-evidence';
  readonly encodedSource: unknown;
  readonly timelineEvidence: unknown;
  readonly backendId: unknown;
  readonly runtime: unknown;
}

type AdapterOptionSnapshot = AdapterScanOptionSnapshot | AdapterTimelineEvidenceOptionSnapshot;

type AdapterPlanningEvidence =
  | { readonly kind: 'scan'; readonly scan: Readonly<AdtsFrameScanResult> }
  | {
      readonly kind: 'timeline-evidence';
      readonly evidence: Readonly<AdtsDecoderTimelineEvidence>;
    };

function createDeferred(): Deferred {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const deferred: Deferred = {
    settled: false,
    promise,
    resolve: () => {
      if (deferred.settled) return;
      deferred.settled = true;
      resolvePromise();
    },
    reject: (error) => {
      if (deferred.settled) return;
      deferred.settled = true;
      rejectPromise(error);
    },
  };
  return deferred;
}

function safeErrorCode(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  return value.slice(0, MAX_FATAL_CODE_LENGTH);
}

function safeClosePort(port: MessagePort | null): boolean {
  if (!port) return true;
  try {
    port.close();
    return true;
  } catch {
    // A transferred or previously closed endpoint no longer belongs here.
    return false;
  }
}

function safeTerminateWorker(worker: Worker | null): void {
  if (!worker) return;
  try {
    worker.terminate();
  } catch {
    // The fresh realm may already have crossed its terminal boundary.
  }
}

function safeDetachPortHandlers(port: MessagePort): void {
  try {
    port.onmessage = null;
  } catch {
    // Closing the owned endpoint below remains the terminal boundary.
  }
  try {
    port.onmessageerror = null;
  } catch {
    // Closing the owned endpoint below remains the terminal boundary.
  }
}

function safeDetachWorkerHandlers(worker: Worker): void {
  try {
    worker.onmessage = null;
  } catch {
    // Best-effort detach after a confirmed or forced terminal boundary.
  }
  try {
    worker.onerror = null;
  } catch {
    // Best-effort detach after a confirmed or forced terminal boundary.
  }
  try {
    worker.onmessageerror = null;
  } catch {
    // Best-effort detach after a confirmed or forced terminal boundary.
  }
}

function safeRemoveAbortListener(signal: AbortSignal, listener: () => void): void {
  try {
    signal.removeEventListener('abort', listener);
  } catch {
    // Owned resource teardown must continue even across an injected EventTarget.
  }
}

function reinforceTerminalWorkerRealm(realm: WorkerRealm): void {
  safeRemoveAbortListener(realm.signal, realm.onAbort);
  safeDetachWorkerHandlers(realm.worker);
}

function reinforceTerminalEofGeneration(generation: EofGeneration): void {
  safeRemoveAbortListener(generation.signal, generation.onAbort);
  safeDetachPortHandlers(generation.port);
}

function initiateWorkerRealmCleanup(realm: WorkerRealm): void {
  try {
    void realm.broker.close().catch(() => undefined);
  } catch {
    // The logical lease close below still severs this generation immediately.
  }
  try {
    void realm.lease.close().catch(() => undefined);
  } catch {
    // Sticky lifecycle diagnostics already record the forced boundary.
  }
}

function releaseLocalLifecycleLease(lease: FilePlaybackUniversalLifecycleLease | null): void {
  if (!lease) return;
  lease.beginRetire().release();
}

interface EofGenerationRequestSnapshot {
  readonly generation: number;
  readonly signal: AbortSignal;
  readonly pcmPort: MessagePort;
}

function snapshotEofGenerationRequest(
  request: StreamingDecoderGenerationRequest,
): EofGenerationRequestSnapshot {
  return {
    generation: request.generation,
    signal: request.signal,
    pcmPort: request.pcmPort,
  };
}

function acquireAcceptedEofLifecycles(request: StreamingDecoderGenerationRequest): {
  readonly generation: FilePlaybackUniversalLifecycleLease;
  readonly port: FilePlaybackUniversalLifecycleLease;
} {
  const generation = acquireFilePlaybackUniversalLifecycleLease('decoderGenerations');
  let port: FilePlaybackUniversalLifecycleLease;
  try {
    port = acquireFilePlaybackUniversalLifecycleLease('ports');
  } catch (error) {
    releaseLocalLifecycleLease(generation);
    throw error;
  }
  try {
    request.acceptPcmPortOwnership();
  } catch (error) {
    releaseLocalLifecycleLease(port);
    releaseLocalLifecycleLease(generation);
    throw error;
  }
  return { generation, port };
}

function isMessagePortLike(value: unknown): value is MessagePort {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as MessagePort).postMessage === 'function' &&
    typeof (value as MessagePort).close === 'function'
  );
}

function isRetryWaitDeltaEnvelope(value: unknown): boolean {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, 'type');
    return (
      !!descriptor && Object.hasOwn(descriptor, 'value') && descriptor.value === 'retry-wait-delta'
    );
  } catch {
    return false;
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason !== undefined
    ? signal.reason
    : new DOMException('AAC decoder operation was aborted', 'AbortError');
}

function asError(value: unknown, fallback: string): Error {
  try {
    if (value instanceof Error) return value;
  } catch {
    // Hostile thrown values must not prevent terminal generation cleanup.
  }
  try {
    return new Error(fallback, value === undefined ? undefined : { cause: value });
  } catch {
    return new Error(fallback);
  }
}

function stoppedBeforeReadyError(): Error {
  return new Error('AAC decoder stopped before priming');
}

function snapshotOptions(value: unknown): AdapterOptionSnapshot {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('AAC decoder adapter options are required');
  }

  try {
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('AAC decoder adapter options must use a plain or null prototype');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
      PropertyKey,
      PropertyDescriptor | undefined
    >;
    const hasScan = Object.hasOwn(descriptors, 'scan');
    const hasTimelineEvidence = Object.hasOwn(descriptors, 'timelineEvidence');
    if (hasScan === hasTimelineEvidence) {
      throw new TypeError(
        'AAC decoder adapter options require exactly one of scan or timelineEvidence',
      );
    }
    const keys = hasScan
      ? (['encodedSource', 'scan', 'backendId', 'runtime'] as const)
      : (['encodedSource', 'timelineEvidence', 'backendId', 'runtime'] as const);
    const expected = new Set<PropertyKey>(keys);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.length !== keys.length || ownKeys.some((key) => !expected.has(key))) {
      throw new TypeError('AAC decoder adapter options must be an exact data-only record');
    }
    const read = (key: (typeof keys)[number]): unknown => {
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError(
          `AAC decoder adapter option ${key} must be an enumerable data property`,
        );
      }
      return descriptor.value;
    };
    const encodedSource = read('encodedSource');
    const backendId = read('backendId');
    const runtime = read('runtime');
    return hasScan
      ? Object.freeze({
          kind: 'scan',
          encodedSource,
          scan: read('scan'),
          backendId,
          runtime,
        })
      : Object.freeze({
          kind: 'timeline-evidence',
          encodedSource,
          timelineEvidence: read('timelineEvidence'),
          backendId,
          runtime,
        });
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError('AAC decoder adapter options could not be inspected', { cause: error });
  }
}

/**
 * Capture one stable source facade without taking ownership. The lifetime is
 * constructed only after every other constructor check succeeds.
 */
function snapshotEncodedSource(value: unknown): EncodedAudioSource {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    throw new TypeError('Streaming AAC requires an encoded source');
  }
  try {
    const kind = Reflect.get(value, 'kind') as unknown;
    const size = Reflect.get(value, 'size') as unknown;
    const identity = Reflect.get(value, 'identity') as unknown;
    const metadataValue = Reflect.get(value, 'metadata') as unknown;
    const readAt = Reflect.get(value, 'readAt') as unknown;
    const close = Reflect.get(value, 'close') as unknown;
    if (!SOURCE_KINDS.has(kind as EncodedAudioSourceKind)) {
      throw new TypeError('Streaming AAC encoded source kind is invalid');
    }
    if (typeof size !== 'number') {
      throw new TypeError('Streaming AAC encoded source size is invalid');
    }
    validateExactRead(size, 0, 0);
    if (size <= 0 || !isEncodedAudioSourceIdentity(identity)) {
      throw new TypeError('Streaming AAC requires a valid non-empty encoded source');
    }
    if (
      metadataValue === null ||
      (typeof metadataValue !== 'object' && typeof metadataValue !== 'function')
    ) {
      throw new TypeError('Streaming AAC encoded source metadata is invalid');
    }
    const name = Reflect.get(metadataValue, 'name') as unknown;
    const mime = Reflect.get(metadataValue, 'mime') as unknown;
    if (typeof name !== 'string' || typeof mime !== 'string') {
      throw new TypeError('Streaming AAC encoded source metadata is invalid');
    }
    if (typeof readAt !== 'function' || typeof close !== 'function') {
      throw new TypeError('Streaming AAC encoded source methods are invalid');
    }
    const target = value;
    return Object.freeze({
      kind: kind as EncodedAudioSourceKind,
      size,
      identity,
      metadata: Object.freeze({ name, mime }),
      readAt: (offset: number, length: number, signal: AbortSignal) =>
        Reflect.apply(readAt, target, [offset, length, signal]) as Promise<Uint8Array>,
      close: () => Reflect.apply(close, target, []) as Promise<void>,
    });
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) throw error;
    throw new TypeError('Streaming AAC encoded source could not be inspected', { cause: error });
  }
}

function snapshotRuntime(value: unknown): Readonly<AacDecoderAdapterRuntime> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    throw new TypeError('Streaming AAC decoder runtime is invalid');
  }
  try {
    const createWorker = Reflect.get(value, 'createWorker') as unknown;
    const createMessageChannel = Reflect.get(value, 'createMessageChannel') as unknown;
    if (typeof createWorker !== 'function' || typeof createMessageChannel !== 'function') {
      throw new TypeError('Streaming AAC decoder runtime is invalid');
    }
    const target = value;
    return Object.freeze({
      createWorker: () => Reflect.apply(createWorker, target, []) as Worker,
      createMessageChannel: () => Reflect.apply(createMessageChannel, target, []) as MessageChannel,
    });
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError('Streaming AAC decoder runtime could not be inspected', { cause: error });
  }
}

function snapshotBackendId(value: unknown): AacDecoderBackendId {
  if (value !== 'webcodecs' && value !== 'symphonia-wasm') {
    throw new TypeError('Streaming AAC decoder backend is invalid');
  }
  return value;
}

/** Fresh-realm bounded AAC decoder owner below the PCM renderer. */
export class AacDecoderAdapter implements StreamingDecoderAdapter {
  readonly info: Readonly<StreamingDecoderMediaInfo>;

  readonly #planningEvidence: AdapterPlanningEvidence;
  readonly #backendId: AacDecoderBackendId;
  readonly #runtime: Readonly<AacDecoderAdapterRuntime>;
  readonly #sourceLifetime: EncodedAudioSourceLifetime;

  #openPromise: Promise<void> | null = null;
  #fatalHandler: StreamingDecoderFatalHandler | null = null;
  #generationStoppedHandler: StreamingDecoderGenerationStoppedHandler | null = null;
  #lifetimeSignal: AbortSignal | null = null;
  readonly #onLifetimeAbort = (): void => {
    const signal = this.#lifetimeSignal;
    void this.#closeInternal(
      signal
        ? abortReason(signal)
        : new DOMException('AAC decoder lifetime was aborted', 'AbortError'),
    );
  };
  #activeGeneration: ActiveGeneration | null = null;
  readonly #retirementPromises = new Set<Promise<void>>();
  #pendingWorkerRetirement: Promise<void> | null = null;
  #opened = false;
  #closed = false;
  #closePromise: Promise<void> | null = null;

  constructor(optionsValue: AacDecoderAdapterOptions) {
    const options = snapshotOptions(optionsValue);
    const source = snapshotEncodedSource(options.encodedSource);
    const runtime = snapshotRuntime(options.runtime);
    const backendId = snapshotBackendId(options.backendId);

    let sourceIdentity: string;
    let sourceSize: number;
    let mediaSampleRateHz: number;
    let channelCount: 1 | 2;
    let totalMediaFrames: number;
    if (options.kind === 'scan') {
      let planning: ReturnType<typeof rebuildAacDecoderPlanningState>;
      try {
        planning = rebuildAacDecoderPlanningState(options.scan as AdtsFrameScanResult);
      } catch (error) {
        throw new TypeError('Streaming AAC scan evidence is invalid', { cause: error });
      }
      sourceIdentity = planning.scan.sourceIdentity;
      sourceSize = planning.scan.sourceSize;
      mediaSampleRateHz = planning.scan.coreSampleRateHz;
      channelCount = planning.scan.coreChannelCount;
      totalMediaFrames = planning.timeline.totalMediaFrames;
      this.#planningEvidence = Object.freeze({ kind: 'scan', scan: planning.scan });
    } else {
      let planning: ReturnType<typeof rebuildAacDecoderTimelinePlanningState>;
      try {
        planning = rebuildAacDecoderTimelinePlanningState(
          options.timelineEvidence as AdtsDecoderTimelineEvidence,
        );
      } catch (error) {
        throw new TypeError('Streaming AAC timeline evidence is invalid', { cause: error });
      }
      sourceIdentity = planning.evidence.sourceIdentity;
      sourceSize = planning.evidence.sourceSize;
      mediaSampleRateHz = planning.evidence.coreSampleRateHz;
      channelCount = planning.evidence.coreChannelCount;
      totalMediaFrames = planning.timeline.totalMediaFrames;
      this.#planningEvidence = Object.freeze({
        kind: 'timeline-evidence',
        evidence: planning.evidence,
      });
    }
    if (sourceSize !== source.size || sourceIdentity !== source.identity) {
      throw new TypeError('Streaming AAC planning evidence belongs to a different encoded source');
    }

    this.#backendId = backendId;
    this.#runtime = runtime;
    this.info = Object.freeze({
      mediaSampleRateHz,
      channelCount,
      totalMediaFrames,
    });
    // Final ownership boundary: every later field is already initialized and
    // this stable facade has passed the lifetime's full source validation.
    this.#sourceLifetime = new EncodedAudioSourceLifetime({ source });
  }

  get opened(): boolean {
    return this.#opened && !this.#closed;
  }

  open(options: StreamingDecoderOpenOptions): Promise<void> {
    if (this.#openPromise) return this.#openPromise;
    if (this.#closed) return Promise.reject(new Error('AAC decoder adapter is closed'));
    if (
      !options ||
      !(options.signal instanceof AbortSignal) ||
      !(options.lifetimeSignal instanceof AbortSignal) ||
      typeof options.onFatal !== 'function' ||
      typeof options.onGenerationStopped !== 'function'
    ) {
      return Promise.reject(new TypeError('AAC decoder open options are invalid'));
    }
    this.#fatalHandler = options.onFatal;
    this.#generationStoppedHandler = options.onGenerationStopped;
    this.#openPromise = Promise.resolve().then(() => {
      throwIfAborted(options.signal);
      throwIfAborted(options.lifetimeSignal);
      if (this.#closed) throw new Error('AAC decoder adapter is closed');
      this.#lifetimeSignal = options.lifetimeSignal;
      try {
        options.lifetimeSignal.addEventListener('abort', this.#onLifetimeAbort, { once: true });
      } catch (error) {
        if (this.#closed || this.#lifetimeSignal !== options.lifetimeSignal) {
          safeRemoveAbortListener(options.lifetimeSignal, this.#onLifetimeAbort);
          throw new Error('AAC decoder adapter is closed', { cause: error });
        }
        throw error;
      }
      if (this.#closed || this.#lifetimeSignal !== options.lifetimeSignal) {
        safeRemoveAbortListener(options.lifetimeSignal, this.#onLifetimeAbort);
        throw new Error('AAC decoder adapter is closed');
      }
      if (options.lifetimeSignal.aborted) {
        this.#onLifetimeAbort();
        throw abortReason(options.lifetimeSignal);
      }
      this.#opened = true;
    });
    return this.#openPromise;
  }

  startGeneration(request: StreamingDecoderGenerationRequest): Promise<void> {
    if (!this.opened) return Promise.reject(new Error('AAC streaming runtime is not initialized'));
    if (
      !request ||
      !isAacDecoderGeneration(request.generation) ||
      !Number.isSafeInteger(request.targetMediaFrame) ||
      request.targetMediaFrame < 0 ||
      request.targetMediaFrame > this.info.totalMediaFrames ||
      !Number.isSafeInteger(request.outputSampleRateHz) ||
      request.outputSampleRateHz <= 0 ||
      request.outputSampleRateHz > AAC_DECODER_MAX_OUTPUT_SAMPLE_RATE_HZ ||
      !isMessagePortLike(request.pcmPort) ||
      typeof request.acceptPcmPortOwnership !== 'function' ||
      !(request.signal instanceof AbortSignal)
    ) {
      return Promise.reject(new TypeError('AAC decoder generation request is invalid'));
    }
    try {
      throwIfAborted(request.signal);
    } catch (error) {
      return Promise.reject(error);
    }

    if (request.targetMediaFrame === this.info.totalMediaFrames) {
      const previous = this.#activeGeneration;
      const previousRetirement = previous
        ? this.#retireGeneration(previous, stoppedBeforeReadyError())
        : this.#pendingWorkerRetirement;
      return previousRetirement
        ? this.#startEofGenerationAfterRetirement(request, previousRetirement)
        : this.#startEofGeneration(request);
    }

    // Descriptor planning is preflight, not generation acceptance. A rejected
    // request must preserve both the active realm and the caller-owned PCM port.
    let descriptor: Readonly<AacDecoderDescriptor>;
    try {
      descriptor =
        this.#planningEvidence.kind === 'scan'
          ? createAacDecoderDescriptor({
              scan: this.#planningEvidence.scan,
              outputSampleRateHz: request.outputSampleRateHz,
              mediaFrame: request.targetMediaFrame,
            })
          : createAacDecoderDescriptorFromTimelineEvidence({
              timelineEvidence: this.#planningEvidence.evidence,
              outputSampleRateHz: request.outputSampleRateHz,
              mediaFrame: request.targetMediaFrame,
            });
    } catch (error) {
      return Promise.reject(error);
    }
    const previous = this.#activeGeneration;
    const previousRetirement = previous
      ? this.#retireGeneration(previous, stoppedBeforeReadyError())
      : this.#pendingWorkerRetirement;
    return previousRetirement
      ? this.#startWorkerGenerationAfterRetirement(request, descriptor, previousRetirement)
      : this.#startWorkerGeneration(request, descriptor);
  }

  stopGeneration(generation: number): void {
    if (!isAacDecoderGeneration(generation)) return;
    const active = this.#activeGeneration;
    if (!active || active.generation !== generation) return;
    this.#retireGeneration(active, stoppedBeforeReadyError());
  }

  close(): Promise<void> {
    return this.#closeInternal(new DOMException('AAC decoder adapter was closed', 'AbortError'));
  }

  #closeInternal(cause: unknown): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    let resolveClose!: () => void;
    const closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    // Publish the stable terminal promise before source cleanup can re-enter.
    this.#closePromise = closePromise;
    this.#closed = true;
    this.#opened = false;
    if (this.#lifetimeSignal) {
      safeRemoveAbortListener(this.#lifetimeSignal, this.#onLifetimeAbort);
    }
    this.#lifetimeSignal = null;
    const active = this.#activeGeneration;
    if (active) this.#retireGeneration(active, cause);
    this.#fatalHandler = null;
    this.#generationStoppedHandler = null;
    let sourceClose: Promise<void>;
    try {
      sourceClose = this.#sourceLifetime.close().catch(() => undefined);
    } catch {
      sourceClose = Promise.resolve();
    }
    const drainRetirements = async (): Promise<void> => {
      await Promise.allSettled([sourceClose]);
      while (this.#retirementPromises.size > 0) {
        await Promise.allSettled([...this.#retirementPromises]);
      }
    };
    void drainRetirements().then(resolveClose, resolveClose);
    return closePromise;
  }

  #startEofGeneration(request: StreamingDecoderGenerationRequest): Promise<void> {
    const lifetimeSignal = this.#lifetimeSignal;
    if (!lifetimeSignal) {
      return Promise.reject(new DOMException('AAC decoder adapter was closed', 'AbortError'));
    }
    let snapshot: EofGenerationRequestSnapshot;
    try {
      snapshot = snapshotEofGenerationRequest(request);
      this.#assertGenerationCanStart(snapshot.signal, lifetimeSignal);
    } catch (error) {
      return Promise.reject(error);
    }
    let lifecycles: ReturnType<typeof acquireAcceptedEofLifecycles>;
    try {
      lifecycles = acquireAcceptedEofLifecycles(request);
    } catch (error) {
      return Promise.reject(error);
    }
    const generationLifecycle = lifecycles.generation;
    const portLifecycle = lifecycles.port;
    const generation: EofGeneration = {
      kind: 'eof',
      generation: snapshot.generation,
      signal: snapshot.signal,
      onAbort: () => {
        if (this.#activeGeneration === generation) {
          this.#retireGeneration(generation, abortReason(snapshot.signal));
        }
      },
      port: snapshot.pcmPort,
      replied: false,
      terminal: null,
      retired: false,
      generationLifecycle,
      portLifecycle,
    };
    this.#activeGeneration = generation;
    try {
      this.#assertGenerationCanStart(snapshot.signal, lifetimeSignal);
      snapshot.signal.addEventListener('abort', generation.onAbort, { once: true });
      if (generation.retired) {
        reinforceTerminalEofGeneration(generation);
        return Promise.reject(generation.terminal?.cause);
      }
      generation.port.onmessage = (event: MessageEvent<unknown>) => {
        if (this.#closed || this.#activeGeneration !== generation || generation.retired) return;
        const demand = parsePcmDemandMessage(event.data);
        if (!demand || demand.generation !== generation.generation || generation.replied) {
          this.#failGeneration(generation, 'decoder-invalid-pcm-demand');
          return;
        }
        generation.replied = true;
        const eof: PcmSupplyMessage = {
          protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
          type: 'eof',
          generation: generation.generation,
        };
        try {
          generation.port.postMessage(eof);
        } catch (error) {
          this.#failGeneration(generation, 'decoder-pcm-port-failed', error);
        }
      };
      if (generation.retired) {
        reinforceTerminalEofGeneration(generation);
        return Promise.reject(generation.terminal?.cause);
      }
      generation.port.onmessageerror = () => {
        this.#failGeneration(generation, 'decoder-pcm-message-error');
      };
      if (generation.retired) {
        reinforceTerminalEofGeneration(generation);
        return Promise.reject(generation.terminal?.cause);
      }
      generation.port.start();
    } catch (error) {
      if (generation.retired) {
        reinforceTerminalEofGeneration(generation);
        return Promise.reject(generation.terminal?.cause);
      }
      this.#retireGeneration(generation, error);
      if (!this.#closed) this.#fatal('decoder-pcm-port-failed', error);
      return Promise.reject(error);
    }
    if (generation.retired) {
      reinforceTerminalEofGeneration(generation);
      return Promise.reject(generation.terminal?.cause);
    }
    if (snapshot.signal.aborted) {
      generation.onAbort();
      return Promise.reject(abortReason(snapshot.signal));
    }
    return Promise.resolve();
  }

  #startWorkerGeneration(
    request: StreamingDecoderGenerationRequest,
    descriptor: Readonly<AacDecoderDescriptor>,
  ): Promise<void> {
    const lifetimeSignal = this.#lifetimeSignal;
    if (!lifetimeSignal) {
      return Promise.reject(new DOMException('AAC decoder adapter was closed', 'AbortError'));
    }
    let lease: EncodedAudioSourceLease | null = null;
    let worker: Worker | null = null;
    let brokerPort: MessagePort | null = null;
    let sourcePort: MessagePort | null = null;
    let broker: EncodedSourcePortBroker | null = null;
    let brokerConstructionStarted = false;
    let readiness: Deferred | null = null;
    let realm: WorkerRealm | null = null;
    let generationLifecycle: FilePlaybackUniversalLifecycleLease | null = null;
    let workerLifecycle: FilePlaybackUniversalLifecycleLease | null = null;
    let sourcePortLifecycle: FilePlaybackUniversalLifecycleLease | null = null;
    let pcmPortLifecycle: FilePlaybackUniversalLifecycleLease | null = null;
    let pcmPortOwnershipAccepted = false;
    try {
      lease = this.#sourceLifetime.acquireLease();
      worker = this.#runtime.createWorker();
      const sourceChannel = this.#runtime.createMessageChannel();
      brokerPort = sourceChannel.port1;
      sourcePort = sourceChannel.port2;
      brokerConstructionStarted = true;
      broker = new EncodedSourcePortBroker({
        source: lease,
        port: brokerPort,
        generation: lease.leaseGeneration,
        lifetimeSignal,
      });
      // Runtime and port construction are injected boundaries. Recheck every
      // terminal authority before publishing a realm or transferring ports.
      this.#assertGenerationCanStart(request.signal, lifetimeSignal);
      readiness = createDeferred();
      generationLifecycle = acquireFilePlaybackUniversalLifecycleLease('decoderGenerations');
      workerLifecycle = acquireFilePlaybackUniversalLifecycleLease('workers');
      sourcePortLifecycle = acquireFilePlaybackUniversalLifecycleLease('ports');
      pcmPortLifecycle = acquireFilePlaybackUniversalLifecycleLease('ports');
      request.acceptPcmPortOwnership();
      pcmPortOwnershipAccepted = true;
      this.#assertGenerationCanStart(request.signal, lifetimeSignal);
      const createdRealm: WorkerRealm = {
        kind: 'worker',
        generation: request.generation,
        sourceLifetimeGeneration: lease.leaseGeneration,
        descriptor,
        expectedOutputFrames: expectedAacOutputFrames(descriptor),
        worker,
        lease,
        broker,
        sourcePort,
        pcmPort: request.pcmPort,
        readiness,
        decoderRetired: createDeferred(),
        workerRetired: createDeferred(),
        generationLifecycle,
        workerLifecycle,
        sourcePortLifecycle,
        pcmPortLifecycle,
        retryWaitLifecycles: [],
        signal: request.signal,
        onAbort: () => {
          if (this.#activeGeneration === createdRealm) {
            this.#retireGeneration(createdRealm, abortReason(request.signal));
          }
        },
        portOwnership: 'local',
        cleanupStarted: false,
        transferUncertain: false,
        stopSent: false,
        decoderRetiredAcknowledged: false,
        workerRetiredAcknowledged: false,
        retryWaitSequence: 0,
        cleanupCompletion: createDeferred(),
        cleanupPromise: null,
        retirementFaulted: false,
        ready: false,
        eof: false,
        retired: false,
        decodedInputBytes: descriptor.startPlan.scanAnchorByteOffset,
        decodedCoreFrames:
          descriptor.startPlan.decodeStartAccessUnitOrdinal * ADTS_CORE_FRAMES_PER_ACCESS_UNIT,
        producedOutputFrames: 0,
      };
      realm = createdRealm;
      this.#activeGeneration = createdRealm;
      request.signal.addEventListener('abort', createdRealm.onAbort, { once: true });
      if (!this.#revalidateWorkerRealmSetup(createdRealm, lifetimeSignal)) {
        reinforceTerminalWorkerRealm(createdRealm);
        return createdRealm.readiness.promise;
      }
      worker.onmessage = (event: MessageEvent<unknown>) =>
        this.#handleWorkerEvent(createdRealm, event.data);
      if (!this.#revalidateWorkerRealmSetup(createdRealm, lifetimeSignal)) {
        reinforceTerminalWorkerRealm(createdRealm);
        return createdRealm.readiness.promise;
      }
      worker.onerror = () => this.#handleWorkerFailure(createdRealm, 'decoder-worker-error');
      if (!this.#revalidateWorkerRealmSetup(createdRealm, lifetimeSignal)) {
        reinforceTerminalWorkerRealm(createdRealm);
        return createdRealm.readiness.promise;
      }
      worker.onmessageerror = () =>
        this.#handleWorkerFailure(createdRealm, 'decoder-message-error');
      if (!this.#revalidateWorkerRealmSetup(createdRealm, lifetimeSignal)) {
        reinforceTerminalWorkerRealm(createdRealm);
        return createdRealm.readiness.promise;
      }

      const command: AacDecoderOpenCommand = {
        protocolVersion: AAC_DECODER_PROTOCOL_VERSION,
        type: 'open-decoder',
        sourceLifetimeGeneration: createdRealm.sourceLifetimeGeneration,
        decoderGeneration: createdRealm.generation,
        backendId: this.#backendId,
        descriptor: createdRealm.descriptor,
        sourcePort: createdRealm.sourcePort,
        pcmPort: createdRealm.pcmPort,
      };
      createdRealm.portOwnership = 'posting';
      try {
        worker.postMessage(command, aacDecoderCommandTransferables(command));
      } catch (error) {
        createdRealm.portOwnership = 'local';
        createdRealm.transferUncertain = true;
        if (createdRealm.retired) this.#cleanupWorkerRealm(createdRealm);
        throw error;
      }
      createdRealm.portOwnership = 'worker';
      if (!this.#revalidateWorkerRealmSetup(createdRealm, lifetimeSignal)) {
        if (createdRealm.retired) this.#cleanupWorkerRealm(createdRealm);
        return createdRealm.readiness.promise;
      }
      if (createdRealm.ready) createdRealm.readiness.resolve();
      return readiness.promise;
    } catch (error) {
      if (realm) {
        const alreadyRetired = realm.retired;
        if (!alreadyRetired) this.#retireGeneration(realm, error);
        else this.#cleanupWorkerRealm(realm);
        reinforceTerminalWorkerRealm(realm);
        // The transfer failed before the caller received the readiness Promise.
        void realm.readiness.promise.catch(() => undefined);
        if (alreadyRetired) return realm.readiness.promise;
      } else {
        readiness?.reject(error);
        if (readiness) void readiness.promise.catch(() => undefined);
        if (broker) void broker.close().catch(() => undefined);
        else {
          if (!brokerConstructionStarted) safeClosePort(brokerPort);
          if (lease) void lease.close().catch(() => undefined);
        }
        const sourcePortClosed = safeClosePort(sourcePort);
        const pcmPortClosed = !pcmPortOwnershipAccepted || safeClosePort(request.pcmPort);
        safeTerminateWorker(worker);
        if (sourcePortLifecycle) {
          if (sourcePortClosed) releaseLocalLifecycleLease(sourcePortLifecycle);
          else sourcePortLifecycle.forceUnconfirmed();
        }
        if (pcmPortLifecycle) {
          if (pcmPortClosed) releaseLocalLifecycleLease(pcmPortLifecycle);
          else pcmPortLifecycle.forceUnconfirmed();
        }
        generationLifecycle?.forceUnconfirmed();
        workerLifecycle?.forceUnconfirmed();
      }
      return Promise.reject(error);
    }
  }

  async #startWorkerGenerationAfterRetirement(
    request: StreamingDecoderGenerationRequest,
    descriptor: Readonly<AacDecoderDescriptor>,
    initialRetirement: Promise<void>,
  ): Promise<void> {
    let retirement: Promise<void> | null = initialRetirement;
    while (retirement) {
      await retirement;
      const active = this.#activeGeneration;
      retirement = active
        ? this.#retireGeneration(active, stoppedBeforeReadyError())
        : this.#pendingWorkerRetirement;
    }
    return this.#startWorkerGeneration(request, descriptor);
  }

  async #startEofGenerationAfterRetirement(
    request: StreamingDecoderGenerationRequest,
    initialRetirement: Promise<void>,
  ): Promise<void> {
    let retirement: Promise<void> | null = initialRetirement;
    while (retirement) {
      await retirement;
      const active = this.#activeGeneration;
      retirement = active
        ? this.#retireGeneration(active, stoppedBeforeReadyError())
        : this.#pendingWorkerRetirement;
    }
    return this.#startEofGeneration(request);
  }

  #handleWorkerEvent(realm: WorkerRealm, value: unknown): void {
    if (realm.portOwnership === 'local' && !realm.transferUncertain) {
      if (realm.retired) {
        this.#rejectWorkerRetirement(realm, new Error('Invalid AAC retirement event'));
      } else {
        this.#failGeneration(realm, 'decoder-invalid-event');
      }
      return;
    }
    const retryWaitDeltaEnvelope = isRetryWaitDeltaEnvelope(value);
    const event = parseAacDecoderEvent(value);
    if (
      !event ||
      event.sourceLifetimeGeneration !== realm.sourceLifetimeGeneration ||
      event.decoderGeneration !== realm.generation
    ) {
      if (retryWaitDeltaEnvelope) this.#markUnknownRetryWait(realm);
      if (realm.retired)
        this.#rejectWorkerRetirement(realm, new Error('Invalid AAC retirement event'));
      else this.#failGeneration(realm, 'decoder-invalid-event');
      return;
    }

    if (event.type === 'retry-wait-delta') {
      this.#acceptRetryWaitDelta(
        realm,
        event.delta,
        event.retryWaitSequence,
        event.activeRetryWaits,
      );
      return;
    }
    if (event.type === 'decoder-retired') {
      if (!realm.retired || !realm.stopSent) {
        if (!realm.retired) this.#failGeneration(realm, 'decoder-premature-retirement');
        this.#rejectWorkerRetirement(realm, new Error('Premature AAC decoder retirement ACK'));
        return;
      }
      if (realm.decoderRetiredAcknowledged) {
        this.#rejectWorkerRetirement(realm, new Error('Duplicate AAC decoder retirement ACK'));
        return;
      }
      realm.decoderRetiredAcknowledged = true;
      realm.decoderRetired.resolve();
      return;
    }
    if (event.type === 'worker-retired') {
      if (!realm.retired || !realm.stopSent) {
        if (!realm.retired) this.#failGeneration(realm, 'decoder-premature-retirement');
        this.#rejectWorkerRetirement(realm, new Error('Premature AAC worker retirement ACK'));
        return;
      }
      const retryStateMismatch =
        event.retryWaitSequence !== realm.retryWaitSequence || event.activeRetryWaits !== 0;
      if (
        realm.workerRetiredAcknowledged ||
        !realm.decoderRetiredAcknowledged ||
        retryStateMismatch ||
        realm.retryWaitLifecycles.length !== 0
      ) {
        if (retryStateMismatch) this.#markUnknownRetryWait(realm);
        this.#rejectWorkerRetirement(realm, new Error('Invalid AAC worker retirement ACK'));
        return;
      }
      realm.workerRetiredAcknowledged = true;
      realm.workerRetired.resolve();
      return;
    }
    // A normal event may already be queued ahead of stop/retirement ACKs. Once
    // logical retirement wins, exact-realm non-ACK telemetry has no authority.
    if (realm.retired) return;
    if (this.#closed || this.#activeGeneration !== realm) {
      this.#rejectWorkerRetirement(realm, new Error('AAC event arrived outside its active realm'));
      return;
    }

    if (event.type === 'decoder-ready') {
      if (realm.ready) {
        this.#failGeneration(realm, 'decoder-duplicate-ready');
        return;
      }
      if (event.backendId !== this.#backendId) {
        this.#failGeneration(realm, 'decoder-backend-mismatch');
        return;
      }
      if (!sameAacDecoderDescriptor(event.descriptor, realm.descriptor)) {
        this.#failGeneration(realm, 'decoder-descriptor-mismatch');
        return;
      }
      realm.ready = true;
      // Native Workers cannot synchronously re-enter postMessage, but injected
      // test/runtime boundaries can. Do not publish readiness until ownership
      // has settled and terminal signals have been rechecked after posting.
      if (realm.portOwnership === 'worker') realm.readiness.resolve();
      return;
    }
    if (event.type === 'decode-progress' || event.type === 'decoder-eof') {
      if (!this.#acceptProgressEvent(realm, event)) {
        this.#failGeneration(realm, 'decoder-invalid-progress');
      }
      return;
    }
    if (event.type === 'decoder-error') {
      const error = new Error(event.message);
      realm.readiness.reject(error);
      this.#failGeneration(realm, `decoder:${safeErrorCode(event.code, 'unknown')}`, error);
      return;
    }
    const error = new Error('AAC decoder stopped unexpectedly');
    realm.readiness.reject(error);
    this.#retireGeneration(realm, error);
    this.#notifyGenerationStopped(realm.generation, error);
  }

  #handleWorkerFailure(realm: WorkerRealm, code: string): void {
    if (realm.retired) {
      this.#rejectWorkerRetirement(realm, new Error(code));
      return;
    }
    this.#failGeneration(realm, code);
  }

  #acceptRetryWaitDelta(
    realm: WorkerRealm,
    delta: -1 | 1,
    retryWaitSequence: number,
    activeRetryWaits: number,
  ): void {
    const expected = realm.retryWaitLifecycles.length + delta;
    if (
      expected < 0 ||
      retryWaitSequence !== realm.retryWaitSequence + 1 ||
      activeRetryWaits !== expected ||
      realm.workerRetiredAcknowledged
    ) {
      this.#markUnknownRetryWait(realm);
      this.#rejectWorkerRetirement(realm, new Error('AAC retry wait accounting mismatch'));
      if (!realm.retired) this.#failGeneration(realm, 'decoder-retry-wait-accounting');
      return;
    }
    if (delta === 1) {
      let wait: FilePlaybackUniversalLifecycleLease | null = null;
      try {
        wait = acquireFilePlaybackUniversalLifecycleLease('retryWaits');
        const timer = acquireFilePlaybackUniversalLifecycleLease('timers');
        realm.retryWaitLifecycles.push({ wait, timer });
        realm.retryWaitSequence = retryWaitSequence;
      } catch (error) {
        wait?.forceUnconfirmed();
        this.#rejectWorkerRetirement(realm, error);
        if (!realm.retired) this.#failGeneration(realm, 'decoder-retry-wait-accounting', error);
      }
      return;
    }
    const lifecycle = realm.retryWaitLifecycles.pop();
    if (!lifecycle) return;
    realm.retryWaitSequence = retryWaitSequence;
    releaseLocalLifecycleLease(lifecycle.wait);
    releaseLocalLifecycleLease(lifecycle.timer);
  }

  #markUnknownRetryWait(realm: WorkerRealm): void {
    let wait: FilePlaybackUniversalLifecycleLease | null = null;
    try {
      wait = acquireFilePlaybackUniversalLifecycleLease('retryWaits');
      const timer = acquireFilePlaybackUniversalLifecycleLease('timers');
      wait.forceUnconfirmed();
      timer.forceUnconfirmed();
    } catch (error) {
      wait?.forceUnconfirmed();
      this.#rejectWorkerRetirement(realm, error);
    }
  }

  #rejectWorkerRetirement(realm: WorkerRealm, cause: unknown): void {
    realm.retirementFaulted = true;
    realm.decoderRetired.reject(cause);
    realm.workerRetired.reject(cause);
  }

  #acceptProgressEvent(
    realm: WorkerRealm,
    event: Extract<AacDecoderEvent, { readonly type: 'decode-progress' | 'decoder-eof' }>,
  ): boolean {
    const descriptor = realm.descriptor;
    if (
      !realm.ready ||
      realm.eof ||
      event.decodedInputBytes < realm.decodedInputBytes ||
      event.decodedInputBytes > descriptor.audioEndByteOffset ||
      event.decodedCoreFrames < realm.decodedCoreFrames ||
      event.decodedCoreFrames > descriptor.timeline.totalMediaFrames ||
      event.decodedCoreFrames % ADTS_CORE_FRAMES_PER_ACCESS_UNIT !== 0 ||
      event.producedOutputFrames < realm.producedOutputFrames ||
      event.producedOutputFrames > realm.expectedOutputFrames
    ) {
      return false;
    }
    const atInputEnd = event.decodedInputBytes === descriptor.audioEndByteOffset;
    const atCoreEnd = event.decodedCoreFrames === descriptor.timeline.totalMediaFrames;
    if (atInputEnd !== atCoreEnd) return false;
    if (
      event.type === 'decoder-eof' &&
      (!atInputEnd || !atCoreEnd || event.producedOutputFrames !== realm.expectedOutputFrames)
    ) {
      return false;
    }
    realm.decodedInputBytes = event.decodedInputBytes;
    realm.decodedCoreFrames = event.decodedCoreFrames;
    realm.producedOutputFrames = event.producedOutputFrames;
    if (event.type === 'decoder-eof') realm.eof = true;
    // Control EOF is telemetry on a separate port from final PCM. The realm
    // remains alive until stop, successor, abort, or adapter close.
    return true;
  }

  #failGeneration(generation: ActiveGeneration, code: string, cause?: unknown): void {
    if (this.#closed || this.#activeGeneration !== generation || generation.retired) return;
    const error = asError(cause, 'AAC decoder generation failed');
    if (generation.kind === 'worker') generation.readiness.reject(error);
    this.#retireGeneration(generation, error);
    this.#fatal(code, cause ?? error);
  }

  #retireGeneration(generation: ActiveGeneration, cause: unknown): Promise<void> | null {
    if (generation.retired) {
      return generation.kind === 'worker' ? this.#ensureWorkerRetirementBarrier(generation) : null;
    }
    generation.retired = true;
    const retirement =
      generation.kind === 'worker' ? this.#ensureWorkerRetirementBarrier(generation) : null;
    safeRemoveAbortListener(generation.signal, generation.onAbort);
    if (this.#activeGeneration === generation) this.#activeGeneration = null;
    if (generation.kind === 'eof') {
      generation.terminal = { cause };
      safeDetachPortHandlers(generation.port);
      if (safeClosePort(generation.port)) releaseLocalLifecycleLease(generation.portLifecycle);
      else generation.portLifecycle.forceUnconfirmed();
      releaseLocalLifecycleLease(generation.generationLifecycle);
      return null;
    }

    generation.readiness.reject(cause);
    this.#cleanupWorkerRealm(generation);
    return retirement;
  }

  #ensureWorkerRetirementBarrier(generation: WorkerRealm): Promise<void> {
    if (!generation.cleanupPromise) {
      generation.cleanupPromise = generation.cleanupCompletion.promise;
      this.#trackRetirement(generation.cleanupPromise);
    }
    return generation.cleanupPromise;
  }

  #cleanupWorkerRealm(generation: WorkerRealm): Promise<void> {
    const retirement = this.#ensureWorkerRetirementBarrier(generation);
    if (generation.cleanupStarted || generation.portOwnership === 'posting') return retirement;
    generation.cleanupStarted = true;

    if (generation.portOwnership === 'local') {
      generation.retirementFaulted = true;
      const sourcePortClosed = safeClosePort(generation.sourcePort);
      const pcmPortClosed = safeClosePort(generation.pcmPort);
      if (generation.transferUncertain) {
        generation.sourcePortLifecycle.forceUnconfirmed();
        generation.pcmPortLifecycle.forceUnconfirmed();
      } else {
        if (sourcePortClosed) releaseLocalLifecycleLease(generation.sourcePortLifecycle);
        else generation.sourcePortLifecycle.forceUnconfirmed();
        if (pcmPortClosed) releaseLocalLifecycleLease(generation.pcmPortLifecycle);
        else generation.pcmPortLifecycle.forceUnconfirmed();
      }
      generation.generationLifecycle.forceUnconfirmed();
      generation.workerLifecycle.forceUnconfirmed();
      for (const lifecycle of generation.retryWaitLifecycles.splice(0)) {
        lifecycle.wait.forceUnconfirmed();
        lifecycle.timer.forceUnconfirmed();
      }
      initiateWorkerRealmCleanup(generation);
      safeTerminateWorker(generation.worker);
      safeDetachWorkerHandlers(generation.worker);
      void Promise.resolve().then(
        generation.cleanupCompletion.resolve,
        generation.cleanupCompletion.reject,
      );
      return retirement;
    }

    try {
      generation.worker.postMessage({
        protocolVersion: AAC_DECODER_PROTOCOL_VERSION,
        type: 'stop-decoder',
        sourceLifetimeGeneration: generation.sourceLifetimeGeneration,
        decoderGeneration: generation.generation,
      } satisfies AacDecoderStopCommand);
      generation.stopSent = true;
    } catch (error) {
      this.#rejectWorkerRetirement(generation, error);
    }

    const decoderOutcome = confirmFilePlaybackUniversalLifecycleRetirement(
      generation.generationLifecycle,
      () => generation.decoderRetired.promise,
    );
    const pcmPortOutcome = confirmFilePlaybackUniversalLifecycleRetirement(
      generation.pcmPortLifecycle,
      () => generation.decoderRetired.promise,
    );
    const sourcePortOutcome = confirmFilePlaybackUniversalLifecycleRetirement(
      generation.sourcePortLifecycle,
      () => generation.workerRetired.promise,
    );
    const workerOutcome = confirmFilePlaybackUniversalLifecycleRetirement(
      generation.workerLifecycle,
      async () => {
        await generation.workerRetired.promise;
        if (generation.retirementFaulted || generation.retryWaitLifecycles.length !== 0) {
          throw new Error('AAC worker retirement left mirrored retry waits');
        }
        await generation.broker.close();
        if (generation.retirementFaulted) throw new Error('AAC worker retirement protocol failed');
        generation.worker.terminate();
      },
    );
    const cleanupTask = Promise.all([
      decoderOutcome,
      pcmPortOutcome,
      sourcePortOutcome,
      workerOutcome,
    ])
      .then((outcomes) => {
        if (outcomes.some((outcome) => outcome === 'unconfirmed')) {
          generation.retirementFaulted = true;
          for (const lifecycle of generation.retryWaitLifecycles.splice(0)) {
            lifecycle.wait.forceUnconfirmed();
            lifecycle.timer.forceUnconfirmed();
          }
          initiateWorkerRealmCleanup(generation);
          safeTerminateWorker(generation.worker);
        }
      })
      .finally(() => {
        safeDetachWorkerHandlers(generation.worker);
      });
    void cleanupTask.then(
      generation.cleanupCompletion.resolve,
      generation.cleanupCompletion.reject,
    );
    return retirement;
  }

  #trackRetirement(retirement: Promise<void>): void {
    this.#retirementPromises.add(retirement);
    this.#pendingWorkerRetirement = retirement;
    void retirement.then(
      () => {
        this.#retirementPromises.delete(retirement);
        if (this.#pendingWorkerRetirement === retirement) this.#pendingWorkerRetirement = null;
      },
      () => {
        this.#retirementPromises.delete(retirement);
        if (this.#pendingWorkerRetirement === retirement) this.#pendingWorkerRetirement = null;
      },
    );
  }

  #assertGenerationCanStart(requestSignal: AbortSignal, lifetimeSignal: AbortSignal): void {
    throwIfAborted(requestSignal);
    throwIfAborted(lifetimeSignal);
    if (
      this.#closed ||
      !this.#opened ||
      this.#lifetimeSignal !== lifetimeSignal ||
      this.#sourceLifetime.closed
    ) {
      throw new DOMException('AAC decoder adapter was closed', 'AbortError');
    }
  }

  #revalidateWorkerRealmSetup(realm: WorkerRealm, lifetimeSignal: AbortSignal): boolean {
    if (realm.retired) return false;
    if (this.#activeGeneration !== realm || this.#closed) {
      this.#retireGeneration(
        realm,
        new DOMException('AAC decoder adapter lost setup authority', 'AbortError'),
      );
      return false;
    }
    try {
      this.#assertGenerationCanStart(realm.signal, lifetimeSignal);
    } catch (error) {
      this.#retireGeneration(realm, error);
      return false;
    }
    return !realm.retired && this.#activeGeneration === realm && !this.#closed;
  }

  #fatal(code: string, cause?: unknown): void {
    if (this.#closed) return;
    try {
      this.#fatalHandler?.(safeErrorCode(code, 'decoder-failed'), cause);
    } catch {
      // Owner teardown may race the synchronous fail-closed notification.
    }
  }

  #notifyGenerationStopped(generation: number, cause: Error): void {
    if (this.#closed) return;
    try {
      this.#generationStoppedHandler?.(generation, cause);
    } catch {
      // Owner teardown may race the terminal decoder notification.
    }
  }
}
