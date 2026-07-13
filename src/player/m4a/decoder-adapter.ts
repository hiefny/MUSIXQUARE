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
  createM4aAacDecoderDescriptor,
  expectedM4aAacDecoderEofProgress,
} from './decoder-helpers.ts';
import {
  M4A_AAC_DECODER_MAX_OUTPUT_SAMPLE_RATE_HZ,
  M4A_AAC_DECODER_PROTOCOL_VERSION,
  isM4aAacDecoderGeneration,
  m4aAacDecoderCommandTransferables,
  parseM4aAacDecoderEvent,
  sameM4aAacDecoderDescriptor,
  type M4aAacDecoderBackendId,
  type M4aAacDecoderDescriptor,
  type M4aAacDecoderEvent,
  type M4aAacDecoderLogicalProgress,
  type M4aAacDecoderOpenCommand,
  type M4aAacDecoderStopCommand,
} from './decoder-protocol.ts';
import { snapshotM4aAacLcManifest, type M4aAacLcManifest } from './metadata.ts';
import { M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT } from './timeline.ts';

const MAX_FATAL_CODE_LENGTH = 256;
const SOURCE_KINDS = new Set<EncodedAudioSourceKind>(['blob', 'peer-range', 'r2-records']);

export interface M4aAacDecoderAdapterRuntime {
  /** A fresh Worker must be returned for every invocation. */
  readonly createWorker: () => Worker;
  readonly createMessageChannel: () => MessageChannel;
}

export interface M4aAacDecoderAdapterOptions {
  /** Ownership transfers only after this constructor validates successfully. */
  readonly encodedSource: EncodedAudioSource;
  /** Main-realm evidence issued by the bounded M4A metadata reader. */
  readonly manifest: Readonly<M4aAacLcManifest>;
  /** Exact room/cohort decoder choice. This adapter never substitutes another backend. */
  readonly backendId: M4aAacDecoderBackendId;
  readonly runtime: M4aAacDecoderAdapterRuntime;
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
  readonly descriptor: Readonly<M4aAacDecoderDescriptor>;
  readonly expectedEof: Readonly<M4aAacDecoderLogicalProgress>;
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
  nextAccessUnitOrdinal: number;
  consumedEncodedBytes: number;
  decodedRawCoreFrames: number;
  acceptedMediaFrames: number;
  producedOutputFrames: number;
}

interface EofGeneration extends GenerationBase {
  readonly kind: 'eof';
  readonly port: MessagePort;
  replied: boolean;
  terminal: { readonly cause: unknown } | null;
}

type ActiveGeneration = WorkerRealm | EofGeneration;

interface AdapterOptionSnapshot {
  readonly encodedSource: unknown;
  readonly manifest: unknown;
  readonly backendId: unknown;
  readonly runtime: unknown;
}

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
    : new DOMException('M4A AAC decoder operation was aborted', 'AbortError');
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
  return new Error('M4A AAC decoder stopped before priming');
}

function snapshotOptions(value: unknown): AdapterOptionSnapshot {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    throw new TypeError('M4A AAC decoder adapter options are required');
  }
  try {
    return Object.freeze({
      encodedSource: Reflect.get(value, 'encodedSource'),
      manifest: Reflect.get(value, 'manifest'),
      backendId: Reflect.get(value, 'backendId'),
      runtime: Reflect.get(value, 'runtime'),
    });
  } catch (error) {
    throw new TypeError('M4A AAC decoder adapter options could not be inspected', { cause: error });
  }
}

