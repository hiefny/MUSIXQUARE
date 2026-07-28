import type {
  StreamingDecoderAdapter,
  StreamingDecoderFatalHandler,
  StreamingDecoderGenerationRequest,
  StreamingDecoderGenerationStoppedHandler,
  StreamingDecoderMediaInfo,
  StreamingDecoderOpenOptions,
} from '../streaming/decoder-adapter.ts';
import {
  acquireFilePlaybackUniversalLifecycleLease,
  type FilePlaybackUniversalLifecycleLease,
  type FilePlaybackUniversalLifecycleRetirement,
} from '../diagnostics/file-playback-universal-lifecycle-diagnostics.ts';
import { PCM_STREAM_MAX_CHANNELS } from '../streaming/pcm-stream-protocol.ts';
import {
  type EncodedAudioSource,
  isEncodedAudioSourceIdentity,
  throwIfAborted,
  validateExactRead,
} from '../sources/encoded-audio-source.ts';
import { EncodedSourcePortBroker } from '../sources/encoded-source-port.ts';
import type { FlacMetadata } from './metadata.ts';
import { FlacSeekIndex } from './seek-index.ts';
import {
  FLAC_STREAM_PROTOCOL_VERSION,
  isFlacDecoderGeneration,
  isFlacSourceLifetimeGeneration,
  isFlacSourceSize,
  type FlacDecoderCommand,
  type FlacStreamDescriptor,
} from './stream-protocol.ts';

const MAX_IDENTIFIER_LENGTH = 256;
const WORKER_RETIRE_TIMEOUT_MS = 4_000;
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

export interface FlacDecoderAdapterRuntime {
  readonly createWorker: () => Worker;
  readonly createMessageChannel: () => MessageChannel;
}

export interface FlacDecoderAdapterOptions {
  /** Ownership transfers only after the containing playback-source constructor succeeds. */
  readonly encodedSource: EncodedAudioSource;
  readonly metadata: FlacMetadata;
  readonly runtime: FlacDecoderAdapterRuntime;
}

interface Deferred {
  settled: boolean;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface PendingGeneration {
  readonly generation: number;
  readonly descriptor: FlacStreamDescriptor;
  readonly readiness: Deferred;
}

type TrackedLifecycleState = 'live' | 'retiring' | 'released' | 'unconfirmed';

interface TrackedLifecycle {
  readonly lease: FilePlaybackUniversalLifecycleLease;
  retirement: FilePlaybackUniversalLifecycleRetirement | null;
  state: TrackedLifecycleState;
}

interface GenerationLifecycle {
  readonly decoder: TrackedLifecycle;
  readonly port: TrackedLifecycle;
}

function acquireTrackedLifecycle(
  kind: 'decoderGenerations' | 'workers' | 'ports' | 'timers',
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

let adapterInstanceCounter = 0;

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH;
}

function isFrame(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function snapshotExactRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null) return null;
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    prototype = Reflect.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  if (prototype !== null && prototype !== Object.prototype) return null;
  const record = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== 'string' || Object.prototype.hasOwnProperty.call(record, key)) return null;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    } catch {
      return null;
    }
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      return null;
    }
    record[key] = descriptor.value;
  }
  return Object.freeze(record);
}

function hasExactKeys(record: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(record, key))
  );
}

function sameDescriptor(actual: Record<string, unknown>, expected: FlacStreamDescriptor): boolean {
  return DESCRIPTOR_KEYS.every((key) => actual[key] === expected[key]);
}

