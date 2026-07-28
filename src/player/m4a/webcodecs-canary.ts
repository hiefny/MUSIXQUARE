import { parseCanonicalAacLcAudioSpecificConfig } from '../aac/audio-specific-config.ts';
import { EncodedSourceIntegrityError } from '../sources/encoded-audio-source.ts';

const AAC_LC_CODEC = 'mp4a.40.2' as const;
const AAC_LC_CORE_FRAMES = 1_024;
const M4A_AAC_MAX_RAW_ACCESS_UNIT_BYTES = 8_191;
const MAX_OUTPUT_CALLBACKS = 64;
const FLOAT32_BYTES = 4;

export interface M4aRawAacWebCodecsDecoderConfig {
  readonly codec: typeof AAC_LC_CODEC;
  readonly sampleRate: number;
  readonly numberOfChannels: 1 | 2;
  /** Exact `DecoderSpecificInfo` bytes from the admitted `mp4a` sample entry. */
  readonly description: Uint8Array;
}

export interface M4aRawAacWebCodecsAudioDataCopyOptions {
  readonly format: 'f32-planar';
  readonly planeIndex: number;
  readonly frameOffset: 0;
  readonly frameCount: number;
}

export interface M4aRawAacWebCodecsAudioData {
  readonly timestamp: unknown;
  readonly numberOfChannels: unknown;
  readonly numberOfFrames: unknown;
  readonly sampleRate: unknown;
  allocationSize(options: M4aRawAacWebCodecsAudioDataCopyOptions): unknown;
  copyTo(destination: Uint8Array, options: M4aRawAacWebCodecsAudioDataCopyOptions): void;
  close(): void;
}

export interface M4aRawAacWebCodecsDecoderInit {
  readonly output: (data: M4aRawAacWebCodecsAudioData) => void;
  readonly error: (error: unknown) => void;
}

export interface M4aRawAacWebCodecsEncodedAudioChunkInit {
  readonly type: 'key';
  readonly timestamp: 0;
  /** One raw AAC access unit. An ADTS header is never synthesized here. */
  readonly data: Uint8Array;
}

export interface M4aRawAacWebCodecsDecoder {
  configure(config: M4aRawAacWebCodecsDecoderConfig): void;
  decode(chunk: unknown): void;
  flush(): PromiseLike<void>;
  close(): void;
}

/** The intentionally small browser surface owned by this capability boundary. */
export interface M4aRawAacWebCodecsBindings {
  isConfigSupported(config: M4aRawAacWebCodecsDecoderConfig): PromiseLike<unknown>;
  createDecoder(init: M4aRawAacWebCodecsDecoderInit): M4aRawAacWebCodecsDecoder;
  createEncodedAudioChunk(init: M4aRawAacWebCodecsEncodedAudioChunkInit): unknown;
}

export type M4aRawAacWebCodecsUnavailableStage =
  | 'api'
  | 'support-query'
  | 'unsupported'
  | 'configuration'
  | 'decode'
  | 'flush'
  | 'cleanup';

export interface M4aRawAacWebCodecsCapabilityEvidence {
  readonly codec: typeof AAC_LC_CODEC;
  readonly framing: 'raw-aac';
  readonly coreSampleRateHz: number;
  readonly coreChannelCount: 1 | 2;
  readonly descriptionByteLength: 2 | 5;
  readonly decodedCoreFrames: typeof AAC_LC_CORE_FRAMES;
  readonly outputCount: number;
  readonly timestampPropagationVerified: true;
  readonly f32PlanarCopyVerified: true;
}

/**
 * WebCodecs could not prove this exact raw-AAC configuration. Cancellation is
 * deliberately never wrapped in this error; the exact AbortSignal reason wins.
 */
export class M4aRawAacWebCodecsUnavailableError extends Error {
  readonly stage: M4aRawAacWebCodecsUnavailableStage;

