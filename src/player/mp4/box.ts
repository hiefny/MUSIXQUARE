import { EncodedSourceIntegrityError } from '../sources/encoded-audio-source.ts';

export const ISO_BMFF_BASE_BOX_HEADER_BYTES = 8;
export const ISO_BMFF_LARGE_BOX_HEADER_BYTES = 16;
export const ISO_BMFF_UUID_USER_TYPE_BYTES = 16;
export const ISO_BMFF_MAX_BOX_HEADER_BYTES = 32;

const UUID_BOX_TYPE = 'uuid';
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

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

export interface IsoBmffBoxRef {
  readonly type: string;
  readonly start: number;
  readonly size: number;
  readonly headerBytes: 8 | 16 | 24 | 32;
  readonly dataStart: number;
  readonly end: number;
  readonly extendsToEnd: boolean;
}

export interface ParseIsoBmffBoxHeaderOptions {
  /** Inclusive lower bound of the containing sibling span. */
  readonly parentStart: number;
  /** Exclusive upper bound of the containing sibling span. */
  readonly parentEnd: number;
  /** Absolute offset of this box header. */
  readonly start: number;
  /** ISO BMFF size32=0 is rejected unless this is exactly true. */
  readonly allowExtendsToEnd?: boolean;
}

export class IsoBmffBoxError extends EncodedSourceIntegrityError {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'IsoBmffBoxError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        value: cause,
      });
    }
  }
}

function snapshotHeaderBytes(value: unknown): Uint8Array {
  if (
    !typedArrayByteLengthGetter ||
    !typedArrayBufferGetter ||
    !typedArrayTagGetter ||
    !arrayBufferByteLengthGetter ||
    !arrayBufferIsView(value)
  ) {
    throw new IsoBmffBoxError('ISO BMFF box header must be a readable Uint8Array');
  }

  let byteLength: number;
  try {
    if (typedArrayTagGetter.call(value) !== 'Uint8Array') {
      throw new TypeError('not a Uint8Array');
    }
    byteLength = typedArrayByteLengthGetter.call(value);
    const buffer = typedArrayBufferGetter.call(value);
    // A shared header can change between the size and type reads, so it is not
    // an admissible exact metadata snapshot.
    arrayBufferByteLengthGetter.call(buffer);
  } catch (error) {
    throw new IsoBmffBoxError('ISO BMFF box header must be readable and non-shared', error);
  }

  if (byteLength < ISO_BMFF_BASE_BOX_HEADER_BYTES || byteLength > ISO_BMFF_MAX_BOX_HEADER_BYTES) {
    throw new IsoBmffBoxError('ISO BMFF box header has an invalid bounded byte length');
  }

  const owned = new Uint8ArrayIntrinsic(byteLength);
  try {
    uint8ArraySet.call(owned, value as Uint8Array, 0);
  } catch (error) {
    throw new IsoBmffBoxError('ISO BMFF box header could not be copied safely', error);
  }
  return owned;
}

function requireSafeOffset(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < 0
  ) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new IsoBmffBoxError(`${label} exceeds the browser safe-integer range`);
  }
  return result;
}

function readType(bytes: Uint8Array): string {
  return String.fromCharCode(bytes[4]!, bytes[5]!, bytes[6]!, bytes[7]!);
}

