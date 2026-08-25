/**
 * RAM accounting for Web Audio file decoding.
 *
 * Playback remains AudioBuffer-only for sample-accurate synchronization. The
 * metadata-only HTMLAudioElement below is never played or connected to the
 * graph; it provides duration before decodeAudioData expands the whole file to
 * planar Float32 PCM. No media bytes are persisted to OPFS or IndexedDB.
 *
 * The AudioBuffer engine deliberately does not reject media from a
 * predicted device-memory budget. Browser allocation and decode failures are
 * allowed to surface naturally so conservative estimates do not reject files
 * that a particular device can actually play. The ledger remains useful for
 * ownership, cleanup, and diagnostics.
 */

import { probeAudioChannelCount } from './audio-header.ts';
import { log } from '../core/log.ts';

const MIB = 1024 * 1024;
const PCM_BYTES_PER_SAMPLE = Float32Array.BYTES_PER_ELEMENT;
const EXPECTED_SAMPLE_RATE = 48_000;
const EXPECTED_CHANNELS = 2;
const UNKNOWN_CHANNELS = 32;
const DURATION_ESTIMATE_HEADROOM = 1.25;
const UNKNOWN_DURATION_EXPANSION = 64;
const ENCODED_PEAK_COPIES = 2;
const ENCODED_RECEIVE_PEAK_COPIES = 2;
// Whole-object upload/download can overlap the source/response bytes with one
// browser-owned request or File backing, so reserve two representations.
const REMOTE_TRANSPORT_PEAK_COPIES = 2;
const METADATA_TIMEOUT_MS = 4_000;
// Effectively unbounded for every file a browser can materialize while keeping
// the accounting arithmetic finite and its invalid-number guards meaningful.
const UNBOUNDED_MEMORY_BYTES = Number.MAX_SAFE_INTEGER;

interface DecodeMemoryBudget {
  readonly tier: 'ios' | 'constrained' | 'standard' | 'high-memory';
  readonly maxDecodedPcmBytes: number;
  readonly maxDecodeWorkingSetBytes: number;
}

interface DecodeRuntimeProfile {
  readonly userAgent?: string;
  readonly deviceMemoryGiB?: number;
  readonly platform?: string;
  readonly maxTouchPoints?: number;
}

type DecodeAdmissionReason =
  | 'estimated-pcm'
  | 'working-set'
  | 'decoded-pcm'
  | 'receive-working-set'
  | 'transport-working-set';

class AudioDecodeAdmissionError extends Error {
  readonly reason: DecodeAdmissionReason;
  readonly actualBytes: number;
  readonly limitBytes: number;
  readonly fileName: string;

  constructor(
    reason: DecodeAdmissionReason,
    actualBytes: number,
    limitBytes: number,
    fileName = '',
  ) {
    const actualMiB = Math.ceil(actualBytes / MIB);
    const limitMiB = Math.floor(limitBytes / MIB);
    super(
      `Audio requires about ${actualMiB} MiB of decode memory; this device allows ${limitMiB} MiB${fileName ? ` (${fileName})` : ''}`,
    );
    this.name = 'AudioDecodeAdmissionError';
    this.reason = reason;
    this.actualBytes = actualBytes;
    this.limitBytes = limitBytes;
    this.fileName = fileName;
  }
}

type NavigatorWithDeviceMemory = Navigator & { deviceMemory?: number };

function readRuntimeProfile(): DecodeRuntimeProfile {
  if (typeof navigator === 'undefined') return {};
  const runtimeNavigator = navigator as NavigatorWithDeviceMemory;
  return {
    userAgent: runtimeNavigator.userAgent,
    deviceMemoryGiB: runtimeNavigator.deviceMemory,
    platform: runtimeNavigator.platform,
    maxTouchPoints: runtimeNavigator.maxTouchPoints,
  };
}

