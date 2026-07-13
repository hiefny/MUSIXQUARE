import { IsoBmffBoxReader, ISO_BMFF_MAX_BOUNDED_READ_BYTES } from '../mp4/box-reader.ts';
import {
  EncodedSourceBusyError,
  EncodedSourceIntegrityError,
} from '../sources/encoded-audio-source.ts';
import {
  assertM4aChunkIndexSampleSizePair,
  createM4aChunkOffsetSequence,
  locateM4aAacAccessUnit,
  type M4aChunkIndex,
  type M4aChunkOffsetSequence,
  type M4aNormalizedChunkRun,
} from './chunk-index.ts';
import {
  createM4aSampleSizeSequence,
  type M4aSampleSizeIndex,
  type M4aSampleSizeSequence,
} from './sample-size-index.ts';

export const M4A_RAW_AAC_MEDIA_CACHE_MAX_BYTES = ISO_BMFF_MAX_BOUNDED_READ_BYTES;
const trustedAbortThrowIfAborted = AbortSignal.prototype.throwIfAborted;
const trustedAbortAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
const trustedAbortReason = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason')?.get;
const trustedEventTargetAdd = EventTarget.prototype.addEventListener;
const trustedEventTargetRemove = EventTarget.prototype.removeEventListener;

function readAbortReason(signal: AbortSignal): unknown {
  try {
    return trustedAbortReason ? Reflect.apply(trustedAbortReason, signal, []) : signal.reason;
  } catch (error) {
    return error;
  }
}

function isAborted(signal: AbortSignal): boolean {
  return trustedAbortAborted
    ? Reflect.apply(trustedAbortAborted, signal, []) === true
    : signal.aborted;
}

function throwIfReaderAborted(signal: AbortSignal): void {
  if (typeof trustedAbortThrowIfAborted === 'function') {
    Reflect.apply(trustedAbortThrowIfAborted, signal, []);
    return;
  }
  if (!isAborted(signal)) return;
  const reason = readAbortReason(signal);
  throw reason === undefined
    ? new DOMException('The M4A raw AAC access-unit read was aborted', 'AbortError')
    : reason;
}

export interface M4aRawAacAccessUnitDescriptor {
  readonly ordinal: number;
  readonly sourceOffset: number;
  readonly byteLength: number;
  readonly chunkOrdinal: number;
  /** Logical `stsz` byte prefix before this access unit. */
  readonly encodedBytePrefix: number;
}

export interface M4aRawAacAccessUnitRead {
  /** Caller-owned bytes that never alias the reader's bounded media cache. */
  readonly bytes: Uint8Array;
  readonly descriptor: Readonly<M4aRawAacAccessUnitDescriptor>;
}

/** Source-bound, forward-only raw AAC access-unit reader for one M4A runtime. */
export interface M4aRawAacAccessUnitReader {
  readonly nextAccessUnitOrdinal: number;
  /** Absolute logical `stsz` prefix consumed before the next access unit. */
  readonly consumedEncodedBytes: number;
  readNext(signal: AbortSignal): Promise<Readonly<M4aRawAacAccessUnitRead> | null>;
  /** Release cursor authority without closing the caller-owned encoded source. */
  close(): void;
}

export class M4aRawAacAccessUnitReaderError extends EncodedSourceIntegrityError {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'M4aRawAacAccessUnitReaderError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', { configurable: true, value: cause });
    }
  }
}

export class M4aRawAacAccessUnitReaderClosedError extends Error {
  constructor() {
    super('M4A raw AAC access-unit reader is closed');
    this.name = 'M4aRawAacAccessUnitReaderClosedError';
  }
}

const rawAccessUnitReaderClosers = new WeakMap<object, () => void>();
const closedRawAccessUnitReaders = new WeakSet<object>();

/**
 * Revoke an exact module-issued cursor without trusting its mutable public
 * `close` property or prototype. Runtime ownership must use this boundary.
 */
