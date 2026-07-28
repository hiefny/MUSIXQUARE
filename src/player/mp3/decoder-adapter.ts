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
  createMp3DecoderDescriptor,
  createMp3DecoderDescriptorFromTimelineEvidence,
  expectedMp3OutputFrames,
  rebuildMp3DecoderPlanningState,
  rebuildMp3DecoderTimelinePlanningState,
} from './decoder-helpers.js';
import {
  MP3_DECODER_MAX_OUTPUT_SAMPLE_RATE_HZ,
  MP3_DECODER_MAX_PROGRESSIVE_INDEX_EVENTS,
  MP3_DECODER_PROTOCOL_VERSION,
  isMp3DecoderGeneration,
  mp3DecoderCommandTransferables,
  mp3FrameIndexPointFromEvent,
  parseMp3DecoderEvent,
  sameMp3DecoderDescriptor,
  type Mp3DecoderDescriptor,
  type Mp3DecoderOpenCommand,
  type Mp3DecoderStopCommand,
  type Mp3DecoderEvent,
} from './decoder-protocol.js';
import type { Mp3Metadata } from './metadata.js';
import type { Mp3DecoderTimelineEvidence } from './decoder-timeline-evidence.js';
import type { MpegLayer3SeekIndexPoint } from './seek-index.js';

const MAX_FATAL_CODE_LENGTH = 256;
const SOURCE_KINDS = new Set<EncodedAudioSourceKind>(['blob', 'peer-range', 'r2-records']);

export interface Mp3DecoderAdapterRuntime {
  /** A fresh Worker must be returned for every invocation. */
  readonly createWorker: () => Worker;
  readonly createMessageChannel: () => MessageChannel;
}

interface Mp3DecoderAdapterBaseOptions {
  /** Ownership transfers only after this constructor validates successfully. */
  readonly encodedSource: EncodedAudioSource;
  readonly runtime: Mp3DecoderAdapterRuntime;
}

export interface Mp3DecoderAdapterMetadataOptions extends Mp3DecoderAdapterBaseOptions {
  readonly metadata: Readonly<Mp3Metadata>;
  readonly timelineEvidence?: never;
}

export interface Mp3DecoderAdapterTimelineEvidenceOptions extends Mp3DecoderAdapterBaseOptions {
  readonly metadata?: never;
  /** Detached decoder planning data issued by a trusted scanner or admission owner. */
  readonly timelineEvidence: Readonly<Mp3DecoderTimelineEvidence>;
}

export type Mp3DecoderAdapterOptions =
  | Mp3DecoderAdapterMetadataOptions
  | Mp3DecoderAdapterTimelineEvidenceOptions;

interface Mp3DecoderAdapterOptionsSnapshot {
  readonly kind: 'metadata' | 'timeline-evidence';
  readonly encodedSource: unknown;
  readonly metadata: unknown;
  readonly timelineEvidence: unknown;
  readonly runtime: unknown;
}

const ADAPTER_COMMON_OPTION_KEYS = Object.freeze(['encodedSource', 'runtime'] as const);
const ADAPTER_METADATA_OPTION_KEYS = Object.freeze([
  ...ADAPTER_COMMON_OPTION_KEYS,
  'metadata',
] as const);
const ADAPTER_EVIDENCE_OPTION_KEYS = Object.freeze([
  ...ADAPTER_COMMON_OPTION_KEYS,
  'timelineEvidence',
] as const);

function snapshotAdapterOptions(value: unknown): Readonly<Mp3DecoderAdapterOptionsSnapshot> {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    throw new TypeError('MP3 decoder adapter options are required');
  }
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Reflect.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    throw new TypeError('MP3 decoder adapter options could not be snapshotted', { cause: error });
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('MP3 decoder adapter options must use a plain or null prototype');
  }
  const hasMetadata = Object.hasOwn(descriptors, 'metadata');
  const hasEvidence = Object.hasOwn(descriptors, 'timelineEvidence');
  if (hasMetadata === hasEvidence) {
    throw new TypeError('MP3 decoder adapter requires exactly one timeline evidence source');
  }
  const expected = hasMetadata ? ADAPTER_METADATA_OPTION_KEYS : ADAPTER_EVIDENCE_OPTION_KEYS;
  const allowed = new Set<PropertyKey>(expected);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== expected.length || keys.some((key) => !allowed.has(key))) {
    throw new TypeError('MP3 decoder adapter options have missing or extra fields');
  }
  const readData = (key: PropertyKey): unknown => {
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`MP3 decoder adapter ${String(key)} must be an enumerable data field`);
    }
    return descriptor.value;
  };
  return Object.freeze({
    kind: hasMetadata ? ('metadata' as const) : ('timeline-evidence' as const),
    encodedSource: readData('encodedSource'),
    metadata: hasMetadata ? readData('metadata') : undefined,
    timelineEvidence: hasEvidence ? readData('timelineEvidence') : undefined,
    runtime: readData('runtime'),
  });
}

