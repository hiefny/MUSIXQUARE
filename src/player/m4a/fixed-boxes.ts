import type { M4aAacEditEvidence } from './timeline.ts';

const MVHD_V0_PAYLOAD_BYTES = 100;
const MVHD_V1_PAYLOAD_BYTES = 112;
const MDHD_V0_PAYLOAD_BYTES = 24;
const MDHD_V1_PAYLOAD_BYTES = 36;
const TKHD_V0_PAYLOAD_BYTES = 84;
const TKHD_V1_PAYLOAD_BYTES = 96;
const HDLR_FIXED_PREFIX_BYTES = 24;
const ELST_V0_PAYLOAD_BYTES = 20;
const ELST_V1_PAYLOAD_BYTES = 28;

const FIXED_ONE_16_16 = 0x0001_0000;
const FIXED_ONE_8_8 = 0x0100;
const IDENTITY_MATRIX = Object.freeze([
  0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000,
] as const);
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

export interface M4aMovieHeader {
  readonly version: 0 | 1;
  readonly movieTimescale: number;
  readonly movieDurationMovieTicks: number;
  readonly nextTrackId: number;
}

export interface M4aMediaHeader {
  readonly version: 0 | 1;
  readonly mediaTimescale: number;
  readonly mediaDurationMediaTicks: number;
  readonly languagePacked: number;
}

export interface M4aTrackHeader {
  readonly version: 0 | 1;
  readonly flags: number;
  readonly trackId: number;
  readonly durationMovieTicks: number;
  readonly layer: number;
  readonly alternateGroup: number;
  /** Raw signed 8.8 fixed-point scalar. The admitted audio subset is exactly `0x0100`. */
  readonly volumeFixed8_8: number;
  /** Raw unsigned 16.16 fixed-point scalar. The admitted audio subset is exactly zero. */
  readonly widthFixed16_16: number;
  /** Raw unsigned 16.16 fixed-point scalar. The admitted audio subset is exactly zero. */
  readonly heightFixed16_16: number;
}

export interface M4aHandlerHeader {
  readonly handlerType: string;
}

export class M4aFixedBoxError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'M4aFixedBoxError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        value: cause,
      });
    }
  }
}

/**
 * Take one immutable metadata snapshot without invoking caller-controlled
 * properties. Shared, detached, proxied, spoofed, and non-Uint8Array values
 * are not admissible fixed-box evidence.
 */
function snapshotPayload(value: unknown, label: string): Uint8Array {
  if (
    !typedArrayByteLengthGetter ||
    !typedArrayBufferGetter ||
    !typedArrayTagGetter ||
    !arrayBufferByteLengthGetter ||
    !arrayBufferIsView(value)
  ) {
    throw new M4aFixedBoxError(`${label} must be a readable Uint8Array`);
  }

  let byteLength: number;
  try {
    if (typedArrayTagGetter.call(value) !== 'Uint8Array') {
      throw new TypeError('not a Uint8Array');
    }
    byteLength = typedArrayByteLengthGetter.call(value);
    const buffer = typedArrayBufferGetter.call(value);
    // Calling the ArrayBuffer intrinsic also excludes SharedArrayBuffer.
    arrayBufferByteLengthGetter.call(buffer);
  } catch (cause) {
    throw new M4aFixedBoxError(`${label} must be readable, attached, and non-shared`, cause);
  }

  const owned = new Uint8ArrayIntrinsic(byteLength);
  try {
    uint8ArraySet.call(owned, value as Uint8Array, 0);
  } catch (cause) {
    throw new M4aFixedBoxError(`${label} could not be copied safely`, cause);
  }
  return owned;
}

function requireExactLength(bytes: Uint8Array, expected: number, label: string): void {
  if (bytes.byteLength !== expected) {
    throw new M4aFixedBoxError(`${label} must contain exactly ${expected} bytes`);
  }
}

