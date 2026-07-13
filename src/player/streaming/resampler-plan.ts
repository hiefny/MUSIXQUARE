/**
 * Codec-neutral planning helpers for the pinned `lanczos-resampler@0.4.1` runtime.
 *
 * The library uses floor(N * outputRate / inputRate) for normal lengths. Its
 * public `numOutputFrames` helper deliberately maps a computed one-frame result
 * to zero, because the Lanczos implementation cannot process fewer than two
 * input/output points. Keep that unusual rule here so the worker's EOF contract
 * and its WASM output cannot disagree by one frame.
 */

export interface LanczosRates {
  readonly inputSampleRate: number;
  readonly outputSampleRate: number;
}

export interface LanczosSegment extends LanczosRates {
  readonly totalSourceFrames: number;
  readonly startSourceFrame: number;
}

export interface BoundedLanczosChunkOptions extends LanczosRates {
  readonly remainingSourceFrames: number;
  readonly maxOutputFrames: number;
}

export interface BoundedLanczosChunkPlan {
  readonly inputFrames: number;
  readonly maximumOutputFrames: number;
  readonly remainingSourceFrames: number;
}

export interface ShortLanczosInputOptions extends LanczosRates {
  /** Real source frames already consumed by this resampler since the seek target. */
  readonly consumedSourceFrames: number;
  /** Output frames already produced by this resampler since the seek target. */
  readonly producedOutputFrames: number;
  /** Unconsumed real source frames currently held in the carry buffer. */
  readonly carriedSourceFrames: number;
  readonly endOfStream: boolean;
}

export interface CarryLanczosInputPlan {
  readonly kind: 'carry';
  readonly carriedSourceFrames: number;
  readonly additionalSourceFramesNeeded: number;
  readonly minimumInputFrames: number;
}

export interface PadAndTrimLanczosInputPlan {
  readonly kind: 'pad-and-trim';
  readonly realInputFrames: number;
  readonly zeroPaddingFrames: number;
  readonly paddedInputFrames: number;
  readonly maximumOutputFrames: number;
  /** Keep this prefix of the padded call's output and discard the rest. */
  readonly trimToOutputFrames: number;
  readonly expectedTotalOutputFrames: number;
}