/** Capture a stable source facade without taking ownership. */
function snapshotEncodedSource(value: unknown): EncodedAudioSource {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    throw new TypeError('Streaming M4A AAC requires an encoded source');
  }
  try {
    const kind = Reflect.get(value, 'kind') as unknown;
    const size = Reflect.get(value, 'size') as unknown;
    const identity = Reflect.get(value, 'identity') as unknown;
    const metadataValue = Reflect.get(value, 'metadata') as unknown;
    const readAt = Reflect.get(value, 'readAt') as unknown;
    const close = Reflect.get(value, 'close') as unknown;
    if (!SOURCE_KINDS.has(kind as EncodedAudioSourceKind)) {
      throw new TypeError('Streaming M4A AAC encoded source kind is invalid');
    }
    if (typeof size !== 'number') {
      throw new TypeError('Streaming M4A AAC encoded source size is invalid');
    }
    validateExactRead(size, 0, 0);
    if (size <= 0 || !isEncodedAudioSourceIdentity(identity)) {
      throw new TypeError('Streaming M4A AAC requires a valid non-empty encoded source');
    }
    if (
      metadataValue === null ||
      (typeof metadataValue !== 'object' && typeof metadataValue !== 'function')
    ) {
      throw new TypeError('Streaming M4A AAC encoded source metadata is invalid');
    }
    const name = Reflect.get(metadataValue, 'name') as unknown;
    const mime = Reflect.get(metadataValue, 'mime') as unknown;
    if (typeof name !== 'string' || typeof mime !== 'string') {
      throw new TypeError('Streaming M4A AAC encoded source metadata is invalid');
    }
    if (typeof readAt !== 'function' || typeof close !== 'function') {
      throw new TypeError('Streaming M4A AAC encoded source methods are invalid');
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
    throw new TypeError('Streaming M4A AAC encoded source could not be inspected', {
      cause: error,
    });
  }
}

function snapshotRuntime(value: unknown): Readonly<M4aAacDecoderAdapterRuntime> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    throw new TypeError('Streaming M4A AAC decoder runtime is invalid');
  }
  try {
    const createWorker = Reflect.get(value, 'createWorker') as unknown;
    const createMessageChannel = Reflect.get(value, 'createMessageChannel') as unknown;
    if (typeof createWorker !== 'function' || typeof createMessageChannel !== 'function') {
      throw new TypeError('Streaming M4A AAC decoder runtime is invalid');
    }
    const target = value;
    return Object.freeze({
      createWorker: () => Reflect.apply(createWorker, target, []) as Worker,
      createMessageChannel: () => Reflect.apply(createMessageChannel, target, []) as MessageChannel,
    });
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError('Streaming M4A AAC decoder runtime could not be inspected', {
      cause: error,
    });
  }
}

function snapshotBackendId(value: unknown): M4aAacDecoderBackendId {
  if (value !== 'webcodecs' && value !== 'symphonia-wasm') {
    throw new TypeError('Streaming M4A AAC decoder backend is invalid');
  }
  return value;
}

function sameLogicalProgress(
  left: Readonly<M4aAacDecoderLogicalProgress>,
  right: Readonly<M4aAacDecoderLogicalProgress>,
): boolean {
  return (
    left.nextAccessUnitOrdinal === right.nextAccessUnitOrdinal &&
    left.consumedEncodedBytes === right.consumedEncodedBytes &&
    left.decodedRawCoreFrames === right.decodedRawCoreFrames &&
    left.acceptedMediaFrames === right.acceptedMediaFrames &&
    left.producedOutputFrames === right.producedOutputFrames
  );
}

/** Fresh-realm bounded M4A AAC decoder owner below the PCM renderer. */
export class M4aAacDecoderAdapter implements StreamingDecoderAdapter {
  readonly info: Readonly<StreamingDecoderMediaInfo>;

