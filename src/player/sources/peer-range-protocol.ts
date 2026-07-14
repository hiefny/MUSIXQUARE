/**
 * Versioned, bounded framing for exact peer range reads.
 *
 * Requests and cancellation travel on the reliable control lane. Byte chunks
 * and terminal errors travel on the bulk lane. Correlation is therefore
 * carried in every frame; neither endpoint may infer ordering across lanes.
 */

export const PEER_RANGE_PROTOCOL = 'musixquare-peer-range' as const;
export const PEER_RANGE_PROTOCOL_VERSION = 1 as const;
export const PEER_RANGE_MAX_READ_BYTES = 64 * 1024;
export const PEER_RANGE_MAX_CHUNK_BYTES = 16 * 1024;
export const PEER_RANGE_MAX_CHUNK_COUNT = PEER_RANGE_MAX_READ_BYTES / PEER_RANGE_MAX_CHUNK_BYTES;

export const PEER_RANGE_MAX_CONNECTION_ID_LENGTH = 192;
export const PEER_RANGE_MAX_SOURCE_IDENTITY_LENGTH = 512;
export const PEER_RANGE_MAX_HANDLE_ID_LENGTH = 192;
export const PEER_RANGE_MAX_REQUEST_ID_LENGTH = 192;
const MAX_ERROR_MESSAGE_LENGTH = 256;
const MAX_CONFIGURED_ACTIVE_REQUESTS = 256;
const MAX_CONFIGURED_RETAINED_BYTES = 16 * 1024 * 1024;
const MAX_CONFIGURED_SETTLED_REQUESTS = 8_192;

export type PeerRangeRemoteErrorCode =
  | 'cancelled'
  | 'closed'
  | 'integrity'
  | 'internal'
  | 'not-found'
  | 'range'
  | 'unavailable';

const REMOTE_ERROR_CODES = new Set<PeerRangeRemoteErrorCode>([
  'cancelled',
  'closed',
  'integrity',
  'internal',
  'not-found',
  'range',
  'unavailable',
]);

export interface PeerRangeReadDescriptor {
  readonly connectionId: string;
  readonly sourceIdentity: string;
  readonly handleId: string;
  readonly requestId: string;
  readonly offset: number;
  readonly totalLength: number;
}

interface PeerRangeFrameBase extends PeerRangeReadDescriptor {
  readonly protocol: typeof PEER_RANGE_PROTOCOL;
  readonly version: typeof PEER_RANGE_PROTOCOL_VERSION;
}

export interface PeerRangeReadFrame extends PeerRangeFrameBase {
  readonly lane: 'control';
  readonly type: 'read';
}

export interface PeerRangeCancelFrame extends PeerRangeFrameBase {
  readonly lane: 'control';
  readonly type: 'cancel';
}

export interface PeerRangeCloseHandleFrame {
  readonly protocol: typeof PEER_RANGE_PROTOCOL;
  readonly version: typeof PEER_RANGE_PROTOCOL_VERSION;
  readonly lane: 'control';
  readonly type: 'close-handle';
  readonly connectionId: string;
  readonly sourceIdentity: string;
  readonly handleId: string;
}

interface PeerRangeBulkFrameBase extends PeerRangeFrameBase {
  readonly lane: 'bulk';
  readonly chunkIndex: number;
  readonly chunkCount: number;
}

export interface PeerRangeChunkFrame extends PeerRangeBulkFrameBase {
  readonly type: 'chunk';
  /** An exact, independently owned payload; never a view into a larger body. */
  readonly payload: ArrayBuffer;
}

export interface PeerRangeErrorFrame extends PeerRangeBulkFrameBase {
  readonly type: 'error';
  readonly code: PeerRangeRemoteErrorCode;
  readonly message: string;
}

export type PeerRangeControlFrame =
  | PeerRangeReadFrame
  | PeerRangeCancelFrame
  | PeerRangeCloseHandleFrame;
