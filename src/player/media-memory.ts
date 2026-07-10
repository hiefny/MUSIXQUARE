/**
 * Bounded-memory policy for Web Audio playback.
 *
 * decodeAudioData() expands compressed media into planar Float32 PCM and does
 * not offer a streaming mode. A small, highly-compressed podcast can therefore
 * allocate hundreds of megabytes even when its encoded Blob looks harmless.
 * These checks reject unsafe inputs before arrayBuffer()/decodeAudioData() and
 * verify the browser's actual AudioBuffer footprint after decoding.
 */

const MIB = 1024 * 1024;
const ESTIMATED_SAMPLE_RATE = 48_000;
const ESTIMATED_CHANNELS = 2;
const FLOAT32_BYTES = 4;
const METADATA_TIMEOUT_MS = 2_500;

interface AudioMemoryBudget {
  readonly maxEncodedBytes: number;
  readonly maxDecodedBytes: number;
  readonly maxEstimatedDurationSeconds: number;
}

interface AudioRuntimeProfile {
  readonly userAgent?: string;
  readonly deviceMemoryGiB?: number;
  readonly platform?: string;
  readonly maxTouchPoints?: number;
}

type AudioMemoryLimitReason = 'encoded' | 'duration' | 'decoded';

class AudioMemoryLimitError extends Error {
  readonly reason: AudioMemoryLimitReason;
  readonly actualBytes: number;
  readonly limitBytes: number;
  readonly fileName: string;

  constructor(
    reason: AudioMemoryLimitReason,
    actualBytes: number,
    limitBytes: number,
    fileName = '',
  ) {
    super(`Audio memory budget exceeded (${reason})${fileName ? `: ${fileName}` : ''}`);
    this.name = 'AudioMemoryLimitError';
    this.reason = reason;
    this.actualBytes = actualBytes;
    this.limitBytes = limitBytes;
    this.fileName = fileName;
  }
}

type NavigatorWithDeviceMemory = Navigator & { deviceMemory?: number };

function readRuntimeProfile(): AudioRuntimeProfile {
  if (typeof navigator === 'undefined') return {};
  const runtimeNavigator = navigator as NavigatorWithDeviceMemory;
  return {
    userAgent: runtimeNavigator.userAgent,
    deviceMemoryGiB: runtimeNavigator.deviceMemory,
    platform: runtimeNavigator.platform,
    maxTouchPoints: runtimeNavigator.maxTouchPoints,
  };
}

function estimateDecodedPcmBytes(
  durationSeconds: number,
  sampleRate = ESTIMATED_SAMPLE_RATE,
  channels = ESTIMATED_CHANNELS,
): number {
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0 ||
    !Number.isFinite(channels) ||
    channels <= 0
  ) {
    return 0;
  }
  return Math.ceil(durationSeconds * sampleRate * channels * FLOAT32_BYTES);
}

function resolveAudioMemoryBudget(
  profile: AudioRuntimeProfile = readRuntimeProfile(),
): AudioMemoryBudget {
  const userAgent = profile.userAgent ?? '';
  const deviceMemory = profile.deviceMemoryGiB;
  // Modern iPadOS can advertise a desktop Macintosh UA. Touch-capable
  // MacIntel is the stable browser-side discriminator for that mode.
  const desktopUaIpad =
    /MacIntel/i.test(profile.platform ?? '') && (profile.maxTouchPoints ?? 0) > 1;
  const mobile = /Android|iPad|iPhone|iPod|Mobile/i.test(userAgent) || desktopUaIpad;
  const constrainedMemory =
    typeof deviceMemory === 'number' && Number.isFinite(deviceMemory) && deviceMemory <= 4;
  const highMemoryDesktop =
    !mobile &&
    typeof deviceMemory === 'number' &&
    Number.isFinite(deviceMemory) &&
    deviceMemory >= 8;

  let maxEncodedBytes: number;
  let maxDecodedBytes: number;
  if (mobile || constrainedMemory) {
    maxEncodedBytes = 64 * MIB;
    maxDecodedBytes = 192 * MIB;
  } else if (highMemoryDesktop) {
    maxEncodedBytes = 192 * MIB;
    maxDecodedBytes = 512 * MIB;
  } else {
    maxEncodedBytes = 128 * MIB;
    maxDecodedBytes = 384 * MIB;
  }

  return {
    maxEncodedBytes,
    maxDecodedBytes,
    maxEstimatedDurationSeconds:
      maxDecodedBytes / (ESTIMATED_SAMPLE_RATE * ESTIMATED_CHANNELS * FLOAT32_BYTES),
  };
}

interface AudioFootprintInput {
  readonly encodedBytes: number;
  readonly durationSeconds?: number | null;
  readonly decodedBytes?: number | null;
  readonly fileName?: string;
  readonly budget?: AudioMemoryBudget;
}

