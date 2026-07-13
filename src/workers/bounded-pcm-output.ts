import { ChunkedResampler, initWithBase64 } from 'lanczos-resampler/loader.js';

import {
  expectedLanczosOutputFrames,
  maximumLanczosOutputFrames,
  minimumLanczosInputFrames,
  planBoundedLanczosChunk,
  planShortLanczosInput,
} from '../player/streaming/resampler-plan.js';
import {
  PCM_STREAM_MAX_CHANNELS,
  PCM_STREAM_MAX_MESSAGE_FRAMES,
} from '../player/streaming/pcm-stream-protocol.js';

// lanczos-resampler@0.4.1 can touch a small private phase tail beyond its
// nominal maximum output at extreme ratios. These frames are never published.
const RESAMPLER_SCRATCH_GUARD_FRAMES = 64;
const MAX_SAMPLE_RATE_HZ = 1_000_000;

let runtimeReadiness: Promise<void> | null = null;

/** A failed WASM initialization is realm-terminal; a fresh Worker must retry. */
export function ensureBoundedPcmOutputRuntimeReady(): Promise<void> {
  runtimeReadiness ??= initWithBase64();
  return runtimeReadiness;
}

export interface BoundedPcmOutputOptions {
  readonly sourceSampleRateHz: number;
  readonly outputSampleRateHz: number;
  readonly channelCount: number;
  /** Exact source-domain PCM frames that may be appended. */
  readonly totalSourceFrames: number;
  /** Largest source-domain frame block accepted by one append. */
  readonly maxAppendFrames: number;
}

export interface BoundedPcmOutputSegment {
  readonly channels: readonly Float32Array[];
  readonly frames: number;
  readonly final: boolean;
}

interface SourceCarry {
  readonly channels: readonly Float32Array[];
  readonly frames: number;
}

interface PcmSegment {
  readonly channels: readonly Float32Array[];
  readonly frames: number;
}

interface PendingOutput extends PcmSegment {
  readonly offset: number;
}

export class BoundedPcmOutputError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'BoundedPcmOutputError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        value: cause,
      });
    }
  }
}