export type PeerRangeBulkFrame = PeerRangeChunkFrame | PeerRangeErrorFrame;

export type PeerRangeAssemblyStatus = 'accepted' | 'completed' | 'failed' | 'ignored';

export interface PeerRangeResponseAssemblerOptions {
  /** Authenticated RTC connection identity; never trusted from an incoming frame. */
  readonly connectionId: string;
  readonly maxActiveRequests?: number;
  readonly maxRetainedBytes?: number;
  readonly maxSettledRequests?: number;
}

export class PeerRangeProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PeerRangeProtocolError';
  }
}

export class PeerRangeRemoteError extends Error {
  readonly code: PeerRangeRemoteErrorCode;

  constructor(code: PeerRangeRemoteErrorCode, message: string) {
    super(message);
    this.name = 'PeerRangeRemoteError';
    this.code = code;
  }
}

export class PeerRangeLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PeerRangeLimitError';
  }
}

export class PeerRangeAssemblerClosedError extends Error {
  constructor() {
    super('Peer range response assembler is closed');
    this.name = 'PeerRangeAssemblerClosedError';
  }
}

export class PeerRangeRequestCancelledError extends Error {
  constructor() {
    super('Peer range request was cancelled');
    this.name = 'PeerRangeRequestCancelledError';
  }
}

type PlainRecord = Record<string, unknown>;
const MAX_FRAME_FIELD_COUNT = 14;

interface AssemblyState {
  readonly request: PeerRangeReadFrame;
  readonly chunkCount: number;
  readonly chunks: Array<Uint8Array | undefined>;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
  readonly resolve: (bytes: Uint8Array) => void;
  readonly reject: (error: unknown) => void;
  receivedChunks: number;
  retainedBytes: number;
}

function assertExactKeys(record: PlainRecord, expected: readonly string[]): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new PeerRangeProtocolError('Peer range frame has an inexact schema');
  }
}

/**
 * Detach one inert snapshot without evaluating frame-owned accessors.
 *
 * Reflective operations against a Proxy can still trap, but every trap is
 * observed at most once and the original object is never read after this
 * function returns. A mutation between ownKeys and a descriptor lookup makes
 * the snapshot invalid instead of producing a mixed-time frame.
 */
function snapshotFrameRecord(value: unknown): PlainRecord {
  if (typeof value !== 'object' || value === null) {
    throw new PeerRangeProtocolError('Peer range frame must be an object');
  }

  let array: boolean;
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    array = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    throw new PeerRangeProtocolError('Peer range frame reflection failed');
  }
  if (array) throw new PeerRangeProtocolError('Peer range frame must be an object');
  if (prototype !== Object.prototype && prototype !== null) {
    throw new PeerRangeProtocolError('Peer range frame must be a plain object');
  }
  if (keys.length > MAX_FRAME_FIELD_COUNT || keys.some((key) => typeof key !== 'string')) {
    throw new PeerRangeProtocolError('Peer range frame has an inexact schema');
  }

  const snapshot = Object.create(null) as PlainRecord;
  for (const propertyKey of keys) {
    const key = propertyKey as string;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw new PeerRangeProtocolError('Peer range frame reflection failed');
    }
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      throw new PeerRangeProtocolError(
        'Peer range frame fields must be own enumerable data properties',
      );
    }
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(snapshot);
}

/**
 * Validate an opaque identifier without normalizing it.
 *
 * Internal spaces and Unicode are meaningful and preserved. Empty values,
 * boundary whitespace, control characters, and oversized values are rejected
 * so both sides correlate the exact same bounded string.
 */
export function validatePeerRangeOpaqueId(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  if (!Number.isSafeInteger(maxLength) || maxLength <= 0) {
    throw new RangeError('Peer range identifier bound must be a positive safe integer');
  }
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.trim() ||
    containsControlCharacter(value)
  ) {
    throw new PeerRangeProtocolError(`${label} is not a canonical opaque identifier`);
  }
  return value;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PeerRangeProtocolError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function positiveSafeInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new PeerRangeProtocolError(`${label} must be a positive safe integer up to ${maximum}`);
  }
  return value as number;
}