function validateAudioMemoryFootprint({
  encodedBytes,
  durationSeconds,
  decodedBytes,
  fileName = '',
  budget = resolveAudioMemoryBudget(),
}: AudioFootprintInput): void {
  if (!Number.isFinite(encodedBytes) || encodedBytes < 0 || encodedBytes > budget.maxEncodedBytes) {
    throw new AudioMemoryLimitError(
      'encoded',
      Number.isFinite(encodedBytes) ? encodedBytes : Number.POSITIVE_INFINITY,
      budget.maxEncodedBytes,
      fileName,
    );
  }

  if (typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)) {
    const estimatedBytes = estimateDecodedPcmBytes(durationSeconds);
    if (estimatedBytes > budget.maxDecodedBytes) {
      throw new AudioMemoryLimitError('duration', estimatedBytes, budget.maxDecodedBytes, fileName);
    }
  }

  if (
    typeof decodedBytes === 'number' &&
    (!Number.isFinite(decodedBytes) || decodedBytes < 0 || decodedBytes > budget.maxDecodedBytes)
  ) {
    throw new AudioMemoryLimitError(
      'decoded',
      Number.isFinite(decodedBytes) ? decodedBytes : Number.POSITIVE_INFINITY,
      budget.maxDecodedBytes,
      fileName,
    );
  }
}

function probeAudioDuration(blob: Blob): Promise<number | null> {
  if (
    typeof document === 'undefined' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function' ||
    (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent))
  ) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const media = document.createElement('audio');
    let objectUrl: string;
    try {
      objectUrl = URL.createObjectURL(blob);
    } catch {
      resolve(null);
      return;
    }
    let settled = false;

    const finish = (duration: number | null): void => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeoutId);
      media.removeEventListener('loadedmetadata', onLoadedMetadata);
      media.removeEventListener('error', onError);
      media.removeAttribute('src');
      URL.revokeObjectURL(objectUrl);
      resolve(duration);
    };
    const onLoadedMetadata = (): void => {
      const duration = media.duration;
      finish(Number.isFinite(duration) && duration > 0 ? duration : null);
    };
    const onError = (): void => finish(null);
    const timeoutId = globalThis.setTimeout(() => finish(null), METADATA_TIMEOUT_MS);

    media.preload = 'metadata';
    media.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
    media.addEventListener('error', onError, { once: true });
    media.src = objectUrl;
    try {
      media.load();
    } catch {
      finish(null);
    }
  });
}

const durationCache = new WeakMap<Blob, Promise<number | null>>();

function getProbedDuration(blob: Blob): Promise<number | null> {
  const cached = durationCache.get(blob);
  if (cached) return cached;
  const pending = probeAudioDuration(blob);
  durationCache.set(blob, pending);
  return pending;
}

interface AudioBlobCheckOptions {
  readonly budget?: AudioMemoryBudget;
  readonly durationProbe?: (blob: Blob) => Promise<number | null>;
  readonly fileName?: string;
}

export async function assertAudioBlobWithinMemoryBudget(
  blob: Blob,
  options: AudioBlobCheckOptions = {},
): Promise<void> {
  const budget = options.budget ?? resolveAudioMemoryBudget();
  const fileName =
    options.fileName ?? (typeof File !== 'undefined' && blob instanceof File ? blob.name : '');

  // Reject encoded-size abuse synchronously before metadata parsing or a full
  // arrayBuffer allocation.
  assertEncodedAudioWithinMemoryBudget(blob.size, fileName, budget);

  const duration = options.durationProbe
    ? await options.durationProbe(blob)
    : await getProbedDuration(blob);
  validateAudioMemoryFootprint({
    encodedBytes: blob.size,
    durationSeconds: duration,
    fileName,
    budget,
  });
}

export function assertEncodedAudioWithinMemoryBudget(
  encodedBytes: number,
  fileName = '',
  budget: AudioMemoryBudget = resolveAudioMemoryBudget(),
): void {
  validateAudioMemoryFootprint({ encodedBytes, fileName, budget });
}

export function assertDecodedAudioWithinMemoryBudget(
  audioBuffer: Pick<AudioBuffer, 'length' | 'numberOfChannels'> &
    Partial<Pick<AudioBuffer, 'duration' | 'sampleRate'>>,
  fileName = '',
  budget: AudioMemoryBudget = resolveAudioMemoryBudget(),
): void {
  const sampleRate =
    Number.isFinite(audioBuffer.sampleRate) && (audioBuffer.sampleRate ?? 0) > 0
      ? (audioBuffer.sampleRate as number)
      : ESTIMATED_SAMPLE_RATE;
  const length =
    Number.isFinite(audioBuffer.length) && audioBuffer.length > 0
      ? audioBuffer.length
      : typeof audioBuffer.duration === 'number' &&
          Number.isFinite(audioBuffer.duration) &&
          audioBuffer.duration > 0
        ? audioBuffer.duration * sampleRate
        : Number.POSITIVE_INFINITY;
  const channels =
    Number.isFinite(audioBuffer.numberOfChannels) && audioBuffer.numberOfChannels > 0
      ? audioBuffer.numberOfChannels
      : ESTIMATED_CHANNELS;
  const decodedBytes = length * channels * FLOAT32_BYTES;
  validateAudioMemoryFootprint({
    encodedBytes: 0,
    decodedBytes,
    fileName,
    budget,
  });
}

export function isAudioMemoryLimitError(error: unknown): error is AudioMemoryLimitError {
  return error instanceof AudioMemoryLimitError;
}

// Explicit unit-test seams. The production surface stays limited to the three
// assertion/predicate functions used by the decode and playlist pipelines.
export const estimateDecodedPcmBytesForTests = estimateDecodedPcmBytes;
export const resolveAudioMemoryBudgetForTests = resolveAudioMemoryBudget;
export const validateAudioMemoryFootprintForTests = validateAudioMemoryFootprint;
