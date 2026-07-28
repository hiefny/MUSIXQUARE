import { MPEGDecoder } from 'mpg123-decoder';

import { parseMpegLayer3FrameHeader } from './frame-header.ts';

export interface Mpg123FrameDecoderConfig {
  readonly encodedChannels: 1 | 2;
  readonly sampleRateHz: number;
  readonly samplesPerFrame: 576 | 1_152;
}

interface Mpg123RuntimeDecodedAudio {
  readonly channelData: unknown;
  readonly samplesDecoded: unknown;
  readonly sampleRate: unknown;
  readonly errors: unknown;
}

/** The deliberately narrow portion of `mpg123-decoder` owned by this boundary. */
export interface Mpg123FrameDecoderRuntime {
  readonly ready: Promise<void>;
  decodeFrame(frame: Uint8Array): Mpg123RuntimeDecodedAudio;
}

export type Mpg123FrameDecoderRuntimeFactory = (options: {
  readonly enableGapless: false;
}) => Mpg123FrameDecoderRuntime;

export interface Mpg123DecodedAudioFrame {
  readonly channelData: readonly Float32Array[];
  readonly samplesDecoded: number;
  readonly sampleRateHz: number;
}

export class Mpg123FrameDecoderError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'Mpg123FrameDecoderError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        value: cause,
      });
    }
  }
}

const PINNED_RUNTIME_FACTORY: Mpg123FrameDecoderRuntimeFactory = (options) =>
  new MPEGDecoder(options);

function requireConfig(config: Mpg123FrameDecoderConfig): void {
  if (!config || typeof config !== 'object') {
    throw new TypeError('MP3 frame decoder config is missing');
  }
  if (config.encodedChannels !== 1 && config.encodedChannels !== 2) {
    throw new RangeError('MP3 encoded channel count must be one or two');
  }
  if (!Number.isSafeInteger(config.sampleRateHz) || config.sampleRateHz <= 0) {
    throw new RangeError('MP3 sample rate must be a positive safe integer');
  }
  if (config.samplesPerFrame !== 576 && config.samplesPerFrame !== 1_152) {
    throw new RangeError('MP3 samples per frame must be 576 or 1152');
  }
}

function runtimeError(message: string, cause?: unknown): Mpg123FrameDecoderError {
  return new Mpg123FrameDecoderError(message, cause);
}

function validateFinitePcm(channel: Float32Array, label: string): void {
  for (let index = 0; index < channel.length; index += 1) {
    if (!Number.isFinite(channel[index])) {
      throw runtimeError(`MP3 decoder returned non-finite ${label} PCM at frame ${index}`);
    }
  }
}

function validateForcedStereoChannels(
  value: unknown,
  expectedFrames: number,
): readonly [Float32Array, Float32Array] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw runtimeError('MP3 decoder must return exactly two FORCE_STEREO channels');
  }
  const left: unknown = value[0];
  const right: unknown = value[1];
  if (!(left instanceof Float32Array) || !(right instanceof Float32Array)) {
    throw runtimeError('MP3 decoder channels must be Float32Array instances');
  }
  if (left.length !== expectedFrames || right.length !== expectedFrames) {
    throw runtimeError('MP3 decoder channel lengths do not match the decoded frame count');
  }
  validateFinitePcm(left, 'left-channel');
  validateFinitePcm(right, 'right-channel');
  return [left, right];
}

function normalizeChannels(
  channels: readonly [Float32Array, Float32Array],
  encodedChannels: 1 | 2,
): readonly Float32Array[] {
  const [left, right] = channels;
  if (encodedChannels === 1) {
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) {
        throw runtimeError('MP3 mono FORCE_STEREO channels are not identical');
      }
    }
    return Object.freeze([left]);
  }
  return Object.freeze([left, right]);
}

/**
 * One-generation, frame-at-a-time mpg123 boundary for an owning decoder worker.
 *
 * The wrapper intentionally has no reset, dispose, or free operation. The
 * pinned upstream package's cleanup path is not a safe ownership boundary, so
 * the worker that constructs this object must terminate its entire realm to
 * release the one WASM generation. This boundary calls and exposes only the
 * upstream single-frame `decodeFrame()` operation; it never calls or exposes
 * bulk `decodeFrames()`, `reset()`, or `free()` operations. (`decodeFrame()`
 * itself delegates internally to the package's byte-feed implementation.)
 */
export class Mpg123FrameDecoder {
  readonly ready: Promise<void>;