function validatedDescriptor(value: PeerRangeReadDescriptor): PeerRangeReadDescriptor {
  const connectionId = validatePeerRangeOpaqueId(
    value.connectionId,
    'connectionId',
    PEER_RANGE_MAX_CONNECTION_ID_LENGTH,
  );
  const sourceIdentity = validatePeerRangeOpaqueId(
    value.sourceIdentity,
    'sourceIdentity',
    PEER_RANGE_MAX_SOURCE_IDENTITY_LENGTH,
  );
  const handleId = validatePeerRangeOpaqueId(
    value.handleId,
    'handleId',
    PEER_RANGE_MAX_HANDLE_ID_LENGTH,
  );
  const requestId = validatePeerRangeOpaqueId(
    value.requestId,
    'requestId',
    PEER_RANGE_MAX_REQUEST_ID_LENGTH,
  );
  const offset = nonNegativeSafeInteger(value.offset, 'offset');
  const totalLength = positiveSafeInteger(
    value.totalLength,
    'totalLength',
    PEER_RANGE_MAX_READ_BYTES,
  );
  if (!Number.isSafeInteger(offset + totalLength)) {
    throw new PeerRangeProtocolError('Peer range request end exceeds the safe-integer range');
  }
  return Object.freeze({
    connectionId,
    sourceIdentity,
    handleId,
    requestId,
    offset,
    totalLength,
  });
}

function expectedChunkCount(totalLength: number): number {
  return Math.ceil(totalLength / PEER_RANGE_MAX_CHUNK_BYTES);
}

function expectedChunkLength(totalLength: number, chunkIndex: number): number {
  return Math.min(
    PEER_RANGE_MAX_CHUNK_BYTES,
    totalLength - chunkIndex * PEER_RANGE_MAX_CHUNK_BYTES,
  );
}

function copyExactBytes(bytes: ArrayBuffer | Uint8Array): Uint8Array {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Uint8Array.from(view);
}

function commonFrame(descriptor: PeerRangeReadDescriptor): PeerRangeFrameBase {
  const validated = validatedDescriptor(descriptor);
  return {
    protocol: PEER_RANGE_PROTOCOL,
    version: PEER_RANGE_PROTOCOL_VERSION,
    ...validated,
  };
}

export function createPeerRangeReadFrame(descriptor: PeerRangeReadDescriptor): PeerRangeReadFrame {
  return Object.freeze({
    ...commonFrame(descriptor),
    lane: 'control' as const,
    type: 'read' as const,
  });
}

export function createPeerRangeCancelFrame(
  descriptor: PeerRangeReadDescriptor,
): PeerRangeCancelFrame {
  return Object.freeze({
    ...commonFrame(descriptor),
    lane: 'control' as const,
    type: 'cancel' as const,
  });
}

export function createPeerRangeCloseHandleFrame(value: {
  readonly connectionId: string;
  readonly sourceIdentity: string;
  readonly handleId: string;
}): PeerRangeCloseHandleFrame {
  const connectionId = validatePeerRangeOpaqueId(
    value.connectionId,
    'connectionId',
    PEER_RANGE_MAX_CONNECTION_ID_LENGTH,
  );
  const sourceIdentity = validatePeerRangeOpaqueId(
    value.sourceIdentity,
    'sourceIdentity',
    PEER_RANGE_MAX_SOURCE_IDENTITY_LENGTH,
  );
  const handleId = validatePeerRangeOpaqueId(
    value.handleId,
    'handleId',
    PEER_RANGE_MAX_HANDLE_ID_LENGTH,
  );
  return Object.freeze({
    protocol: PEER_RANGE_PROTOCOL,
    version: PEER_RANGE_PROTOCOL_VERSION,
    lane: 'control' as const,
    type: 'close-handle' as const,
    connectionId,
    sourceIdentity,
    handleId,
  });
}

