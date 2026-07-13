import { EncodedSourceIntegrityError } from '../sources/encoded-audio-source.ts';
import { parseAdtsHeader, type AdtsHeader } from './adts-header.ts';

const AAC_LC_CODEC = 'mp4a.40.2' as const;
const AAC_LC_CORE_FRAMES = 1_024;
const ADTS_MAX_FRAME_BYTES = 8_191;
const MAX_OUTPUT_CALLBACKS = 64;
const FLOAT32_BYTES = 4;

export interface AacWebCodecsDecoderConfig {
  readonly codec: typeof AAC_LC_CODEC;
  readonly sampleRate: number;
  readonly numberOfChannels: 1 | 2;
}

export interface AacWebCodecsAudioDataCopyOptions {
  readonly format: 'f32-planar';
  readonly planeIndex: number;
  readonly frameOffset: 0;
  readonly frameCount: number;
}

export interface AacWebCodecsAudioData {
  readonly numberOfChannels: unknown;
  readonly numberOfFrames: unknown;
  readonly sampleRate: unknown;
  allocationSize(options: AacWebCodecsAudioDataCopyOptions): unknown;
  copyTo(destination: Uint8Array, options: AacWebCodecsAudioDataCopyOptions): void;
  close(): void;
}

export interface AacWebCodecsDecoderInit {
  readonly output: (data: AacWebCodecsAudioData) => void;
  readonly error: (error: unknown) => void;
}

export interface AacWebCodecsEncodedAudioChunkInit {
  readonly type: 'key';
  readonly timestamp: 0;
  readonly data: Uint8Array;
}

export interface AacWebCodecsDecoder {
  configure(config: AacWebCodecsDecoderConfig): void;
  decode(chunk: unknown): void;
  flush(): PromiseLike<void>;
  close(): void;
}

/** The intentionally small browser surface owned by this capability boundary. */
export interface AacWebCodecsBindings {
  isConfigSupported(config: AacWebCodecsDecoderConfig): PromiseLike<unknown>;
  createDecoder(init: AacWebCodecsDecoderInit): AacWebCodecsDecoder;
  createEncodedAudioChunk(init: AacWebCodecsEncodedAudioChunkInit): unknown;
}

export interface AacWebCodecsCapabilityEvidence {
  readonly codec: typeof AAC_LC_CODEC;
  readonly framing: 'adts';
  readonly coreSampleRateHz: number;
  readonly coreChannelCount: 1 | 2;
  readonly decodedCoreFrames: typeof AAC_LC_CORE_FRAMES;
  readonly outputCount: number;
  readonly f32PlanarCopyVerified: true;
}

export class AacWebCodecsUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'AacWebCodecsUnavailableError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        value: cause,
      });
    }
  }
}

export class AacWebCodecsIntegrityError extends EncodedSourceIntegrityError {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'AacWebCodecsIntegrityError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        value: cause,
      });
    }
  }
}

interface BindingSnapshot {
  readonly authority: AacWebCodecsBindings;
  readonly isConfigSupported: AacWebCodecsBindings['isConfigSupported'];
  readonly createDecoder: AacWebCodecsBindings['createDecoder'];
  readonly createEncodedAudioChunk: AacWebCodecsBindings['createEncodedAudioChunk'];
}

interface VerifiedFrame {
  readonly bytes: Uint8Array;
  readonly header: Readonly<AdtsHeader>;
  readonly coreChannelCount: 1 | 2;
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
const uint8ArraySubarray = Uint8ArrayIntrinsic.prototype.subarray;
const trustedAbortThrowIfAborted = AbortSignal.prototype.throwIfAborted;
const trustedAbortAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
const trustedAbortReason = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason')?.get;
const trustedEventTargetAdd = EventTarget.prototype.addEventListener;
const trustedEventTargetRemove = EventTarget.prototype.removeEventListener;

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
    ? new DOMException('The AAC WebCodecs capability probe was aborted', 'AbortError')
    : reason;
}