function requireVersion(bytes: Uint8Array, label: string): 0 | 1 {
  const version = bytes[0];
  if (version !== 0 && version !== 1) {
    throw new M4aFixedBoxError(`${label} version must be 0 or 1`);
  }
  return version;
}

function readFlags(bytes: Uint8Array): number {
  return bytes[1]! * 0x1_0000 + bytes[2]! * 0x100 + bytes[3]!;
}

function requireZeroFlags(bytes: Uint8Array, label: string): void {
  if (readFlags(bytes) !== 0) {
    throw new M4aFixedBoxError(`${label} flags must be zero`);
  }
}

function requireAllZero(bytes: Uint8Array, start: number, end: number, label: string): void {
  for (let offset = start; offset < end; offset += 1) {
    if (bytes[offset] !== 0) {
      throw new M4aFixedBoxError(`${label} must be zero`);
    }
  }
}

function safeUnsignedBigInt(value: bigint, label: string): number {
  if (value > MAX_SAFE_BIGINT) {
    throw new M4aFixedBoxError(`${label} exceeds the browser safe-integer range`);
  }
  return Number(value);
}

function safeSignedBigInt(value: bigint, label: string): number {
  if (value < -MAX_SAFE_BIGINT || value > MAX_SAFE_BIGINT) {
    throw new M4aFixedBoxError(`${label} exceeds the browser safe-integer range`);
  }
  return Number(value);
}

function requirePositive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new M4aFixedBoxError(`${label} must be a positive safe integer`);
  }
  return value;
}

function requireNonNegative(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new M4aFixedBoxError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function readUint32(view: DataView, offset: number): number {
  return view.getUint32(offset, false);
}

function readUint64(view: DataView, offset: number, label: string): number {
  return safeUnsignedBigInt(view.getBigUint64(offset, false), label);
}

function readInt64(view: DataView, offset: number, label: string): number {
  return safeSignedBigInt(view.getBigInt64(offset, false), label);
}

function requireIdentityMatrix(bytes: Uint8Array, offset: number, label: string): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < IDENTITY_MATRIX.length; index += 1) {
    if (view.getUint32(offset + index * 4, false) !== IDENTITY_MATRIX[index]) {
      throw new M4aFixedBoxError(`${label} must be the identity transform`);
    }
  }
}

function readFourCc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset]!,
    bytes[offset + 1]!,
    bytes[offset + 2]!,
    bytes[offset + 3]!,
  );
}

/** Parse the complete payload of one strict `mvhd` FullBox. */
export function parseM4aMovieHeader(payload: Uint8Array): Readonly<M4aMovieHeader> {
  const bytes = snapshotPayload(payload, 'M4A mvhd payload');
  const version = requireVersion(bytes, 'M4A mvhd');
  requireExactLength(
    bytes,
    version === 0 ? MVHD_V0_PAYLOAD_BYTES : MVHD_V1_PAYLOAD_BYTES,
    'M4A mvhd payload',
  );
  requireZeroFlags(bytes, 'M4A mvhd');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const timescaleOffset = version === 0 ? 12 : 20;
  const durationOffset = version === 0 ? 16 : 24;
  const rateOffset = version === 0 ? 20 : 32;
  const volumeOffset = rateOffset + 4;
  const reservedOffset = volumeOffset + 2;
  const matrixOffset = reservedOffset + 10;
  const predefinedOffset = matrixOffset + 36;
  const nextTrackIdOffset = predefinedOffset + 24;

  const movieTimescale = requirePositive(readUint32(view, timescaleOffset), 'M4A mvhd timescale');
  const movieDurationMovieTicks = requirePositive(
    version === 0
      ? readUint32(view, durationOffset)
      : readUint64(view, durationOffset, 'M4A mvhd duration'),
    'M4A mvhd duration',
  );
  if (readUint32(view, rateOffset) !== FIXED_ONE_16_16) {
    throw new M4aFixedBoxError('M4A mvhd rate must be the standard 1.0 value');
  }
  if (view.getInt16(volumeOffset, false) !== FIXED_ONE_8_8) {
    throw new M4aFixedBoxError('M4A mvhd volume must be the standard 1.0 value');
  }
  requireAllZero(bytes, reservedOffset, reservedOffset + 10, 'M4A mvhd reserved fields');
  requireIdentityMatrix(bytes, matrixOffset, 'M4A mvhd matrix');
  requireAllZero(bytes, predefinedOffset, nextTrackIdOffset, 'M4A mvhd predefined fields');
  const nextTrackId = requirePositive(
    readUint32(view, nextTrackIdOffset),
    'M4A mvhd next track ID',
  );

  return Object.freeze({
    version,
    movieTimescale,
    movieDurationMovieTicks,
    nextTrackId,
  });
}