export function createPeerRangeChunkFrames(
  descriptor: PeerRangeReadDescriptor,
  bytes: ArrayBuffer | Uint8Array,
): readonly PeerRangeChunkFrame[] {
  const common = commonFrame(descriptor);
  if (bytes.byteLength !== common.totalLength) {
    throw new PeerRangeProtocolError(
      `Peer range response has ${bytes.byteLength} bytes; expected ${common.totalLength}`,
    );
  }
  const exact = copyExactBytes(bytes);

  const chunkCount = expectedChunkCount(common.totalLength);
  const frames: PeerRangeChunkFrame[] = [];
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const start = chunkIndex * PEER_RANGE_MAX_CHUNK_BYTES;
    const end = start + expectedChunkLength(common.totalLength, chunkIndex);
    const payload = exact.slice(start, end).buffer;
    frames.push(
      Object.freeze({
        ...common,
        lane: 'bulk' as const,
        type: 'chunk' as const,
        chunkIndex,
        chunkCount,
        payload,
      }),
    );
  }
  return Object.freeze(frames);
}

export function createPeerRangeErrorFrame(
  descriptor: PeerRangeReadDescriptor,
  code: PeerRangeRemoteErrorCode,
  message: string,
  chunkIndex = 0,
): PeerRangeErrorFrame {
  const common = commonFrame(descriptor);
  if (!REMOTE_ERROR_CODES.has(code)) {
    throw new PeerRangeProtocolError('Peer range error code is not supported');
  }
  if (
    typeof message !== 'string' ||
    message.length === 0 ||
    message.length > MAX_ERROR_MESSAGE_LENGTH ||
    message !== message.trim() ||
    containsControlCharacter(message)
  ) {
    throw new PeerRangeProtocolError('Peer range error message is not bounded canonical text');
  }
  const chunkCount = expectedChunkCount(common.totalLength);
  const validatedChunkIndex = nonNegativeSafeInteger(chunkIndex, 'chunkIndex');
  if (validatedChunkIndex >= chunkCount) {
    throw new PeerRangeProtocolError('Peer range error chunkIndex exceeds chunkCount');
  }
  return Object.freeze({
    ...common,
    lane: 'bulk' as const,
    type: 'error' as const,
    chunkIndex: validatedChunkIndex,
    chunkCount,
    code,
    message,
  });
}

const CONTROL_KEYS = [
  'protocol',
  'version',
  'lane',
  'type',
  'connectionId',
  'sourceIdentity',
  'handleId',
  'requestId',
  'offset',
  'totalLength',
] as const;

const CLOSE_HANDLE_KEYS = [
  'protocol',
  'version',
  'lane',
  'type',
  'connectionId',
  'sourceIdentity',
  'handleId',
] as const;

const CHUNK_KEYS = [...CONTROL_KEYS, 'chunkIndex', 'chunkCount', 'payload'] as const;
const ERROR_KEYS = [...CONTROL_KEYS, 'chunkIndex', 'chunkCount', 'code', 'message'] as const;

function parseFrameBase(record: PlainRecord): PeerRangeFrameBase {
  if (record.protocol !== PEER_RANGE_PROTOCOL || record.version !== PEER_RANGE_PROTOCOL_VERSION) {
    throw new PeerRangeProtocolError('Peer range frame protocol or version is unsupported');
  }
  return commonFrame({
    connectionId: record.connectionId as string,
    sourceIdentity: record.sourceIdentity as string,
    handleId: record.handleId as string,
    requestId: record.requestId as string,
    offset: record.offset as number,
    totalLength: record.totalLength as number,
  });
}

