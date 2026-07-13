import {
  type EncodedRandomAccessSource,
  isEncodedAudioSourceIdentity,
  throwIfAborted,
  validateExactRead,
} from '../sources/encoded-audio-source.ts';
import {
  ISO_BMFF_BASE_BOX_HEADER_BYTES,
  ISO_BMFF_MAX_BOX_HEADER_BYTES,
  IsoBmffBoxError,
  type IsoBmffBoxRef,
  parseIsoBmffBoxHeader,
  requiredIsoBmffBoxHeaderBytes,
} from './box.ts';

export const ISO_BMFF_DEFAULT_MAX_BOXES = 1_024;
export const ISO_BMFF_HARD_MAX_BOXES = 8_192;
export const ISO_BMFF_MAX_BOUNDED_READ_BYTES = 64 * 1_024;
export const ISO_BMFF_MAX_HEADER_TAIL_READ_BYTES =
  ISO_BMFF_MAX_BOX_HEADER_BYTES - ISO_BMFF_BASE_BOX_HEADER_BYTES;

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

interface SourceSnapshot {
  readonly authority: EncodedRandomAccessSource;
  readonly size: number;
  readonly identity: string;
  readonly readAt: EncodedRandomAccessSource['readAt'];
}

export interface IsoBmffBoxReaderOptions {
  /** Shared across every direct read and cursor created by this reader. */
  readonly maxBoxes?: number;
}

export interface IsoBmffBoxReadOptions {
  readonly parentStart: number;
  readonly parentEnd: number;
  readonly start: number;
  readonly allowExtendsToEnd?: boolean;
}

export interface IsoBmffBoxCursorOptions {
  /** Absolute first sibling offset. Defaults to zero. */
  readonly start?: number;
  /** Exclusive sibling-span end. Defaults to the physical source size. */
  readonly end?: number;
  /** Defaults to false, including for nested cursors. */
  readonly allowExtendsToEnd?: boolean;
}

export interface IsoBmffChildCursorOptions {
  /** Absolute first child offset. Defaults to parent.dataStart. */
  readonly start?: number;
  /** Exclusive child-span end. Defaults to parent.end. */
  readonly end?: number;
  /** Defaults to false. */
  readonly allowExtendsToEnd?: boolean;
}