function readAbortReason(signal: AbortSignal): unknown {
  try {
    return trustedAbortReason ? Reflect.apply(trustedAbortReason, signal, []) : undefined;
  } catch (error) {
    return error;
  }
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
        ? new DOMException('The AAC WebCodecs capability probe was aborted', 'AbortError')
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

function snapshotFrame(value: unknown): Uint8Array {
  if (
    !typedArrayByteLengthGetter ||
    !typedArrayBufferGetter ||
    !typedArrayTagGetter ||
    !arrayBufferByteLengthGetter ||
    !arrayBufferIsView(value) ||
    typedArrayTagGetter.call(value) !== 'Uint8Array'
  ) {
    throw new AacWebCodecsIntegrityError('AAC WebCodecs canary frame must be a Uint8Array');
  }

  let byteLength: number;
  try {
    byteLength = typedArrayByteLengthGetter.call(value);
    const buffer = typedArrayBufferGetter.call(value);
    // This intrinsic throws for SharedArrayBuffer and detached/non-readable buffers.
    arrayBufferByteLengthGetter.call(buffer);
  } catch (cause) {
    throw new AacWebCodecsIntegrityError(
      'AAC WebCodecs canary frame must use readable, non-shared storage',
      cause,
    );
  }
  if (byteLength < 8 || byteLength > ADTS_MAX_FRAME_BYTES) {
    throw new AacWebCodecsIntegrityError('AAC WebCodecs canary frame has an invalid ADTS size');
  }

  const owned = new Uint8ArrayIntrinsic(byteLength);
  try {
    Reflect.apply(uint8ArraySet, owned, [value, 0]);
  } catch (cause) {
    throw new AacWebCodecsIntegrityError('AAC WebCodecs canary frame could not be copied', cause);
  }
  return owned;
}

function verifyFrame(value: unknown): VerifiedFrame {
  const bytes = snapshotFrame(value);
  try {
    const protectionAbsent = ((bytes[1] ?? 0) & 1) === 1;
    const headerBytes = protectionAbsent ? 7 : 9;
    const headerView = Reflect.apply(uint8ArraySubarray, bytes, [0, headerBytes]) as Uint8Array;
    const header = parseAdtsHeader(headerView);

    if (bytes.byteLength !== header.frameLengthBytes) {
      throw new AacWebCodecsIntegrityError(
        'AAC WebCodecs canary frame length contradicts its ADTS header',
      );
    }
    if (
      header.mpegId !== 0 ||
      header.mpegVersion !== 'MPEG-4' ||
      header.profile !== 1 ||
      header.coreAudioObjectType !== 2 ||
      header.profileName !== 'low-complexity' ||
      !header.protectionAbsent ||
      header.hasCrc ||
      header.rawDataBlocks !== 1
    ) {
      throw new AacWebCodecsIntegrityError(
        'AAC WebCodecs canary requires MPEG-4 AAC-LC, no CRC, and one raw_data_block',
      );
    }
    if (
      (header.channelConfiguration !== 1 && header.channelConfiguration !== 2) ||
      (header.coreChannelCount !== 1 && header.coreChannelCount !== 2) ||
      header.channelConfiguration !== header.coreChannelCount
    ) {
      throw new AacWebCodecsIntegrityError(
        'AAC WebCodecs canary requires exact mono or stereo core geometry',
      );
    }

    return Object.freeze({
      bytes,
      header,
      coreChannelCount: header.coreChannelCount,
    });
  } catch (cause) {
    Reflect.apply(uint8ArrayFill, bytes, [0]);
    if (cause instanceof AacWebCodecsIntegrityError) throw cause;
    throw new AacWebCodecsIntegrityError(
      'AAC WebCodecs canary frame failed defensive ADTS verification',
      cause,
    );
  }
}

function snapshotBindings(value: unknown): BindingSnapshot {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    throw new TypeError('AAC WebCodecs bindings are required');
  }
  const authority = value as AacWebCodecsBindings;
  let isConfigSupported: AacWebCodecsBindings['isConfigSupported'];
  let createDecoder: AacWebCodecsBindings['createDecoder'];
  let createEncodedAudioChunk: AacWebCodecsBindings['createEncodedAudioChunk'];
  try {
    isConfigSupported = authority.isConfigSupported;
    createDecoder = authority.createDecoder;
    createEncodedAudioChunk = authority.createEncodedAudioChunk;
  } catch (cause) {
    throw new TypeError('AAC WebCodecs bindings could not be inspected', { cause });
  }
  if (
    typeof isConfigSupported !== 'function' ||
    typeof createDecoder !== 'function' ||
    typeof createEncodedAudioChunk !== 'function'
  ) {
    throw new TypeError('AAC WebCodecs bindings are incomplete');
  }
  return Object.freeze({
    authority,
    isConfigSupported,
    createDecoder,
    createEncodedAudioChunk,
  });
}