  readonly #config: Readonly<Mpg123FrameDecoderConfig>;
  readonly #runtime: Mpg123FrameDecoderRuntime;
  #isReady = false;
  #terminalError: Mpg123FrameDecoderError | null = null;

  constructor(
    config: Mpg123FrameDecoderConfig,
    runtimeFactory: Mpg123FrameDecoderRuntimeFactory = PINNED_RUNTIME_FACTORY,
  ) {
    requireConfig(config);
    if (typeof runtimeFactory !== 'function') {
      throw new TypeError('MP3 frame decoder runtime factory must be a function');
    }
    this.#config = Object.freeze({ ...config });
    const runtime = runtimeFactory(Object.freeze({ enableGapless: false as const }));
    if (
      !runtime ||
      typeof runtime !== 'object' ||
      !(runtime.ready instanceof Promise) ||
      typeof runtime.decodeFrame !== 'function'
    ) {
      throw new TypeError('MP3 frame decoder runtime is invalid');
    }
    this.#runtime = runtime;
    this.ready = Promise.resolve(runtime.ready).then(
      () => {
        this.#isReady = true;
      },
      (cause: unknown) => {
        const error = runtimeError('MP3 decoder runtime failed to initialize', cause);
        this.#terminalError = error;
        throw error;
      },
    );
  }

  /**
   * Decode one scanner-verified audio frame.
   *
   * A leading Xing/Info/VBRI structural frame is outside this boundary and
   * must never be fed here. The owning worker starts at `firstAudioFrameOffset`.
   */
  decodeVerifiedAudioFrame(frame: Uint8Array): Mpg123DecodedAudioFrame {
    if (this.#terminalError) throw this.#terminalError;
    if (!this.#isReady) {
      throw runtimeError('MP3 decoder runtime is not ready');
    }

    try {
      if (!(frame instanceof Uint8Array)) {
        throw new TypeError('MP3 verified frame must be a Uint8Array');
      }
      if (frame.byteLength < 4) {
        throw runtimeError('MP3 verified frame is shorter than its header');
      }

      const header = parseMpegLayer3FrameHeader(frame.subarray(0, 4));
      if (frame.byteLength !== header.frameLengthBytes) {
        throw runtimeError('MP3 verified frame length does not match its parsed header');
      }
      if (
        header.sampleRateHz !== this.#config.sampleRateHz ||
        header.channelCount !== this.#config.encodedChannels ||
        header.samplesPerFrame !== this.#config.samplesPerFrame
      ) {
        throw runtimeError('MP3 verified frame header does not match the decoder generation');
      }

      let decoded: Mpg123RuntimeDecodedAudio;
      try {
        decoded = this.#runtime.decodeFrame(frame);
      } catch (cause) {
        throw runtimeError('MP3 decoder rejected a scanner-verified frame', cause);
      }
      if (!decoded || typeof decoded !== 'object') {
        throw runtimeError('MP3 decoder returned an invalid result');
      }
      if (!Array.isArray(decoded.errors)) {
        throw runtimeError('MP3 decoder returned an invalid error collection');
      }
      if (decoded.errors.length !== 0) {
        throw runtimeError('MP3 decoder reported an error for a scanner-verified frame');
      }
      if (!Number.isSafeInteger(decoded.samplesDecoded) || (decoded.samplesDecoded as number) < 0) {
        throw runtimeError('MP3 decoder returned an invalid decoded frame count');
      }
      if (!Number.isSafeInteger(decoded.sampleRate) || (decoded.sampleRate as number) < 0) {
        throw runtimeError('MP3 decoder returned an invalid sample rate');
      }

      const expectedFrames = this.#config.samplesPerFrame;
      const samplesDecoded = decoded.samplesDecoded as number;
      const sampleRateHz = decoded.sampleRate as number;
      if (samplesDecoded !== expectedFrames) {
        throw runtimeError('MP3 audio frame did not decode to exactly one frame of PCM');
      }
      if (sampleRateHz !== this.#config.sampleRateHz) {
        throw runtimeError('MP3 decoder sample rate does not match the decoder generation');
      }

      const forcedStereo = validateForcedStereoChannels(decoded.channelData, expectedFrames);
      const channelData = normalizeChannels(forcedStereo, this.#config.encodedChannels);
      return Object.freeze({
        channelData,
        samplesDecoded,
        sampleRateHz,
      });
    } catch (cause) {
      const error =
        cause instanceof Mpg123FrameDecoderError
          ? cause
          : runtimeError('MP3 verified frame failed decoder validation', cause);
      this.#terminalError = error;
      throw error;
    }
  }
}
