const MIB = 1024 * 1024;
const FLOAT32_BYTES = Float32Array.BYTES_PER_ELEMENT;
const RENDER_QUANTUM_FRAMES = 128;

export const PCM_RING_MIN_CHANNELS = 1;
export const PCM_RING_MAX_CHANNELS = 8;
export const PCM_RING_MIN_SAMPLE_RATE_HZ = 44_100;
export const PCM_RING_MAX_SAMPLE_RATE_HZ = 768_000;
export const PCM_RING_TARGET_CAPACITY_SECONDS = 12;
export const PCM_RING_MAX_CAPACITY_SECONDS = 20;
export const PCM_RING_TARGET_PRIME_SECONDS = 4;
export const PCM_RING_MIN_PRIME_SECONDS = 1;
export const PCM_RING_HEADROOM_SECONDS = 0.25;
export const PCM_RING_DEFAULT_MAX_BYTES = 32 * MIB;
export const PCM_RING_HARD_MAX_BYTES = 64 * MIB;

const OPTION_KEYS = Object.freeze([
  'channels',
  'sampleRate',
  'capacitySeconds',
  'primeSeconds',
  'maxRingBytes',
] as const);
const REQUIRED_OPTION_KEYS = Object.freeze(['channels', 'sampleRate'] as const);

export interface PcmRingCapacityPlan {
  readonly capacityFrames: number;
  readonly primeFrames: number;
  readonly highWaterFrames: number;
  readonly allocationBytes: number;
}

type ExactOptions = Readonly<Record<(typeof OPTION_KEYS)[number], unknown>>;

function snapshotExactOptions(value: unknown): ExactOptions {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('PCM ring capacity options must be an exact plain record');
    }
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('PCM ring capacity options must be an exact plain record');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    const allowed = new Set<string>(OPTION_KEYS);
    if (
      ownKeys.some((key) => typeof key !== 'string' || !allowed.has(key)) ||
      REQUIRED_OPTION_KEYS.some((key) => !Object.hasOwn(descriptors, key))
    ) {
      throw new TypeError('PCM ring capacity options have unexpected or missing fields');
    }

    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of OPTION_KEYS) {
      const descriptor = descriptors[key];
      if (!descriptor) {
        snapshot[key] = undefined;
        continue;
      }
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('PCM ring capacity options must use enumerable data fields');
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot) as ExactOptions;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError('PCM ring capacity options could not be inspected', { cause: error });
  }
}

function requireSafeIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < minimum ||
    value > maximum
  ) {
    throw new RangeError(`${label} must be a safe integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function requireFiniteInRange(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    Object.is(value, -0) ||
    value < minimum ||
    value > maximum
  ) {
    throw new RangeError(`${label} must be a finite number from ${minimum} through ${maximum}`);
  }
  return value;
}

function optionalFiniteInRange(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  return value === undefined ? fallback : requireFiniteInRange(value, minimum, maximum, label);
}

function optionalSafeIntegerInRange(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  return value === undefined ? fallback : requireSafeIntegerInRange(value, minimum, maximum, label);
}

/**
 * Plan one planar Float32 PCM ring before the AudioWorklet allocates it.
 *
 * The duration target and byte ceiling are independent. A byte-constrained
 * ring may shorten its prime target, but never below one second and never so
 * far that less than 250 ms of refill headroom remains.
 */
export function planPcmRingCapacity(options: unknown): Readonly<PcmRingCapacityPlan> {
  const input = snapshotExactOptions(options);
  const channels = requireSafeIntegerInRange(
    input.channels,
    PCM_RING_MIN_CHANNELS,
    PCM_RING_MAX_CHANNELS,
    'channels',
  );
  const sampleRate = requireSafeIntegerInRange(
    input.sampleRate,
    PCM_RING_MIN_SAMPLE_RATE_HZ,
    PCM_RING_MAX_SAMPLE_RATE_HZ,
    'sampleRate',
  );
  const minimumCapacitySeconds = PCM_RING_MIN_PRIME_SECONDS + PCM_RING_HEADROOM_SECONDS;
  const capacitySeconds = optionalFiniteInRange(
    input.capacitySeconds,
    PCM_RING_TARGET_CAPACITY_SECONDS,
    minimumCapacitySeconds,
    PCM_RING_MAX_CAPACITY_SECONDS,
    'capacitySeconds',
  );
  const primeSeconds = optionalFiniteInRange(
    input.primeSeconds,
    PCM_RING_TARGET_PRIME_SECONDS,
    PCM_RING_MIN_PRIME_SECONDS,
    PCM_RING_MAX_CAPACITY_SECONDS,
    'primeSeconds',
  );
  const maxRingBytes = optionalSafeIntegerInRange(
    input.maxRingBytes,
    PCM_RING_DEFAULT_MAX_BYTES,
    1,
    PCM_RING_HARD_MAX_BYTES,
    'maxRingBytes',
  );

  const bytesPerFrame = channels * FLOAT32_BYTES;
  const durationFrames = Math.floor(sampleRate * capacitySeconds);
  const byteFrames = Math.floor(maxRingBytes / bytesPerFrame);
  const capacityFrames = Math.min(durationFrames, byteFrames);
  const minimumPrimeFrames = Math.ceil(sampleRate * PCM_RING_MIN_PRIME_SECONDS);
  const headroomFrames = Math.max(
    RENDER_QUANTUM_FRAMES,
    Math.ceil(sampleRate * PCM_RING_HEADROOM_SECONDS),
  );
  const maximumPrimeFrames = capacityFrames - headroomFrames;
  if (maximumPrimeFrames < minimumPrimeFrames) {
    throw new RangeError('maxRingBytes cannot hold the minimum PCM prime and refill headroom');
  }

  const desiredPrimeFrames = Math.floor(sampleRate * primeSeconds);
  const primeFrames = Math.min(
    Math.max(desiredPrimeFrames, minimumPrimeFrames),
    maximumPrimeFrames,
  );
  const highWaterFrames = Math.max(primeFrames, Math.floor(capacityFrames * 0.8));
  const allocationBytes = capacityFrames * bytesPerFrame;

  if (
    !Number.isSafeInteger(capacityFrames) ||
    !Number.isSafeInteger(primeFrames) ||
    !Number.isSafeInteger(highWaterFrames) ||
    !Number.isSafeInteger(allocationBytes) ||
    capacityFrames <= 0 ||
    primeFrames < minimumPrimeFrames ||
    primeFrames > maximumPrimeFrames ||
    highWaterFrames < primeFrames ||
    highWaterFrames > capacityFrames ||
    allocationBytes > maxRingBytes
  ) {
    throw new RangeError('PCM ring capacity plan is outside its numeric bounds');
  }

  return Object.freeze({
    capacityFrames,
    primeFrames,
    highWaterFrames,
    allocationBytes,
  });
}