function defaultBindings(): AacWebCodecsBindings {
  const decoderConstructor = globalThis.AudioDecoder;
  const chunkConstructor = globalThis.EncodedAudioChunk;
  if (
    typeof decoderConstructor !== 'function' ||
    typeof decoderConstructor.isConfigSupported !== 'function' ||
    typeof chunkConstructor !== 'function'
  ) {
    throw new AacWebCodecsUnavailableError('WebCodecs audio decoding is unavailable');
  }

  return Object.freeze({
    isConfigSupported(config: AacWebCodecsDecoderConfig): PromiseLike<unknown> {
      return Reflect.apply(decoderConstructor.isConfigSupported, decoderConstructor, [config]);
    },
    createDecoder(init: AacWebCodecsDecoderInit): AacWebCodecsDecoder {
      return new decoderConstructor({
        output: init.output as AudioDataOutputCallback,
        error: init.error,
      }) as unknown as AacWebCodecsDecoder;
    },
    createEncodedAudioChunk(init: AacWebCodecsEncodedAudioChunkInit): unknown {
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
    throw new AacWebCodecsIntegrityError(`${label} must be a positive safe integer`);
  }
  return value;
}

function asUnavailable(message: string, cause: unknown): AacWebCodecsUnavailableError {
  return cause instanceof AacWebCodecsUnavailableError
    ? cause
    : new AacWebCodecsUnavailableError(message, cause);
}

/**
 * Prove that this browser can decode one scanner-verified ADTS AAC-LC frame
 * through the exact bounded WebCodecs surface needed by the streaming engine.
 *
 * This is a capability canary, not a PCM decoder. It deliberately discards all
 * copied PCM and encoded bytes before returning immutable scalar evidence. It
 * proves the selected output's core geometry; it does not parse raw_data_block
 * payloads and therefore cannot prove that an input lacks SBR/PS when a decoder
 * silently ignores those extensions. Strict stream admission remains a separate
 * canonical-decoder or payload-validation responsibility.
 */
export async function probeAacWebCodecsAdtsFrame(
  frame: Uint8Array,
  signal: AbortSignal,
  injectedBindings?: AacWebCodecsBindings,
): Promise<Readonly<AacWebCodecsCapabilityEvidence>> {
  if (!(signal instanceof AbortSignal)) {
    throw new TypeError('AAC WebCodecs capability probe requires an exact AbortSignal');
  }
  throwIfAborted(signal);

  const verified = verifyFrame(frame);
  let retainedFrame: Uint8Array | null = verified.bytes;
  let decoder: AacWebCodecsDecoder | null = null;
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
      return new AacWebCodecsIntegrityError('WebCodecs emitted a non-object AudioData value');
    }
    if (closedOutputs.has(output)) return null;
    closedOutputs.add(output);
    try {
      const close = (output as AacWebCodecsAudioData).close;
      if (typeof close !== 'function') {
        throw new TypeError('AudioData close is unavailable');
      }
      Reflect.apply(close, output, []);
      return null;
    } catch (cause) {
      return asUnavailable('WebCodecs AudioData could not be closed', cause);
    }
  };

  const output = (data: AacWebCodecsAudioData): void => {
    if (!isObjectIdentity(data)) {
      recordFailure(new AacWebCodecsIntegrityError('WebCodecs emitted invalid AudioData'));
      return;
    }
    if (closedOutputs.has(data)) {
      if (acceptingOutput) {
        recordFailure(new AacWebCodecsIntegrityError('WebCodecs emitted the same AudioData twice'));
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
          new AacWebCodecsIntegrityError(
            'WebCodecs emitted AudioData before the verified AAC frame was submitted',
          ),
      );
      return;
    }
    if (processingOutput) {
      recordFailure(
        new AacWebCodecsIntegrityError('WebCodecs re-entered the AudioData output callback'),
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
        throw new AacWebCodecsIntegrityError('WebCodecs split one AAC frame into too many outputs');
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
      if (numberOfChannels !== verified.coreChannelCount) {
        throw new AacWebCodecsIntegrityError(
          'WebCodecs output channel count differs from the AAC core (channel expansion is rejected)',
        );
      }
      if (sampleRate !== verified.header.coreSampleRateHz) {
        throw new AacWebCodecsIntegrityError(
          'WebCodecs output rate differs from the AAC core (rate expansion is rejected)',
        );
      }
      if (numberOfFrames > AAC_LC_CORE_FRAMES) {
        throw new AacWebCodecsIntegrityError(
          'WebCodecs output exceeds one AAC-LC core frame (frame expansion is rejected)',
        );
      }
      nextDecodedFrames += numberOfFrames;
      if (nextDecodedFrames > AAC_LC_CORE_FRAMES) {
        throw new AacWebCodecsIntegrityError('WebCodecs output exceeds 1024 AAC-LC core frames');
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
          throw new AacWebCodecsIntegrityError(
            'WebCodecs reported an invalid f32-planar allocation size',
          );
        }
        // Geometry is fully bounded and checked before this allocation.
        const scratch = new Uint8ArrayIntrinsic(expectedPlaneBytes);
        Reflect.apply(data.copyTo, data, [scratch, copyOptions]);
        const samples = new Float32Array(scratch.buffer, scratch.byteOffset, numberOfFrames);
        for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
          if (!Number.isFinite(samples[sampleIndex])) {
            throw new AacWebCodecsIntegrityError('WebCodecs emitted non-finite f32-planar PCM');
          }
        }
        throwIfAborted(signal);
      }
    } catch (cause) {
      try {
        throwIfAborted(signal);
        outputFailure =
          cause instanceof AacWebCodecsIntegrityError
            ? cause
            : asUnavailable('WebCodecs could not prove bounded f32-planar output', cause);
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

  let evidence: Readonly<AacWebCodecsCapabilityEvidence> | null = null;
  let operationFailure: unknown;
  try {
    const bindings = snapshotBindings(injectedBindings ?? defaultBindings());
    // ADTS decoding ignores these geometry hints, but WebCodecs requires the
    // members. Keeping them equal to the verified core also makes any injected
    // description (AudioSpecificConfig) structurally impossible here.
    const config = Object.freeze({
      codec: AAC_LC_CODEC,
      sampleRate: verified.header.coreSampleRateHz,
      numberOfChannels: verified.coreChannelCount,
    });

    let support: unknown;
    try {
      const task = Reflect.apply(bindings.isConfigSupported, bindings.authority, [config]);
      support = await raceAbort(task, signal);
    } catch (cause) {
      throwIfAborted(signal);
      throw asUnavailable('WebCodecs AAC-LC support probing failed', cause);
    }
    if ((typeof support !== 'object' && typeof support !== 'function') || support === null) {
      throw new AacWebCodecsUnavailableError('WebCodecs returned an invalid AAC support result');
    }
    let supported: unknown;
    try {
      supported = Reflect.get(support, 'supported');
    } catch (cause) {
      throw asUnavailable('WebCodecs AAC support result could not be inspected', cause);
    }
    if (supported !== true) {
      throw new AacWebCodecsUnavailableError('WebCodecs does not support ADTS AAC-LC decoding');
    }
    throwIfAborted(signal);

    try {
      decoder = Reflect.apply(bindings.createDecoder, bindings.authority, [
        Object.freeze({
          output,
          error(error: unknown): void {
            if (!acceptingOutput) return;
            recordFailure(asUnavailable('WebCodecs AAC decoder reported an error', error));
          },
        }),
      ]) as AacWebCodecsDecoder;
      if (
        !decoder ||
        typeof decoder !== 'object' ||
        typeof decoder.configure !== 'function' ||
        typeof decoder.decode !== 'function' ||
        typeof decoder.flush !== 'function' ||
        typeof decoder.close !== 'function'
      ) {
        throw new TypeError('WebCodecs AAC decoder binding is invalid');
      }
      if (hasTerminalFailure) throw terminalFailure;
      Reflect.apply(decoder.configure, decoder, [config]);
      if (hasTerminalFailure) throw terminalFailure;
      const chunkInit = Object.freeze({
        type: 'key' as const,
        timestamp: 0 as const,
        data: verified.bytes,
      });
      const chunk = Reflect.apply(bindings.createEncodedAudioChunk, bindings.authority, [
        chunkInit,
      ]);
      if (hasTerminalFailure) throw terminalFailure;
      // EncodedAudioChunk construction copies BufferSource synchronously.
      Reflect.apply(uint8ArrayFill, verified.bytes, [0]);
      retainedFrame = null;
      throwIfAborted(signal);
      decodeSubmitted = true;
      Reflect.apply(decoder.decode, decoder, [chunk]);
      if (hasTerminalFailure) throw terminalFailure;
    } catch (cause) {
      throwIfAborted(signal);
      if (hasTerminalFailure) throw terminalFailure;
      if (cause instanceof AacWebCodecsIntegrityError) throw cause;
      throw asUnavailable('WebCodecs rejected the verified ADTS AAC-LC frame', cause);
    }

    let flushTask: PromiseLike<void>;
    try {
      flushTask = Reflect.apply(decoder.flush, decoder, []) as PromiseLike<void>;
    } catch (cause) {
      throw asUnavailable('WebCodecs AAC decoder flush could not start', cause);
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
      throw asUnavailable('WebCodecs AAC decoder flush failed', cause);
    }
    if (completion.kind === 'failure') throw completion.cause;
    if (hasTerminalFailure) throw terminalFailure;
    throwIfAborted(signal);
    if (decodedFrames !== AAC_LC_CORE_FRAMES || outputCount < 1) {
      throw new AacWebCodecsIntegrityError(
        'WebCodecs did not emit exactly 1024 AAC-LC core frames',
      );
    }

    evidence = Object.freeze({
      codec: AAC_LC_CODEC,
      framing: 'adts' as const,
      coreSampleRateHz: verified.header.coreSampleRateHz,
      coreChannelCount: verified.coreChannelCount,
      decodedCoreFrames: AAC_LC_CORE_FRAMES,
      outputCount,
      f32PlanarCopyVerified: true as const,
    });
  } catch (cause) {
    operationFailure = cause;
  } finally {
    acceptingOutput = false;
    if (retainedFrame) {
      Reflect.apply(uint8ArrayFill, retainedFrame, [0]);
    }
    if (decoder) {
      try {
        Reflect.apply(decoder.close, decoder, []);
      } catch (cause) {
        if (operationFailure === undefined) {
          operationFailure = asUnavailable('WebCodecs AAC decoder could not be closed', cause);
        }
      }
    }
  }

  try {
    throwIfAborted(signal);
  } catch (abortCause) {
    operationFailure = abortCause;
  }
  if (operationFailure !== undefined) throw operationFailure;
  if (!evidence) {
    throw new AacWebCodecsUnavailableError('WebCodecs AAC capability evidence is unavailable');
  }
  return evidence;
}