  constructor(stage: M4aRawAacWebCodecsUnavailableStage, message: string, cause?: unknown) {
    super(message);
    this.name = 'M4aRawAacWebCodecsUnavailableError';
    this.stage = stage;
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        value: cause,
      });
    }
  }
}

export class M4aRawAacWebCodecsIntegrityError extends EncodedSourceIntegrityError {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'M4aRawAacWebCodecsIntegrityError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        value: cause,
      });
    }
  }
}

interface BindingSnapshot {
  readonly authority: M4aRawAacWebCodecsBindings;
  readonly isConfigSupported: M4aRawAacWebCodecsBindings['isConfigSupported'];
  readonly createDecoder: M4aRawAacWebCodecsBindings['createDecoder'];
  readonly createEncodedAudioChunk: M4aRawAacWebCodecsBindings['createEncodedAudioChunk'];
}

interface DecoderSnapshot {
  readonly authority: M4aRawAacWebCodecsDecoder;
  readonly configure: M4aRawAacWebCodecsDecoder['configure'];
  readonly decode: M4aRawAacWebCodecsDecoder['decode'];
  readonly flush: M4aRawAacWebCodecsDecoder['flush'];
  readonly close: M4aRawAacWebCodecsDecoder['close'];
}

const Uint8ArrayIntrinsic = Uint8Array;
const arrayBufferIsView = ArrayBuffer.isView;
const typedArrayPrototype = Reflect.getPrototypeOf(Uint8ArrayIntrinsic.prototype) as object | null;
const typedArrayByteLengthGetter = typedArrayPrototype
  ? Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get
  : undefined;
const typedArrayBufferGetter = typedArrayPrototype
  ? Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get
  : undefined;
const typedArrayTagGetter = typedArrayPrototype
  ? Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get
  : undefined;
const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength',
)?.get;
const uint8ArraySet = Uint8ArrayIntrinsic.prototype.set;
const uint8ArrayFill = Uint8ArrayIntrinsic.prototype.fill;
const uint8ArraySlice = Uint8ArrayIntrinsic.prototype.slice;
const float32ArrayFill = Float32Array.prototype.fill;
const trustedAbortThrowIfAborted = AbortSignal.prototype.throwIfAborted;
const trustedAbortAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
const trustedAbortReason = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason')?.get;
const trustedEventTargetAdd = EventTarget.prototype.addEventListener;
const trustedEventTargetRemove = EventTarget.prototype.removeEventListener;