function safeErrorCode(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  return value.slice(0, MAX_IDENTIFIER_LENGTH);
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

function safeDetachWorkerHandlers(worker: Worker): void {
  try {
    worker.onmessage = null;
  } catch {
    // Termination below remains the native terminal boundary.
  }
  try {
    worker.onerror = null;
  } catch {
    // Termination below remains the native terminal boundary.
  }
  try {
    worker.onmessageerror = null;
  } catch {
    // Termination below remains the native terminal boundary.
  }
}

function safeTerminateWorker(worker: Worker | null): boolean {
  if (!worker) return true;
  safeDetachWorkerHandlers(worker);
  try {
    worker.terminate();
    return true;
  } catch {
    return false;
  }
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

function abortError(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  return new DOMException('FLAC decoder operation was aborted', 'AbortError');
}

function stoppedBeforeReadyError(): Error {
  return new Error('FLAC decoder stopped before priming');
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
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

/** Native-FLAC worker/index owner below the codec-neutral PCM renderer. */
export class FlacDecoderAdapter implements StreamingDecoderAdapter {
  readonly info: Readonly<StreamingDecoderMediaInfo>;

  readonly #encodedSource: EncodedAudioSource;
  readonly #metadata: FlacMetadata;
  readonly #runtime: FlacDecoderAdapterRuntime;
  readonly #seekIndex: FlacSeekIndex;
  readonly #sourceLifetimeGeneration: number;

  #worker: Worker | null = null;
  #workerLifecycle: TrackedLifecycle | null = null;
  #sourcePortLifecycle: TrackedLifecycle | null = null;
  readonly #generationLifecycles = new Map<number, GenerationLifecycle>();
  #workerRetirementReadiness: Deferred | null = null;
  #workerRetirementTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  #workerRetirementTimerLifecycle: TrackedLifecycle | null = null;
  #workerRetirementConfirmed = false;
  #workerFaulted = false;
  #sourceOpenedAcknowledged = false;
  #sourceBroker: EncodedSourcePortBroker | null = null;
  #sourceOpenReadiness: Deferred | null = null;
  #openPromise: Promise<void> | null = null;
  #fatalHandler: StreamingDecoderFatalHandler | null = null;
  #generationStoppedHandler: StreamingDecoderGenerationStoppedHandler | null = null;
  #currentGeneration = 0;
  #currentDescriptor: FlacStreamDescriptor | null = null;
  #pendingGeneration: PendingGeneration | null = null;
  #opened = false;
  #closed = false;
  #closePromise: Promise<void> | null = null;

  constructor(options: FlacDecoderAdapterOptions) {
    if (
      !options.encodedSource ||
      typeof options.encodedSource.readAt !== 'function' ||
      typeof options.encodedSource.close !== 'function' ||
      !isFlacSourceSize(options.encodedSource.size) ||
      !isEncodedAudioSourceIdentity(options.encodedSource.identity)
    ) {
      throw new TypeError('Streaming FLAC requires a valid non-empty encoded source');
    }
    validateExactRead(options.encodedSource.size, 0, 0);
    const streamInfo = options.metadata?.streamInfo;
    if (
      !streamInfo ||
      !Number.isSafeInteger(streamInfo.sampleRate) ||
      streamInfo.sampleRate <= 0 ||
      !Number.isSafeInteger(streamInfo.channels) ||
      streamInfo.channels < 1 ||
      streamInfo.channels > PCM_STREAM_MAX_CHANNELS ||
      !Number.isSafeInteger(streamInfo.bitDepth) ||
      streamInfo.bitDepth < 4 ||
      streamInfo.bitDepth > 32 ||
      !Number.isSafeInteger(streamInfo.totalSamples) ||
      streamInfo.totalSamples <= 0 ||
      !Number.isFinite(streamInfo.duration) ||
      streamInfo.duration <= 0 ||
      !Number.isSafeInteger(options.metadata.firstAudioFrameOffset) ||
      options.metadata.firstAudioFrameOffset < 4 ||
      options.metadata.firstAudioFrameOffset >= options.encodedSource.size
    ) {
      throw new TypeError('Streaming FLAC metadata is invalid');
    }
    if (
      !options.runtime ||
      typeof options.runtime.createWorker !== 'function' ||
      typeof options.runtime.createMessageChannel !== 'function'
    ) {
      throw new TypeError('Streaming FLAC decoder runtime is invalid');
    }

    adapterInstanceCounter += 1;
    if (!isFlacSourceLifetimeGeneration(adapterInstanceCounter)) {
      throw new RangeError('Streaming FLAC source lifetime generation is exhausted');
    }
    this.#sourceLifetimeGeneration = adapterInstanceCounter;
    this.#encodedSource = options.encodedSource;
    this.#metadata = options.metadata;
    this.#runtime = options.runtime;
    this.#seekIndex = new FlacSeekIndex(options.metadata, options.encodedSource.size);
    this.info = Object.freeze({
      mediaSampleRateHz: streamInfo.sampleRate,
      channelCount: streamInfo.channels,
      totalMediaFrames: streamInfo.totalSamples,
    });
  }

  get opened(): boolean {
    return this.#opened && !this.#closed;
  }

  open(options: StreamingDecoderOpenOptions): Promise<void> {
    if (this.#openPromise) return this.#openPromise;
    if (this.#closed) return Promise.reject(new Error('FLAC decoder adapter is closed'));
    if (
      !options ||
      !(options.signal instanceof AbortSignal) ||
      !(options.lifetimeSignal instanceof AbortSignal) ||
      typeof options.onFatal !== 'function' ||
      typeof options.onGenerationStopped !== 'function'
    ) {
      return Promise.reject(new TypeError('FLAC decoder open options are invalid'));
    }
    this.#fatalHandler = options.onFatal;
    this.#generationStoppedHandler = options.onGenerationStopped;
    this.#openPromise = this.#open(options);
    return this.#openPromise;
  }

  startGeneration(request: StreamingDecoderGenerationRequest): Promise<void> {
    if (!this.opened || !this.#worker) {
      return Promise.reject(new Error('FLAC streaming runtime is not initialized'));
    }
    if (
      !request ||
      !isFlacDecoderGeneration(request.generation) ||
      !Number.isSafeInteger(request.targetMediaFrame) ||
      request.targetMediaFrame < 0 ||
      request.targetMediaFrame > this.info.totalMediaFrames ||
      !Number.isSafeInteger(request.outputSampleRateHz) ||
      request.outputSampleRateHz <= 0 ||
      !request.pcmPort ||
      typeof request.pcmPort.postMessage !== 'function' ||
      typeof request.acceptPcmPortOwnership !== 'function' ||
      !(request.signal instanceof AbortSignal)
    ) {
      return Promise.reject(new TypeError('FLAC decoder generation request is invalid'));
    }
    try {
      throwIfAborted(request.signal);
    } catch (error) {
      return Promise.reject(error);
    }

    const descriptor = this.#descriptorForMediaFrame(
      request.targetMediaFrame,
      request.outputSampleRateHz,
    );
    if (this.#currentGeneration > 0 && this.#currentGeneration !== request.generation) {
      this.#beginGenerationRetirement(this.#currentGeneration);
    }
    if (this.#generationLifecycles.has(request.generation)) {
      return Promise.reject(new Error('FLAC decoder generation was already created'));
    }
    let generationLifecycle: GenerationLifecycle;
    try {
      const decoder = acquireTrackedLifecycle('decoderGenerations');
      try {
        generationLifecycle = {
          decoder,
          port: acquireTrackedLifecycle('ports'),
        };
      } catch (error) {
        releaseTrackedLifecycle(decoder);
        throw error;
      }
    } catch (error) {
      return Promise.reject(error);
    }
    try {
      request.acceptPcmPortOwnership();
    } catch (error) {
      releaseTrackedLifecycle(generationLifecycle.port);
      releaseTrackedLifecycle(generationLifecycle.decoder);
      return Promise.reject(error);
    }
    this.#generationLifecycles.set(request.generation, generationLifecycle);
    const readiness = createDeferred();
    const previous = this.#pendingGeneration;
    if (previous && !previous.readiness.settled)
      previous.readiness.reject(stoppedBeforeReadyError());
    this.#currentGeneration = request.generation;
    this.#currentDescriptor = descriptor;
    this.#pendingGeneration = { generation: request.generation, descriptor, readiness };

    try {
      this.#worker.postMessage(
        {
          protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
          type: 'init-decoder',
          sourceLifetimeGeneration: this.#sourceLifetimeGeneration,
          decoderGeneration: request.generation,
          descriptor,
          pcmPort: request.pcmPort,
        } satisfies FlacDecoderCommand,
        [request.pcmPort],
      );
    } catch (error) {
      if (this.#pendingGeneration?.readiness === readiness) this.#pendingGeneration = null;
      readiness.reject(error);
      safeClosePort(request.pcmPort);
      // postMessage() throwing leaves transfer completion unknowable. Never
      // convert that ambiguous decoder/port boundary into a clean release.
      forceTrackedLifecycleUnconfirmed(generationLifecycle.port);
      forceTrackedLifecycleUnconfirmed(generationLifecycle.decoder);
      this.#generationLifecycles.delete(request.generation);
      return Promise.reject(error);
    }

    return raceAbort(readiness.promise, request.signal);
  }

  stopGeneration(generation: number): void {
    if (!isFlacDecoderGeneration(generation)) return;
    const pending = this.#pendingGeneration;
    const ownsGeneration =
      this.#currentGeneration === generation || pending?.generation === generation;
    if (!ownsGeneration) return;
    this.#beginGenerationRetirement(generation);
    if (pending?.generation === generation) {
      this.#pendingGeneration = null;
      pending.readiness.reject(stoppedBeforeReadyError());
    }
    if (this.#currentGeneration === generation) {
      this.#currentGeneration = 0;
      this.#currentDescriptor = null;
    }
    if (!this.#worker || this.#closed) return;
    try {
      this.#worker.postMessage({
        protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
        type: 'stop-decoder',
        sourceLifetimeGeneration: this.#sourceLifetimeGeneration,
        decoderGeneration: generation,
      } satisfies FlacDecoderCommand);
    } catch (error) {
      this.#fatal('decoder-command-failed', error);
    }
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    const completion = createDeferred();
    // Publish the one stable terminal promise before postMessage(), deferred
    // rejection, or source cleanup can synchronously re-enter close().
    this.#closePromise = completion.promise;
    const worker = this.#worker;
    const broker = this.#sourceBroker;
    const retirement = createDeferred();
    this.#workerRetirementReadiness = retirement;
    try {
      this.#closed = true;
      this.#opened = false;
      const closedError = new DOMException('FLAC decoder adapter was closed', 'AbortError');
      this.#sourceOpenReadiness?.reject(closedError);
      this.#sourceOpenReadiness = null;
      this.#pendingGeneration?.readiness.reject(closedError);
      this.#pendingGeneration = null;
      this.#currentDescriptor = null;
      this.#worker = null;
      this.#sourceBroker = null;
      for (const generation of this.#generationLifecycles.keys()) {
        this.#beginGenerationRetirement(generation);
      }
      if (this.#workerLifecycle) beginTrackedRetirement(this.#workerLifecycle);
      if (this.#sourcePortLifecycle) beginTrackedRetirement(this.#sourcePortLifecycle);

      if (!worker) retirement.resolve();
      else if (this.#workerFaulted || !this.#sourceOpenedAcknowledged) {
        this.#settleWorkerRetirement(false);
      } else {
        worker.postMessage({
          protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
          type: 'close-source',
          sourceLifetimeGeneration: this.#sourceLifetimeGeneration,
        } satisfies FlacDecoderCommand);
        if (!retirement.settled) {
          const timerLifecycle = acquireTrackedLifecycle('timers');
          this.#workerRetirementTimerLifecycle = timerLifecycle;
          this.#workerRetirementTimer = globalThis.setTimeout(() => {
            this.#workerRetirementTimer = null;
            if (this.#workerRetirementTimerLifecycle === timerLifecycle) {
              this.#workerRetirementTimerLifecycle = null;
            }
            releaseTrackedLifecycle(timerLifecycle);
            this.#settleWorkerRetirement(false);
          }, WORKER_RETIRE_TIMEOUT_MS);
        }
      }
    } catch {
      this.#settleWorkerRetirement(false);
    }

    void retirement.promise
      .then(() => {
        let sourceCleanup = Promise.resolve();
        try {
          sourceCleanup = broker
            ? broker.close().catch(() => undefined)
            : Promise.resolve(this.#encodedSource.close()).catch(() => undefined);
        } catch {
          // Cleanup was initiated as far as the owned implementation allowed.
        }
        void sourceCleanup;

        const terminated = safeTerminateWorker(worker);
        if (this.#workerLifecycle) {
          if (this.#workerRetirementConfirmed && terminated) {
            releaseTrackedLifecycle(this.#workerLifecycle);
          } else {
            forceTrackedLifecycleUnconfirmed(this.#workerLifecycle);
          }
        }
        this.#fatalHandler = null;
        this.#generationStoppedHandler = null;
      })
      .then(
        () => completion.resolve(),
        () => {
          if (this.#workerLifecycle) forceTrackedLifecycleUnconfirmed(this.#workerLifecycle);
          try {
            safeTerminateWorker(worker);
          } finally {
            this.#fatalHandler = null;
            this.#generationStoppedHandler = null;
            completion.resolve();
          }
        },
      );
    return this.#closePromise;
  }

  async #open(options: StreamingDecoderOpenOptions): Promise<void> {
    throwIfAborted(options.signal);
    if (this.#closed) throw new Error('FLAC decoder adapter is closed');
    this.#workerLifecycle = acquireTrackedLifecycle('workers');
    let worker: Worker;
    try {
      worker = this.#runtime.createWorker();
    } catch (error) {
      this.#workerFaulted = true;
      forceTrackedLifecycleUnconfirmed(this.#workerLifecycle);
      throw error;
    }
    this.#worker = worker;
    worker.onmessage = (event: MessageEvent<unknown>) => this.#handleWorkerEvent(event.data);
    worker.onerror = () => {
      this.#markWorkerFaulted();
      this.#fatal('decoder-worker-error');
    };
    worker.onmessageerror = () => {
      this.#markWorkerFaulted();
      this.#fatal('decoder-message-error');
    };

    const sourceChannel = this.#runtime.createMessageChannel();
    try {
      this.#sourcePortLifecycle = acquireTrackedLifecycle('ports');
    } catch (error) {
      safeClosePort(sourceChannel.port1);
      safeClosePort(sourceChannel.port2);
      throw error;
    }
    let sourcePortTransferred = false;
    let brokerConstructionInvoked = false;
    const readiness = createDeferred();
    this.#sourceOpenReadiness = readiness;
    try {
      // EncodedSourcePortBroker owns port1 as soon as construction is invoked,
      // including its throwing path. Never perform a fallback re-close here.
      brokerConstructionInvoked = true;
      this.#sourceBroker = new EncodedSourcePortBroker({
        source: this.#encodedSource,
        port: sourceChannel.port1,
        generation: this.#sourceLifetimeGeneration,
        lifetimeSignal: options.lifetimeSignal,
      });
      worker.postMessage(
        {
          protocolVersion: FLAC_STREAM_PROTOCOL_VERSION,
          type: 'open-source',
          sourceLifetimeGeneration: this.#sourceLifetimeGeneration,
          sourceSize: this.#encodedSource.size,
          sourceIdentity: this.#encodedSource.identity,
          sourcePort: sourceChannel.port2,
        } satisfies FlacDecoderCommand,
        [sourceChannel.port2],
      );
      sourcePortTransferred = true;
      await raceAbort(readiness.promise, options.signal);
      throwIfAborted(options.signal);
      if (this.#closed) throw new Error('FLAC decoder adapter is closed');
      this.#opened = true;
    } catch (error) {
      if (!brokerConstructionInvoked) safeClosePort(sourceChannel.port1);
      if (!sourcePortTransferred && this.#sourcePortLifecycle) {
        if (safeClosePort(sourceChannel.port2)) {
          releaseTrackedLifecycle(this.#sourcePortLifecycle);
        } else {
          forceTrackedLifecycleUnconfirmed(this.#sourcePortLifecycle);
        }
        this.#sourcePortLifecycle = null;
      }
      throw error;
    } finally {
      if (this.#sourceOpenReadiness === readiness) this.#sourceOpenReadiness = null;
    }
  }

  #descriptorForMediaFrame(
    targetMediaFrame: number,
    outputSampleRate: number,
  ): FlacStreamDescriptor {
    const info = this.#metadata.streamInfo;
    const anchor = this.#seekIndex.nearestBefore(targetMediaFrame);
    return Object.freeze({
      sourceSampleRate: info.sampleRate,
      outputSampleRate,
      channels: info.channels,
      bitDepth: info.bitDepth,
      totalSourceSamples: info.totalSamples,
      firstAudioFrameOffset: this.#metadata.firstAudioFrameOffset,
      targetSourceSample: targetMediaFrame,
      decodeAnchorByteOffset: anchor.byteOffset,
      decodeAnchorSourceSample: anchor.sourceSample,
      minBlockSize: info.minBlockSize,
      maxBlockSize: info.maxBlockSize,
      minFrameSize: info.minFrameSize,
      maxFrameSize: info.maxFrameSize,
    });
  }

  #handleWorkerEvent(value: unknown): void {
    const event = snapshotExactRecord(value);
    if (!event || event.protocolVersion !== FLAC_STREAM_PROTOCOL_VERSION) {
      this.#markWorkerFaulted();
      this.#fatal('decoder-invalid-event');
      return;
    }
    if (event.type === 'decoder-retired') {
      if (
        !hasExactKeys(event, [
          'protocolVersion',
          'type',
          'sourceLifetimeGeneration',
          'decoderGeneration',
        ]) ||
        event.sourceLifetimeGeneration !== this.#sourceLifetimeGeneration ||
        !isFlacDecoderGeneration(event.decoderGeneration)
      ) {
        this.#markWorkerFaulted();
        this.#fatal('decoder-invalid-event');
        return;
      }
      if (!this.#releaseGenerationLifecycle(event.decoderGeneration)) {
        this.#fatal('decoder-invalid-event');
      }
      return;
    }
    if (event.type === 'worker-retired') {
      if (
        !hasExactKeys(event, ['protocolVersion', 'type', 'sourceLifetimeGeneration']) ||
        event.sourceLifetimeGeneration !== this.#sourceLifetimeGeneration ||
        !this.#closed ||
        !this.#workerRetirementReadiness
      ) {
        this.#markWorkerFaulted();
        this.#fatal('decoder-invalid-event');
        return;
      }
      this.#settleWorkerRetirement(this.#generationLifecycles.size === 0);
      return;
    }
    if (this.#closed) return;
    if (event.type === 'source-opened') {
      const valid =
        hasExactKeys(event, [
          'protocolVersion',
          'type',
          'sourceLifetimeGeneration',
          'sourceSize',
          'sourceIdentity',
        ]) &&
        event.sourceLifetimeGeneration === this.#sourceLifetimeGeneration &&
        event.sourceSize === this.#encodedSource.size &&
        event.sourceIdentity === this.#encodedSource.identity;
      const readiness = this.#sourceOpenReadiness;
      if (!valid || !readiness) {
        const error = new Error('FLAC source-open acknowledgement mismatch');
        readiness?.reject(error);
        this.#fatal('decoder-source-open-mismatch', error);
        return;
      }
      this.#sourceOpenedAcknowledged = true;
      readiness.resolve();
      return;
    }
    if (event.type === 'source-error') {
      if (
        !hasExactKeys(event, ['protocolVersion', 'type', 'sourceLifetimeGeneration', 'code']) ||
        event.sourceLifetimeGeneration !== this.#sourceLifetimeGeneration ||
        !isBoundedIdentifier(event.code)
      ) {
        this.#fatal('decoder-source-error-mismatch');
        return;
      }
      const code = safeErrorCode(event.code, 'unknown');
      const error = new Error(`FLAC encoded source failed: ${code}`);
      this.#sourceOpenReadiness?.reject(error);
      this.#pendingGeneration?.readiness.reject(error);
      this.#fatal(`decoder-source:${code}`, error);
      return;
    }
    if (event.type === 'source-closed') {
      if (
        !hasExactKeys(event, ['protocolVersion', 'type', 'sourceLifetimeGeneration']) ||
        event.sourceLifetimeGeneration !== this.#sourceLifetimeGeneration
      ) {
        this.#fatal('decoder-invalid-event');
        return;
      }
      this.#fatal('decoder-source-closed');
      return;
    }
    if (
      !isFlacSourceLifetimeGeneration(event.sourceLifetimeGeneration) ||
      !isFlacDecoderGeneration(event.decoderGeneration)
    ) {
      this.#fatal('decoder-invalid-event');
      return;
    }
    const sameCurrentGeneration =
      event.sourceLifetimeGeneration === this.#sourceLifetimeGeneration &&
      event.decoderGeneration === this.#currentGeneration;

    if (event.type === 'decoder-error') {
      if (
        !hasExactKeys(event, [
          'protocolVersion',
          'type',
          'sourceLifetimeGeneration',
          'decoderGeneration',
          'code',
          'message',
        ]) ||
        !isBoundedIdentifier(event.code) ||
        typeof event.message !== 'string' ||
        event.message.length > 1_024
      ) {
        this.#fatal('decoder-invalid-event');
        return;
      }
      if (!sameCurrentGeneration) return;
      this.#beginGenerationRetirement(event.decoderGeneration);
      const error = new Error(event.message || 'FLAC decoder failed');
      this.#pendingGeneration?.readiness.reject(error);
      this.#fatal(`decoder:${safeErrorCode(event.code, 'unknown')}`, error);
      return;
    }
    if (event.type === 'decoder-stopped') {
      if (
        !hasExactKeys(event, [
          'protocolVersion',
          'type',
          'sourceLifetimeGeneration',
          'decoderGeneration',
        ])
      ) {
        this.#fatal('decoder-invalid-event');
        return;
      }
      this.#beginGenerationRetirement(event.decoderGeneration);
      if (!sameCurrentGeneration) return;
      const pending = this.#pendingGeneration;
      const error = stoppedBeforeReadyError();
      if (pending?.generation === event.decoderGeneration) {
        this.#pendingGeneration = null;
        pending.readiness.reject(error);
      }
      this.#currentGeneration = 0;
      this.#currentDescriptor = null;
      this.#notifyGenerationStopped(event.decoderGeneration, error);
      return;
    }
    if (event.type === 'decode-anchor-rejected' || event.type === 'frame-index-point') {
      if (
        !hasExactKeys(event, [
          'protocolVersion',
          'type',
          'sourceLifetimeGeneration',
          'decoderGeneration',
          'sourceSample',
          'byteOffset',
        ]) ||
        !isFrame(event.sourceSample) ||
        !isFrame(event.byteOffset)
      ) {
        this.#fatal('decoder-invalid-index-point');
        return;
      }
      if (!sameCurrentGeneration) return;
      if (event.type === 'decode-anchor-rejected') {
        this.#seekIndex.rejectUnverifiedCandidate(event.sourceSample, event.byteOffset);
      } else {
        this.#seekIndex.addVerifiedFrame(event.sourceSample, event.byteOffset);
      }
      return;
    }
    if (event.type === 'decode-progress' || event.type === 'decoder-eof') {
      const invalid =
        !hasExactKeys(event, [
          'protocolVersion',
          'type',
          'sourceLifetimeGeneration',
          'decoderGeneration',
          'decodedInputBytes',
          'decodedSourceSamples',
          'producedOutputFrames',
        ]) ||
        !isFrame(event.decodedInputBytes) ||
        !isFrame(event.decodedSourceSamples) ||
        !isFrame(event.producedOutputFrames);
      if (invalid) {
        this.#fatal('decoder-invalid-event');
        return;
      }
      if (event.type === 'decoder-eof' && sameCurrentGeneration) {
        this.#beginGenerationRetirement(event.decoderGeneration);
      }
      return;
    }
    if (event.type !== 'decoder-ready') {
      this.#fatal('decoder-invalid-event');
      return;
    }
    if (
      !hasExactKeys(event, [
        'protocolVersion',
        'type',
        'sourceLifetimeGeneration',
        'decoderGeneration',
        'descriptor',
      ])
    ) {
      this.#fatal('decoder-invalid-event');
      return;
    }
    if (!sameCurrentGeneration) return;
    const descriptor = snapshotExactRecord(event.descriptor);
    if (!descriptor || !hasExactKeys(descriptor, DESCRIPTOR_KEYS)) {
      const error = new Error('FLAC decoder descriptor is missing');
      this.#pendingGeneration?.readiness.reject(error);
      this.#fatal('decoder-invalid-event', error);
      return;
    }
    const expected = this.#currentDescriptor;
    if (!expected || !sameDescriptor(descriptor, expected)) {
      const error = new Error('FLAC decoder descriptor mismatch');
      this.#pendingGeneration?.readiness.reject(error);
      this.#fatal('decoder-descriptor-mismatch', error);
      return;
    }
    const pending = this.#pendingGeneration;
    if (!pending) return;
    if (pending.generation !== event.decoderGeneration || pending.descriptor !== expected) {
      const error = new Error('FLAC decoder descriptor mismatch');
      pending.readiness.reject(error);
      this.#fatal('decoder-descriptor-mismatch', error);
      return;
    }
    this.#pendingGeneration = null;
    pending.readiness.resolve();
  }

  #beginGenerationRetirement(generation: number): void {
    const lifecycle = this.#generationLifecycles.get(generation);
    if (!lifecycle) return;
    beginTrackedRetirement(lifecycle.decoder);
    beginTrackedRetirement(lifecycle.port);
  }

  #releaseGenerationLifecycle(generation: number): boolean {
    const lifecycle = this.#generationLifecycles.get(generation);
    if (
      !lifecycle ||
      lifecycle.decoder.state !== 'retiring' ||
      lifecycle.port.state !== 'retiring'
    ) {
      return false;
    }
    releaseTrackedLifecycle(lifecycle.port);
    releaseTrackedLifecycle(lifecycle.decoder);
    this.#generationLifecycles.delete(generation);
    return true;
  }

  #forceGenerationLifecyclesUnconfirmed(): void {
    for (const lifecycle of this.#generationLifecycles.values()) {
      forceTrackedLifecycleUnconfirmed(lifecycle.port);
      forceTrackedLifecycleUnconfirmed(lifecycle.decoder);
    }
    this.#generationLifecycles.clear();
  }

  #settleWorkerRetirement(confirmed: boolean): void {
    const readiness = this.#workerRetirementReadiness;
    if (!readiness || readiness.settled) return;
    this.#clearWorkerRetirementTimer();
    const exactConfirmation =
      confirmed && !this.#workerFaulted && this.#generationLifecycles.size === 0;
    this.#workerRetirementConfirmed = exactConfirmation;
    if (!exactConfirmation) {
      this.#forceGenerationLifecyclesUnconfirmed();
      if (this.#workerLifecycle) forceTrackedLifecycleUnconfirmed(this.#workerLifecycle);
      if (this.#sourcePortLifecycle) {
        forceTrackedLifecycleUnconfirmed(this.#sourcePortLifecycle);
      }
    } else if (this.#sourcePortLifecycle) {
      releaseTrackedLifecycle(this.#sourcePortLifecycle);
    }
    readiness.resolve();
  }

  #clearWorkerRetirementTimer(): void {
    if (this.#workerRetirementTimer !== null) {
      globalThis.clearTimeout(this.#workerRetirementTimer);
      this.#workerRetirementTimer = null;
    }
    const lifecycle = this.#workerRetirementTimerLifecycle;
    this.#workerRetirementTimerLifecycle = null;
    if (lifecycle) releaseTrackedLifecycle(lifecycle);
  }

  #markWorkerFaulted(): void {
    this.#workerFaulted = true;
    this.#workerRetirementConfirmed = false;
    if (this.#workerLifecycle) forceTrackedLifecycleUnconfirmed(this.#workerLifecycle);
    if (this.#sourcePortLifecycle) forceTrackedLifecycleUnconfirmed(this.#sourcePortLifecycle);
    if (this.#closed) this.#settleWorkerRetirement(false);
  }

  #fatal(code: string, cause?: unknown): void {
    if (
      code === 'decoder-invalid-event' ||
      code === 'decoder-source-closed' ||
      code.endsWith('-mismatch')
    ) {
      this.#markWorkerFaulted();
    }
    if (this.#closed) return;
    const handler = this.#fatalHandler;
    if (!handler) return;
    try {
      handler(safeErrorCode(code, 'decoder-failed'), cause);
    } catch {
      // The adapter remains deterministic even if its owner is already tearing down.
    }
  }

  #notifyGenerationStopped(generation: number, cause: Error): void {
    if (this.#closed) return;
    try {
      this.#generationStoppedHandler?.(generation, cause);
    } catch {
      // Owner teardown may race a terminal decoder notification.
    }
  }
}