export function resolveDecodeMemoryBudget(
  profile: DecodeRuntimeProfile = readRuntimeProfile(),
): DecodeMemoryBudget {
  const userAgent = profile.userAgent ?? '';
  const desktopUaIpad =
    /MacIntel/i.test(profile.platform ?? '') && (profile.maxTouchPoints ?? 0) > 1;
  const ios = /iPad|iPhone|iPod/i.test(userAgent) || desktopUaIpad;
  const mobile = ios || /Android|Mobile/i.test(userAgent);
  const deviceMemory = profile.deviceMemoryGiB;
  const constrainedMemory =
    typeof deviceMemory === 'number' && Number.isFinite(deviceMemory) && deviceMemory <= 4;
  const highMemoryDesktop =
    !mobile &&
    typeof deviceMemory === 'number' &&
    Number.isFinite(deviceMemory) &&
    deviceMemory >= 8;
  let tier: DecodeMemoryBudget['tier'];

  if (ios) {
    tier = 'ios';
  } else if (mobile || constrainedMemory) {
    tier = 'constrained';
  } else if (highMemoryDesktop) {
    tier = 'high-memory';
  } else {
    tier = 'standard';
  }

  return {
    tier,
    maxDecodedPcmBytes: UNBOUNDED_MEMORY_BYTES,
    maxDecodeWorkingSetBytes: UNBOUNDED_MEMORY_BYTES,
  };
}

function hasPredictiveMemoryLimit(budget: DecodeMemoryBudget): boolean {
  return (
    budget.maxDecodedPcmBytes < UNBOUNDED_MEMORY_BYTES ||
    budget.maxDecodeWorkingSetBytes < UNBOUNDED_MEMORY_BYTES
  );
}

export function estimateDecodedPcmBytes(
  durationSeconds: number,
  outputSampleRate = EXPECTED_SAMPLE_RATE,
  channelCount = EXPECTED_CHANNELS,
): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  const safeSampleRate =
    Number.isFinite(outputSampleRate) && outputSampleRate > 0
      ? outputSampleRate
      : EXPECTED_SAMPLE_RATE;
  const safeChannels =
    Number.isFinite(channelCount) && channelCount > 0 ? Math.ceil(channelCount) : UNKNOWN_CHANNELS;
  return Math.ceil(
    durationSeconds *
      safeSampleRate *
      safeChannels *
      PCM_BYTES_PER_SAMPLE *
      DURATION_ESTIMATE_HEADROOM,
  );
}