/** Capture one stable facade without taking ownership until construction commits. */
function snapshotEncodedSource(value: unknown): EncodedAudioSource {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    throw new TypeError('Streaming MP3 requires an encoded source');
  }
  try {
    const kind = Reflect.get(value, 'kind') as unknown;
    const size = Reflect.get(value, 'size') as unknown;
    const identity = Reflect.get(value, 'identity') as unknown;
    const metadataValue = Reflect.get(value, 'metadata') as unknown;
    const readAt = Reflect.get(value, 'readAt') as unknown;
    const close = Reflect.get(value, 'close') as unknown;
    if (!SOURCE_KINDS.has(kind as EncodedAudioSourceKind)) {
      throw new TypeError('Streaming MP3 encoded source kind is invalid');
    }
    if (typeof size !== 'number') {
      throw new TypeError('Streaming MP3 encoded source size is invalid');
    }
    validateExactRead(size, 0, 0);
    if (size <= 0 || !isEncodedAudioSourceIdentity(identity)) {
      throw new TypeError('Streaming MP3 requires a valid non-empty encoded source');
    }
    if (
      metadataValue === null ||
      (typeof metadataValue !== 'object' && typeof metadataValue !== 'function')
    ) {
      throw new TypeError('Streaming MP3 encoded source metadata is invalid');
    }
    const name = Reflect.get(metadataValue, 'name') as unknown;
    const mime = Reflect.get(metadataValue, 'mime') as unknown;
    if (typeof name !== 'string' || typeof mime !== 'string') {
      throw new TypeError('Streaming MP3 encoded source metadata is invalid');
    }
    if (typeof readAt !== 'function' || typeof close !== 'function') {
      throw new TypeError('Streaming MP3 encoded source methods are invalid');
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
    throw new TypeError('Streaming MP3 encoded source could not be inspected', { cause: error });
  }
}

function snapshotRuntime(value: unknown): Readonly<Mp3DecoderAdapterRuntime> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    throw new TypeError('Streaming MP3 decoder runtime is invalid');
  }
  try {
    const createWorker = Reflect.get(value, 'createWorker') as unknown;
    const createMessageChannel = Reflect.get(value, 'createMessageChannel') as unknown;
    if (typeof createWorker !== 'function' || typeof createMessageChannel !== 'function') {
      throw new TypeError('Streaming MP3 decoder runtime is invalid');
    }
    const target = value;
    return Object.freeze({
      createWorker: () => Reflect.apply(createWorker, target, []) as Worker,
      createMessageChannel: () => Reflect.apply(createMessageChannel, target, []) as MessageChannel,
    });
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError('Streaming MP3 decoder runtime could not be inspected', { cause: error });
  }
}

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
  readonly descriptor: Readonly<Mp3DecoderDescriptor>;
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
  transferred: boolean;
  posting: boolean;
  transferUncertain: boolean;
  stopSent: boolean;
  decoderRetiredAcknowledged: boolean;
  workerRetiredAcknowledged: boolean;
  retryWaitSequence: number;
  readonly cleanupCompletion: Deferred;
  cleanupPromise: Promise<void> | null;
  cleanupStarted: boolean;
  retirementFaulted: boolean;
  ready: boolean;
  progressiveIndexEvents: number;
  decodedInputBytes: number;
  decodedRawSamples: number;
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
    // The realm may already have crossed its native terminal boundary.
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
  return signal.reason ?? new DOMException('MP3 decoder operation was aborted', 'AbortError');
}

function asError(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value;
  return new Error(fallback, value === undefined ? undefined : { cause: value });
}