function readAbortReason(signal: AbortSignal): unknown {
  try {
    return trustedAbortReason ? Reflect.apply(trustedAbortReason, signal, []) : undefined;
  } catch (error) {
    return error;
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (typeof trustedAbortThrowIfAborted === 'function') {
    Reflect.apply(trustedAbortThrowIfAborted, signal, []);
    return;
  }
  const aborted = trustedAbortAborted
    ? (Reflect.apply(trustedAbortAborted, signal, []) as unknown)
    : signal.aborted;
  if (aborted !== true) return;
  const reason = readAbortReason(signal);
  throw reason === undefined
    ? new DOMException('The M4A raw AAC WebCodecs probe was aborted', 'AbortError')
    : reason;
}

function addAbortListener(signal: AbortSignal, listener: EventListener): void {
  Reflect.apply(trustedEventTargetAdd, signal, ['abort', listener, { once: true }]);
}

function removeAbortListener(signal: AbortSignal, listener: EventListener): void {
  Reflect.apply(trustedEventTargetRemove, signal, ['abort', listener]);
}

async function raceAbort<T>(task: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort: EventListener = () => {
    const reason = readAbortReason(signal);
    rejectAbort(
      reason === undefined
        ? new DOMException('The M4A raw AAC WebCodecs probe was aborted', 'AbortError')
        : reason,
    );
  };

  addAbortListener(signal, abort);
  try {
    throwIfAborted(signal);
    return await Promise.race([Promise.resolve(task), aborted]);
  } finally {
    removeAbortListener(signal, abort);
  }
}

function snapshotBytes(
  value: unknown,
  label: string,
  minimumBytes: number,
  maximumBytes: number,
): Uint8Array {
  if (
    !typedArrayByteLengthGetter ||
    !typedArrayBufferGetter ||
    !typedArrayTagGetter ||
    !arrayBufferByteLengthGetter ||
    !arrayBufferIsView(value) ||
    typedArrayTagGetter.call(value) !== 'Uint8Array'
  ) {
    throw new M4aRawAacWebCodecsIntegrityError(`${label} must be a Uint8Array`);
  }

  let byteLength: number;
  try {
    byteLength = typedArrayByteLengthGetter.call(value);
    const buffer = typedArrayBufferGetter.call(value);
    // Reject SharedArrayBuffer and detached/non-readable ArrayBuffer storage.
    arrayBufferByteLengthGetter.call(buffer);
  } catch (cause) {
    throw new M4aRawAacWebCodecsIntegrityError(
      `${label} must use readable, non-shared storage`,
      cause,
    );
  }
  if (byteLength < minimumBytes || byteLength > maximumBytes) {
    throw new M4aRawAacWebCodecsIntegrityError(
      `${label} must contain from ${minimumBytes} through ${maximumBytes} bytes`,
    );
  }

  const owned = new Uint8ArrayIntrinsic(byteLength);
  try {
    Reflect.apply(uint8ArraySet, owned, [value, 0]);
  } catch (cause) {
    throw new M4aRawAacWebCodecsIntegrityError(`${label} could not be copied`, cause);
  }
  return owned;
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return Reflect.apply(uint8ArraySlice, bytes, [0]) as Uint8Array;
}

function clearBytes(bytes: Uint8Array | null, label: string): unknown | null {
  if (!bytes) return null;
  try {
    Reflect.apply(uint8ArrayFill, bytes, [0]);
    return null;
  } catch (cause) {
    return new M4aRawAacWebCodecsUnavailableError(
      'cleanup',
      `${label} could not be cleared`,
      cause,
    );
  }
}

function snapshotBindings(value: unknown): BindingSnapshot {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    throw new TypeError('M4A raw AAC WebCodecs bindings are required');
  }
  const authority = value as M4aRawAacWebCodecsBindings;
  let isConfigSupported: M4aRawAacWebCodecsBindings['isConfigSupported'];
  let createDecoder: M4aRawAacWebCodecsBindings['createDecoder'];
  let createEncodedAudioChunk: M4aRawAacWebCodecsBindings['createEncodedAudioChunk'];
  try {
    isConfigSupported = authority.isConfigSupported;
    createDecoder = authority.createDecoder;
    createEncodedAudioChunk = authority.createEncodedAudioChunk;
  } catch (cause) {
    throw new TypeError('M4A raw AAC WebCodecs bindings could not be inspected', { cause });
  }
  if (
    typeof isConfigSupported !== 'function' ||
    typeof createDecoder !== 'function' ||
    typeof createEncodedAudioChunk !== 'function'
  ) {
    throw new TypeError('M4A raw AAC WebCodecs bindings are incomplete');
  }
  return Object.freeze({
    authority,
    isConfigSupported,
    createDecoder,
    createEncodedAudioChunk,
  });
}

function snapshotDecoder(value: unknown): DecoderSnapshot {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('M4A raw AAC WebCodecs decoder binding is invalid');
  }
  const authority = value as M4aRawAacWebCodecsDecoder;
  let configure: M4aRawAacWebCodecsDecoder['configure'];
  let decode: M4aRawAacWebCodecsDecoder['decode'];
  let flush: M4aRawAacWebCodecsDecoder['flush'];
  let close: M4aRawAacWebCodecsDecoder['close'];
  try {
    configure = authority.configure;
    decode = authority.decode;
    flush = authority.flush;
    close = authority.close;
  } catch (cause) {
    throw new TypeError('M4A raw AAC WebCodecs decoder could not be inspected', { cause });
  }
  if (
    typeof configure !== 'function' ||
    typeof decode !== 'function' ||
    typeof flush !== 'function' ||
    typeof close !== 'function'
  ) {
    throw new TypeError('M4A raw AAC WebCodecs decoder binding is incomplete');
  }
  return Object.freeze({ authority, configure, decode, flush, close });
}