function estimateUnknownDurationPcmBytes(encodedBytes: number): number {
  if (!Number.isFinite(encodedBytes) || encodedBytes <= 0) return 0;
  return Math.ceil(encodedBytes * UNKNOWN_DURATION_EXPANSION);
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
      try {
        media.pause();
        media.removeAttribute('src');
        media.load();
      } catch {
        // The element is already detached; cleanup remains best-effort.
      }
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
    media.muted = true;
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
const channelCountCache = new WeakMap<Blob, Promise<number | null>>();

function getProbedDuration(blob: Blob): Promise<number | null> {
  const cached = durationCache.get(blob);
  if (cached) return cached;
  const pending = probeAudioDuration(blob);
  durationCache.set(blob, pending);
  pending
    .then((duration) => {
      // A timeout/error is not authoritative. Let a later user retry probe the
      // same local File instead of pinning the conservative fallback forever.
      if (duration === null && durationCache.get(blob) === pending) durationCache.delete(blob);
    })
    .catch((error) => {
      if (durationCache.get(blob) === pending) durationCache.delete(blob);
      log.warn('[DecodeAdmission] Duration probe failed', error);
    });
  return pending;
}

function getProbedChannelCount(blob: Blob): Promise<number | null> {
  const cached = channelCountCache.get(blob);
  if (cached) return cached;
  const pending = probeAudioChannelCount(blob);
  channelCountCache.set(blob, pending);
  return pending;
}

interface DecodeAdmissionOptions {
  readonly budget?: DecodeMemoryBudget;
  readonly durationProbe?: (blob: Blob) => Promise<number | null>;
  readonly channelCountProbe?: (blob: Blob) => Promise<number | null>;
  /** decodeAudioData resamples into this AudioContext output rate. */
  readonly outputSampleRate?: number;
  readonly fileName?: string;
  readonly retainedPcmBytes?: number;
}

interface DecodeWorkingSetOptions extends Pick<
  DecodeAdmissionOptions,
  'budget' | 'fileName' | 'retainedPcmBytes'
> {
  /**
   * Lease whose projected footprint is being replaced by a measured one.
   * Every other global decode lease is included automatically exactly once.
   */
  readonly excludeDecodeReservationId?: number;
  /** RAM-store lease already represented by this decode's own Blob footprint. */
  readonly excludeEncodedReceiveReservationId?: number;
}

interface DecodeAdmission {
  readonly durationSeconds: number | null;
  readonly channelCount: number;
  readonly outputSampleRate: number;
  readonly estimatedPcmBytes: number;
  readonly ownDecodeFootprintBytes: number;
  readonly estimatedWorkingSetBytes: number;
  readonly budget: DecodeMemoryBudget;
  readonly sourceEncodedReceiveReservationId?: number;
}

interface DecodeMemoryReservation {
  readonly id: number;
  update(actualBytes: number): void;
  release(): void;
}

export interface EncodedReceiveMemoryReservation {
  readonly id: number;
  readonly encodedBytes: number;
  /** Shrink the two-copy assembly peak to the retained finalized Blob. */
  markFinalized(): void;
  release(): void;
}

export interface RemoteTransportMemoryReservation {
  /**
   * Atomically replace the two-copy whole-object transport peak with one retained
   * encoded-file lease. The returned lease must be owned by the published
   * Blob/File until that resident object is discarded.
   */
  handoffToRetainedEncoded(blob: Blob, encodedBytes?: number): EncodedReceiveMemoryReservation;
  release(): void;
}

interface EncodedReceiveReservationEntry {
  bytes: number;
  /** Only an assembling receive is expected to make progress on its own. */
  waitable: boolean;
}

const inFlightDecodeReservations = new Map<number, number>();
let nextDecodeReservationId = 1;
const inFlightRemoteTransportReservations = new Map<number, number>();
let nextRemoteTransportReservationId = 1;
const encodedReceiveReservations = new Map<number, EncodedReceiveReservationEntry>();
const encodedReceiveReservationByBlob = new WeakMap<Blob, number>();
let nextEncodedReceiveReservationId = 1;
const memoryReservationChangeWaiters = new Set<() => void>();

function notifyMemoryReservationChange(): void {
  const waiters = Array.from(memoryReservationChangeWaiters);
  memoryReservationChangeWaiters.clear();
  for (const resolve of waiters) resolve();
}

/**
 * Wait until a native decode, remote transport, or RAM-store receive lease changes.
 *
 * A projected working-set rejection can be temporary while an uncancellable
 * older decode settles. Returning false means there was no live reservation
 * to wait for, so the caller should treat the rejection as deterministic.
 */
function hasWaitableMemoryReservation(excludeEncodedReceiveReservationId?: number): boolean {
  if (inFlightDecodeReservations.size > 0 || inFlightRemoteTransportReservations.size > 0) {
    return true;
  }
  for (const [id, entry] of encodedReceiveReservations) {
    if (id !== excludeEncodedReceiveReservationId && entry.waitable) return true;
  }
  return false;
}

export function waitForInFlightMemoryReservationChange(
  signal?: AbortSignal,
  options: { excludeEncodedReceiveReservationId?: number } = {},
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (!hasWaitableMemoryReservation(options.excludeEncodedReceiveReservationId)) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (changed: boolean): void => {
      if (settled) return;
      settled = true;
      memoryReservationChangeWaiters.delete(onReservationChange);
      signal?.removeEventListener('abort', onAbort);
      resolve(changed);
    };
    const onReservationChange = (): void => finish(true);
    const onAbort = (): void => finish(false);
    memoryReservationChangeWaiters.add(onReservationChange);
    signal?.addEventListener('abort', onAbort, { once: true });
    // Keep the registration race-free if a future synchronous release hook is
    // introduced between the entry check and waiter insertion.
    if (!hasWaitableMemoryReservation(options.excludeEncodedReceiveReservationId)) {
      finish(true);
    }
  });
}

