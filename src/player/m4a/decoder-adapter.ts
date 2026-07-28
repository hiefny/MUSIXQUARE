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
  readonly generationLifecycle: FilePlaybackUniversalLifecycleLease;
  readonly portLifecycle: FilePlaybackUniversalLifecycleLease;
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
  readonly #retirementPromises = new Set<Promise<void>>();
  #pendingWorkerRetirement: Promise<void> | null = null;
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
      try {
        options.lifetimeSignal.addEventListener('abort', this.#onLifetimeAbort, { once: true });
      } catch (error) {
        if (this.#closed || this.#lifetimeSignal !== options.lifetimeSignal) {
          safeRemoveAbortListener(options.lifetimeSignal, this.#onLifetimeAbort);
          throw new Error('M4A AAC decoder adapter is closed', { cause: error });
        }
        throw error;
      }
      if (this.#closed || this.#lifetimeSignal !== options.lifetimeSignal) {
        safeRemoveAbortListener(options.lifetimeSignal, this.#onLifetimeAbort);
        throw new Error('M4A AAC decoder adapter is closed');
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
      typeof request.acceptPcmPortOwnership !== 'function' ||
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
      const previousRetirement = previous
        ? this.#retireGeneration(previous, stoppedBeforeReadyError())
        : this.#pendingWorkerRetirement;
      return previousRetirement
        ? this.#startEofGenerationAfterRetirement(request, previousRetirement)
        : this.#startEofGeneration(request);
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
    const previousRetirement = previous
      ? this.#retireGeneration(previous, stoppedBeforeReadyError())
      : this.#pendingWorkerRetirement;
    return previousRetirement
      ? this.#startWorkerGenerationAfterRetirement(request, descriptor, previousRetirement)
      : this.#startWorkerGeneration(request, descriptor);
  }

  stopGeneration(generation: number): void {
    if (!isM4aAacDecoderGeneration(generation)) return;
    const active = this.#activeGeneration;
    if (!active || active.generation !== generation) return;
    this.#retireGeneration(active, stoppedBeforeReadyError());
  }

  close(): Promise<void> {
    return this.#closeInternal(
      new DOMException('M4A AAC decoder adapter was closed', 'AbortError'),
    );
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
      return Promise.reject(new DOMException('M4A AAC decoder adapter was closed', 'AbortError'));
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
      const expectedEof = expectedM4aAacDecoderEofProgress(descriptor);
      request.acceptPcmPortOwnership();
      pcmPortOwnershipAccepted = true;
      this.#assertGenerationCanStart(request.signal, lifetimeSignal);
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
    descriptor: Readonly<M4aAacDecoderDescriptor>,
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
        this.#rejectWorkerRetirement(realm, new Error('Invalid M4A AAC retirement event'));
      } else {
        this.#failGeneration(realm, 'decoder-invalid-event');
      }
      return;
    }
    const retryWaitDeltaEnvelope = isRetryWaitDeltaEnvelope(value);
    const event = parseM4aAacDecoderEvent(value);
    if (
      !event ||
      event.sourceLifetimeGeneration !== realm.sourceLifetimeGeneration ||
      event.decoderGeneration !== realm.generation
    ) {
      if (retryWaitDeltaEnvelope) this.#markUnknownRetryWait(realm);
      if (realm.retired) {
        this.#rejectWorkerRetirement(realm, new Error('Invalid M4A AAC retirement event'));
      } else {
        this.#failGeneration(realm, 'decoder-invalid-event');
      }
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
        this.#rejectWorkerRetirement(realm, new Error('Premature M4A AAC decoder retirement ACK'));
        return;
      }
      if (realm.decoderRetiredAcknowledged) {
        this.#rejectWorkerRetirement(realm, new Error('Duplicate M4A AAC decoder retirement ACK'));
        return;
      }
      realm.decoderRetiredAcknowledged = true;
      realm.decoderRetired.resolve();
      return;
    }
    if (event.type === 'worker-retired') {
      if (!realm.retired || !realm.stopSent) {
        if (!realm.retired) this.#failGeneration(realm, 'decoder-premature-retirement');
        this.#rejectWorkerRetirement(realm, new Error('Premature M4A AAC worker retirement ACK'));
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
        this.#rejectWorkerRetirement(realm, new Error('Invalid M4A AAC worker retirement ACK'));
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
      this.#rejectWorkerRetirement(
        realm,
        new Error('M4A AAC event arrived outside its active realm'),
      );
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
      this.#rejectWorkerRetirement(realm, new Error('M4A AAC retry wait accounting mismatch'));
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
        protocolVersion: M4A_AAC_DECODER_PROTOCOL_VERSION,
        type: 'stop-decoder',
        sourceLifetimeGeneration: generation.sourceLifetimeGeneration,
        decoderGeneration: generation.generation,
      } satisfies M4aAacDecoderStopCommand);
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
          throw new Error('M4A AAC worker retirement left mirrored retry waits');
        }
        await generation.broker.close();
        if (generation.retirementFaulted) {
          throw new Error('M4A AAC worker retirement protocol failed');
        }
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
      throw new DOMException('M4A AAC decoder adapter was closed', 'AbortError');
    }
  }

  #revalidateWorkerRealmSetup(realm: WorkerRealm, lifetimeSignal: AbortSignal): boolean {
    if (realm.retired) return false;
    if (this.#activeGeneration !== realm || this.#closed) {
      this.#retireGeneration(
        realm,
        new DOMException('M4A AAC decoder adapter lost setup authority', 'AbortError'),
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