/** Parse the complete payload of one strict `mdhd` FullBox. */
export function parseM4aMediaHeader(payload: Uint8Array): Readonly<M4aMediaHeader> {
  const bytes = snapshotPayload(payload, 'M4A mdhd payload');
  const version = requireVersion(bytes, 'M4A mdhd');
  requireExactLength(
    bytes,
    version === 0 ? MDHD_V0_PAYLOAD_BYTES : MDHD_V1_PAYLOAD_BYTES,
    'M4A mdhd payload',
  );
  requireZeroFlags(bytes, 'M4A mdhd');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const timescaleOffset = version === 0 ? 12 : 20;
  const durationOffset = version === 0 ? 16 : 24;
  const languageOffset = version === 0 ? 20 : 32;
  const mediaTimescale = requirePositive(readUint32(view, timescaleOffset), 'M4A mdhd timescale');
  const mediaDurationMediaTicks = requirePositive(
    version === 0
      ? readUint32(view, durationOffset)
      : readUint64(view, durationOffset, 'M4A mdhd duration'),
    'M4A mdhd duration',
  );
  const languagePacked = view.getUint16(languageOffset, false);
  if (view.getUint16(languageOffset + 2, false) !== 0) {
    throw new M4aFixedBoxError('M4A mdhd predefined field must be zero');
  }

  return Object.freeze({
    version,
    mediaTimescale,
    mediaDurationMediaTicks,
    languagePacked,
  });
}