function parsePeerRangeControlSnapshot(record: PlainRecord): PeerRangeControlFrame {
  if (record.type === 'close-handle') {
    assertExactKeys(record, CLOSE_HANDLE_KEYS);
    if (
      record.protocol !== PEER_RANGE_PROTOCOL ||
      record.version !== PEER_RANGE_PROTOCOL_VERSION ||
      record.lane !== 'control'
    ) {
      throw new PeerRangeProtocolError('Peer range close-handle frame is unsupported');
    }
    return createPeerRangeCloseHandleFrame({
      connectionId: record.connectionId as string,
      sourceIdentity: record.sourceIdentity as string,
      handleId: record.handleId as string,
    });
  }
  assertExactKeys(record, CONTROL_KEYS);
  if (record.lane !== 'control' || (record.type !== 'read' && record.type !== 'cancel')) {
    throw new PeerRangeProtocolError('Peer range control frame has an invalid lane or type');
  }
  const base = parseFrameBase(record);
  return Object.freeze({ ...base, lane: 'control' as const, type: record.type });
}

export function parsePeerRangeControlFrame(value: unknown): PeerRangeControlFrame {
  return parsePeerRangeControlSnapshot(snapshotFrameRecord(value));
}

const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength',
)?.get;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object | null;
const typedArrayBufferGetter = typedArrayPrototype
  ? Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get
  : undefined;
const typedArrayByteLengthGetter = typedArrayPrototype
  ? Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get
  : undefined;
const typedArrayByteOffsetGetter = typedArrayPrototype
  ? Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')?.get
  : undefined;

function copyArrayBufferPayload(value: unknown, expectedByteLength: number): ArrayBuffer {
  if (!arrayBufferByteLengthGetter) {
    throw new PeerRangeProtocolError('ArrayBuffer validation is unavailable');
  }

  let arrayBufferByteLength: number | null = null;
  try {
    arrayBufferByteLength = Reflect.apply(arrayBufferByteLengthGetter, value, []) as number;
  } catch {
    // PeerJS reconstructs an internally chunked BinaryPack envelope as a
    // Uint8Array. BinaryPack then preserves that container type for nested
    // raw values, so this exact wire representation is handled below.
  }

  let source: Uint8Array;
  if (arrayBufferByteLength !== null) {
    if (arrayBufferByteLength !== expectedByteLength) {
      throw new PeerRangeProtocolError(
        'Peer range chunk payload length does not match its semantic position',
      );
    }
    try {
      source = new Uint8Array(value as ArrayBuffer);
    } catch {
      throw new PeerRangeProtocolError('Peer range chunk payload could not be copied');
    }
  } else {
    if (!typedArrayBufferGetter || !typedArrayByteLengthGetter || !typedArrayByteOffsetGetter) {
      throw new PeerRangeProtocolError('Uint8Array validation is unavailable');
    }
    let prototype: object | null;
    let backingPrototype: object | null;
    let buffer: ArrayBuffer;
    let byteLength: number;
    let byteOffset: number;
    let backingByteLength: number;
    try {
      buffer = Reflect.apply(typedArrayBufferGetter, value, []) as ArrayBuffer;
      byteLength = Reflect.apply(typedArrayByteLengthGetter, value, []) as number;
      byteOffset = Reflect.apply(typedArrayByteOffsetGetter, value, []) as number;
      backingByteLength = Reflect.apply(arrayBufferByteLengthGetter, buffer, []) as number;
    } catch {
      throw new PeerRangeProtocolError(
        'Peer range chunk payload must be an ArrayBuffer or exact Uint8Array wire value',
      );
    }
    try {
      prototype = Reflect.getPrototypeOf(value as object);
      backingPrototype = Reflect.getPrototypeOf(buffer);
    } catch {
      throw new PeerRangeProtocolError('Peer range chunk payload reflection failed');
    }
    if (
      prototype !== Uint8Array.prototype ||
      backingPrototype !== ArrayBuffer.prototype ||
      byteLength !== expectedByteLength ||
      !Number.isSafeInteger(byteOffset) ||
      byteOffset !== 0 ||
      backingByteLength !== byteLength
    ) {
      throw new PeerRangeProtocolError(
        'Peer range chunk payload length does not match its semantic position',
      );
    }
    try {
      source = new Uint8Array(buffer, byteOffset, byteLength);
    } catch {
      throw new PeerRangeProtocolError('Peer range chunk payload could not be copied');
    }
  }
  try {
    const copy = new Uint8Array(expectedByteLength);
    copy.set(source);
    return copy.buffer;
  } catch (error) {
    if (error instanceof PeerRangeProtocolError) throw error;
    throw new PeerRangeProtocolError('Peer range chunk payload could not be copied');
  }
}