function stoppedBeforeReadyError(): Error {
  return new Error('MP3 decoder stopped before priming');
}

function sameIndexPoint(
  left: Readonly<MpegLayer3SeekIndexPoint>,
  right: Readonly<MpegLayer3SeekIndexPoint>,
): boolean {
  return (
    left.rawSample === right.rawSample &&
    left.byteOffset === right.byteOffset &&
    left.frameOrdinal === right.frameOrdinal &&
    left.mainDataCapacityBytes === right.mainDataCapacityBytes &&
    left.mainDataBeginBytes === right.mainDataBeginBytes
  );
}

/** Fresh-realm native MP3 decoder owner below the bounded PCM renderer. */
export class Mp3DecoderAdapter implements StreamingDecoderAdapter {
  readonly info: Readonly<StreamingDecoderMediaInfo>;

  readonly #metadata: Readonly<Mp3Metadata> | null;
  readonly #timelineEvidence: Readonly<Mp3DecoderTimelineEvidence> | null;
  readonly #runtime: Mp3DecoderAdapterRuntime;
  readonly #sourceLifetime: EncodedAudioSourceLifetime;
  readonly #seekIndex: ReturnType<typeof rebuildMp3DecoderPlanningState>['seekIndex'];

  #openPromise: Promise<void> | null = null;
  #fatalHandler: StreamingDecoderFatalHandler | null = null;
  #generationStoppedHandler: StreamingDecoderGenerationStoppedHandler | null = null;
  #lifetimeSignal: AbortSignal | null = null;
  readonly #onLifetimeAbort = (): void => {
    void this.close();
  };
  #activeGeneration: ActiveGeneration | null = null;
  readonly #retirementPromises = new Set<Promise<void>>();
  #pendingWorkerRetirement: Promise<void> | null = null;
  #opened = false;
  #closed = false;
  #closePromise: Promise<void> | null = null;

  constructor(options: Mp3DecoderAdapterOptions) {
    const snapshot = snapshotAdapterOptions(options);
    const source = snapshotEncodedSource(snapshot.encodedSource);
    const runtime = snapshotRuntime(snapshot.runtime);

    if (snapshot.kind === 'timeline-evidence') {
      let planning: ReturnType<typeof rebuildMp3DecoderTimelinePlanningState>;
      try {
        planning = rebuildMp3DecoderTimelinePlanningState({
          evidence: snapshot.timelineEvidence as Readonly<Mp3DecoderTimelineEvidence>,
        });
      } catch (error) {
        throw new TypeError('Streaming MP3 timeline evidence is invalid', { cause: error });
      }
      if (
        planning.evidence.sourceSize !== source.size ||
        planning.evidence.sourceIdentity !== source.identity
      ) {
        throw new TypeError('Streaming MP3 timeline evidence belongs to another encoded source');
      }
      this.#metadata = null;
      this.#timelineEvidence = planning.evidence;
      this.#seekIndex = planning.seekIndex;
      this.info = Object.freeze({
        mediaSampleRateHz: planning.evidence.sampleRateHz,
        channelCount: planning.evidence.channels,
        totalMediaFrames: planning.timeline.totalMediaFrames,
      });
    } else {
      let planning: ReturnType<typeof rebuildMp3DecoderPlanningState>;
      try {
        planning = rebuildMp3DecoderPlanningState({
          metadata: snapshot.metadata as Readonly<Mp3Metadata>,
          sourceSize: source.size,
        });
      } catch (error) {
        throw new TypeError('Streaming MP3 metadata is invalid', { cause: error });
      }
      this.#metadata = planning.metadata;
      this.#timelineEvidence = null;
      this.#seekIndex = planning.seekIndex;
      this.info = Object.freeze({
        mediaSampleRateHz: planning.metadata.sampleRateHz,
        channelCount: planning.metadata.channels,
        totalMediaFrames: planning.timeline.totalMediaFrames,
      });
    }
    this.#runtime = runtime;
    // This is the final potentially throwing ownership boundary in a valid
    // constructor. The lifetime performs no reads and creates no native realm.
    this.#sourceLifetime = new EncodedAudioSourceLifetime({ source });
  }

  get opened(): boolean {
    return this.#opened && !this.#closed;
  }

  open(options: StreamingDecoderOpenOptions): Promise<void> {
    if (this.#openPromise) return this.#openPromise;
    if (this.#closed) return Promise.reject(new Error('MP3 decoder adapter is closed'));
    if (
      !options ||
      !(options.signal instanceof AbortSignal) ||
      !(options.lifetimeSignal instanceof AbortSignal) ||
      typeof options.onFatal !== 'function' ||
      typeof options.onGenerationStopped !== 'function'
    ) {
      return Promise.reject(new TypeError('MP3 decoder open options are invalid'));
    }
    this.#fatalHandler = options.onFatal;
    this.#generationStoppedHandler = options.onGenerationStopped;
    this.#openPromise = Promise.resolve().then(() => {
      throwIfAborted(options.signal);
      throwIfAborted(options.lifetimeSignal);
      if (this.#closed) throw new Error('MP3 decoder adapter is closed');
      this.#lifetimeSignal = options.lifetimeSignal;
      try {
        options.lifetimeSignal.addEventListener('abort', this.#onLifetimeAbort, { once: true });
      } catch (error) {
        if (this.#closed || this.#lifetimeSignal !== options.lifetimeSignal) {
          safeRemoveAbortListener(options.lifetimeSignal, this.#onLifetimeAbort);
          throw new Error('MP3 decoder adapter is closed', { cause: error });
        }
        throw error;
      }
      if (this.#closed || this.#lifetimeSignal !== options.lifetimeSignal) {
        safeRemoveAbortListener(options.lifetimeSignal, this.#onLifetimeAbort);
        throw new Error('MP3 decoder adapter is closed');
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
    if (!this.opened) return Promise.reject(new Error('MP3 streaming runtime is not initialized'));
    if (
      !request ||
      !isMp3DecoderGeneration(request.generation) ||
      !Number.isSafeInteger(request.targetMediaFrame) ||
      request.targetMediaFrame < 0 ||
      request.targetMediaFrame > this.info.totalMediaFrames ||
      !Number.isSafeInteger(request.outputSampleRateHz) ||
      request.outputSampleRateHz <= 0 ||
      request.outputSampleRateHz > MP3_DECODER_MAX_OUTPUT_SAMPLE_RATE_HZ ||
      !isMessagePortLike(request.pcmPort) ||
      typeof request.acceptPcmPortOwnership !== 'function' ||
      !(request.signal instanceof AbortSignal)
    ) {
      return Promise.reject(new TypeError('MP3 decoder generation request is invalid'));
    }
    try {
      throwIfAborted(request.signal);
    } catch (error) {
      return Promise.reject(error);
    }

    const previous = this.#activeGeneration;
    const previousRetirement = previous
      ? this.#retireGeneration(previous, stoppedBeforeReadyError())
      : this.#pendingWorkerRetirement;
    if (request.targetMediaFrame === this.info.totalMediaFrames) {
      return previousRetirement
        ? this.#startEofGenerationAfterRetirement(request, previousRetirement)
        : this.#startEofGeneration(request);
    }
    return previousRetirement
      ? this.#startWorkerGenerationAfterRetirement(request, previousRetirement)
      : this.#startWorkerGeneration(request);
  }

  stopGeneration(generation: number): void {
    if (!isMp3DecoderGeneration(generation)) return;
    const active = this.#activeGeneration;
    if (!active || active.generation !== generation) return;
    this.#retireGeneration(active, stoppedBeforeReadyError());
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    let resolveClose!: () => void;
    const closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    // Publish the stable terminal promise before any retirement or source
    // callback can re-enter close().
    this.#closePromise = closePromise;
    this.#closed = true;
    this.#opened = false;
    if (this.#lifetimeSignal) {
      safeRemoveAbortListener(this.#lifetimeSignal, this.#onLifetimeAbort);
    }
    this.#lifetimeSignal = null;
    const active = this.#activeGeneration;
    if (active) {
      this.#retireGeneration(
        active,
        new DOMException('MP3 decoder adapter was closed', 'AbortError'),
      );
    }
    this.#fatalHandler = null;
    this.#generationStoppedHandler = null;
    let sourceClose: Promise<void>;
    try {
      sourceClose = this.#sourceLifetime.close();
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
    let snapshot: EofGenerationRequestSnapshot;
    try {
      snapshot = snapshotEofGenerationRequest(request);
      this.#assertGenerationCanStart(snapshot.signal);
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
          this.#retireGeneration(
            generation,
            asError(abortReason(snapshot.signal), 'MP3 EOF aborted'),
          );
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
      this.#assertGenerationCanStart(snapshot.signal);
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
      this.#retireGeneration(generation, asError(error, 'MP3 EOF setup failed'));
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

  #startWorkerGeneration(request: StreamingDecoderGenerationRequest): Promise<void> {
    try {
      this.#assertGenerationCanStart(request.signal);
    } catch (error) {
      return Promise.reject(error);
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
      const seekPoints = this.#seekIndex.snapshot();
      const descriptor = this.#timelineEvidence
        ? createMp3DecoderDescriptorFromTimelineEvidence({
            evidence: this.#timelineEvidence,
            seekPoints,
            mediaFrame: request.targetMediaFrame,
            outputSampleRate: request.outputSampleRateHz,
          })
        : createMp3DecoderDescriptor({
            metadata: this.#metadata!,
            sourceSize: this.#sourceLifetime.size,
            sourceIdentity: this.#sourceLifetime.identity,
            seekPoints,
            mediaFrame: request.targetMediaFrame,
            outputSampleRate: request.outputSampleRateHz,
          });
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
        lifetimeSignal: this.#lifetimeSignal ?? undefined,
      });
      readiness = createDeferred();
      generationLifecycle = acquireFilePlaybackUniversalLifecycleLease('decoderGenerations');
      workerLifecycle = acquireFilePlaybackUniversalLifecycleLease('workers');
      sourcePortLifecycle = acquireFilePlaybackUniversalLifecycleLease('ports');
      pcmPortLifecycle = acquireFilePlaybackUniversalLifecycleLease('ports');
      this.#assertGenerationCanStart(request.signal);
      request.acceptPcmPortOwnership();
      pcmPortOwnershipAccepted = true;
      this.#assertGenerationCanStart(request.signal);
      const createdRealm: WorkerRealm = {
        kind: 'worker',
        generation: request.generation,
        sourceLifetimeGeneration: lease.leaseGeneration,
        descriptor,
        expectedOutputFrames: expectedMp3OutputFrames(descriptor),
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
            this.#retireGeneration(
              createdRealm,
              asError(abortReason(request.signal), 'MP3 decoder generation aborted'),
            );
          }
        },
        transferred: false,
        posting: false,
        transferUncertain: false,
        stopSent: false,
        decoderRetiredAcknowledged: false,
        workerRetiredAcknowledged: false,
        retryWaitSequence: 0,
        cleanupCompletion: createDeferred(),
        cleanupPromise: null,
        cleanupStarted: false,
        retirementFaulted: false,
        ready: false,
        retired: false,
        progressiveIndexEvents: 0,
        decodedInputBytes: descriptor.startPlan.scanAnchorByteOffset,
        decodedRawSamples: descriptor.startPlan.scanAnchorFrameOrdinal * descriptor.samplesPerFrame,
        producedOutputFrames: 0,
      };
      realm = createdRealm;
      this.#activeGeneration = createdRealm;
      request.signal.addEventListener('abort', createdRealm.onAbort, { once: true });
      if (!this.#revalidateWorkerRealmSetup(createdRealm)) {
        reinforceTerminalWorkerRealm(createdRealm);
        return createdRealm.readiness.promise;
      }
      worker.onmessage = (event: MessageEvent<unknown>) =>
        this.#handleWorkerEvent(createdRealm, event.data);
      if (!this.#revalidateWorkerRealmSetup(createdRealm)) {
        reinforceTerminalWorkerRealm(createdRealm);
        return createdRealm.readiness.promise;
      }
      worker.onerror = () => this.#handleWorkerFailure(createdRealm, 'decoder-worker-error');
      if (!this.#revalidateWorkerRealmSetup(createdRealm)) {
        reinforceTerminalWorkerRealm(createdRealm);
        return createdRealm.readiness.promise;
      }
      worker.onmessageerror = () =>
        this.#handleWorkerFailure(createdRealm, 'decoder-message-error');
      if (!this.#revalidateWorkerRealmSetup(createdRealm)) {
        reinforceTerminalWorkerRealm(createdRealm);
        return createdRealm.readiness.promise;
      }

      const command: Mp3DecoderOpenCommand = {
        protocolVersion: MP3_DECODER_PROTOCOL_VERSION,
        type: 'open-decoder',
        sourceLifetimeGeneration: createdRealm.sourceLifetimeGeneration,
        decoderGeneration: createdRealm.generation,
        descriptor: createdRealm.descriptor,
        sourcePort: createdRealm.sourcePort,
        pcmPort: createdRealm.pcmPort,
      };
      createdRealm.posting = true;
      try {
        worker.postMessage(command, mp3DecoderCommandTransferables(command));
      } catch (error) {
        createdRealm.posting = false;
        createdRealm.transferUncertain = true;
        if (createdRealm.retired) this.#cleanupWorkerRealm(createdRealm);
        throw error;
      }
      createdRealm.posting = false;
      createdRealm.transferred = true;
      if (!this.#revalidateWorkerRealmSetup(createdRealm)) {
        if (createdRealm.retired) this.#cleanupWorkerRealm(createdRealm);
        return createdRealm.readiness.promise;
      }
      return readiness.promise;
    } catch (error) {
      if (realm) {
        const alreadyRetired = realm.retired;
        if (!alreadyRetired) {
          this.#retireGeneration(realm, asError(error, 'MP3 decoder generation failed'));
        } else {
          this.#cleanupWorkerRealm(realm);
        }
        reinforceTerminalWorkerRealm(realm);
        // Transfer failed before the caller could receive the readiness Promise.
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
    return this.#startWorkerGeneration(request);
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
    if (!realm.transferred && !realm.transferUncertain) {
      if (realm.retired) {
        this.#rejectWorkerRetirement(realm, new Error('Invalid MP3 retirement event'));
      } else {
        this.#failGeneration(realm, 'decoder-invalid-event');
      }
      return;
    }
    const retryWaitDeltaEnvelope = isRetryWaitDeltaEnvelope(value);
    const event = parseMp3DecoderEvent(value);
    if (
      !event ||
      event.sourceLifetimeGeneration !== realm.sourceLifetimeGeneration ||
      event.decoderGeneration !== realm.generation
    ) {
      if (retryWaitDeltaEnvelope) this.#markUnknownRetryWait(realm);
      if (realm.retired)
        this.#rejectWorkerRetirement(realm, new Error('Invalid MP3 retirement event'));
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
        this.#rejectWorkerRetirement(realm, new Error('Premature MP3 decoder retirement ACK'));
        return;
      }
      if (realm.decoderRetiredAcknowledged) {
        this.#rejectWorkerRetirement(realm, new Error('Duplicate MP3 decoder retirement ACK'));
        return;
      }
      realm.decoderRetiredAcknowledged = true;
      realm.decoderRetired.resolve();
      return;
    }
    if (event.type === 'worker-retired') {
      if (!realm.retired || !realm.stopSent) {
        if (!realm.retired) this.#failGeneration(realm, 'decoder-premature-retirement');
        this.#rejectWorkerRetirement(realm, new Error('Premature MP3 worker retirement ACK'));
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
        this.#rejectWorkerRetirement(realm, new Error('Invalid MP3 worker retirement ACK'));
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
      this.#rejectWorkerRetirement(realm, new Error('MP3 event arrived outside its active realm'));
      return;
    }

    if (event.type === 'decoder-ready') {
      if (!sameMp3DecoderDescriptor(event.descriptor, realm.descriptor)) {
        this.#failGeneration(realm, 'decoder-descriptor-mismatch');
        return;
      }
      realm.ready = true;
      realm.readiness.resolve();
      return;
    }
    if (event.type === 'frame-index-point') {
      this.#acceptIndexEvent(realm, event);
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
    const error = new Error('MP3 decoder stopped unexpectedly');
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
      this.#rejectWorkerRetirement(realm, new Error('MP3 retry wait accounting mismatch'));
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

  #acceptIndexEvent(
    realm: WorkerRealm,
    event: Extract<Mp3DecoderEvent, { readonly type: 'frame-index-point' }>,
  ): void {
    realm.progressiveIndexEvents += 1;
    if (realm.progressiveIndexEvents > MP3_DECODER_MAX_PROGRESSIVE_INDEX_EVENTS) {
      this.#failGeneration(realm, 'decoder-index-limit');
      return;
    }
    let point: Readonly<MpegLayer3SeekIndexPoint>;
    try {
      point = mp3FrameIndexPointFromEvent(event, realm.descriptor);
    } catch (error) {
      this.#failGeneration(realm, 'decoder-invalid-index-point', error);
      return;
    }
    const existing = this.#seekIndex.nearestBefore(point.rawSample);
    if (existing.frameOrdinal === point.frameOrdinal) {
      if (!sameIndexPoint(existing, point)) {
        this.#failGeneration(realm, 'decoder-index-conflict');
      }
      return;
    }
    if (
      !this.#seekIndex.addVerifiedFrame(
        point.rawSample,
        point.byteOffset,
        point.frameOrdinal,
        point.mainDataCapacityBytes,
        point.mainDataBeginBytes,
      )
    ) {
      this.#failGeneration(realm, 'decoder-invalid-index-point');
    }
  }

  #acceptProgressEvent(
    realm: WorkerRealm,
    event: Extract<Mp3DecoderEvent, { readonly type: 'decode-progress' | 'decoder-eof' }>,
  ): boolean {
    const descriptor = realm.descriptor;
    if (
      event.decodedInputBytes < realm.decodedInputBytes ||
      event.decodedInputBytes > descriptor.audioEndByteOffset ||
      event.decodedRawSamples < realm.decodedRawSamples ||
      event.decodedRawSamples > descriptor.timeline.totalRawSamples ||
      event.producedOutputFrames < realm.producedOutputFrames ||
      event.producedOutputFrames > realm.expectedOutputFrames
    ) {
      return false;
    }
    if (
      event.type === 'decoder-eof' &&
      (!realm.ready ||
        event.decodedInputBytes !== descriptor.audioEndByteOffset ||
        event.decodedRawSamples !== descriptor.timeline.totalRawSamples ||
        event.producedOutputFrames !== realm.expectedOutputFrames)
    ) {
      return false;
    }
    realm.decodedInputBytes = event.decodedInputBytes;
    realm.decodedRawSamples = event.decodedRawSamples;
    realm.producedOutputFrames = event.producedOutputFrames;
    // Control EOF is telemetry on a different port from final PCM. The realm
    // remains alive until an explicit stop, successor generation, abort, or close.
    return true;
  }

  #failGeneration(generation: ActiveGeneration, code: string, cause?: unknown): void {
    if (this.#closed || this.#activeGeneration !== generation || generation.retired) return;
    const error = asError(cause, 'MP3 decoder generation failed');
    if (generation.kind === 'worker') generation.readiness.reject(error);
    this.#retireGeneration(generation, error);
    this.#fatal(code, cause ?? error);
  }

  #retireGeneration(generation: ActiveGeneration, cause: Error): Promise<void> | null {
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
    if (generation.cleanupStarted || generation.posting) return retirement;
    generation.cleanupStarted = true;

    if (!generation.transferred) {
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
        protocolVersion: MP3_DECODER_PROTOCOL_VERSION,
        type: 'stop-decoder',
        sourceLifetimeGeneration: generation.sourceLifetimeGeneration,
        decoderGeneration: generation.generation,
      } satisfies Mp3DecoderStopCommand);
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
          throw new Error('MP3 worker retirement left mirrored retry waits');
        }
        await generation.broker.close();
        if (generation.retirementFaulted) throw new Error('MP3 worker retirement protocol failed');
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

  #assertGenerationCanStart(requestSignal: AbortSignal): void {
    throwIfAborted(requestSignal);
    if (this.#closed || !this.#opened || this.#sourceLifetime.closed) {
      throw new DOMException('MP3 decoder adapter was closed', 'AbortError');
    }
  }

  #revalidateWorkerRealmSetup(realm: WorkerRealm): boolean {
    if (realm.retired) return false;
    if (this.#activeGeneration !== realm || this.#closed) {
      this.#retireGeneration(
        realm,
        new DOMException('MP3 decoder adapter lost setup authority', 'AbortError'),
      );
      return false;
    }
    try {
      this.#assertGenerationCanStart(realm.signal);
    } catch (error) {
      this.#retireGeneration(realm, asError(error, 'MP3 decoder setup authority was lost'));
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