/** Parse the complete payload of one strict, untransformed audio `tkhd` FullBox. */
export function parseM4aTrackHeader(payload: Uint8Array): Readonly<M4aTrackHeader> {
  const bytes = snapshotPayload(payload, 'M4A tkhd payload');
  const version = requireVersion(bytes, 'M4A tkhd');
  requireExactLength(
    bytes,
    version === 0 ? TKHD_V0_PAYLOAD_BYTES : TKHD_V1_PAYLOAD_BYTES,
    'M4A tkhd payload',
  );

  const flags = readFlags(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const trackIdOffset = version === 0 ? 12 : 20;
  const firstReservedOffset = trackIdOffset + 4;
  const durationOffset = firstReservedOffset + 4;
  const secondReservedOffset = durationOffset + (version === 0 ? 4 : 8);
  const layerOffset = secondReservedOffset + 8;
  const alternateGroupOffset = layerOffset + 2;
  const volumeOffset = alternateGroupOffset + 2;
  const matrixOffset = volumeOffset + 4;
  const widthOffset = matrixOffset + 36;
  const heightOffset = widthOffset + 4;

  const trackId = requirePositive(readUint32(view, trackIdOffset), 'M4A tkhd track ID');
  requireAllZero(
    bytes,
    firstReservedOffset,
    firstReservedOffset + 4,
    'M4A tkhd reserved track field',
  );
  const durationMovieTicks = requireNonNegative(
    version === 0
      ? readUint32(view, durationOffset)
      : readUint64(view, durationOffset, 'M4A tkhd duration'),
    'M4A tkhd duration',
  );
  requireAllZero(
    bytes,
    secondReservedOffset,
    secondReservedOffset + 8,
    'M4A tkhd reserved duration fields',
  );

  const layer = view.getInt16(layerOffset, false);
  const alternateGroup = view.getInt16(alternateGroupOffset, false);
  const volumeFixed8_8 = view.getInt16(volumeOffset, false);
  if (volumeFixed8_8 !== FIXED_ONE_8_8) {
    throw new M4aFixedBoxError('M4A audio tkhd volume must be the standard 1.0 value');
  }
  if (view.getUint16(volumeOffset + 2, false) !== 0) {
    throw new M4aFixedBoxError('M4A tkhd geometry reserved field must be zero');
  }
  requireIdentityMatrix(bytes, matrixOffset, 'M4A tkhd matrix');

  const widthFixed16_16 = readUint32(view, widthOffset);
  const heightFixed16_16 = readUint32(view, heightOffset);
  if (widthFixed16_16 !== 0 || heightFixed16_16 !== 0) {
    throw new M4aFixedBoxError('M4A audio tkhd width and height must be zero');
  }

  return Object.freeze({
    version,
    flags,
    trackId,
    durationMovieTicks,
    layer,
    alternateGroup,
    volumeFixed8_8,
    widthFixed16_16,
    heightFixed16_16,
  });
}

/** Parse the exact fixed 24-byte prefix of one `hdlr` payload, excluding its optional name. */
export function parseM4aHandlerHeader(prefix: Uint8Array): Readonly<M4aHandlerHeader> {
  const bytes = snapshotPayload(prefix, 'M4A hdlr fixed prefix');
  requireExactLength(bytes, HDLR_FIXED_PREFIX_BYTES, 'M4A hdlr fixed prefix');
  if (bytes[0] !== 0) {
    throw new M4aFixedBoxError('M4A hdlr version must be zero');
  }
  requireZeroFlags(bytes, 'M4A hdlr');
  requireAllZero(bytes, 4, 8, 'M4A hdlr predefined field');
  requireAllZero(bytes, 12, 24, 'M4A hdlr reserved fields');
  return Object.freeze({ handlerType: readFourCc(bytes, 8) });
}

/** Parse the complete payload of the one non-empty rate-1 `elst` subset. */
export function parseM4aEditList(payload: Uint8Array): Readonly<M4aAacEditEvidence> {
  const bytes = snapshotPayload(payload, 'M4A elst payload');
  const version = requireVersion(bytes, 'M4A elst');
  requireExactLength(
    bytes,
    version === 0 ? ELST_V0_PAYLOAD_BYTES : ELST_V1_PAYLOAD_BYTES,
    'M4A elst payload',
  );
  requireZeroFlags(bytes, 'M4A elst');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readUint32(view, 4) !== 1) {
    throw new M4aFixedBoxError('M4A elst must contain exactly one edit entry');
  }
  const segmentDurationOffset = 8;
  const mediaTimeOffset = version === 0 ? 12 : 16;
  const rateOffset = version === 0 ? 16 : 24;
  const segmentDurationMovieTicks = requirePositive(
    version === 0
      ? readUint32(view, segmentDurationOffset)
      : readUint64(view, segmentDurationOffset, 'M4A elst segment duration'),
    'M4A elst segment duration',
  );
  const mediaTimeCoreFrames =
    version === 0
      ? view.getInt32(mediaTimeOffset, false)
      : readInt64(view, mediaTimeOffset, 'M4A elst media time');
  requireNonNegative(mediaTimeCoreFrames, 'M4A elst media time');

  const mediaRateInteger = view.getInt16(rateOffset, false);
  const mediaRateFraction = view.getInt16(rateOffset + 2, false);
  if (mediaRateInteger !== 1 || mediaRateFraction !== 0) {
    throw new M4aFixedBoxError('M4A elst media rate must be exactly 1.0');
  }

  return Object.freeze({
    mediaTimeCoreFrames,
    mediaRateInteger: 1,
    mediaRateFraction: 0,
    segmentDurationMovieTicks,
  });
}