function parsePeerRangeBulkSnapshot(record: PlainRecord): PeerRangeBulkFrame {
  if (record.type === 'chunk') assertExactKeys(record, CHUNK_KEYS);
  else if (record.type === 'error') assertExactKeys(record, ERROR_KEYS);
  else throw new PeerRangeProtocolError('Peer range bulk frame type is invalid');
  if (record.lane !== 'bulk') {
    throw new PeerRangeProtocolError('Peer range bulk frame has an invalid lane');
  }

  const base = parseFrameBase(record);
  const chunkCount = positiveSafeInteger(
    record.chunkCount,
    'chunkCount',
    PEER_RANGE_MAX_CHUNK_COUNT,
  );
  if (chunkCount !== expectedChunkCount(base.totalLength)) {
    throw new PeerRangeProtocolError('Peer range chunkCount does not match totalLength');
  }
  const chunkIndex = nonNegativeSafeInteger(record.chunkIndex, 'chunkIndex');
  if (chunkIndex >= chunkCount) {
    throw new PeerRangeProtocolError('Peer range chunkIndex exceeds chunkCount');
  }

  if (record.type === 'chunk') {
    // Capture this detached data-property reference exactly once before the
    // bounded defensive copy. No frame-owned getter can swap it mid-parse.
    const payloadValue = record.payload;
    const payload = copyArrayBufferPayload(
      payloadValue,
      expectedChunkLength(base.totalLength, chunkIndex),
    );
    return Object.freeze({
      ...base,
      lane: 'bulk' as const,
      type: 'chunk' as const,
      chunkIndex,
      chunkCount,
      payload,
    });
  }

  if (!REMOTE_ERROR_CODES.has(record.code as PeerRangeRemoteErrorCode)) {
    throw new PeerRangeProtocolError('Peer range error code is not supported');
  }
  const message = record.message;
  if (
    typeof message !== 'string' ||
    message.length === 0 ||
    message.length > MAX_ERROR_MESSAGE_LENGTH ||
    message !== message.trim() ||
    containsControlCharacter(message)
  ) {
    throw new PeerRangeProtocolError('Peer range error message is not bounded canonical text');
  }
  return Object.freeze({
    ...base,
    lane: 'bulk' as const,
    type: 'error' as const,
    chunkIndex,
    chunkCount,
    code: record.code as PeerRangeRemoteErrorCode,
    message,
  });
}

export function parsePeerRangeBulkFrame(value: unknown): PeerRangeBulkFrame {
  return parsePeerRangeBulkSnapshot(snapshotFrameRecord(value));
}

function requestKey(descriptor: PeerRangeReadDescriptor): string {
  return JSON.stringify([
    descriptor.connectionId,
    descriptor.sourceIdentity,
    descriptor.handleId,
    descriptor.requestId,
    descriptor.offset,
    descriptor.totalLength,
  ]);
}

function configuredLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > maximum) {
    throw new RangeError(`${label} must be a positive safe integer up to ${maximum}`);
  }
  return selected;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Peer range request was aborted', 'AbortError');
}

function candidateRequestKey(snapshot: PlainRecord | null): string | null {
  if (!snapshot) return null;
  try {
    return requestKey(
      validatedDescriptor({
        connectionId: snapshot.connectionId as string,
        sourceIdentity: snapshot.sourceIdentity as string,
        handleId: snapshot.handleId as string,
        requestId: snapshot.requestId as string,
        offset: snapshot.offset as number,
        totalLength: snapshot.totalLength as number,
      }),
    );
  } catch {
    return null;
  }
}

