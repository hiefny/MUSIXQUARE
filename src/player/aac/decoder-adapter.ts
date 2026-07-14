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
  portOwnership: 'local' | 'posting' | 'worker';
  cleanupStarted: boolean;
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
    // The fresh realm may already have crossed its terminal boundary.
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
      if (previous) this.#retireGeneration(previous, stoppedBeforeReadyError());
      return this.#startEofGeneration(request);
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
    if (previous) this.#retireGeneration(previous, stoppedBeforeReadyError());
    return this.#startWorkerGeneration(request, descriptor);
  }

  stopGeneration(generation: number): void {
    if (!isAacDecoderGeneration(generation)) return;
    const active = this.#activeGeneration;
    if (!active || active.generation !== generation) return;
    if (active.kind === 'worker' && !active.retired) {
      try {
        active.worker.postMessage({
          protocolVersion: AAC_DECODER_PROTOCOL_VERSION,
          type: 'stop-decoder',
          sourceLifetimeGeneration: active.sourceLifetimeGeneration,
          decoderGeneration: active.generation,
        } satisfies AacDecoderStopCommand);
      } catch (error) {
        this.#fatal('decoder-command-failed', error);
      }
    }
    this.#retireGeneration(active, stoppedBeforeReadyError());
  }

  close(): Promise<void> {
    return this.#closeInternal(new DOMException('AAC decoder adapter was closed', 'AbortError'));
  }

  #closeInternal(cause: unknown): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    const closePromise = Promise.resolve();
    // Publish the stable terminal promise before source cleanup can re-enter.
    this.#closePromise = closePromise;
    this.#closed = true;
    this.#opened = false;
    this.#lifetimeSignal?.removeEventListener('abort', this.#onLifetimeAbort);
    this.#lifetimeSignal = null;
    const active = this.#activeGeneration;
    if (active) this.#retireGeneration(active, cause);
    this.#fatalHandler = null;
    this.#generationStoppedHandler = null;
    try {
      void this.#sourceLifetime.close().catch(() => undefined);
    } catch {
      // The local terminal boundary and stable close Promise are already published.
    }
    return closePromise;
  }

  #startEofGeneration(request: StreamingDecoderGenerationRequest): Promise<void> {
    const generation: EofGeneration = {
      kind: 'eof',
      generation: request.generation,
      signal: request.signal,
      onAbort: () => {
        if (this.#activeGeneration === generation) {
          this.#retireGeneration(generation, abortReason(request.signal));
        }
      },
      port: request.pcmPort,
      replied: false,
      terminal: null,
      retired: false,
    };
    this.#activeGeneration = generation;
    request.signal.addEventListener('abort', generation.onAbort, { once: true });
    try {
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
      if (generation.retired) return Promise.reject(generation.terminal?.cause);
      generation.port.onmessageerror = () => {
        this.#failGeneration(generation, 'decoder-pcm-message-error');
      };
      if (generation.retired) return Promise.reject(generation.terminal?.cause);
      generation.port.start();
    } catch (error) {
      if (generation.retired) return Promise.reject(generation.terminal?.cause);
      this.#failGeneration(generation, 'decoder-pcm-port-failed', error);
      return Promise.reject(error);
    }
    if (generation.retired) return Promise.reject(generation.terminal?.cause);
    if (request.signal.aborted) {
      generation.onAbort();
      return Promise.reject(abortReason(request.signal));
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
    let readiness: Deferred | null = null;
    let realm: WorkerRealm | null = null;
    try {
      lease = this.#sourceLifetime.acquireLease();
      worker = this.#runtime.createWorker();
      const sourceChannel = this.#runtime.createMessageChannel();
      brokerPort = sourceChannel.port1;
      sourcePort = sourceChannel.port2;
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
        signal: request.signal,
        onAbort: () => {
          if (this.#activeGeneration === createdRealm) {
            this.#retireGeneration(createdRealm, abortReason(request.signal));
          }
        },
        portOwnership: 'local',
        cleanupStarted: false,
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
      worker.onmessage = (event: MessageEvent<unknown>) =>
        this.#handleWorkerEvent(createdRealm, event.data);
      worker.onerror = () => this.#failGeneration(createdRealm, 'decoder-worker-error');
      worker.onmessageerror = () => this.#failGeneration(createdRealm, 'decoder-message-error');

      // Handler installation is also an injected Worker boundary. A hostile
      // setter may synchronously abort or close after realm publication.
      if (!createdRealm.retired) {
        try {
          this.#assertGenerationCanStart(request.signal, lifetimeSignal);
        } catch (error) {
          this.#retireGeneration(createdRealm, error);
        }
      }
      if (createdRealm.retired) return createdRealm.readiness.promise;

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
        if (createdRealm.retired) this.#cleanupWorkerRealm(createdRealm);
        throw error;
      }
      createdRealm.portOwnership = 'worker';
      if (!createdRealm.retired) {
        try {
          this.#assertGenerationCanStart(request.signal, lifetimeSignal);
        } catch (error) {
          this.#retireGeneration(createdRealm, error);
        }
      }
      if (createdRealm.retired) this.#cleanupWorkerRealm(createdRealm);
      else if (createdRealm.ready) createdRealm.readiness.resolve();
      return readiness.promise;
    } catch (error) {
      if (realm) {
        const alreadyRetired = realm.retired;
        if (!alreadyRetired) this.#retireGeneration(realm, error);
        else this.#cleanupWorkerRealm(realm);
        // The transfer failed before the caller received the readiness Promise.
        void realm.readiness.promise.catch(() => undefined);
        if (alreadyRetired) return realm.readiness.promise;
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
    if (realm.portOwnership === 'local') {
      this.#failGeneration(realm, 'decoder-invalid-event');
      return;
    }
    const event = parseAacDecoderEvent(value);
    if (
      !event ||
      event.sourceLifetimeGeneration !== realm.sourceLifetimeGeneration ||
      event.decoderGeneration !== realm.generation
    ) {
      this.#failGeneration(realm, 'decoder-invalid-event');
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

  #retireGeneration(generation: ActiveGeneration, cause: unknown): void {
    if (generation.retired) return;
    generation.retired = true;
    generation.signal.removeEventListener('abort', generation.onAbort);
    if (this.#activeGeneration === generation) this.#activeGeneration = null;
    if (generation.kind === 'eof') {
      generation.terminal = { cause };
      generation.port.onmessage = null;
      generation.port.onmessageerror = null;
      safeClosePort(generation.port);
      return;
    }

    generation.readiness.reject(cause);
    generation.worker.onmessage = null;
    generation.worker.onerror = null;
    generation.worker.onmessageerror = null;
    this.#cleanupWorkerRealm(generation);
  }

  #cleanupWorkerRealm(generation: WorkerRealm): void {
    if (generation.cleanupStarted || generation.portOwnership === 'posting') return;
    generation.cleanupStarted = true;
    safeTerminateWorker(generation.worker);
    if (generation.portOwnership === 'local') {
      safeClosePort(generation.sourcePort);
      safeClosePort(generation.pcmPort);
    }
    try {
      void generation.broker.close().catch(() => undefined);
    } catch {
      void generation.lease.close().catch(() => undefined);
    }
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