function inFlightDecodeReservationBytes(exceptId?: number): number {
  let total = 0;
  for (const [id, bytes] of inFlightDecodeReservations) {
    if (id !== exceptId) total += bytes;
  }
  return total;
}

function reserveDecodeMemory(bytes: number): DecodeMemoryReservation {
  const id = nextDecodeReservationId++;
  let released = false;
  inFlightDecodeReservations.set(id, Math.max(0, bytes));
  return {
    id,
    update(actualBytes) {
      if (!released) {
        inFlightDecodeReservations.set(id, Math.max(0, actualBytes));
        notifyMemoryReservationChange();
      }
    },
    release() {
      if (released) return;
      released = true;
      inFlightDecodeReservations.delete(id);
      notifyMemoryReservationChange();
    },
  };
}

function inFlightRemoteTransportReservationBytes(): number {
  let total = 0;
  for (const bytes of inFlightRemoteTransportReservations.values()) total += bytes;
  return total;
}

function encodedReceiveReservationBytes(exceptIds: ReadonlySet<number> = new Set()): number {
  let total = 0;
  for (const [id, entry] of encodedReceiveReservations) {
    if (!exceptIds.has(id)) total += entry.bytes;
  }
  return total;
}

function encodedReceiveExceptSet(id?: number): ReadonlySet<number> {
  return id === undefined ? new Set() : new Set([id]);
}

export function bindEncodedReceiveReservationToBlob(blob: Blob, reservationId: number): void {
  if (encodedReceiveReservations.has(reservationId)) {
    encodedReceiveReservationByBlob.set(blob, reservationId);
  }
}

export function encodedReceiveReservationIdForBlob(blob: Blob): number | undefined {
  const reservationId = encodedReceiveReservationByBlob.get(blob);
  return reservationId !== undefined && encodedReceiveReservations.has(reservationId)
    ? reservationId
    : undefined;
}

function createEncodedReceiveReservation(
  encodedBytes: number,
  initialBytes: number,
  waitable: boolean,
): EncodedReceiveMemoryReservation {
  const id = nextEncodedReceiveReservationId++;
  let released = false;
  let finalized = !waitable;
  encodedReceiveReservations.set(id, { bytes: initialBytes, waitable });
  return {
    id,
    encodedBytes,
    markFinalized() {
      if (released || finalized) return;
      finalized = true;
      encodedReceiveReservations.set(id, { bytes: encodedBytes, waitable: false });
      notifyMemoryReservationChange();
    },
    release() {
      if (released) return;
      released = true;
      encodedReceiveReservations.delete(id);
      notifyMemoryReservationChange();
    },
  };
}

interface EncodedReceiveAdmissionOptions extends Pick<
  DecodeAdmissionOptions,
  'budget' | 'fileName' | 'retainedPcmBytes'
> {
  readonly excludeReservationIds?: readonly number[];
}

/**
 * Reserve a RAM-only P2P receive before the first payload chunk is accepted.
 * Typed-array chunks and Blob construction can coexist at finalization, hence
 * the two-copy assembly peak. Once finalized, the lease shrinks to one retained
 * encoded Blob and stays live until storage cleanup/reset releases it.
 */