function defaultBindings(): M4aRawAacWebCodecsBindings {
  const decoderConstructor = globalThis.AudioDecoder;
  const chunkConstructor = globalThis.EncodedAudioChunk;
  if (
    typeof decoderConstructor !== 'function' ||
    typeof decoderConstructor.isConfigSupported !== 'function' ||
    typeof chunkConstructor !== 'function'
  ) {
    throw new M4aRawAacWebCodecsUnavailableError('api', 'WebCodecs audio decoding is unavailable');
  }

  return Object.freeze({
    isConfigSupported(config: M4aRawAacWebCodecsDecoderConfig): PromiseLike<unknown> {
      return Reflect.apply(decoderConstructor.isConfigSupported, decoderConstructor, [config]);
    },
    createDecoder(init: M4aRawAacWebCodecsDecoderInit): M4aRawAacWebCodecsDecoder {
      return new decoderConstructor({
        output: init.output as AudioDataOutputCallback,
        error: init.error,
      }) as unknown as M4aRawAacWebCodecsDecoder;
    },
    createEncodedAudioChunk(init: M4aRawAacWebCodecsEncodedAudioChunkInit): unknown {
      return new chunkConstructor(init);
    },
  });
}

function isObjectIdentity(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function readPositiveSafeInteger(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value <= 0
  ) {
    throw new M4aRawAacWebCodecsIntegrityError(`${label} must be a positive safe integer`);
  }
  return value;
}

function readSupported(value: unknown): boolean {
  if (!isObjectIdentity(value)) {
    throw new M4aRawAacWebCodecsUnavailableError(
      'support-query',
      'WebCodecs returned an invalid raw AAC support result',
    );
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, 'supported');
  } catch (cause) {
    throw new M4aRawAacWebCodecsUnavailableError(
      'support-query',
      'WebCodecs raw AAC support result could not be inspected',
      cause,
    );
  }
  if (
    !descriptor ||
    descriptor.enumerable !== true ||
    !Object.hasOwn(descriptor, 'value') ||
    typeof descriptor.value !== 'boolean'
  ) {
    throw new M4aRawAacWebCodecsUnavailableError(
      'support-query',
      'WebCodecs raw AAC support result must expose an own boolean data field',
    );
  }
  return descriptor.value;
}

function unavailable(
  stage: M4aRawAacWebCodecsUnavailableStage,
  message: string,
  cause: unknown,
): M4aRawAacWebCodecsUnavailableError {
  return cause instanceof M4aRawAacWebCodecsUnavailableError
    ? cause
    : new M4aRawAacWebCodecsUnavailableError(stage, message, cause);
}

/**
 * Prove that this browser can decode one bounded raw AAC-LC access unit using
 * the exact M4A `AudioSpecificConfig`. This canary never creates ADTS framing,
 * never routes product playback, and discards all encoded/decoded scratch data.
 */