export function closeM4aRawAacAccessUnitReader(readerValue: unknown): void {
  const isObject =
    readerValue !== null && (typeof readerValue === 'object' || typeof readerValue === 'function');
  if (isObject && closedRawAccessUnitReaders.has(readerValue)) return;
  const close = isObject ? rawAccessUnitReaderClosers.get(readerValue) : undefined;
  if (close === undefined) {
    throw new TypeError('M4A raw AAC access-unit reader lacks module provenance');
  }
  close();
  rawAccessUnitReaderClosers.delete(readerValue as object);
  closedRawAccessUnitReaders.add(readerValue as object);
}

interface CursorPosition {
  readonly ordinal: number;
  readonly consumedEncodedBytes: number;
  readonly chunkOrdinal: number;
  readonly chunkFirstAccessUnitOrdinal: number;
  readonly chunkEndAccessUnitOrdinalExclusive: number;
  readonly chunkOffset: number | null;
  readonly sourceOffset: number | null;
  readonly mediaDataEnd: number | null;
}

interface MediaReadCandidate {
  readonly bytes: Uint8Array;
  /** A newly read page that may become the sole cache only after cursor commit. */
  readonly pendingCache: Readonly<{ readonly offset: number; readonly bytes: Uint8Array }> | null;
}

interface ActiveReadOperation {
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  readonly detachCallerAbort: () => void;
}

function readerError(message: string, cause?: unknown): M4aRawAacAccessUnitReaderError {
  return new M4aRawAacAccessUnitReaderError(message, cause);
}

function requireStartOrdinal(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < 0
  ) {
    throw new RangeError('M4A raw AAC start ordinal must be a non-negative safe integer');
  }
  return value;
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw readerError(`${label} exceeds the browser safe-integer range`);
  }
  return result;
}

function findRunForChunk(
  runs: readonly Readonly<M4aNormalizedChunkRun>[],
  chunkOrdinal: number,
): Readonly<M4aNormalizedChunkRun> {
  const oneBasedChunk = chunkOrdinal + 1;
  let low = 0;
  let high = runs.length;
  while (low + 1 < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (runs[middle]!.firstChunk <= oneBasedChunk) low = middle;
    else high = middle;
  }
  const run = runs[low];
  if (!run || oneBasedChunk < run.firstChunk || oneBasedChunk >= run.endChunkExclusive) {
    throw readerError(`M4A chunk ${chunkOrdinal} is not covered by canonical stsc geometry`);
  }
  return run;
}

function findMediaDataEnd(
  chunks: Readonly<M4aChunkIndex>,
  start: number,
  byteLength: number,
  ordinal: number,
): number {
  if (byteLength < 1) {
    throw readerError(`M4A raw AAC access unit ${ordinal} must contain at least one byte`);
  }
  const end = safeAdd(start, byteLength, `M4A raw AAC access unit ${ordinal} end`);
  const range = chunks.mediaDataRanges.find(
    (candidate) => start >= candidate.start && end <= candidate.end,
  );
  if (!range) {
    throw readerError(
      `M4A raw AAC access unit ${ordinal} is not wholly contained by one canonical mdat payload`,
    );
  }
  return range.end;
}

function terminalPosition(
  sampleSizes: Readonly<M4aSampleSizeIndex>,
  chunks: Readonly<M4aChunkIndex>,
): CursorPosition {
  return Object.freeze({
    ordinal: sampleSizes.sampleCount,
    consumedEncodedBytes: sampleSizes.totalEncodedBytes,
    chunkOrdinal: chunks.chunkCount,
    chunkFirstAccessUnitOrdinal: sampleSizes.sampleCount,
    chunkEndAccessUnitOrdinalExclusive: sampleSizes.sampleCount,
    chunkOffset: null,
    sourceOffset: null,
    mediaDataEnd: null,
  });
}