export function reserveEncodedReceiveMemoryWithinBudget(
  encodedBytes: number,
  options: EncodedReceiveAdmissionOptions = {},
): EncodedReceiveMemoryReservation {
  const budget = options.budget ?? resolveDecodeMemoryBudget();
  const normalizedBytes = Math.max(0, encodedBytes);
  const excluded = new Set(options.excludeReservationIds ?? []);
  const receivePeakBytes = normalizedBytes * ENCODED_RECEIVE_PEAK_COPIES;
  const estimatedWorkingSetBytes =
    Math.max(0, options.retainedPcmBytes ?? 0) +
    inFlightDecodeReservationBytes() +
    inFlightRemoteTransportReservationBytes() +
    encodedReceiveReservationBytes(excluded) +
    receivePeakBytes;
  if (
    !Number.isSafeInteger(encodedBytes) ||
    encodedBytes <= 0 ||
    !Number.isFinite(estimatedWorkingSetBytes) ||
    estimatedWorkingSetBytes > budget.maxDecodeWorkingSetBytes
  ) {
    throw new AudioDecodeAdmissionError(
      'receive-working-set',
      estimatedWorkingSetBytes,
      budget.maxDecodeWorkingSetBytes,
      options.fileName,
    );
  }

  return createEncodedReceiveReservation(normalizedBytes, receivePeakBytes, true);
}

function reserveRemoteTransportMemory(encodedBytes: number): RemoteTransportMemoryReservation {
  const id = nextRemoteTransportReservationId++;
  let released = false;
  inFlightRemoteTransportReservations.set(
    id,
    Math.max(0, encodedBytes) * REMOTE_TRANSPORT_PEAK_COPIES,
  );
  return {
    handoffToRetainedEncoded(blob, retainedBytes = encodedBytes) {
      if (released) throw new Error('REMOTE_TRANSPORT_RESERVATION_RELEASED');
      if (
        !Number.isSafeInteger(retainedBytes) ||
        retainedBytes <= 0 ||
        retainedBytes > encodedBytes
      ) {
        throw new Error('INVALID_RETAINED_ENCODED_SIZE');
      }

      // This is a strict footprint reduction (2x transport -> 1x retained),
      // so no second admission check is needed and there is no gap where both
      // ledgers omit the materialized File.
      const retained = createEncodedReceiveReservation(retainedBytes, retainedBytes, false);
      bindEncodedReceiveReservationToBlob(blob, retained.id);
      released = true;
      inFlightRemoteTransportReservations.delete(id);
      notifyMemoryReservationChange();
      return retained;
    },
    release() {
      if (released) return;
      released = true;
      inFlightRemoteTransportReservations.delete(id);
      notifyMemoryReservationChange();
    },
  };
}

function assertDecodeWorkingSetWithinBudget(
  ownDecodeFootprintBytes: number,
  options: DecodeWorkingSetOptions = {},
): number {
  const budget = options.budget ?? resolveDecodeMemoryBudget();
  const estimatedWorkingSetBytes =
    Math.max(0, options.retainedPcmBytes ?? 0) +
    inFlightDecodeReservationBytes(options.excludeDecodeReservationId) +
    inFlightRemoteTransportReservationBytes() +
    encodedReceiveReservationBytes(
      encodedReceiveExceptSet(options.excludeEncodedReceiveReservationId),
    ) +
    Math.max(0, ownDecodeFootprintBytes);
  if (
    !Number.isFinite(estimatedWorkingSetBytes) ||
    estimatedWorkingSetBytes > budget.maxDecodeWorkingSetBytes
  ) {
    throw new AudioDecodeAdmissionError(
      'working-set',
      estimatedWorkingSetBytes,
      budget.maxDecodeWorkingSetBytes,
      options.fileName,
    );
  }
  return estimatedWorkingSetBytes;
}

/** Atomically re-check the live ledger and reserve this native decode. */
export function reserveDecodeMemoryWithinBudget(
  ownDecodeFootprintBytes: number,
  options: DecodeWorkingSetOptions = {},
): DecodeMemoryReservation {
  // This synchronous check owns global-ledger accounting. Callers pass only
  // non-ledger memory (retained PCM); accepting a second "in-flight" value
  // here would make it easy to count the same decode lease twice.
  assertDecodeWorkingSetWithinBudget(ownDecodeFootprintBytes, options);
  return reserveDecodeMemory(ownDecodeFootprintBytes);
}

