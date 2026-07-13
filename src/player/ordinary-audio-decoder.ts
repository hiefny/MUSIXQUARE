import * as playerState from './_state.ts';
import {
  assertBlobCanDecodeToAudioBuffer,
  assertDecodedAudioBufferWithinBudget,
  encodedReceiveReservationIdForBlob,
  isAudioDecodeAdmissionError,
  reserveDecodeMemoryWithinBudget,
  resolveDecodeMemoryBudget,
  waitForInFlightMemoryReservationChange,
} from './decode-admission.ts';
import type {
  OrdinaryAudioDecoder,
  OrdinaryAudioDecodeRequest,
  OrdinaryAudioDecodeResult,
} from './file-playback-source-factory.ts';
import { throwIfAborted } from './sources/encoded-audio-source.ts';

const ORDINARY_DECODE_REQUEST_KEYS = Object.freeze([
  'blob',
  'audioContext',
  'signal',
  'sourceIdentity',
] as const);
const ORDINARY_DECODE_OWNERSHIP_KEYS = Object.freeze([
  'assertCurrent',
  'waitForMemoryReservationChange',
] as const);
const MAX_SOURCE_IDENTITY_LENGTH = 512;
const nativeBlobArrayBuffer =
  typeof Blob === 'function' && typeof Blob.prototype.arrayBuffer === 'function'
    ? Blob.prototype.arrayBuffer
    : null;

interface OrdinaryAudioDecodeOwnership {
  /** Throw when this result may no longer be published by the caller. */
  assertCurrent(): void;
  /** Wait for an older native decode or transport lease to change. */
  waitForMemoryReservationChange(excludeEncodedReceiveReservationId?: number): Promise<boolean>;
}

interface CapturedAudioContext {
  readonly audioContext: AudioContext;
  readonly sampleRate: number;
  readonly decodeAudioData: (audioData: ArrayBuffer) => Promise<AudioBuffer>;
}

interface CapturedDecodeOwnership {
  readonly receiver: OrdinaryAudioDecodeOwnership;
  readonly assertCurrent: OrdinaryAudioDecodeOwnership['assertCurrent'];
  readonly waitForMemoryReservationChange: OrdinaryAudioDecodeOwnership['waitForMemoryReservationChange'];
}

/**
 * Detach the public decoder request without invoking accessors or inherited
 * properties. The factory normally supplies a plain literal, but this module
 * is also an independently exported product boundary.
 */
function snapshotDecodeRequest(value: unknown): OrdinaryAudioDecodeRequest {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('Ordinary audio decode request must be an exact plain record');
    }
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Ordinary audio decode request must be an exact plain record');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    const expected = new Set<string>(ORDINARY_DECODE_REQUEST_KEYS);
    if (
      ownKeys.length !== expected.size ||
      ownKeys.some((key) => typeof key !== 'string' || !expected.has(key))
    ) {
      throw new TypeError('Ordinary audio decode request has unexpected fields');
    }

    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of ORDINARY_DECODE_REQUEST_KEYS) {
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('Ordinary audio decode request fields must be enumerable data');
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot) as unknown as OrdinaryAudioDecodeRequest;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError('Ordinary audio decode request could not be inspected', { cause: error });
  }
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function assertSourceIdentity(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_SOURCE_IDENTITY_LENGTH ||
    value !== value.trim() ||
    containsControlCharacter(value)
  ) {
    throw new TypeError('Ordinary audio source identity is invalid');
  }
}

function captureAudioContext(audioContext: unknown): CapturedAudioContext {
  if (audioContext === null || typeof audioContext !== 'object') {
    throw new TypeError('Ordinary audio decode AudioContext is invalid');
  }
  const candidate = audioContext as Partial<AudioContext>;
  const sampleRate = candidate.sampleRate;
  const decodeAudioData = candidate.decodeAudioData;
  if (
    typeof sampleRate !== 'number' ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0 ||
    typeof decodeAudioData !== 'function'
  ) {
    throw new TypeError('Ordinary audio decode AudioContext is invalid');
  }
  return Object.freeze({
    audioContext: candidate as AudioContext,
    sampleRate,
    decodeAudioData,
  });
}

function assertBlob(blob: unknown): asserts blob is Blob {
  if (typeof Blob === 'undefined' || !(blob instanceof Blob)) {
    throw new TypeError('Ordinary audio decode Blob is invalid');
  }
}