function requireSafeInteger(value: number, label: string, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be a safe integer from ${minimum} through ${maximum}`);
  }
}

function copyFiniteChannel(channel: unknown, frames: number, label: string): Float32Array {
  if (!(channel instanceof Float32Array) || channel.length !== frames) {
    throw new BoundedPcmOutputError(`${label} must contain exactly ${frames} Float32 frames`);
  }
  const copy = new Float32Array(frames);
  for (let index = 0; index < frames; index += 1) {
    const sample = channel[index];
    if (!Number.isFinite(sample)) {
      throw new BoundedPcmOutputError(`${label} contains non-finite PCM at frame ${index}`);
    }
    copy[index] = sample;
  }
  return copy;
}

function assertFiniteChannel(channel: Float32Array, label: string): void {
  for (let index = 0; index < channel.length; index += 1) {
    if (!Number.isFinite(channel[index])) {
      throw new BoundedPcmOutputError(`${label} contains non-finite PCM at frame ${index}`);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Codec-neutral, duration-independent PCM carry and resampling boundary.
 *
 * A codec worker appends only exact decoded blocks and pulls at most one PCM
 * protocol message at a time. The object retains at most one append block plus
 * the pinned Lanczos minimum-input tail and one fixed output segment; it never
 * accumulates by duration.
 */
export class BoundedPcmOutput {
  readonly sourceSampleRateHz: number;
  readonly outputSampleRateHz: number;
  readonly channelCount: number;
  readonly totalSourceFrames: number;
  readonly maxAppendFrames: number;
  readonly expectedOutputFrames: number;

  readonly #resamplers: ChunkedResampler[] = [];
  #carry: SourceCarry | null = null;
  #pendingOutput: PendingOutput | null = null;
  #acceptedSourceFrames = 0;
  #consumedSourceFrames = 0;
  #producedOutputFrames = 0;
  #inputEnded = false;
  #closed = false;
  #terminalError: BoundedPcmOutputError | null = null;

  constructor(options: BoundedPcmOutputOptions) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('Bounded PCM output options must be an object');
    }
    requireSafeInteger(options.sourceSampleRateHz, 'sourceSampleRateHz', 1, MAX_SAMPLE_RATE_HZ);
    requireSafeInteger(options.outputSampleRateHz, 'outputSampleRateHz', 1, MAX_SAMPLE_RATE_HZ);
    requireSafeInteger(options.channelCount, 'channelCount', 1, PCM_STREAM_MAX_CHANNELS);
    requireSafeInteger(options.totalSourceFrames, 'totalSourceFrames', 1, Number.MAX_SAFE_INTEGER);
    requireSafeInteger(
      options.maxAppendFrames,
      'maxAppendFrames',
      1,
      PCM_STREAM_MAX_MESSAGE_FRAMES,
    );

    this.sourceSampleRateHz = options.sourceSampleRateHz;
    this.outputSampleRateHz = options.outputSampleRateHz;
    this.channelCount = options.channelCount;
    this.totalSourceFrames = options.totalSourceFrames;
    this.maxAppendFrames = options.maxAppendFrames;
    this.expectedOutputFrames =
      this.sourceSampleRateHz === this.outputSampleRateHz
        ? this.totalSourceFrames
        : expectedLanczosOutputFrames({
            inputSampleRate: this.sourceSampleRateHz,
            outputSampleRate: this.outputSampleRateHz,
            totalSourceFrames: this.totalSourceFrames,
            startSourceFrame: 0,
          });

    if (this.sourceSampleRateHz !== this.outputSampleRateHz) {
      const rates = {
        inputSampleRate: this.sourceSampleRateHz,
        outputSampleRate: this.outputSampleRateHz,
      };
      const minimumInputFrames = minimumLanczosInputFrames(rates);
      if (
        minimumInputFrames > PCM_STREAM_MAX_MESSAGE_FRAMES ||
        maximumLanczosOutputFrames(minimumInputFrames, rates) > PCM_STREAM_MAX_MESSAGE_FRAMES
      ) {
        throw new RangeError('Bounded PCM sample-rate ratio exceeds one fixed output segment');
      }
      try {
        for (let channel = 0; channel < this.channelCount; channel += 1) {
          this.#resamplers.push(
            new ChunkedResampler(this.sourceSampleRateHz, this.outputSampleRateHz),
          );
        }
      } catch (error) {
        for (const resampler of this.#resamplers) resampler.free();
        this.#resamplers.splice(0);
        throw new BoundedPcmOutputError(
          `Bounded PCM resampler failed to initialize: ${errorMessage(error)}`,
          error,
        );
      }
    }
  }

  get acceptedSourceFrames(): number {
    return this.#acceptedSourceFrames;
  }

  get consumedSourceFrames(): number {
    return this.#consumedSourceFrames;
  }

  get producedOutputFrames(): number {
    return this.#producedOutputFrames;
  }

  get inputEnded(): boolean {
    return this.#inputEnded;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get finished(): boolean {
    return (
      this.#inputEnded &&
      this.#carry === null &&
      this.#pendingOutput === null &&
      this.#consumedSourceFrames === this.totalSourceFrames &&
      this.#producedOutputFrames === this.expectedOutputFrames
    );
  }

  /** True when another decoded block can be appended without growing carry. */
  get needsInput(): boolean {
    if (
      this.#closed ||
      this.#terminalError ||
      this.#inputEnded ||
      this.#acceptedSourceFrames >= this.totalSourceFrames
    ) {
      return false;
    }
    if (this.#pendingOutput) return false;
    if (!this.#carry) return true;
    if (this.sourceSampleRateHz === this.outputSampleRateHz) return false;
    return this.#carry.frames < this.#minimumResamplerInputFrames();
  }

  append(channels: readonly Float32Array[], frames: number): void {
    this.#assertOpen();
    if (this.#inputEnded) throw new BoundedPcmOutputError('Bounded PCM input already ended');
    requireSafeInteger(frames, 'frames', 1, this.maxAppendFrames);
    if (!Array.isArray(channels) || channels.length !== this.channelCount) {
      throw new BoundedPcmOutputError(
        `Bounded PCM append requires exactly ${this.channelCount} channels`,
      );
    }
    const acceptedAfter = this.#acceptedSourceFrames + frames;
    if (!Number.isSafeInteger(acceptedAfter) || acceptedAfter > this.totalSourceFrames) {
      throw new BoundedPcmOutputError('Bounded PCM append exceeds its exact source timeline');
    }
    if (!this.needsInput) {
      throw new BoundedPcmOutputError('Bounded PCM carry must be drained before another append');
    }

    const copied = channels.map((channel, index) =>
      copyFiniteChannel(channel, frames, `channel ${index}`),
    );
    const carry = this.#carry;
    if (!carry) {
      this.#carry = Object.freeze({ channels: Object.freeze(copied), frames });
    } else {
      const maximumCarryFrames = this.#minimumResamplerInputFrames() - 1;
      if (carry.frames > maximumCarryFrames) {
        throw new BoundedPcmOutputError('Bounded PCM carry exceeded its fixed tail limit');
      }
      const combinedFrames = carry.frames + frames;
      if (combinedFrames > this.maxAppendFrames + maximumCarryFrames) {
        throw new BoundedPcmOutputError('Bounded PCM carry exceeded its fixed allocation bound');
      }
      const combined = carry.channels.map((previous, channelIndex) => {
        const next = copied[channelIndex];
        if (!next) throw new BoundedPcmOutputError('Bounded PCM append lost a channel');
        const output = new Float32Array(combinedFrames);
        output.set(previous);
        output.set(next, carry.frames);
        return output;
      });
      this.#carry = Object.freeze({ channels: Object.freeze(combined), frames: combinedFrames });
    }
    this.#acceptedSourceFrames = acceptedAfter;
  }

  endInput(): void {
    this.#assertOpen();
    if (this.#inputEnded) return;
    if (this.#acceptedSourceFrames !== this.totalSourceFrames) {
      throw new BoundedPcmOutputError(
        `Bounded PCM input ended at ${this.#acceptedSourceFrames}; expected ${this.totalSourceFrames}`,
      );
    }
    this.#inputEnded = true;
  }

  /** Returns null when more decoded input is needed or the stream is finished. */
  pull(maxFrames: number): BoundedPcmOutputSegment | null {
    this.#assertOpen();
    try {
      return this.#pull(maxFrames);
    } catch (error) {
      const terminal =
        error instanceof BoundedPcmOutputError
          ? error
          : new BoundedPcmOutputError('Bounded PCM output failed', error);
      this.#terminalError = terminal;
      throw terminal;
    }
  }

  #pull(maxFrames: number): BoundedPcmOutputSegment | null {
    requireSafeInteger(maxFrames, 'maxFrames', 1, PCM_STREAM_MAX_MESSAGE_FRAMES);
    if (this.#pendingOutput) return this.#drainPendingOutput(maxFrames);
    if (this.finished) return null;

    let segment: PcmSegment | null = null;
    if (this.sourceSampleRateHz === this.outputSampleRateHz) {
      const carry = this.#carry;
      if (carry) {
        const frames = Math.min(carry.frames, PCM_STREAM_MAX_MESSAGE_FRAMES);
        const channels = this.#consumeCarry(frames);
        this.#consumedSourceFrames += frames;
        this.#accountProduced(frames);
        segment = Object.freeze({ channels, frames });
      }
    } else {
      segment = this.#pullNormalResampled();
      if (!segment && this.#inputEnded && this.#carry) segment = this.#pullEofResampled();
    }

    if (!segment || segment.frames === 0) {
      if (this.#inputEnded && !this.finished) {
        throw new BoundedPcmOutputError('Bounded PCM output stalled before its exact EOF');
      }
      return null;
    }
    this.#pendingOutput = Object.freeze({ ...segment, offset: 0 });
    return this.#drainPendingOutput(maxFrames);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#carry = null;
    this.#pendingOutput = null;
    for (const resampler of this.#resamplers) {
      try {
        resampler.free();
      } catch {
        // The local terminal boundary remains authoritative.
      }
    }
    this.#resamplers.splice(0);
  }

  #pullNormalResampled(): PcmSegment | null {
    const carry = this.#carry;
    if (!carry) return null;
    const plan = planBoundedLanczosChunk({
      inputSampleRate: this.sourceSampleRateHz,
      outputSampleRate: this.outputSampleRateHz,
      remainingSourceFrames: carry.frames,
      maxOutputFrames: PCM_STREAM_MAX_MESSAGE_FRAMES,
    });
    if (!plan) return null;

    const inputs = this.#consumeCarry(plan.inputFrames);
    const consumedAfter = this.#consumedSourceFrames + plan.inputFrames;
    const expectedAfter = this.#expectedOutputAfter(consumedAfter);
    const outputFrames = expectedAfter - this.#producedOutputFrames;
    if (outputFrames <= 0 || outputFrames > plan.maximumOutputFrames) {
      throw new BoundedPcmOutputError('Bounded PCM resampler output delta is invalid');
    }
    const outputs = this.#runResamplers(
      inputs,
      plan.inputFrames,
      plan.maximumOutputFrames,
      outputFrames,
      true,
    );
    this.#consumedSourceFrames = consumedAfter;
    this.#accountProduced(outputFrames);
    return Object.freeze({ channels: outputs, frames: outputFrames });
  }

  #pullEofResampled(): PcmSegment | null {
    const carry = this.#carry;
    if (!carry) return null;
    const plan = planShortLanczosInput({
      inputSampleRate: this.sourceSampleRateHz,
      outputSampleRate: this.outputSampleRateHz,
      consumedSourceFrames: this.#consumedSourceFrames,
      producedOutputFrames: this.#producedOutputFrames,
      carriedSourceFrames: carry.frames,
      endOfStream: true,
    });
    if (plan.kind !== 'pad-and-trim') {
      throw new BoundedPcmOutputError('Bounded PCM EOF plan did not finalize');
    }
    const realInputs = this.#consumeCarry(plan.realInputFrames);
    const paddedInputs = realInputs.map((input) => {
      const padded = new Float32Array(plan.paddedInputFrames);
      padded.set(input);
      return padded;
    });
    const outputs = this.#runResamplers(
      paddedInputs,
      plan.paddedInputFrames,
      plan.maximumOutputFrames,
      plan.trimToOutputFrames,
      false,
    );
    this.#consumedSourceFrames += plan.realInputFrames;
    this.#accountProduced(plan.trimToOutputFrames);
    if (plan.trimToOutputFrames === 0) return null;
    return Object.freeze({ channels: outputs, frames: plan.trimToOutputFrames });
  }

  #drainPendingOutput(maxFrames: number): BoundedPcmOutputSegment {
    const pending = this.#pendingOutput;
    if (!pending) throw new BoundedPcmOutputError('Bounded PCM output segment is missing');
    const frames = Math.min(maxFrames, pending.frames - pending.offset);
    if (frames <= 0) throw new BoundedPcmOutputError('Bounded PCM output segment is empty');
    const end = pending.offset + frames;
    const channels = Object.freeze(
      pending.channels.map((channel) => channel.slice(pending.offset, end)),
    );
    if (end === pending.frames) this.#pendingOutput = null;
    else this.#pendingOutput = Object.freeze({ ...pending, offset: end });
    return Object.freeze({ channels, frames, final: this.finished });
  }

  #runResamplers(
    inputs: readonly Float32Array[],
    inputFrames: number,
    maximumOutputFrames: number,
    keepOutputFrames: number,
    requireExactWritten: boolean,
  ): readonly Float32Array[] {
    const outputs: Float32Array[] = [];
    for (let channel = 0; channel < this.channelCount; channel += 1) {
      const resampler = this.#resamplers[channel];
      const input = inputs[channel];
      if (!resampler || !input) {
        throw new BoundedPcmOutputError('Bounded PCM resampler channel is missing');
      }
      if (resampler.maxNumOutputFrames(inputFrames) !== maximumOutputFrames) {
        throw new BoundedPcmOutputError('Pinned Lanczos output bound changed');
      }
      const output = new Float32Array(maximumOutputFrames + RESAMPLER_SCRATCH_GUARD_FRAMES);
      const outcome = resampler.resample(input, output);
      try {
        if (outcome.numRead !== inputFrames) {
          throw new BoundedPcmOutputError('Pinned Lanczos resampler did not consume its input');
        }
        if (
          !Number.isSafeInteger(outcome.numWritten) ||
          outcome.numWritten < keepOutputFrames ||
          outcome.numWritten > maximumOutputFrames ||
          (requireExactWritten && outcome.numWritten !== keepOutputFrames)
        ) {
          throw new BoundedPcmOutputError('Pinned Lanczos output contract changed');
        }
        const published = output.slice(0, keepOutputFrames);
        assertFiniteChannel(published, `resampled channel ${channel}`);
        outputs.push(published);
      } finally {
        outcome.free();
      }
    }
    return Object.freeze(outputs);
  }

  #consumeCarry(frames: number): readonly Float32Array[] {
    const carry = this.#carry;
    if (!carry || frames <= 0 || frames > carry.frames) {
      throw new BoundedPcmOutputError('Bounded PCM carry consumption is invalid');
    }
    const consumed = carry.channels.map((channel) => channel.slice(0, frames));
    if (frames === carry.frames) this.#carry = null;
    else {
      this.#carry = Object.freeze({
        channels: Object.freeze(carry.channels.map((channel) => channel.slice(frames))),
        frames: carry.frames - frames,
      });
    }
    return Object.freeze(consumed);
  }

  #minimumResamplerInputFrames(): number {
    return minimumLanczosInputFrames({
      inputSampleRate: this.sourceSampleRateHz,
      outputSampleRate: this.outputSampleRateHz,
    });
  }

  #expectedOutputAfter(sourceFrames: number): number {
    return expectedLanczosOutputFrames({
      inputSampleRate: this.sourceSampleRateHz,
      outputSampleRate: this.outputSampleRateHz,
      totalSourceFrames: sourceFrames,
      startSourceFrame: 0,
    });
  }

  #accountProduced(frames: number): void {
    this.#producedOutputFrames += frames;
    if (
      !Number.isSafeInteger(this.#producedOutputFrames) ||
      this.#producedOutputFrames > this.expectedOutputFrames
    ) {
      throw new BoundedPcmOutputError('Bounded PCM output exceeds its exact timeline');
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new BoundedPcmOutputError('Bounded PCM output is closed');
    if (this.#terminalError) throw this.#terminalError;
  }
}
