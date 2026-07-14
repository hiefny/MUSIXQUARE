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
  transferred: boolean;
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

function safeClosePort(port: MessagePort | null): void {
  if (!port) return;
  try {
    port.close();
  } catch {
    // A transferred or previously closed endpoint no longer belongs here.
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

function isMessagePortLike(value: unknown): value is MessagePort {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as MessagePort).postMessage === 'function' &&
    typeof (value as MessagePort).close === 'function'
  );
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
      options.lifetimeSignal.addEventListener('abort', this.#onLifetimeAbort, { once: true });
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
    if (previous) this.#retireGeneration(previous, stoppedBeforeReadyError());
    if (request.targetMediaFrame === this.info.totalMediaFrames) {
      return this.#startEofGeneration(request);
    }
    return this.#startWorkerGeneration(request);
  }

  stopGeneration(generation: number): void {
    if (!isMp3DecoderGeneration(generation)) return;
    const active = this.#activeGeneration;
    if (!active || active.generation !== generation) return;
    if (active.kind === 'worker' && !active.retired) {
      try {
        active.worker.postMessage({
          protocolVersion: MP3_DECODER_PROTOCOL_VERSION,
          type: 'stop-decoder',
          sourceLifetimeGeneration: active.sourceLifetimeGeneration,
          decoderGeneration: active.generation,
        } satisfies Mp3DecoderStopCommand);
      } catch (error) {
        this.#fatal('decoder-command-failed', error);
      }
    }
    this.#retireGeneration(active, stoppedBeforeReadyError());
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#opened = false;
    this.#lifetimeSignal?.removeEventListener('abort', this.#onLifetimeAbort);
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
    try {
      this.#closePromise = this.#sourceLifetime.close();
    } catch {
      this.#closePromise = Promise.resolve();
    }
    return this.#closePromise;
  }

  #startEofGeneration(request: StreamingDecoderGenerationRequest): Promise<void> {
    const generation: EofGeneration = {
      kind: 'eof',
      generation: request.generation,
      signal: request.signal,
      onAbort: () => {
        if (this.#activeGeneration === generation) {
          this.#retireGeneration(
            generation,
            asError(abortReason(request.signal), 'MP3 EOF aborted'),
          );
        }
      },
      port: request.pcmPort,
      replied: false,
      retired: false,
    };
    this.#activeGeneration = generation;
    request.signal.addEventListener('abort', generation.onAbort, { once: true });
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
    generation.port.onmessageerror = () => {
      this.#failGeneration(generation, 'decoder-pcm-message-error');
    };
    try {
      generation.port.start();
    } catch (error) {
      this.#failGeneration(generation, 'decoder-pcm-port-failed', error);
      return Promise.reject(error);
    }
    if (request.signal.aborted) {
      generation.onAbort();
      return Promise.reject(abortReason(request.signal));
    }
    return Promise.resolve();
  }

  #startWorkerGeneration(request: StreamingDecoderGenerationRequest): Promise<void> {
    let lease: EncodedAudioSourceLease | null = null;
    let worker: Worker | null = null;
    let brokerPort: MessagePort | null = null;
    let sourcePort: MessagePort | null = null;
    let broker: EncodedSourcePortBroker | null = null;
    let readiness: Deferred | null = null;
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
      broker = new EncodedSourcePortBroker({
        source: lease,
        port: brokerPort,
        generation: lease.leaseGeneration,
        lifetimeSignal: this.#lifetimeSignal ?? undefined,
      });
      readiness = createDeferred();
      const realm: WorkerRealm = {
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
        signal: request.signal,
        onAbort: () => {
          if (this.#activeGeneration === realm) {
            this.#retireGeneration(
              realm,
              asError(abortReason(request.signal), 'MP3 decoder generation aborted'),
            );
          }
        },
        transferred: false,
        ready: false,
        retired: false,
        progressiveIndexEvents: 0,
        decodedInputBytes: descriptor.startPlan.scanAnchorByteOffset,
        decodedRawSamples: descriptor.startPlan.scanAnchorFrameOrdinal * descriptor.samplesPerFrame,
        producedOutputFrames: 0,
      };
      this.#activeGeneration = realm;
      request.signal.addEventListener('abort', realm.onAbort, { once: true });
      worker.onmessage = (event: MessageEvent<unknown>) =>
        this.#handleWorkerEvent(realm, event.data);
      worker.onerror = () => this.#failGeneration(realm, 'decoder-worker-error');
      worker.onmessageerror = () => this.#failGeneration(realm, 'decoder-message-error');

      const command: Mp3DecoderOpenCommand = {
        protocolVersion: MP3_DECODER_PROTOCOL_VERSION,
        type: 'open-decoder',
        sourceLifetimeGeneration: realm.sourceLifetimeGeneration,
        decoderGeneration: realm.generation,
        descriptor: realm.descriptor,
        sourcePort: realm.sourcePort,
        pcmPort: realm.pcmPort,
      };
      worker.postMessage(command, mp3DecoderCommandTransferables(command));
      realm.transferred = true;
      if (request.signal.aborted) realm.onAbort();
      return readiness.promise;
    } catch (error) {
      const active = this.#activeGeneration;
      if (active?.kind === 'worker' && active.readiness === readiness) {
        this.#retireGeneration(active, asError(error, 'MP3 decoder generation failed'));
        // Transfer failed before the caller could receive the readiness Promise.
        void active.readiness.promise.catch(() => undefined);
      } else {
        readiness?.reject(error);
        if (readiness) void readiness.promise.catch(() => undefined);
        if (broker) void broker.close().catch(() => undefined);
        else {
          safeClosePort(brokerPort);
          if (lease) void lease.close().catch(() => undefined);
        }
        safeClosePort(sourcePort);
        safeClosePort(request.pcmPort);
        safeTerminateWorker(worker);
      }
      return Promise.reject(error);
    }
  }

  #handleWorkerEvent(realm: WorkerRealm, value: unknown): void {
    if (this.#closed || this.#activeGeneration !== realm || realm.retired) return;
    const event = parseMp3DecoderEvent(value);
    if (
      !event ||
      event.sourceLifetimeGeneration !== realm.sourceLifetimeGeneration ||
      event.decoderGeneration !== realm.generation
    ) {
      this.#failGeneration(realm, 'decoder-invalid-event');
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

  #retireGeneration(generation: ActiveGeneration, cause: Error): void {
    if (generation.retired) return;
    generation.retired = true;
    generation.signal.removeEventListener('abort', generation.onAbort);
    if (this.#activeGeneration === generation) this.#activeGeneration = null;
    if (generation.kind === 'eof') {
      generation.port.onmessage = null;
      generation.port.onmessageerror = null;
      safeClosePort(generation.port);
      return;
    }

    generation.readiness.reject(cause);
    generation.worker.onmessage = null;
    generation.worker.onerror = null;
    generation.worker.onmessageerror = null;
    safeTerminateWorker(generation.worker);
    if (!generation.transferred) {
      safeClosePort(generation.sourcePort);
      safeClosePort(generation.pcmPort);
    }
    try {
      void generation.broker.close().catch(() => undefined);
    } catch {
      void generation.lease.close().catch(() => undefined);
    }
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