export type ShortLanczosInputPlan = CarryLanczosInputPlan | PadAndTrimLanczosInputPlan;

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function requireSafeInteger(value: number, label: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${label} must be a safe integer greater than or equal to ${minimum}`);
  }
}

function validateRates(rates: LanczosRates): void {
  requireSafeInteger(rates.inputSampleRate, 'inputSampleRate', 1);
  requireSafeInteger(rates.outputSampleRate, 'outputSampleRate', 1);
}

function toSafeNumber(value: bigint, label: string): number {
  if (value < 0n || value > MAX_SAFE_BIGINT) {
    throw new RangeError(`${label} exceeds the safe-integer range`);
  }
  return Number(value);
}

function rawOutputFramesBigInt(
  inputFrames: bigint,
  inputSampleRate: bigint,
  outputSampleRate: bigint,
): bigint {
  return (inputFrames * outputSampleRate) / inputSampleRate;
}

function pinnedOutputFramesBigInt(
  inputFrames: bigint,
  inputSampleRate: bigint,
  outputSampleRate: bigint,
): bigint {
  const computed = rawOutputFramesBigInt(inputFrames, inputSampleRate, outputSampleRate);
  return computed === 1n ? 0n : computed;
}

function pinnedMaximumOutputFramesBigInt(
  inputFrames: bigint,
  inputSampleRate: bigint,
  outputSampleRate: bigint,
): bigint {
  return pinnedOutputFramesBigInt(inputFrames, inputSampleRate, outputSampleRate) + 1n;
}

/**
 * Exact output length of a fresh pinned Lanczos stream beginning at a source
 * seek target. A mathematically computed one-frame result is intentionally
 * zero, matching `lanczos-resampler@0.4.1` rather than rounding it up.
 */
export function expectedLanczosOutputFrames(segment: LanczosSegment): number {
  validateRates(segment);
  requireSafeInteger(segment.totalSourceFrames, 'totalSourceFrames');
  requireSafeInteger(segment.startSourceFrame, 'startSourceFrame');
  if (segment.startSourceFrame > segment.totalSourceFrames) {
    throw new RangeError('startSourceFrame must not exceed totalSourceFrames');
  }

  const remaining = BigInt(segment.totalSourceFrames) - BigInt(segment.startSourceFrame);
  const result = pinnedOutputFramesBigInt(
    remaining,
    BigInt(segment.inputSampleRate),
    BigInt(segment.outputSampleRate),
  );
  return toSafeNumber(result, 'Lanczos output frame count');
}

/** Minimum input that `ChunkedResampler.resample` is guaranteed to consume. */
export function minimumLanczosInputFrames(rates: LanczosRates): number {
  validateRates(rates);
  const inputRate = BigInt(rates.inputSampleRate);
  const outputRate = BigInt(rates.outputSampleRate);
  const ratioMinimum = (2n * inputRate + outputRate - 1n) / outputRate;
  return toSafeNumber(ratioMinimum < 2n ? 2n : ratioMinimum, 'minimum Lanczos input');
}

/**
 * Mirrors `ChunkedResampler.maxNumOutputFrames` without touching WASM state.
 * The extra frame covers the phase carried between chunk calls.
 */
export function maximumLanczosOutputFrames(inputFrames: number, rates: LanczosRates): number {
  validateRates(rates);
  requireSafeInteger(inputFrames, 'inputFrames');
  const maximum = pinnedMaximumOutputFramesBigInt(
    BigInt(inputFrames),
    BigInt(rates.inputSampleRate),
    BigInt(rates.outputSampleRate),
  );
  return toSafeNumber(maximum, 'maximum Lanczos output frame count');
}

/**
 * Pick the largest bounded input while keeping the complete remaining segment
 * partitionable into consumable chunks. Consequently a nonzero remainder is
 * always at least `minimumLanczosInputFrames`; the 16,384 @ 8kHz case becomes
 * 5,461 + 5,461 + 5,460 + 2 instead of ending in an unconsumable one frame.
 *
 * Returns `null` when there is not enough input yet; the caller should use
 * `planShortLanczosInput` to carry it or finalize it at EOF.
 */
export function planBoundedLanczosChunk(
  options: BoundedLanczosChunkOptions,
): BoundedLanczosChunkPlan | null {
  validateRates(options);
  requireSafeInteger(options.remainingSourceFrames, 'remainingSourceFrames');
  requireSafeInteger(options.maxOutputFrames, 'maxOutputFrames', 1);

  const minimum = minimumLanczosInputFrames(options);
  if (options.remainingSourceFrames < minimum) return null;

  const inputRate = BigInt(options.inputSampleRate);
  const outputRate = BigInt(options.outputSampleRate);
  const outputLimit = BigInt(options.maxOutputFrames);
  let low = minimum;
  let high = options.remainingSourceFrames;
  let maximumBoundedInput = 0;

  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const maximum = pinnedMaximumOutputFramesBigInt(BigInt(middle), inputRate, outputRate);
    if (maximum <= outputLimit) {
      maximumBoundedInput = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (maximumBoundedInput < minimum) {
    throw new RangeError('maxOutputFrames cannot hold a minimum consumable Lanczos input');
  }

  let inputFrames = options.remainingSourceFrames;
  if (inputFrames > maximumBoundedInput) {
    const remaining = BigInt(options.remainingSourceFrames);
    const capacity = BigInt(maximumBoundedInput);
    const chunkCount = (remaining + capacity - 1n) / capacity;
    const minimumRequired = chunkCount * BigInt(minimum);
    if (remaining < minimumRequired) {
      throw new RangeError('source frames cannot be partitioned into bounded consumable chunks');
    }

    // Leave enough frames for every later chunk, instead of greedily creating
    // an eventual one-frame remainder.
    const laterChunks = chunkCount - 1n;
    const largestSafeFirstChunk = remaining - laterChunks * BigInt(minimum);
    inputFrames = toSafeNumber(
      largestSafeFirstChunk < capacity ? largestSafeFirstChunk : capacity,
      'planned Lanczos input',
    );
  }

  const remainingSourceFrames = options.remainingSourceFrames - inputFrames;
  if (inputFrames < minimum || (remainingSourceFrames > 0 && remainingSourceFrames < minimum)) {
    throw new RangeError('planned Lanczos chunk would leave an unconsumable remainder');
  }

  return {
    inputFrames,
    maximumOutputFrames: maximumLanczosOutputFrames(inputFrames, options),
    remainingSourceFrames,
  };
}

/**
 * Plan the only legal treatments for a positive carry shorter than the pinned
 * resampler minimum. Before EOF it remains buffered. At EOF it is followed by
 * zeroes up to the minimum input and the WASM result is trimmed back to the
 * exact unpadded stream contract.
 */
export function planShortLanczosInput(options: ShortLanczosInputOptions): ShortLanczosInputPlan {
  validateRates(options);
  requireSafeInteger(options.consumedSourceFrames, 'consumedSourceFrames');
  requireSafeInteger(options.producedOutputFrames, 'producedOutputFrames');
  requireSafeInteger(options.carriedSourceFrames, 'carriedSourceFrames', 1);

  const minimum = minimumLanczosInputFrames(options);
  if (options.carriedSourceFrames >= minimum) {
    throw new RangeError('carriedSourceFrames must be shorter than the minimum Lanczos input');
  }
  if (options.consumedSourceFrames > 0 && options.consumedSourceFrames < minimum) {
    throw new RangeError('consumedSourceFrames cannot describe an unconsumable prior chunk');
  }

  const expectedProduced = expectedLanczosOutputFrames({
    ...options,
    totalSourceFrames: options.consumedSourceFrames,
    startSourceFrame: 0,
  });
  if (options.producedOutputFrames !== expectedProduced) {
    throw new RangeError('producedOutputFrames does not match the pinned Lanczos stream phase');
  }

  if (!options.endOfStream) {
    return {
      kind: 'carry',
      carriedSourceFrames: options.carriedSourceFrames,
      additionalSourceFramesNeeded: minimum - options.carriedSourceFrames,
      minimumInputFrames: minimum,
    };
  }

  const total = BigInt(options.consumedSourceFrames) + BigInt(options.carriedSourceFrames);
  const totalSourceFrames = toSafeNumber(total, 'total source frame count');
  const expectedTotalOutputFrames = expectedLanczosOutputFrames({
    ...options,
    totalSourceFrames,
    startSourceFrame: 0,
  });
  const trimToOutputFrames = expectedTotalOutputFrames - options.producedOutputFrames;
  if (trimToOutputFrames < 0) {
    throw new RangeError('EOF trim cannot remove output already published by the resampler');
  }

  const maximumOutputFrames = maximumLanczosOutputFrames(minimum, options);
  if (trimToOutputFrames > maximumOutputFrames) {
    throw new RangeError('EOF trim exceeds the padded Lanczos output bound');
  }

  return {
    kind: 'pad-and-trim',
    realInputFrames: options.carriedSourceFrames,
    zeroPaddingFrames: minimum - options.carriedSourceFrames,
    paddedInputFrames: minimum,
    maximumOutputFrames,
    trimToOutputFrames,
    expectedTotalOutputFrames,
  };
}