export async function probeM4aRawAacWebCodecsAccessUnit(
  accessUnit: Uint8Array,
  audioSpecificConfig: Uint8Array,
  signal: AbortSignal,
  injectedBindings?: M4aRawAacWebCodecsBindings,
): Promise<Readonly<M4aRawAacWebCodecsCapabilityEvidence>> {
  if (!(signal instanceof AbortSignal)) {
    throw new TypeError('M4A raw AAC WebCodecs probe requires an exact AbortSignal');
  }
  throwIfAborted(signal);

  let retainedAccessUnit: Uint8Array | null = snapshotBytes(
    accessUnit,
    'M4A raw AAC WebCodecs access unit',
    1,
    M4A_AAC_MAX_RAW_ACCESS_UNIT_BYTES,
  );
  const retainedDescription = (() => {
    try {
      return snapshotBytes(audioSpecificConfig, 'M4A raw AAC WebCodecs AudioSpecificConfig', 2, 5);
    } catch (cause) {
      void clearBytes(retainedAccessUnit, 'M4A raw AAC access-unit copy');
      throw cause;
    }
  })();
  let parsed: ReturnType<typeof parseCanonicalAacLcAudioSpecificConfig>;
  try {
    parsed = parseCanonicalAacLcAudioSpecificConfig(retainedDescription);
  } catch (cause) {
    void clearBytes(retainedAccessUnit, 'M4A raw AAC access-unit copy');
    void clearBytes(retainedDescription, 'M4A raw AAC AudioSpecificConfig copy');
    throw new M4aRawAacWebCodecsIntegrityError(
      'M4A raw AAC WebCodecs AudioSpecificConfig is not canonical AAC-LC',
      cause,
    );
  }
  const descriptionByteLength = retainedDescription.byteLength as 2 | 5;

  let supportDescription: Uint8Array | null = null;
  let decoderDescription: Uint8Array | null = null;
  let createdDecoder: unknown = null;
  let decoder: DecoderSnapshot | null = null;
  let acceptingOutput = true;
  let decodeSubmitted = false;
  let processingOutput = false;
  let outputCount = 0;
  let decodedFrames = 0;
  let terminalFailure: unknown;
  let hasTerminalFailure = false;
  let resolveFailure!: (cause: unknown) => void;
  const failureNotice = new Promise<unknown>((resolve) => {
    resolveFailure = resolve;
  });
  const closedOutputs = new WeakSet<object>();

  const recordFailure = (cause: unknown): void => {
    if (hasTerminalFailure) return;
    hasTerminalFailure = true;
    terminalFailure = cause;
    acceptingOutput = false;
    resolveFailure(cause);
  };

  const closeOutputOnce = (output: unknown): unknown | null => {
    if (!isObjectIdentity(output)) {
      return new M4aRawAacWebCodecsIntegrityError('WebCodecs emitted non-object AudioData');
    }
    if (closedOutputs.has(output)) return null;
    closedOutputs.add(output);
    try {
      const close = (output as M4aRawAacWebCodecsAudioData).close;
      if (typeof close !== 'function') throw new TypeError('AudioData close is unavailable');
      Reflect.apply(close, output, []);
      return null;
    } catch (cause) {
      return unavailable('cleanup', 'WebCodecs AudioData could not be closed', cause);
    }
  };

  const output = (data: M4aRawAacWebCodecsAudioData): void => {
    if (!isObjectIdentity(data)) {
      recordFailure(new M4aRawAacWebCodecsIntegrityError('WebCodecs emitted invalid AudioData'));
      return;
    }
    if (closedOutputs.has(data)) {
      if (acceptingOutput) {
        recordFailure(
          new M4aRawAacWebCodecsIntegrityError('WebCodecs emitted the same AudioData twice'),
        );
      }
      return;
    }
    if (!acceptingOutput) {
      closeOutputOnce(data);
      return;
    }
    if (!decodeSubmitted) {
      const closeFailure = closeOutputOnce(data);
      recordFailure(
        closeFailure ??
          new M4aRawAacWebCodecsIntegrityError(
            'WebCodecs emitted AudioData before the raw AAC access unit was submitted',
          ),
      );
      return;
    }
    if (processingOutput) {
      recordFailure(
        new M4aRawAacWebCodecsIntegrityError('WebCodecs re-entered its AudioData callback'),
      );
      closeOutputOnce(data);
      return;
    }

    processingOutput = true;
    let outputFailure: unknown;
    let nextOutputCount = outputCount;
    let nextDecodedFrames = decodedFrames;
    try {
      throwIfAborted(signal);
      nextOutputCount += 1;
      if (nextOutputCount > MAX_OUTPUT_CALLBACKS) {
        throw new M4aRawAacWebCodecsIntegrityError(
          'WebCodecs split one raw AAC access unit into too many outputs',
        );
      }

      const timestamp = data.timestamp;
      if (typeof timestamp !== 'number' || !Object.is(timestamp, 0)) {
        throw new M4aRawAacWebCodecsIntegrityError(
          'WebCodecs did not preserve the raw AAC chunk timestamp',
        );
      }
      const numberOfChannels = readPositiveSafeInteger(
        data.numberOfChannels,
        'WebCodecs output channel count',
      );
      const numberOfFrames = readPositiveSafeInteger(
        data.numberOfFrames,
        'WebCodecs output frame count',
      );
      const sampleRate = readPositiveSafeInteger(data.sampleRate, 'WebCodecs output sample rate');
      if (numberOfChannels !== parsed.channelCount) {
        throw new M4aRawAacWebCodecsIntegrityError(
          'WebCodecs output channel count differs from the M4A AAC core',
        );
      }
      if (sampleRate !== parsed.sampleRateHz) {
        throw new M4aRawAacWebCodecsIntegrityError(
          'WebCodecs output sample rate differs from the M4A AAC core',
        );
      }
      if (numberOfFrames > AAC_LC_CORE_FRAMES) {
        throw new M4aRawAacWebCodecsIntegrityError(
          'WebCodecs output exceeds one AAC-LC core access unit',
        );
      }
      nextDecodedFrames += numberOfFrames;
      if (nextDecodedFrames > AAC_LC_CORE_FRAMES) {
        throw new M4aRawAacWebCodecsIntegrityError(
          'WebCodecs output exceeds 1024 AAC-LC core frames',
        );
      }

      const expectedPlaneBytes = numberOfFrames * FLOAT32_BYTES;
      for (let planeIndex = 0; planeIndex < numberOfChannels; planeIndex += 1) {
        const copyOptions = Object.freeze({
          format: 'f32-planar' as const,
          planeIndex,
          frameOffset: 0 as const,
          frameCount: numberOfFrames,
        });
        const allocationBytes = Reflect.apply(data.allocationSize, data, [copyOptions]) as unknown;
        if (allocationBytes !== expectedPlaneBytes) {
          throw new M4aRawAacWebCodecsIntegrityError(
            'WebCodecs reported an invalid f32-planar allocation size',
          );
        }
        const scratch = new Uint8ArrayIntrinsic(expectedPlaneBytes);
        try {
          const samples = new Float32Array(scratch.buffer, scratch.byteOffset, numberOfFrames);
          // A no-op or partial `copyTo()` must not masquerade as valid silence.
          Reflect.apply(float32ArrayFill, samples, [Number.NaN]);
          Reflect.apply(data.copyTo, data, [scratch, copyOptions]);
          for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
            if (!Number.isFinite(samples[sampleIndex])) {
              throw new M4aRawAacWebCodecsIntegrityError(
                'WebCodecs emitted non-finite f32-planar PCM',
              );
            }
          }
        } finally {
          Reflect.apply(uint8ArrayFill, scratch, [0]);
        }
        throwIfAborted(signal);
      }
    } catch (cause) {
      try {
        throwIfAborted(signal);
        outputFailure =
          cause instanceof M4aRawAacWebCodecsIntegrityError
            ? cause
            : unavailable('decode', 'WebCodecs could not prove bounded f32-planar output', cause);
      } catch (abortCause) {
        outputFailure = abortCause;
      }
    } finally {
      const closeFailure = closeOutputOnce(data);
      if (outputFailure === undefined && closeFailure !== null) outputFailure = closeFailure;
      processingOutput = false;
    }

    if (hasTerminalFailure && outputFailure === undefined) return;
    if (outputFailure !== undefined) {
      recordFailure(outputFailure);
      return;
    }
    outputCount = nextOutputCount;
    decodedFrames = nextDecodedFrames;
  };

  let evidence: Readonly<M4aRawAacWebCodecsCapabilityEvidence> | null = null;
  let operationFailure: unknown;
  let cleanupFailure: unknown;
  const recordCleanupFailure = (cause: unknown | null): void => {
    if (cause !== null && cleanupFailure === undefined) cleanupFailure = cause;
  };
  try {
    const bindings = snapshotBindings(injectedBindings ?? defaultBindings());
    throwIfAborted(signal);
    supportDescription = copyBytes(retainedDescription);
    const supportConfig = Object.freeze({
      codec: AAC_LC_CODEC,
      sampleRate: parsed.sampleRateHz,
      numberOfChannels: parsed.channelCount,
      description: supportDescription,
    });

    let support: unknown;
    try {
      const task = Reflect.apply(bindings.isConfigSupported, bindings.authority, [supportConfig]);
      support = await raceAbort(task, signal);
    } catch (cause) {
      throwIfAborted(signal);
      throw unavailable('support-query', 'WebCodecs raw AAC-LC support probing failed', cause);
    } finally {
      const completedSupportDescription = supportDescription;
      supportDescription = null;
      recordCleanupFailure(
        clearBytes(completedSupportDescription, 'WebCodecs support-query AudioSpecificConfig'),
      );
    }
    if (cleanupFailure !== undefined) throw cleanupFailure;
    if (!readSupported(support)) {
      throw new M4aRawAacWebCodecsUnavailableError(
        'unsupported',
        'WebCodecs does not support raw AAC-LC with this AudioSpecificConfig',
      );
    }
    throwIfAborted(signal);

    try {
      createdDecoder = Reflect.apply(bindings.createDecoder, bindings.authority, [
        Object.freeze({
          output,
          error(error: unknown): void {
            if (!acceptingOutput) return;
            recordFailure(
              unavailable('decode', 'WebCodecs raw AAC decoder reported an error', error),
            );
          },
        }),
      ]);
      decoder = snapshotDecoder(createdDecoder);
      throwIfAborted(signal);
      if (hasTerminalFailure) throw terminalFailure;

      decoderDescription = copyBytes(retainedDescription);
      const decodeConfig = Object.freeze({
        codec: AAC_LC_CODEC,
        sampleRate: parsed.sampleRateHz,
        numberOfChannels: parsed.channelCount,
        description: decoderDescription,
      });
      Reflect.apply(decoder.configure, decoder.authority, [decodeConfig]);
      throwIfAborted(signal);
      if (hasTerminalFailure) throw terminalFailure;
    } catch (cause) {
      throwIfAborted(signal);
      if (hasTerminalFailure) throw terminalFailure;
      throw unavailable('configuration', 'WebCodecs rejected the raw AAC-LC configuration', cause);
    }

    try {
      const chunkInit = Object.freeze({
        type: 'key' as const,
        timestamp: 0 as const,
        data: retainedAccessUnit,
      });
      const chunk = Reflect.apply(bindings.createEncodedAudioChunk, bindings.authority, [
        chunkInit,
      ]);
      throwIfAborted(signal);
      if (hasTerminalFailure) throw terminalFailure;
      // EncodedAudioChunk construction synchronously copies its BufferSource.
      const submittedAccessUnit = retainedAccessUnit;
      retainedAccessUnit = null;
      const submittedClearFailure = clearBytes(
        submittedAccessUnit,
        'WebCodecs submitted raw AAC access-unit copy',
      );
      recordCleanupFailure(submittedClearFailure);
      if (submittedClearFailure !== null) throw submittedClearFailure;
      decodeSubmitted = true;
      Reflect.apply(decoder.decode, decoder.authority, [chunk]);
      throwIfAborted(signal);
      if (hasTerminalFailure) throw terminalFailure;
    } catch (cause) {
      throwIfAborted(signal);
      if (hasTerminalFailure) throw terminalFailure;
      if (cause instanceof M4aRawAacWebCodecsIntegrityError) throw cause;
      throw unavailable('decode', 'WebCodecs rejected the raw AAC-LC access unit', cause);
    }

    let flushTask: PromiseLike<void>;
    try {
      flushTask = Reflect.apply(decoder.flush, decoder.authority, []) as PromiseLike<void>;
      throwIfAborted(signal);
      if (hasTerminalFailure) throw terminalFailure;
    } catch (cause) {
      throwIfAborted(signal);
      if (hasTerminalFailure) throw terminalFailure;
      throw unavailable('flush', 'WebCodecs raw AAC decoder flush could not start', cause);
    }
    const flushOrFailure = Promise.race([
      Promise.resolve(flushTask).then(() => Object.freeze({ kind: 'flush' as const })),
      failureNotice.then((cause) => Object.freeze({ kind: 'failure' as const, cause })),
    ]);
    let completion: Awaited<typeof flushOrFailure>;
    try {
      completion = await raceAbort(flushOrFailure, signal);
    } catch (cause) {
      throwIfAborted(signal);
      if (hasTerminalFailure) throw terminalFailure;
      throw unavailable('flush', 'WebCodecs raw AAC decoder flush failed', cause);
    }
    if (completion.kind === 'failure') throw completion.cause;
    if (hasTerminalFailure) throw terminalFailure;
    throwIfAborted(signal);
    if (decodedFrames !== AAC_LC_CORE_FRAMES || outputCount < 1) {
      throw new M4aRawAacWebCodecsIntegrityError(
        'WebCodecs did not emit exactly 1024 AAC-LC core frames',
      );
    }

    evidence = Object.freeze({
      codec: AAC_LC_CODEC,
      framing: 'raw-aac' as const,
      coreSampleRateHz: parsed.sampleRateHz,
      coreChannelCount: parsed.channelCount,
      descriptionByteLength,
      decodedCoreFrames: AAC_LC_CORE_FRAMES,
      outputCount,
      timestampPropagationVerified: true as const,
      f32PlanarCopyVerified: true as const,
    });
  } catch (cause) {
    operationFailure = cause;
  } finally {
    acceptingOutput = false;
    const finalAccessUnit = retainedAccessUnit;
    const finalDescription = retainedDescription;
    const finalSupportDescription = supportDescription;
    const finalDecoderDescription = decoderDescription;
    recordCleanupFailure(clearBytes(finalAccessUnit, 'M4A raw AAC access-unit copy'));
    recordCleanupFailure(clearBytes(finalDescription, 'M4A raw AAC AudioSpecificConfig copy'));
    recordCleanupFailure(
      clearBytes(finalSupportDescription, 'WebCodecs support-query AudioSpecificConfig'),
    );
    recordCleanupFailure(
      clearBytes(finalDecoderDescription, 'WebCodecs decoder AudioSpecificConfig'),
    );
    if (decoder) {
      try {
        Reflect.apply(decoder.close, decoder.authority, []);
      } catch (cause) {
        recordCleanupFailure(
          unavailable('cleanup', 'WebCodecs raw AAC decoder could not be closed', cause),
        );
      }
    } else if (isObjectIdentity(createdDecoder)) {
      // A malformed injected decoder may fail method snapshotting after native
      // construction. Best-effort close it without replacing the primary error.
      try {
        const close = Reflect.get(createdDecoder, 'close') as unknown;
        if (typeof close === 'function') Reflect.apply(close, createdDecoder, []);
      } catch {
        // The configuration/snapshot failure remains the actionable boundary.
      }
    }
    if (operationFailure === undefined && cleanupFailure !== undefined) {
      operationFailure = cleanupFailure;
    }
  }

  try {
    throwIfAborted(signal);
  } catch (abortCause) {
    operationFailure = abortCause;
  }
  if (operationFailure !== undefined) throw operationFailure;
  if (!evidence) {
    throw new M4aRawAacWebCodecsUnavailableError(
      'decode',
      'WebCodecs raw AAC capability evidence is unavailable',
    );
  }
  return evidence;
}