export async function assertBlobCanDecodeToAudioBuffer(
  blob: Blob,
  options: DecodeAdmissionOptions = {},
): Promise<DecodeAdmission> {
  const budget = options.budget ?? resolveDecodeMemoryBudget();
  const fileName =
    options.fileName ?? (typeof File !== 'undefined' && blob instanceof File ? blob.name : '');
  const retainedPcmBytes = Math.max(0, options.retainedPcmBytes ?? 0);
  const sourceEncodedReceiveReservationId = encodedReceiveReservationByBlob.get(blob);
  // The production policy is unbounded, so avoid delaying every load on
  // metadata probes whose only purpose is predictive rejection. Explicit
  // finite budgets retain the probe path for validation callers.
  const [duration, probedChannels] = hasPredictiveMemoryLimit(budget)
    ? await Promise.all([
        options.durationProbe ? options.durationProbe(blob) : getProbedDuration(blob),
        options.channelCountProbe ? options.channelCountProbe(blob) : getProbedChannelCount(blob),
      ])
    : [null, null];
  const channelCount =
    typeof probedChannels === 'number' && Number.isInteger(probedChannels) && probedChannels > 0
      ? probedChannels
      : UNKNOWN_CHANNELS;
  const outputSampleRate =
    typeof options.outputSampleRate === 'number' &&
    Number.isFinite(options.outputSampleRate) &&
    options.outputSampleRate > 0
      ? Math.max(EXPECTED_SAMPLE_RATE, options.outputSampleRate)
      : EXPECTED_SAMPLE_RATE;

  const estimatedPcmBytes = hasPredictiveMemoryLimit(budget)
    ? typeof duration === 'number' && Number.isFinite(duration) && duration > 0
      ? estimateDecodedPcmBytes(duration, outputSampleRate, channelCount)
      : estimateUnknownDurationPcmBytes(blob.size)
    : 0;

  if (estimatedPcmBytes > budget.maxDecodedPcmBytes) {
    throw new AudioDecodeAdmissionError(
      'estimated-pcm',
      estimatedPcmBytes,
      budget.maxDecodedPcmBytes,
      fileName,
    );
  }

  // During decode, a RAM-backed Blob, its ArrayBuffer copy, decoded PCM, and
  // any native buffers WebKit has not reclaimed can coexist.
  const ownDecodeFootprintBytes = estimatedPcmBytes + blob.size * ENCODED_PEAK_COPIES;
  const estimatedWorkingSetBytes = assertDecodeWorkingSetWithinBudget(ownDecodeFootprintBytes, {
    budget,
    fileName,
    retainedPcmBytes,
    excludeEncodedReceiveReservationId: sourceEncodedReceiveReservationId,
  });

  return {
    durationSeconds: duration,
    channelCount,
    outputSampleRate,
    estimatedPcmBytes,
    ownDecodeFootprintBytes,
    estimatedWorkingSetBytes,
    budget,
    sourceEncodedReceiveReservationId,
  };
}