function requiredHeaderBytesFromSnapshot(bytes: Uint8Array): 8 | 16 | 24 | 32 {
  if (bytes.byteLength < ISO_BMFF_BASE_BOX_HEADER_BYTES) {
    throw new IsoBmffBoxError('ISO BMFF box header is shorter than 8 bytes');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hasLargeSize = view.getUint32(0, false) === 1;
  const hasUserType = readType(bytes) === UUID_BOX_TYPE;
  if (hasLargeSize && hasUserType) return 32;
  if (hasUserType) return 24;
  if (hasLargeSize) return 16;
  return 8;
}

/**
 * Determine the exact total header width from an owned eight-byte prefix.
 * The returned width includes the 64-bit large-size and `uuid` user-type
 * extensions when present.
 */
export function requiredIsoBmffBoxHeaderBytes(baseHeader: Uint8Array): 8 | 16 | 24 | 32 {
  const bytes = snapshotHeaderBytes(baseHeader);
  if (bytes.byteLength !== ISO_BMFF_BASE_BOX_HEADER_BYTES) {
    throw new IsoBmffBoxError('ISO BMFF base box header must contain exactly 8 bytes');
  }
  return requiredHeaderBytesFromSnapshot(bytes);
}

/**
 * Parse one complete ISO BMFF box header without reading or retaining its body.
 *
 * `header` must contain exactly 8, 16, 24, or 32 bytes as selected by size32
 * and type. All returned coordinates are safe integers and are contained by
 * the declared parent span.
 */
export function parseIsoBmffBoxHeader(
  header: Uint8Array,
  options: ParseIsoBmffBoxHeaderOptions,
): Readonly<IsoBmffBoxRef> {
  const bytes = snapshotHeaderBytes(header);
  const expectedHeaderBytes = requiredHeaderBytesFromSnapshot(bytes);
  if (bytes.byteLength !== expectedHeaderBytes) {
    throw new IsoBmffBoxError(
      `ISO BMFF box header returned ${bytes.byteLength} bytes; expected ${expectedHeaderBytes}`,
    );
  }
  if (!options || typeof options !== 'object') {
    throw new TypeError('ISO BMFF box header options must be an object');
  }

  const parentStart = requireSafeOffset(options.parentStart, 'ISO BMFF parent start');
  const parentEnd = requireSafeOffset(options.parentEnd, 'ISO BMFF parent end');
  const start = requireSafeOffset(options.start, 'ISO BMFF box start');
  if (parentEnd < parentStart) {
    throw new IsoBmffBoxError('ISO BMFF parent span has an inverted boundary');
  }
  if (start < parentStart || start >= parentEnd) {
    throw new IsoBmffBoxError('ISO BMFF box start is outside its parent span');
  }
  if (options.allowExtendsToEnd !== undefined && typeof options.allowExtendsToEnd !== 'boolean') {
    throw new TypeError('ISO BMFF allowExtendsToEnd must be a boolean');
  }

  const type = readType(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size32 = view.getUint32(0, false);
  const extendsToEnd = size32 === 0;
  let size: number;
  if (extendsToEnd) {
    if (options.allowExtendsToEnd !== true) {
      throw new IsoBmffBoxError('ISO BMFF size-zero box is not allowed in this cursor');
    }
    size = parentEnd - start;
  } else if (size32 === 1) {
    const largeSize = view.getBigUint64(8, false);
    if (largeSize > MAX_SAFE_BIGINT) {
      throw new IsoBmffBoxError('ISO BMFF large box size exceeds the browser safe-integer range');
    }
    size = Number(largeSize);
  } else {
    size = size32;
  }

  if (size < expectedHeaderBytes) {
    throw new IsoBmffBoxError(
      `ISO BMFF ${JSON.stringify(type)} box is smaller than its ${expectedHeaderBytes}-byte header`,
    );
  }
  const end = extendsToEnd ? parentEnd : safeAdd(start, size, 'ISO BMFF box end');
  if (end > parentEnd) {
    throw new IsoBmffBoxError(`ISO BMFF ${JSON.stringify(type)} box escapes its parent span`);
  }
  if (end <= start) {
    throw new IsoBmffBoxError('ISO BMFF box makes no forward progress');
  }
  const dataStart = safeAdd(start, expectedHeaderBytes, 'ISO BMFF box data start');
  if (dataStart > end) {
    throw new IsoBmffBoxError('ISO BMFF box header exceeds its declared end');
  }

  return Object.freeze({
    type,
    start,
    size,
    headerBytes: expectedHeaderBytes,
    dataStart,
    end,
    extendsToEnd,
  });
}