function requireSafeInteger(
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

function requireOptionalBoolean(value: unknown, label: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`);
  return value;
}

function snapshotSource(value: unknown): SourceSnapshot {
  try {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
      throw new TypeError('ISO BMFF reader requires an encoded random-access source');
    }
    const authority = value as EncodedRandomAccessSource;
    const size = authority.size;
    const identity = authority.identity;
    const readAt = authority.readAt;
    const close = authority.close;
    validateExactRead(size, 0, 0);
    if (!isEncodedAudioSourceIdentity(identity)) {
      throw new TypeError('ISO BMFF encoded source identity is invalid');
    }
    if (typeof readAt !== 'function' || typeof close !== 'function') {
      throw new TypeError('ISO BMFF encoded source methods are invalid');
    }
    return Object.freeze({ authority, size, identity, readAt });
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) throw error;
    throw new TypeError('ISO BMFF encoded source could not be inspected safely', { cause: error });
  }
}

function snapshotExactRead(value: unknown, expectedLength: number): Uint8Array {
  if (
    !typedArrayByteLengthGetter ||
    !typedArrayBufferGetter ||
    !typedArrayTagGetter ||
    !arrayBufferByteLengthGetter ||
    !arrayBufferIsView(value)
  ) {
    throw new IsoBmffBoxError('ISO BMFF source returned invalid bytes');
  }

  let byteLength: number;
  try {
    if (typedArrayTagGetter.call(value) !== 'Uint8Array') {
      throw new TypeError('not a Uint8Array');
    }
    byteLength = typedArrayByteLengthGetter.call(value);
    const buffer = typedArrayBufferGetter.call(value);
    arrayBufferByteLengthGetter.call(buffer);
  } catch (error) {
    throw new IsoBmffBoxError(
      'ISO BMFF source result must be a readable non-shared Uint8Array',
      error,
    );
  }
  if (byteLength !== expectedLength) {
    throw new IsoBmffBoxError(
      `ISO BMFF source returned ${byteLength} bytes; expected ${expectedLength}`,
    );
  }

  const owned = new Uint8ArrayIntrinsic(expectedLength);
  try {
    uint8ArraySet.call(owned, value as Uint8Array, 0);
  } catch (error) {
    throw new IsoBmffBoxError('ISO BMFF source bytes could not be copied safely', error);
  }
  return owned;
}

function snapshotBoxRef(value: unknown, sourceSize: number): Readonly<IsoBmffBoxRef> {
  if (!value || typeof value !== 'object') {
    throw new TypeError('ISO BMFF child cursor requires a parent box reference');
  }
  const candidate = value as IsoBmffBoxRef;
  const { type, start, size, headerBytes, dataStart, end, extendsToEnd } = candidate;
  if (typeof type !== 'string' || type.length !== 4) {
    throw new TypeError('ISO BMFF parent box type must be a four-character code');
  }
  const validHeaderBytes =
    headerBytes === 8 || headerBytes === 16 || headerBytes === 24 || headerBytes === 32;
  if (!validHeaderBytes || typeof extendsToEnd !== 'boolean') {
    throw new TypeError('ISO BMFF parent box reference has invalid header metadata');
  }
  requireSafeInteger(start, 0, sourceSize, 'ISO BMFF parent box start');
  requireSafeInteger(size, headerBytes, sourceSize, 'ISO BMFF parent box size');
  requireSafeInteger(dataStart, 0, sourceSize, 'ISO BMFF parent box data start');
  requireSafeInteger(end, 0, sourceSize, 'ISO BMFF parent box end');
  const expectedDataStart = safeAdd(start, headerBytes, 'ISO BMFF parent box data start');
  const expectedEnd = safeAdd(start, size, 'ISO BMFF parent box end');
  if (expectedDataStart !== dataStart || expectedEnd !== end || dataStart > end) {
    throw new IsoBmffBoxError('ISO BMFF parent box reference has contradictory geometry');
  }
  return Object.freeze({ type, start, size, headerBytes, dataStart, end, extendsToEnd });
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new IsoBmffBoxError(`${label} exceeds the browser safe-integer range`);
  }
  return result;
}

class SharedBoxBudget {
  #committed = 0;
  #reserved = 0;

  constructor(readonly maximum: number) {}

  reserve(): { commit(): void; release(): void } {
    if (this.#committed + this.#reserved >= this.maximum) {
      throw new IsoBmffBoxError(`ISO BMFF box count exceeds the shared limit of ${this.maximum}`);
    }
    this.#reserved += 1;
    let settled = false;
    return Object.freeze({
      commit: (): void => {
        if (settled) return;
        settled = true;
        this.#reserved -= 1;
        this.#committed += 1;
      },
      release: (): void => {
        if (settled) return;
        settled = true;
        this.#reserved -= 1;
      },
    });
  }
}

/**
 * Exact bounded ISO BMFF header reader.
 *
 * The encoded source remains caller-owned. No box body is retained, and every
 * successful header consumes one slot from a budget shared by all cursors
 * created by this instance.
 */
export class IsoBmffBoxReader {
  readonly #source: SourceSnapshot;
  readonly #budget: SharedBoxBudget;
  readonly #issuedRefs = new WeakSet<object>();

  constructor(source: EncodedRandomAccessSource, options: IsoBmffBoxReaderOptions = {}) {
    this.#source = snapshotSource(source);
    if (!options || typeof options !== 'object') {
      throw new TypeError('ISO BMFF reader options must be an object');
    }
    const maxBoxes =
      options.maxBoxes === undefined
        ? ISO_BMFF_DEFAULT_MAX_BOXES
        : requireSafeInteger(
            options.maxBoxes,
            1,
            ISO_BMFF_HARD_MAX_BOXES,
            'ISO BMFF maximum box count',
          );
    this.#budget = new SharedBoxBudget(maxBoxes);
  }

  get sourceSize(): number {
    return this.#source.size;
  }

  /** Immutable identity captured with the exact random-access source facade. */
  get sourceIdentity(): string {
    return this.#source.identity;
  }

  createCursor(options: IsoBmffBoxCursorOptions = {}): IsoBmffBoxCursor {
    if (!options || typeof options !== 'object') {
      throw new TypeError('ISO BMFF cursor options must be an object');
    }
    const start =
      options.start === undefined
        ? 0
        : requireSafeInteger(options.start, 0, this.#source.size, 'ISO BMFF cursor start');
    const end =
      options.end === undefined
        ? this.#source.size
        : requireSafeInteger(options.end, 0, this.#source.size, 'ISO BMFF cursor end');
    if (end < start) throw new IsoBmffBoxError('ISO BMFF cursor span has an inverted boundary');
    return new SourceBoundIsoBmffBoxCursor(
      this,
      start,
      end,
      requireOptionalBoolean(options.allowExtendsToEnd, 'ISO BMFF cursor allowExtendsToEnd'),
    );
  }

  createChildCursor(
    parent: Readonly<IsoBmffBoxRef>,
    options: IsoBmffChildCursorOptions = {},
  ): IsoBmffBoxCursor {
    if (
      parent === null ||
      (typeof parent !== 'object' && typeof parent !== 'function') ||
      !this.#issuedRefs.has(parent)
    ) {
      throw new IsoBmffBoxError('ISO BMFF child cursor parent was not issued by this reader');
    }
    const box = snapshotBoxRef(parent, this.#source.size);
    if (!options || typeof options !== 'object') {
      throw new TypeError('ISO BMFF child cursor options must be an object');
    }
    const start =
      options.start === undefined
        ? box.dataStart
        : requireSafeInteger(options.start, box.dataStart, box.end, 'ISO BMFF child cursor start');
    const end =
      options.end === undefined
        ? box.end
        : requireSafeInteger(options.end, box.dataStart, box.end, 'ISO BMFF child cursor end');
    if (end < start) {
      throw new IsoBmffBoxError('ISO BMFF child cursor span has an inverted boundary');
    }
    return new SourceBoundIsoBmffBoxCursor(
      this,
      start,
      end,
      requireOptionalBoolean(options.allowExtendsToEnd, 'ISO BMFF child cursor allowExtendsToEnd'),
    );
  }

  async readBoxAt(
    options: IsoBmffBoxReadOptions,
    signal: AbortSignal,
  ): Promise<Readonly<IsoBmffBoxRef>> {
    if (!(signal instanceof AbortSignal)) {
      throw new TypeError('ISO BMFF box read requires an AbortSignal');
    }
    throwIfAborted(signal);
    if (!options || typeof options !== 'object') {
      throw new TypeError('ISO BMFF box read options must be an object');
    }
    const parentStart = requireSafeInteger(
      options.parentStart,
      0,
      this.#source.size,
      'ISO BMFF read parent start',
    );
    const parentEnd = requireSafeInteger(
      options.parentEnd,
      parentStart,
      this.#source.size,
      'ISO BMFF read parent end',
    );
    const start = requireSafeInteger(options.start, parentStart, parentEnd, 'ISO BMFF read start');
    const allowExtendsToEnd = requireOptionalBoolean(
      options.allowExtendsToEnd,
      'ISO BMFF read allowExtendsToEnd',
    );
    if (parentEnd - start < ISO_BMFF_BASE_BOX_HEADER_BYTES) {
      throw new IsoBmffBoxError('ISO BMFF sibling span ends inside a box header');
    }

    const reservation = this.#budget.reserve();
    try {
      const baseHeader = await this.#readExactHeader(start, ISO_BMFF_BASE_BOX_HEADER_BYTES, signal);
      const headerBytes = requiredIsoBmffBoxHeaderBytes(baseHeader);
      if (headerBytes > parentEnd - start) {
        throw new IsoBmffBoxError('ISO BMFF sibling span truncates an extended box header');
      }

      let completeHeader = baseHeader;
      const tailBytes = headerBytes - ISO_BMFF_BASE_BOX_HEADER_BYTES;
      if (tailBytes > 0) {
        if (tailBytes > ISO_BMFF_MAX_HEADER_TAIL_READ_BYTES) {
          throw new IsoBmffBoxError('ISO BMFF box header tail exceeds its physical read bound');
        }
        const tail = await this.#readExactHeader(
          start + ISO_BMFF_BASE_BOX_HEADER_BYTES,
          tailBytes,
          signal,
        );
        completeHeader = new Uint8ArrayIntrinsic(headerBytes);
        completeHeader.set(baseHeader, 0);
        completeHeader.set(tail, ISO_BMFF_BASE_BOX_HEADER_BYTES);
      }

      const box = parseIsoBmffBoxHeader(completeHeader, {
        parentStart,
        parentEnd,
        start,
        allowExtendsToEnd,
      });
      throwIfAborted(signal);
      this.#assertSourceStable();
      this.#issuedRefs.add(box);
      reservation.commit();
      return box;
    } catch (error) {
      reservation.release();
      throwIfAborted(signal);
      throw error;
    }
  }

  /**
   * Read one small manifest span through the same immutable source authority.
   * This does not consume the shared box-header budget.
   */
  async readBytes(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    if (!(signal instanceof AbortSignal)) {
      throw new TypeError('ISO BMFF bounded byte read requires an AbortSignal');
    }
    throwIfAborted(signal);
    requireSafeInteger(offset, 0, this.#source.size, 'ISO BMFF bounded read offset');
    requireSafeInteger(length, 0, ISO_BMFF_MAX_BOUNDED_READ_BYTES, 'ISO BMFF bounded read length');
    validateExactRead(this.#source.size, offset, length);
    if (length === 0) {
      this.assertReadable(signal);
      return new Uint8ArrayIntrinsic(0);
    }
    return this.#readExactBytes(offset, length, signal);
  }

  assertReadable(signal: AbortSignal): void {
    throwIfAborted(signal);
    this.#assertSourceStable();
  }

  async #readExactHeader(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    if (length > ISO_BMFF_MAX_HEADER_TAIL_READ_BYTES && length !== 8) {
      throw new IsoBmffBoxError('ISO BMFF physical header read exceeds its bounded width');
    }
    return this.#readExactBytes(offset, length, signal);
  }

  async #readExactBytes(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    validateExactRead(this.#source.size, offset, length);
    this.assertReadable(signal);

    let candidate: unknown;
    try {
      candidate = await Reflect.apply(this.#source.readAt, this.#source.authority, [
        offset,
        length,
        signal,
      ]);
    } catch (error) {
      throwIfAborted(signal);
      throw error;
    }
    throwIfAborted(signal);
    this.#assertSourceStable();
    const owned = snapshotExactRead(candidate, length);
    throwIfAborted(signal);
    this.#assertSourceStable();
    return owned;
  }

  #assertSourceStable(): void {
    try {
      if (
        this.#source.authority.size !== this.#source.size ||
        this.#source.authority.identity !== this.#source.identity
      ) {
        throw new IsoBmffBoxError('ISO BMFF encoded source changed during box reading');
      }
    } catch (error) {
      if (error instanceof IsoBmffBoxError) throw error;
      throw new IsoBmffBoxError('ISO BMFF encoded source could not be revalidated safely', error);
    }
  }
}

/** A sequential sibling walker whose offset advances only after a valid box. */
export interface IsoBmffBoxCursor {
  readonly start: number;
  readonly end: number;
  readonly offset: number;
  readonly remainingBytes: number;
  next(signal: AbortSignal): Promise<Readonly<IsoBmffBoxRef> | null>;
}

class SourceBoundIsoBmffBoxCursor implements IsoBmffBoxCursor {
  #offset: number;
  #reading = false;

  constructor(
    private readonly reader: IsoBmffBoxReader,
    readonly start: number,
    readonly end: number,
    private readonly allowExtendsToEnd: boolean,
  ) {
    this.#offset = start;
  }

  get offset(): number {
    return this.#offset;
  }

  get remainingBytes(): number {
    return this.end - this.#offset;
  }

  next(signal: AbortSignal): Promise<Readonly<IsoBmffBoxRef> | null> {
    if (!(signal instanceof AbortSignal)) {
      return Promise.reject(new TypeError('ISO BMFF cursor read requires an AbortSignal'));
    }
    try {
      this.reader.assertReadable(signal);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.#reading) {
      return Promise.reject(
        new IsoBmffBoxError('Concurrent or reentrant ISO BMFF cursor reads are not supported'),
      );
    }

    this.#reading = true;
    return this.#next(signal).finally(() => {
      this.#reading = false;
    });
  }

  async #next(signal: AbortSignal): Promise<Readonly<IsoBmffBoxRef> | null> {
    if (this.#offset === this.end) return null;
    const current = this.#offset;
    const box = await this.reader.readBoxAt(
      {
        parentStart: this.start,
        parentEnd: this.end,
        start: current,
        allowExtendsToEnd: this.allowExtendsToEnd,
      },
      signal,
    );
    if (box.end <= current) {
      throw new IsoBmffBoxError('ISO BMFF cursor box made no forward progress');
    }
    this.#offset = box.end;
    return box;
  }
}