  readonly #manifest: Readonly<M4aAacLcManifest>;
  readonly #backendId: M4aAacDecoderBackendId;
  readonly #runtime: Readonly<M4aAacDecoderAdapterRuntime>;
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
        : new DOMException('M4A AAC decoder lifetime was aborted', 'AbortError'),
    );
  };
  #activeGeneration: ActiveGeneration | null = null;
  #opened = false;
  #closed = false;
  #closePromise: Promise<void> | null = null;

  constructor(optionsValue: M4aAacDecoderAdapterOptions) {
    const options = snapshotOptions(optionsValue);
    const source = snapshotEncodedSource(options.encodedSource);
    const runtime = snapshotRuntime(options.runtime);
    const backendId = snapshotBackendId(options.backendId);

    let manifest: Readonly<M4aAacLcManifest>;
    try {
      manifest = snapshotM4aAacLcManifest(options.manifest as Readonly<M4aAacLcManifest>);
    } catch (error) {
      throw new TypeError('Streaming M4A AAC manifest evidence is invalid', { cause: error });
    }
    if (manifest.sourceSize !== source.size || manifest.sourceIdentity !== source.identity) {
      throw new TypeError('Streaming M4A AAC manifest belongs to a different encoded source');
    }

    this.#manifest = manifest;
    this.#backendId = backendId;
    this.#runtime = runtime;
    this.info = Object.freeze({
      mediaSampleRateHz: manifest.codec.sampleRateHz,
      channelCount: manifest.codec.channelCount,
      totalMediaFrames: manifest.timeline.totalMediaFrames,
    });
    // Final ownership boundary: every other constructor check has succeeded.
    this.#sourceLifetime = new EncodedAudioSourceLifetime({ source });
  }

  get opened(): boolean {
    return this.#opened && !this.#closed;
  }

  open(options: StreamingDecoderOpenOptions): Promise<void> {
    if (this.#openPromise) return this.#openPromise;
    if (this.#closed) return Promise.reject(new Error('M4A AAC decoder adapter is closed'));
    if (
      !options ||
      !(options.signal instanceof AbortSignal) ||
      !(options.lifetimeSignal instanceof AbortSignal) ||
      typeof options.onFatal !== 'function' ||
      typeof options.onGenerationStopped !== 'function'
    ) {
      return Promise.reject(new TypeError('M4A AAC decoder open options are invalid'));
    }
    this.#fatalHandler = options.onFatal;
    this.#generationStoppedHandler = options.onGenerationStopped;
    this.#openPromise = Promise.resolve().then(() => {
      throwIfAborted(options.signal);
      throwIfAborted(options.lifetimeSignal);
      if (this.#closed) throw new Error('M4A AAC decoder adapter is closed');
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
    if (!this.opened) {
      return Promise.reject(new Error('M4A AAC streaming runtime is not initialized'));
    }
    if (
      !request ||
      !isM4aAacDecoderGeneration(request.generation) ||
      !Number.isSafeInteger(request.targetMediaFrame) ||
      request.targetMediaFrame < 0 ||
      request.targetMediaFrame > this.info.totalMediaFrames ||
      !Number.isSafeInteger(request.outputSampleRateHz) ||
      request.outputSampleRateHz <= 0 ||
      request.outputSampleRateHz > M4A_AAC_DECODER_MAX_OUTPUT_SAMPLE_RATE_HZ ||
      !isMessagePortLike(request.pcmPort) ||
      !(request.signal instanceof AbortSignal)
    ) {
      return Promise.reject(new TypeError('M4A AAC decoder generation request is invalid'));
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
    let descriptor: Readonly<M4aAacDecoderDescriptor>;
    try {
      descriptor = createM4aAacDecoderDescriptor({
        manifest: this.#manifest,
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
    if (!isM4aAacDecoderGeneration(generation)) return;
    const active = this.#activeGeneration;
    if (!active || active.generation !== generation) return;
    if (active.kind === 'worker' && !active.retired) {
      try {
        active.worker.postMessage({
          protocolVersion: M4A_AAC_DECODER_PROTOCOL_VERSION,
          type: 'stop-decoder',
          sourceLifetimeGeneration: active.sourceLifetimeGeneration,
          decoderGeneration: active.generation,
        } satisfies M4aAacDecoderStopCommand);
      } catch (error) {
        this.#fatal('decoder-command-failed', error);
      }
    }
    this.#retireGeneration(active, stoppedBeforeReadyError());
  }

  close(): Promise<void> {
    return this.#closeInternal(
      new DOMException('M4A AAC decoder adapter was closed', 'AbortError'),
    );
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
    descriptor: Readonly<M4aAacDecoderDescriptor>,
  ): Promise<void> {
    const lifetimeSignal = this.#lifetimeSignal;
    if (!lifetimeSignal) {
      return Promise.reject(new DOMException('M4A AAC decoder adapter was closed', 'AbortError'));
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
      const expectedEof = expectedM4aAacDecoderEofProgress(descriptor);
      const createdRealm: WorkerRealm = {
        kind: 'worker',
        generation: request.generation,
        sourceLifetimeGeneration: lease.leaseGeneration,
        descriptor,
        expectedEof,
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
        nextAccessUnitOrdinal: descriptor.startPlan.decodeStartAccessUnitOrdinal,
        consumedEncodedBytes: 0,
        decodedRawCoreFrames:
          descriptor.startPlan.decodeStartAccessUnitOrdinal * M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT,
        acceptedMediaFrames: 0,
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

      const command: M4aAacDecoderOpenCommand = {
        protocolVersion: M4A_AAC_DECODER_PROTOCOL_VERSION,
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
        worker.postMessage(command, m4aAacDecoderCommandTransferables(command));
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
    const event = parseM4aAacDecoderEvent(value);
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
      if (!sameM4aAacDecoderDescriptor(event.descriptor, realm.descriptor)) {
        this.#failGeneration(realm, 'decoder-descriptor-mismatch');
        return;
      }
      realm.ready = true;
      // Do not publish readiness until the open command's transfer boundary has settled.
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
    const error = new Error('M4A AAC decoder stopped unexpectedly');
    realm.readiness.reject(error);
    this.#retireGeneration(realm, error);
    this.#notifyGenerationStopped(realm.generation, error);
  }

  #acceptProgressEvent(
    realm: WorkerRealm,
    event: Extract<M4aAacDecoderEvent, { readonly type: 'decode-progress' | 'decoder-eof' }>,
  ): boolean {
    const descriptor = realm.descriptor;
    const manifest = descriptor.manifest;
    if (
      !realm.ready ||
      realm.eof ||
      event.nextAccessUnitOrdinal < realm.nextAccessUnitOrdinal ||
      event.nextAccessUnitOrdinal > manifest.timeline.accessUnitCount ||
      event.consumedEncodedBytes < realm.consumedEncodedBytes ||
      event.consumedEncodedBytes > manifest.sampleSizes.totalEncodedBytes ||
      event.decodedRawCoreFrames < realm.decodedRawCoreFrames ||
      event.decodedRawCoreFrames > manifest.timeline.rawCoreFrames ||
      event.acceptedMediaFrames < realm.acceptedMediaFrames ||
      event.acceptedMediaFrames > realm.expectedEof.acceptedMediaFrames ||
      event.producedOutputFrames < realm.producedOutputFrames ||
      event.producedOutputFrames > realm.expectedEof.producedOutputFrames
    ) {
      return false;
    }

    const expectedRawCoreFrames = event.nextAccessUnitOrdinal * M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT;
    if (event.decodedRawCoreFrames !== expectedRawCoreFrames) return false;

    const decodedAfterTarget = Math.max(
      0,
      event.decodedRawCoreFrames - descriptor.startPlan.rawTargetCoreFrame,
    );
    const maximumAcceptedMediaFrames = Math.min(
      realm.expectedEof.acceptedMediaFrames,
      decodedAfterTarget,
    );
    if (event.acceptedMediaFrames > maximumAcceptedMediaFrames) return false;

    const atAccessUnitEnd = event.nextAccessUnitOrdinal === manifest.timeline.accessUnitCount;
    const atEncodedEnd = event.consumedEncodedBytes === manifest.sampleSizes.totalEncodedBytes;
    const atRawEnd = event.decodedRawCoreFrames === manifest.timeline.rawCoreFrames;
    if (atAccessUnitEnd !== atEncodedEnd || atAccessUnitEnd !== atRawEnd) return false;
    if (event.type === 'decoder-eof' && !sameLogicalProgress(event, realm.expectedEof)) {
      return false;
    }

    realm.nextAccessUnitOrdinal = event.nextAccessUnitOrdinal;
    realm.consumedEncodedBytes = event.consumedEncodedBytes;
    realm.decodedRawCoreFrames = event.decodedRawCoreFrames;
    realm.acceptedMediaFrames = event.acceptedMediaFrames;
    realm.producedOutputFrames = event.producedOutputFrames;
    if (event.type === 'decoder-eof') realm.eof = true;
    // Control EOF is telemetry on a separate port from final PCM. The realm
    // remains alive until stop, successor, abort, or adapter close.
    return true;
  }

  #failGeneration(generation: ActiveGeneration, code: string, cause?: unknown): void {
    if (this.#closed || this.#activeGeneration !== generation || generation.retired) return;
    const error = asError(cause, 'M4A AAC decoder generation failed');
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
      throw new DOMException('M4A AAC decoder adapter was closed', 'AbortError');
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
