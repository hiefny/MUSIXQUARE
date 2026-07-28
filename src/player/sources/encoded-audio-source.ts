/**
 * Random-access encoded media contract used by playback decoders.
 *
 * Implementations may retain browser or network resources, but media bytes
 * remain RAM-only and every read is exact, bounded, and abort-aware.
 */

export type EncodedAudioSourceKind = 'blob' | 'peer-range' | 'r2-records';
export const ENCODED_AUDIO_SOURCE_MAX_IDENTITY_LENGTH = 512;

export interface EncodedAudioSourceMetadata {
  readonly name: string;
  readonly mime: string;
}

/**
 * Narrow random-access byte authority consumed by codec readers.
 *
 * Worker-side MessagePort facades intentionally implement only this contract:
 * transport kind and presentation metadata belong to the owning main-thread
 * source and must not be invented after it crosses the port boundary.
 */
export interface EncodedRandomAccessSource {
  readonly size: number;
  /** Immutable identity for this exact byte source, never filename-derived. */
  readonly identity: string;

  /**
   * Read exactly `length` bytes from `offset`.
   *
   * A request outside `[0, size]`, a short transport response, a closed
   * source, or an aborted signal rejects instead of returning partial bytes.
   */
  readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** Main-thread encoded media source with transport and presentation metadata. */
export interface EncodedAudioSource extends EncodedRandomAccessSource {
  readonly kind: EncodedAudioSourceKind;
  readonly metadata: EncodedAudioSourceMetadata;
}

export function isEncodedAudioSourceIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= ENCODED_AUDIO_SOURCE_MAX_IDENTITY_LENGTH
  );
}

export class EncodedSourceClosedError extends Error {
  constructor() {
    super('Encoded audio source is closed');
    this.name = 'EncodedSourceClosedError';
  }
}

export class EncodedSourceRangeError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'EncodedSourceRangeError';
  }
}

export class EncodedSourceIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncodedSourceIntegrityError';
  }
}

/** A transient source-level capacity limit; callers may retry later. */
export class EncodedSourceBusyError extends Error {
  constructor(message = 'Encoded audio source read capacity is exhausted') {
    super(message);
    this.name = 'EncodedSourceBusyError';
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  throw new DOMException('The encoded audio read was aborted', 'AbortError');
}

export function validateExactRead(size: number, offset: number, length: number): number {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new EncodedSourceRangeError('Source size must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new EncodedSourceRangeError('Read offset must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new EncodedSourceRangeError('Read length must be a non-negative safe integer');
  }
  const end = offset + length;
  if (!Number.isSafeInteger(end) || end > size) {
    throw new EncodedSourceRangeError(`Read [${offset}, ${end}) exceeds source size ${size}`);
  }
  return end;
}