function assertSignal(signal: unknown): asserts signal is AbortSignal {
  if (typeof AbortSignal === 'undefined' || !(signal instanceof AbortSignal)) {
    throw new TypeError('Ordinary audio decode AbortSignal is invalid');
  }
}

function captureOwnership(value: unknown): CapturedDecodeOwnership {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('Ordinary audio decode ownership must be an exact plain record');
    }
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Ordinary audio decode ownership must be an exact plain record');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    const expected = new Set<string>(ORDINARY_DECODE_OWNERSHIP_KEYS);
    if (
      ownKeys.length !== expected.size ||
      ownKeys.some((key) => typeof key !== 'string' || !expected.has(key))
    ) {
      throw new TypeError('Ordinary audio decode ownership has unexpected fields');
    }
    const assertCurrent = descriptors.assertCurrent;
    const waitForMemoryReservationChange = descriptors.waitForMemoryReservationChange;
    if (
      !assertCurrent ||
      assertCurrent.enumerable !== true ||
      !Object.hasOwn(assertCurrent, 'value') ||
      typeof assertCurrent.value !== 'function' ||
      !waitForMemoryReservationChange ||
      waitForMemoryReservationChange.enumerable !== true ||
      !Object.hasOwn(waitForMemoryReservationChange, 'value') ||
      typeof waitForMemoryReservationChange.value !== 'function'
    ) {
      throw new TypeError('Ordinary audio decode ownership fields must be enumerable functions');
    }
    return Object.freeze({
      receiver: value as OrdinaryAudioDecodeOwnership,
      assertCurrent: assertCurrent.value as OrdinaryAudioDecodeOwnership['assertCurrent'],
      waitForMemoryReservationChange:
        waitForMemoryReservationChange.value as OrdinaryAudioDecodeOwnership['waitForMemoryReservationChange'],
    });
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError('Ordinary audio decode ownership could not be inspected', { cause: error });
  }
}

function captureBlobArrayBuffer(blob: Blob): (this: Blob) => Promise<ArrayBuffer> {
  const ownDescriptor = Object.getOwnPropertyDescriptor(blob, 'arrayBuffer');
  if (ownDescriptor) {
    if (!Object.hasOwn(ownDescriptor, 'value') || typeof ownDescriptor.value !== 'function') {
      throw new TypeError('Ordinary audio decode Blob arrayBuffer must be a data function');
    }
    return ownDescriptor.value as (this: Blob) => Promise<ArrayBuffer>;
  }
  if (nativeBlobArrayBuffer === null) {
    throw new TypeError('Ordinary audio decode Blob cannot be read');
  }
  return nativeBlobArrayBuffer;
}

function assertCurrent(ownership: CapturedDecodeOwnership): void {
  Reflect.apply(ownership.assertCurrent, ownership.receiver, []);
}

function waitForMemoryReservationChange(
  ownership: CapturedDecodeOwnership,
  excludeEncodedReceiveReservationId?: number,
): Promise<boolean> {
  return Reflect.apply(ownership.waitForMemoryReservationChange, ownership.receiver, [
    excludeEncodedReceiveReservationId,
  ]);
}

function oneShotRelease(release: () => void): () => void {
  let ownedRelease: (() => void) | null = release;
  return () => {
    const current = ownedRelease;
    if (current === null) return;
    // Claim before invoking the ledger hook so even an exceptional cleanup
    // path cannot attempt to release the same reservation twice.
    ownedRelease = null;
    current();
  };
}

/**
 * Shared whole-Blob Web Audio decode core.
 *
 * Cancellation here is publication ownership, not native cancellation:
 * decodeAudioData has no cancellation primitive. Once native decode starts,
 * this function always awaits it and retains the admission reservation until
 * it settles. That prevents a superseding retry from overlapping hidden PCM
 * allocation, especially on iOS.
 */