class SourceBoundM4aRawAacAccessUnitReader implements M4aRawAacAccessUnitReader {
  #position: CursorPosition;
  #reader: IsoBmffBoxReader | null;
  #sampleSizes: Readonly<M4aSampleSizeIndex> | null;
  #chunks: Readonly<M4aChunkIndex> | null;
  #sampleSizeSequence: M4aSampleSizeSequence | null;
  #chunkOffsetSequence: M4aChunkOffsetSequence | null;
  #needsReseed = false;
  #reading = false;
  #activeRead: ActiveReadOperation | null = null;
  #closed = false;
  readonly #closedError = new M4aRawAacAccessUnitReaderClosedError();
  #fatalError: unknown = null;
  #hasFatalError = false;
  #cacheOffset = 0;
  #cache: Uint8Array = new Uint8Array(0);

  constructor(
    reader: IsoBmffBoxReader,
    sampleSizes: Readonly<M4aSampleSizeIndex>,
    chunks: Readonly<M4aChunkIndex>,
    position: CursorPosition,
    sampleSizeSequence: M4aSampleSizeSequence,
    chunkOffsetSequence: M4aChunkOffsetSequence,
  ) {
    this.#reader = reader;
    this.#sampleSizes = sampleSizes;
    this.#chunks = chunks;
    this.#position = position;
    this.#sampleSizeSequence = sampleSizeSequence;
    this.#chunkOffsetSequence = chunkOffsetSequence;
    rawAccessUnitReaderClosers.set(this, () => this.#closeIssuedReader());
  }

  get nextAccessUnitOrdinal(): number {
    return this.#position.ordinal;
  }

  get consumedEncodedBytes(): number {
    return this.#position.consumedEncodedBytes;
  }

  readNext(signal: AbortSignal): Promise<Readonly<M4aRawAacAccessUnitRead> | null> {
    if (!(signal instanceof AbortSignal)) {
      return Promise.reject(new TypeError('M4A raw AAC access-unit read requires an AbortSignal'));
    }
    if (this.#closed) return Promise.reject(this.#closedError);
    if (this.#hasFatalError) return Promise.reject(this.#fatalError);
    try {
      throwIfReaderAborted(signal);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.#reading) {
      return Promise.reject(
        readerError('Concurrent or reentrant M4A raw AAC access-unit reads are not supported'),
      );
    }

    const controller = new AbortController();
    const operationSignal = controller.signal;
    if (!Reflect.preventExtensions(operationSignal)) {
      return Promise.reject(
        readerError('M4A raw AAC read cancellation signal could not be sealed'),
      );
    }
    const forwardCallerAbort = (): void => {
      controller.abort(readAbortReason(signal));
    };
    let listenerInstalled = false;
    const detachCallerAbort = (): void => {
      if (!listenerInstalled) return;
      listenerInstalled = false;
      try {
        Reflect.apply(trustedEventTargetRemove, signal, ['abort', forwardCallerAbort]);
      } catch {
        // Native detachment is noexcept for the validated AbortSignal. A
        // secondary environment failure cannot break read cleanup.
      }
    };
    try {
      Reflect.apply(trustedEventTargetAdd, signal, ['abort', forwardCallerAbort, { once: true }]);
      listenerInstalled = true;
      if (isAborted(signal)) forwardCallerAbort();
      throwIfReaderAborted(operationSignal);
    } catch (error) {
      detachCallerAbort();
      return Promise.reject(error);
    }
    const operation: ActiveReadOperation = Object.freeze({
      controller,
      signal: operationSignal,
      detachCallerAbort,
    });
    this.#reading = true;
    this.#activeRead = operation;
    return this.#readNext(operationSignal)
      .catch((error: unknown) => {
        if (isAborted(operationSignal)) {
          if (!this.#closed) this.#needsReseed = true;
          // Source stability checks may reentrantly abort while returning a
          // secondary integrity error. Cancellation keeps exact precedence.
          throwIfReaderAborted(operationSignal);
          throw error;
        }
        if (this.#closed) throw this.#closedError;
        if (error instanceof EncodedSourceBusyError) {
          this.#needsReseed = true;
          throw error;
        }
        this.#hasFatalError = true;
        this.#fatalError = error;
        this.#clearCache();
        throw error;
      })
      .finally(() => {
        detachCallerAbort();
        if (this.#activeRead === operation) this.#activeRead = null;
        this.#reading = false;
      });
  }

  close(): void {
    closeM4aRawAacAccessUnitReader(this);
  }

  #closeIssuedReader(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#activeRead !== null) {
      this.#activeRead.controller.abort(this.#closedError);
      this.#activeRead.detachCallerAbort();
      this.#activeRead = null;
    }
    this.#needsReseed = false;
    this.#hasFatalError = false;
    this.#fatalError = null;
    this.#clearCache();
    // A caller may retain a closed cursor indefinitely. Drop every authority
    // that can otherwise keep the borrowed source and authenticated tables live.
    this.#sampleSizeSequence = null;
    this.#chunkOffsetSequence = null;
    this.#sampleSizes = null;
    this.#chunks = null;
    this.#reader = null;
  }

  async #readNext(signal: AbortSignal): Promise<Readonly<M4aRawAacAccessUnitRead> | null> {
    let reader = this.#reader;
    if (reader === null) throw this.#closedError;
    reader.assertReadable(signal);
    if (this.#closed) throw this.#closedError;
    if (this.#needsReseed) this.#reseed();
    reader = this.#reader;
    const sampleSizes = this.#sampleSizes;
    const chunks = this.#chunks;
    const sampleSizeSequence = this.#sampleSizeSequence;
    const chunkOffsetSequence = this.#chunkOffsetSequence;
    if (
      reader === null ||
      sampleSizes === null ||
      chunks === null ||
      sampleSizeSequence === null ||
      chunkOffsetSequence === null
    ) {
      throw this.#closedError;
    }
    const position = this.#position;
    if (position.ordinal === sampleSizes.sampleCount) return null;

    const byteLength = await sampleSizeSequence.sumNext(1, signal);
    if (this.#closed) throw this.#closedError;
    let chunkOffset = position.chunkOffset;
    let sourceOffset = position.sourceOffset;
    let mediaDataEnd = position.mediaDataEnd;
    if (chunkOffset === null || sourceOffset === null || mediaDataEnd === null) {
      const candidate = await chunkOffsetSequence.readNext(signal);
      if (candidate === null) {
        throw readerError('M4A chunk-offset sequence ended before the access-unit sequence');
      }
      if (this.#closed) throw this.#closedError;
      chunkOffset = candidate;
      sourceOffset = candidate;
      mediaDataEnd = findMediaDataEnd(chunks, sourceOffset, byteLength, position.ordinal);
    } else {
      const authenticatedMediaDataEnd = findMediaDataEnd(
        chunks,
        sourceOffset,
        byteLength,
        position.ordinal,
      );
      if (authenticatedMediaDataEnd !== mediaDataEnd) {
        throw readerError('M4A raw AAC cursor changed canonical mdat containment');
      }
    }

    if (
      position.ordinal < position.chunkFirstAccessUnitOrdinal ||
      position.ordinal >= position.chunkEndAccessUnitOrdinalExclusive
    ) {
      throw readerError('M4A raw AAC cursor has inconsistent chunk access-unit geometry');
    }

    const media = await this.#readMedia(reader, sourceOffset, byteLength, mediaDataEnd, signal);
    try {
      if (this.#closed) throw this.#closedError;
      reader.assertReadable(signal);
      // `assertReadable()` revalidates caller-owned getters, which may abort
      // reentrantly while still returning stable values.
      throwIfReaderAborted(signal);

      const descriptor = Object.freeze({
        ordinal: position.ordinal,
        sourceOffset,
        byteLength,
        chunkOrdinal: position.chunkOrdinal,
        encodedBytePrefix: position.consumedEncodedBytes,
      });
      const nextOrdinal = position.ordinal + 1;
      const nextConsumedEncodedBytes = safeAdd(
        position.consumedEncodedBytes,
        byteLength,
        'M4A consumed encoded-byte prefix',
      );
      let nextPosition: CursorPosition;
      if (nextOrdinal === sampleSizes.sampleCount) {
        if (nextConsumedEncodedBytes !== sampleSizes.totalEncodedBytes) {
          throw readerError('M4A raw AAC EOF contradicts the authenticated encoded-byte total');
        }
        nextPosition = terminalPosition(sampleSizes, chunks);
      } else if (nextOrdinal < position.chunkEndAccessUnitOrdinalExclusive) {
        nextPosition = Object.freeze({
          ...position,
          ordinal: nextOrdinal,
          consumedEncodedBytes: nextConsumedEncodedBytes,
          chunkOffset,
          sourceOffset: safeAdd(sourceOffset, byteLength, 'M4A next raw AAC source offset'),
          mediaDataEnd,
        });
      } else if (nextOrdinal === position.chunkEndAccessUnitOrdinalExclusive) {
        const nextChunkOrdinal = position.chunkOrdinal + 1;
        const nextRun = findRunForChunk(chunks.runs, nextChunkOrdinal);
        const expectedNextOrdinal = safeAdd(
          nextRun.firstSampleOrdinal,
          (nextChunkOrdinal + 1 - nextRun.firstChunk) * nextRun.samplesPerChunk,
          'M4A next chunk first access-unit ordinal',
        );
        if (expectedNextOrdinal !== nextOrdinal) {
          throw readerError('M4A next chunk first access-unit ordinal contradicts stsc geometry');
        }
        const nextChunkEnd = safeAdd(
          nextOrdinal,
          nextRun.samplesPerChunk,
          'M4A next chunk access-unit end',
        );
        if (nextChunkEnd > sampleSizes.sampleCount) {
          throw readerError('M4A next chunk exceeds the authenticated access-unit count');
        }
        nextPosition = Object.freeze({
          ordinal: nextOrdinal,
          consumedEncodedBytes: nextConsumedEncodedBytes,
          chunkOrdinal: nextChunkOrdinal,
          chunkFirstAccessUnitOrdinal: nextOrdinal,
          chunkEndAccessUnitOrdinalExclusive: nextChunkEnd,
          chunkOffset: null,
          sourceOffset: null,
          mediaDataEnd: null,
        });
      } else {
        throw readerError('M4A raw AAC cursor advanced beyond its current chunk');
      }

      if (this.#closed) throw this.#closedError;
      const result = Object.freeze({ bytes: media.bytes, descriptor });
      // Publish cursor state before replacing the sole persistent media cache.
      this.#position = nextPosition;
      this.#needsReseed = false;
      if (media.pendingCache !== null) {
        this.#clearCache();
        this.#cacheOffset = media.pendingCache.offset;
        this.#cache = media.pendingCache.bytes;
      }
      return result;
    } catch (error) {
      media.bytes.fill(0);
      media.pendingCache?.bytes.fill(0);
      throw error;
    }
  }

  #reseed(): void {
    const position = this.#position;
    const reader = this.#reader;
    const sampleSizes = this.#sampleSizes;
    const chunks = this.#chunks;
    if (reader === null || sampleSizes === null || chunks === null) throw this.#closedError;
    const sampleSizeSequence = createM4aSampleSizeSequence(reader, sampleSizes, position.ordinal);
    if (this.#closed) throw this.#closedError;
    const chunkOffsetSequence = createM4aChunkOffsetSequence(
      reader,
      chunks,
      position.chunkOffset === null ? position.chunkOrdinal : position.chunkOrdinal + 1,
    );
    if (this.#closed) throw this.#closedError;
    this.#sampleSizeSequence = sampleSizeSequence;
    this.#chunkOffsetSequence = chunkOffsetSequence;
    this.#needsReseed = false;
  }

  async #readMedia(
    reader: IsoBmffBoxReader,
    sourceOffset: number,
    byteLength: number,
    mediaDataEnd: number,
    signal: AbortSignal,
  ): Promise<MediaReadCandidate> {
    const end = safeAdd(sourceOffset, byteLength, 'M4A raw AAC media read end');
    const cacheEnd = this.#cacheOffset + this.#cache.byteLength;
    if (sourceOffset >= this.#cacheOffset && end <= cacheEnd) {
      return Object.freeze({
        bytes: this.#cache.slice(sourceOffset - this.#cacheOffset, end - this.#cacheOffset),
        pendingCache: null,
      });
    }
    if (end > mediaDataEnd) {
      throw readerError('M4A raw AAC media read crosses its canonical mdat payload');
    }
    const readLength = Math.min(M4A_RAW_AAC_MEDIA_CACHE_MAX_BYTES, mediaDataEnd - sourceOffset);
    if (readLength < byteLength) {
      throw readerError('M4A raw AAC media cache cannot contain the complete access unit');
    }
    const page = await reader.readBytes(sourceOffset, readLength, signal);
    try {
      reader.assertReadable(signal);
      if (this.#closed) throw this.#closedError;
      return Object.freeze({
        bytes: page.slice(0, byteLength),
        pendingCache: Object.freeze({ offset: sourceOffset, bytes: page }),
      });
    } catch (error) {
      page.fill(0);
      throw error;
    }
  }

  #clearCache(): void {
    this.#cache.fill(0);
    this.#cache = new Uint8Array(0);
    this.#cacheOffset = 0;
  }
}

/**
 * Open a bounded raw-AAC cursor at any authenticated access-unit ordinal.
 *
 * The ISO BMFF reader and its encoded source remain caller-owned. The random
 * locator is used once to seed logical and physical chunk geometry; subsequent
 * reads combine authenticated forward table cursors and never infer physical
 * contiguity between chunks.
 */
export async function openSourceBoundM4aRawAacAccessUnitReader(
  reader: IsoBmffBoxReader,
  sampleSizes: Readonly<M4aSampleSizeIndex>,
  chunks: Readonly<M4aChunkIndex>,
  startOrdinal: number,
  signal: AbortSignal,
): Promise<M4aRawAacAccessUnitReader> {
  if (!(signal instanceof AbortSignal)) {
    throw new TypeError('M4A raw AAC access-unit reader requires an AbortSignal');
  }
  throwIfReaderAborted(signal);
  if (!(reader instanceof IsoBmffBoxReader)) {
    throw new TypeError('M4A raw AAC access-unit reader requires an IsoBmffBoxReader');
  }
  const ordinal = requireStartOrdinal(startOrdinal);
  assertM4aChunkIndexSampleSizePair(reader, chunks, sampleSizes, signal);
  const sampleSizeSequence = createM4aSampleSizeSequence(reader, sampleSizes, ordinal);
  // Authenticate the exact chunk authority before reading any caller-visible fields.
  createM4aChunkOffsetSequence(reader, chunks, 0);
  if (sampleSizes.sampleCount !== chunks.sampleCount) {
    throw readerError('M4A raw AAC sample-size and chunk indexes disagree on access-unit count');
  }

  if (ordinal === sampleSizes.sampleCount) {
    reader.assertReadable(signal);
    return new SourceBoundM4aRawAacAccessUnitReader(
      reader,
      sampleSizes,
      chunks,
      terminalPosition(sampleSizes, chunks),
      sampleSizeSequence,
      createM4aChunkOffsetSequence(reader, chunks, chunks.chunkCount),
    );
  }

  const location = await locateM4aAacAccessUnit(reader, chunks, ordinal, signal);
  reader.assertReadable(signal);
  return new SourceBoundM4aRawAacAccessUnitReader(
    reader,
    sampleSizes,
    chunks,
    Object.freeze({
      ordinal,
      consumedEncodedBytes: location.encodedBytePrefix,
      chunkOrdinal: location.chunkOrdinal,
      chunkFirstAccessUnitOrdinal: location.chunkFirstAccessUnitOrdinal,
      chunkEndAccessUnitOrdinalExclusive: location.chunkEndAccessUnitOrdinalExclusive,
      chunkOffset: location.chunkOffset,
      sourceOffset: location.offset,
      mediaDataEnd: location.mediaDataEnd,
    }),
    sampleSizeSequence,
    createM4aChunkOffsetSequence(reader, chunks, location.chunkOrdinal + 1),
  );
}