/**
 * Bounded exact-response assembler for bulk-lane frames.
 *
 * Chunks may arrive in any order. Frames for a different immutable descriptor
 * are uncorrelated and ignored; a duplicate or mismatch within the exact
 * descriptor fails the whole request. Cancellation removes ownership
 * immediately, making all later bulk frames for that request inert. Only a
 * complete, independently copied byte array is ever exposed to the caller.
 */
export class PeerRangeResponseAssembler {
  readonly #connectionId: string;
  readonly #maxActiveRequests: number;
  readonly #maxRetainedBytes: number;
  readonly #maxSettledRequests: number;
  readonly #active = new Map<string, AssemblyState>();
  readonly #settled = new Set<string>();
  #retainedBytes = 0;
  #closed = false;

  constructor(options: PeerRangeResponseAssemblerOptions) {
    this.#connectionId = validatePeerRangeOpaqueId(
      options.connectionId,
      'connectionId',
      PEER_RANGE_MAX_CONNECTION_ID_LENGTH,
    );
    this.#maxActiveRequests = configuredLimit(
      options.maxActiveRequests,
      8,
      MAX_CONFIGURED_ACTIVE_REQUESTS,
      'maxActiveRequests',
    );
    this.#maxRetainedBytes = configuredLimit(
      options.maxRetainedBytes,
      512 * 1024,
      MAX_CONFIGURED_RETAINED_BYTES,
      'maxRetainedBytes',
    );
    this.#maxSettledRequests = configuredLimit(
      options.maxSettledRequests,
      512,
      MAX_CONFIGURED_SETTLED_REQUESTS,
      'maxSettledRequests',
    );
  }

  get activeRequestCount(): number {
    return this.#active.size;
  }

  get retainedByteLength(): number {
    return this.#retainedBytes;
  }

  get settledRequestCount(): number {
    return this.#settled.size;
  }

  open(requestValue: PeerRangeReadFrame, signal?: AbortSignal): Promise<Uint8Array> {
    if (this.#closed) throw new PeerRangeAssemblerClosedError();
    const request = parsePeerRangeControlFrame(requestValue);
    if (request.type !== 'read') {
      throw new PeerRangeProtocolError('Only a read frame can open a response assembly');
    }
    this.#assertTrustedConnection(request.connectionId);
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const key = requestKey(request);
    if (this.#settled.has(key)) {
      throw new PeerRangeProtocolError('Peer range request descriptor was already settled');
    }
    if (this.#active.has(key)) {
      throw new PeerRangeProtocolError('Peer range request key is already active');
    }
    if (this.#active.size >= this.#maxActiveRequests) {
      throw new PeerRangeLimitError('Peer range active-request limit was reached');
    }

    let resolve!: (bytes: Uint8Array) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<Uint8Array>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const onAbort = signal
      ? () => {
          this.#fail(key, abortReason(signal));
        }
      : undefined;
    const state: AssemblyState = {
      request,
      chunkCount: expectedChunkCount(request.totalLength),
      chunks: new Array<Uint8Array | undefined>(expectedChunkCount(request.totalLength)),
      signal,
      onAbort,
      resolve,
      reject,
      receivedChunks: 0,
      retainedBytes: 0,
    };
    this.#active.set(key, state);
    if (signal && onAbort) signal.addEventListener('abort', onAbort, { once: true });
    return promise;
  }

  accept(value: unknown): PeerRangeAssemblyStatus {
    if (this.#closed) return 'ignored';

    let frame: PeerRangeBulkFrame;
    let snapshot: PlainRecord | null = null;
    try {
      snapshot = snapshotFrameRecord(value);
      frame = parsePeerRangeBulkSnapshot(snapshot);
    } catch (error) {
      const candidateKey = candidateRequestKey(snapshot);
      if (candidateKey && this.#active.has(candidateKey)) {
        this.#fail(candidateKey, error);
        return 'failed';
      }
      throw error;
    }

    this.#assertTrustedConnection(frame.connectionId);

    const key = requestKey(frame);
    const state = this.#active.get(key);
    if (!state) return 'ignored';

    const request = state.request;
    if (
      frame.sourceIdentity !== request.sourceIdentity ||
      frame.offset !== request.offset ||
      frame.totalLength !== request.totalLength ||
      frame.chunkCount !== state.chunkCount
    ) {
      this.#fail(key, new PeerRangeProtocolError('Peer range response correlation mismatch'));
      return 'failed';
    }

    if (frame.type === 'error') {
      this.#fail(key, new PeerRangeRemoteError(frame.code, frame.message));
      return 'failed';
    }

    const expectedLength = expectedChunkLength(request.totalLength, frame.chunkIndex);
    if (frame.payload.byteLength !== expectedLength) {
      this.#fail(key, new PeerRangeProtocolError('Peer range response chunk length mismatch'));
      return 'failed';
    }
    if (state.chunks[frame.chunkIndex]) {
      this.#fail(key, new PeerRangeProtocolError('Peer range response contains a duplicate chunk'));
      return 'failed';
    }
    if (this.#retainedBytes + expectedLength > this.#maxRetainedBytes) {
      this.#fail(key, new PeerRangeLimitError('Peer range retained-byte limit was reached'));
      return 'failed';
    }

    const payload = new Uint8Array(frame.payload.slice(0));
    state.chunks[frame.chunkIndex] = payload;
    state.receivedChunks += 1;
    state.retainedBytes += payload.byteLength;
    this.#retainedBytes += payload.byteLength;

    if (state.receivedChunks !== state.chunkCount) return 'accepted';
    if (state.retainedBytes !== request.totalLength) {
      this.#fail(key, new PeerRangeProtocolError('Peer range response did not assemble exactly'));
      return 'failed';
    }

    const result = new Uint8Array(request.totalLength);
    for (let index = 0; index < state.chunks.length; index += 1) {
      const chunk = state.chunks[index];
      if (!chunk) {
        this.#fail(key, new PeerRangeProtocolError('Peer range response is incomplete'));
        return 'failed';
      }
      result.set(chunk, index * PEER_RANGE_MAX_CHUNK_BYTES);
    }
    this.#settle(key);
    state.resolve(result);
    return 'completed';
  }

  cancel(
    descriptor: PeerRangeReadDescriptor,
    reason: unknown = new PeerRangeRequestCancelledError(),
  ): boolean {
    if (this.#closed) return false;
    const validated = validatedDescriptor(descriptor);
    this.#assertTrustedConnection(validated.connectionId);
    const key = requestKey(validated);
    return this.#fail(key, reason);
  }

  close(reason: unknown = new PeerRangeAssemblerClosedError()): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const key of [...this.#active.keys()]) this.#fail(key, reason);
  }

  #settle(key: string): AssemblyState | undefined {
    const state = this.#active.get(key);
    if (!state) return undefined;
    this.#active.delete(key);
    if (state.signal && state.onAbort) {
      state.signal.removeEventListener('abort', state.onAbort);
    }
    this.#retainedBytes -= state.retainedBytes;
    state.chunks.fill(undefined);
    state.retainedBytes = 0;
    this.#rememberSettled(key);
    return state;
  }

  #assertTrustedConnection(connectionId: string): void {
    if (connectionId !== this.#connectionId) {
      throw new PeerRangeProtocolError('Peer range frame claimed a different connection');
    }
  }

  #rememberSettled(key: string): void {
    this.#settled.add(key);
    while (this.#settled.size > this.#maxSettledRequests) {
      const oldest = this.#settled.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#settled.delete(oldest);
    }
  }

  #fail(key: string, error: unknown): boolean {
    const state = this.#settle(key);
    if (!state) return false;
    state.reject(error);
    return true;
  }
}