export async function decodeOrdinaryAudioWithAdmission(
  blob: Blob,
  audioContext: AudioContext,
  fileName: string,
  ownership: OrdinaryAudioDecodeOwnership,
): Promise<OrdinaryAudioDecodeResult> {
  assertBlob(blob);
  const readArrayBuffer = captureBlobArrayBuffer(blob);
  const context = captureAudioContext(audioContext);
  const capturedOwnership = captureOwnership(ownership);
  assertCurrent(capturedOwnership);

  const budget = resolveDecodeMemoryBudget();
  const sourceEncodedReceiveReservationId = encodedReceiveReservationIdForBlob(blob);
  // Only iOS counts WeakRef survivors. Other tiers avoid nondeterministic GC
  // accounting while app-owned current buffers are released before entry.
  let retainedPcmBytes = budget.tier === 'ios' ? playerState.liveAudioBufferPcmBytes() : 0;
  let admission: Awaited<ReturnType<typeof assertBlobCanDecodeToAudioBuffer>>;
  let reservation: ReturnType<typeof reserveDecodeMemoryWithinBudget>;

  for (;;) {
    try {
      if (budget.tier === 'ios') retainedPcmBytes = playerState.liveAudioBufferPcmBytes();
      admission = await assertBlobCanDecodeToAudioBuffer(blob, {
        budget,
        fileName,
        retainedPcmBytes,
        outputSampleRate: context.sampleRate,
      });

      assertCurrent(capturedOwnership);
      // Admission probes are asynchronous. The synchronous ledger reservation
      // closes the same-microtask over-admission window between concurrent
      // probe continuations.
      reservation = reserveDecodeMemoryWithinBudget(admission.ownDecodeFootprintBytes, {
        budget: admission.budget,
        fileName,
        retainedPcmBytes:
          budget.tier === 'ios' ? playerState.liveAudioBufferPcmBytes() : retainedPcmBytes,
        excludeEncodedReceiveReservationId: admission.sourceEncodedReceiveReservationId,
      });
      break;
    } catch (error) {
      if (isAudioDecodeAdmissionError(error) && error.reason === 'working-set') {
        assertCurrent(capturedOwnership);
        const changed = await waitForMemoryReservationChange(
          capturedOwnership,
          sourceEncodedReceiveReservationId,
        );
        if (changed) continue;
        assertCurrent(capturedOwnership);
      }
      throw error;
    }
  }

  const release = oneShotRelease(reservation.release);
  try {
    const arrayBuffer = await Reflect.apply(readArrayBuffer, blob, []);
    assertCurrent(capturedOwnership);

    // Deliberately no timeout and no abort race: the browser cannot cancel
    // this native operation, so its reservation must remain live until settle.
    const audioBuffer = await context.decodeAudioData.call(context.audioContext, arrayBuffer);
    // WebKit may retain native PCM even when ownership changed or the measured
    // footprint is rejected. Track before either post-decode check.
    playerState.trackDecodedAudioBufferForAdmission(audioBuffer);
    assertCurrent(capturedOwnership);

    const actualFootprint = assertDecodedAudioBufferWithinBudget(audioBuffer, blob.size, {
      budget: admission.budget,
      fileName,
      retainedPcmBytes:
        budget.tier === 'ios' ? playerState.liveAudioBufferPcmBytes(audioBuffer) : retainedPcmBytes,
      excludeDecodeReservationId: reservation.id,
      excludeEncodedReceiveReservationId: admission.sourceEncodedReceiveReservationId,
    });
    reservation.update(actualFootprint);
    return Object.freeze({ audioBuffer, release });
  } catch (error) {
    release();
    throw error;
  }
}

/** Product decoder injected into createBlobFilePlaybackSource(). */
export const decodeOrdinaryAudio: OrdinaryAudioDecoder = async (
  rawRequest: OrdinaryAudioDecodeRequest,
): Promise<OrdinaryAudioDecodeResult> => {
  const request = snapshotDecodeRequest(rawRequest);
  assertBlob(request.blob);
  assertSignal(request.signal);
  assertSourceIdentity(request.sourceIdentity);
  const signal = request.signal;
  const fileName =
    typeof File !== 'undefined' && request.blob instanceof File
      ? request.blob.name
      : request.sourceIdentity;

  return decodeOrdinaryAudioWithAdmission(request.blob, request.audioContext, fileName, {
    assertCurrent: () => throwIfAborted(signal),
    waitForMemoryReservationChange: (excludeEncodedReceiveReservationId) =>
      waitForInFlightMemoryReservationChange(signal, { excludeEncodedReceiveReservationId }),
  });
};