export function assertDecodedAudioBufferWithinBudget(
  audioBuffer: Pick<AudioBuffer, 'length' | 'numberOfChannels'> &
    Partial<Pick<AudioBuffer, 'duration' | 'sampleRate'>>,
  encodedBytes: number,
  options: DecodeWorkingSetOptions = {},
): number {
  const budget = options.budget ?? resolveDecodeMemoryBudget();
  const sampleRate =
    Number.isFinite(audioBuffer.sampleRate) && (audioBuffer.sampleRate ?? 0) > 0
      ? (audioBuffer.sampleRate as number)
      : EXPECTED_SAMPLE_RATE;
  const channels =
    Number.isFinite(audioBuffer.numberOfChannels) && audioBuffer.numberOfChannels > 0
      ? audioBuffer.numberOfChannels
      : EXPECTED_CHANNELS;
  const frames =
    Number.isFinite(audioBuffer.length) && audioBuffer.length > 0
      ? audioBuffer.length
      : typeof audioBuffer.duration === 'number' &&
          Number.isFinite(audioBuffer.duration) &&
          audioBuffer.duration > 0
        ? audioBuffer.duration * sampleRate
        : Number.POSITIVE_INFINITY;
  const decodedPcmBytes = frames * channels * PCM_BYTES_PER_SAMPLE;

  if (!Number.isFinite(decodedPcmBytes) || decodedPcmBytes > budget.maxDecodedPcmBytes) {
    throw new AudioDecodeAdmissionError(
      'decoded-pcm',
      decodedPcmBytes,
      budget.maxDecodedPcmBytes,
      options.fileName,
    );
  }

  const actualFootprint = decodedPcmBytes + Math.max(0, encodedBytes) * ENCODED_PEAK_COPIES;
  assertDecodeWorkingSetWithinBudget(actualFootprint, options);
  return actualFootprint;
}

/**
 * Account for a whole-object remote upload/download before it starts allocating.
 *
 * XHR can overlap the source File/Blob or response ArrayBuffer with one
 * browser-owned request/File backing. The two-copy estimate remains useful for
 * diagnostics and explicit finite test budgets; the production policy
 * does not reject on this estimate.
 */
function assertRemoteTransportMemoryWithinBudget(
  encodedBytes: number,
  options: Pick<DecodeAdmissionOptions, 'budget' | 'fileName' | 'retainedPcmBytes'> = {},
): number {
  const budget = options.budget ?? resolveDecodeMemoryBudget();
  const retainedPcmBytes = Math.max(0, options.retainedPcmBytes ?? 0);
  const transportBytes = Math.max(0, encodedBytes) * REMOTE_TRANSPORT_PEAK_COPIES;
  const estimatedWorkingSetBytes =
    retainedPcmBytes +
    inFlightDecodeReservationBytes() +
    inFlightRemoteTransportReservationBytes() +
    encodedReceiveReservationBytes() +
    transportBytes;
  if (
    !Number.isFinite(estimatedWorkingSetBytes) ||
    estimatedWorkingSetBytes > budget.maxDecodeWorkingSetBytes
  ) {
    throw new AudioDecodeAdmissionError(
      'transport-working-set',
      estimatedWorkingSetBytes,
      budget.maxDecodeWorkingSetBytes,
      options.fileName,
    );
  }
  return estimatedWorkingSetBytes;
}

/** Atomically check all remote/decode leases and reserve this transport. */
export function reserveRemoteTransportMemoryWithinBudget(
  encodedBytes: number,
  options: Pick<DecodeAdmissionOptions, 'budget' | 'fileName' | 'retainedPcmBytes'> = {},
): RemoteTransportMemoryReservation {
  assertRemoteTransportMemoryWithinBudget(encodedBytes, options);
  return reserveRemoteTransportMemory(encodedBytes);
}

export function isAudioDecodeAdmissionError(error: unknown): error is AudioDecodeAdmissionError {
  return error instanceof AudioDecodeAdmissionError;
}

/** @internal Test-only snapshot of the global memory ledger. */
export function memoryReservationStatsForTests(): {
  decodeBytes: number;
  remoteTransportBytes: number;
  encodedReceiveBytes: number;
  encodedReceiveCount: number;
  waitableEncodedReceiveCount: number;
} {
  let encodedReceiveBytes = 0;
  let waitableEncodedReceiveCount = 0;
  for (const entry of encodedReceiveReservations.values()) {
    encodedReceiveBytes += entry.bytes;
    if (entry.waitable) waitableEncodedReceiveCount++;
  }
  return {
    decodeBytes: inFlightDecodeReservationBytes(),
    remoteTransportBytes: inFlightRemoteTransportReservationBytes(),
    encodedReceiveBytes,
    encodedReceiveCount: encodedReceiveReservations.size,
    waitableEncodedReceiveCount,
  };
}
