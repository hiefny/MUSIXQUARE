import { MAX_FILE_PLAYBACK_ROOM_TIME_MS } from '../network/file-playback-clock-exchange.ts';
import { FILE_MEDIA_SOURCE_OFFER_V2_TYPE } from '../network/file-playback-transport-contract.ts';
import { REMOTE_SHARE_AES_GCM_TAG_BYTES, REMOTE_SHARE_MAX_BYTES } from '../core/constants.ts';
import type { QueueItemId } from '../types/index.ts';
import {
  CODEC_TIMELINE_MANIFEST_HEADER_BYTES,
  CODEC_TIMELINE_MANIFEST_MAX_BYTES,
} from './manifests/codec-timeline-manifest.ts';
import { isQueueItemId } from './queue-model.ts';
import {
  PEER_RANGE_MAX_CONNECTION_ID_LENGTH,
  PEER_RANGE_MAX_HANDLE_ID_LENGTH,
} from './sources/peer-range-protocol.ts';

export const FILE_MEDIA_SOURCE_OFFER_V2_PROTOCOL_VERSION = 2 as const;
/** Maximum canonical JSON size after exact offer validation. */
export const FILE_MEDIA_SOURCE_OFFER_V2_MAX_FRAME_BYTES = 4 * 1024;
export const FILE_MEDIA_SOURCE_OFFER_V2_MAX_IDENTIFIER_LENGTH = 256;
export const FILE_MEDIA_SOURCE_OFFER_V2_MAX_NAME_LENGTH = 512;
export const FILE_MEDIA_SOURCE_OFFER_V2_MAX_MIME_LENGTH = 128;
export const FILE_MEDIA_SOURCE_OFFER_V2_R2_WHOLE_BLOB_ENCRYPTION = 'aes-256-gcm-whole-v1' as const;

const DEFAULT_MAX_LIVE_QUEUE_ITEMS = 128;
const MAX_LIVE_QUEUE_ITEMS = 1_024;
const DEFAULT_MAX_ACTIVE_OFFERS = 32;
const MAX_ACTIVE_OFFERS = 256;
const DEFAULT_MAX_RETIRED_TOMBSTONES = 16_384;
const MAX_RETIRED_TOMBSTONES = 1_000_000;
const MIME_PATTERN = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u;
const R2_STORAGE_ROOM_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const R2_OBJECT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const AES_256_KEY_BYTES = 32;
const AES_GCM_IV_BYTES = 12;
const AES_256_KEY_BASE64_LENGTH = 44;
const AES_GCM_IV_BASE64_LENGTH = 16;
const SHA_256_BYTES = 32;
const SHA_256_BASE64_LENGTH = 44;

const PEER_RANGE_OFFER_KEYS = Object.freeze([
  'connectionId',
  'encodedSize',
  'expiresAtRoomTimeMs',
  'handleId',
  'mime',
  'name',
  'prepareId',
  'prepareRevision',
  'protocolVersion',
  'queueItemId',
  'sessionId',
  'sourceIdentity',
  'transferSessionId',
  'transport',
  'type',
] as const);

const PEER_RANGE_MANIFEST_OFFER_KEYS = Object.freeze([
  'connectionId',
  'encodedSize',
  'expiresAtRoomTimeMs',
  'handleId',
  'manifestByteLength',
  'manifestSha256B64',
  'mime',
  'name',
  'prepareId',
  'prepareRevision',
  'protocolVersion',
  'queueItemId',
  'sessionId',
  'sourceIdentity',
  'transferSessionId',
  'transport',
  'type',
] as const);

const R2_WHOLE_BLOB_OFFER_KEYS = Object.freeze([
  'connectionId',
  'encodedSize',
  'encryptedSize',
  'encryption',
  'expiresAtRoomTimeMs',
  'ivB64',
  'keyB64',
  'mime',
  'name',
  'objectId',
  'prepareId',
  'prepareRevision',
  'protocolVersion',
  'queueItemId',
  'sessionId',
  'sourceIdentity',
  'storageRoomId',
  'transferSessionId',
  'transport',
  'type',
] as const);

type Primitive = string | number;
type Snapshot = Readonly<Record<string, Primitive>>;
type CommonSnapshot = Snapshot &
  Readonly<{
    sessionId: string;
    connectionId: string;
    prepareId: string;
    prepareRevision: number;
    queueItemId: QueueItemId;
    sourceIdentity: string;
    transferSessionId: string;
    encodedSize: number;
    name: string;
    mime: string;
    expiresAtRoomTimeMs: number;
  }>;
declare const currentOfferLeaseBrand: unique symbol;

/**
 * Opaque proof that one exact accepted offer is still current in its issuing
 * registry. Runtime authenticity is held only in a registry-private WeakMap;
 * this type has no serializable or forgeable authority fields.
 */
export interface FileMediaCurrentOfferLease {
  readonly [currentOfferLeaseBrand]: true;
}

interface CurrentOfferLeaseRecord {
  readonly offer: Readonly<FileMediaSourceOfferV2>;
}

/**
 * Host -> guest preparation authority for one exact encoded source.
 *
 * This is deliberately not a playback run or rendezvous. A queue occurrence
 * may be prepared and superseded before any run exists. Codec/container
 * Regular peer-range offers deliberately carry no codec/container metadata:
 * the guest must re-read and validate it through EncodedAudioSource. The
 * manifest-prefixed variant carries only authenticated bundle geometry in the
 * offer; its bounded timeline manifest is still read from that exact source
 * and structurally revalidated before decoder construction.
 *
 * The transport discriminant keeps peer-range handles disjoint from temporary
 * whole-Blob R2 descriptors. Record-encrypted R2 remains a future variant.
 */
export interface PeerRangeFileMediaSourceOfferV2 {
  readonly protocolVersion: typeof FILE_MEDIA_SOURCE_OFFER_V2_PROTOCOL_VERSION;
  readonly type: typeof FILE_MEDIA_SOURCE_OFFER_V2_TYPE;
  readonly transport: 'peer-range';
  readonly sessionId: string;
  readonly connectionId: string;
  readonly prepareId: string;
  readonly prepareRevision: number;
  readonly queueItemId: QueueItemId;
  readonly sourceIdentity: string;
  readonly transferSessionId: string;
  readonly handleId: string;
  readonly encodedSize: number;
  readonly name: string;
  readonly mime: string;
  readonly expiresAtRoomTimeMs: number;
}

/**
 * Peer-range transport whose one handle exposes `[manifest][encoded media]`.
 * `encodedSize` remains the media size; bundle geometry is derived locally.
 */
export interface PeerRangeManifestFileMediaSourceOfferV2 {
  readonly protocolVersion: typeof FILE_MEDIA_SOURCE_OFFER_V2_PROTOCOL_VERSION;
  readonly type: typeof FILE_MEDIA_SOURCE_OFFER_V2_TYPE;
  readonly transport: 'peer-range-manifest';
  readonly sessionId: string;
  readonly connectionId: string;
  readonly prepareId: string;
  readonly prepareRevision: number;
  readonly queueItemId: QueueItemId;
  readonly sourceIdentity: string;
  readonly transferSessionId: string;
  readonly handleId: string;
  /** Encoded media bytes only, excluding the manifest prefix. */
  readonly encodedSize: number;
  readonly manifestByteLength: number;
  readonly manifestSha256B64: string;
  readonly name: string;
  readonly mime: string;
  readonly expiresAtRoomTimeMs: number;
}

/**
 * Temporary whole-Blob object-storage transport for a current-route browser
 * decode fallback. The cleanup capability and endpoint URL are deliberately
 * not wire fields.
 */
export interface R2WholeBlobFileMediaSourceOfferV2 {
  readonly protocolVersion: typeof FILE_MEDIA_SOURCE_OFFER_V2_PROTOCOL_VERSION;
  readonly type: typeof FILE_MEDIA_SOURCE_OFFER_V2_TYPE;
  readonly transport: 'r2-whole-blob';
  readonly encryption: typeof FILE_MEDIA_SOURCE_OFFER_V2_R2_WHOLE_BLOB_ENCRYPTION;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly prepareId: string;
  readonly prepareRevision: number;
  readonly queueItemId: QueueItemId;
  readonly sourceIdentity: string;
  readonly transferSessionId: string;
  readonly storageRoomId: string;
  readonly objectId: string;
  readonly encodedSize: number;
  readonly encryptedSize: number;
  readonly keyB64: string;
  readonly ivB64: string;
  readonly name: string;
  readonly mime: string;
  readonly expiresAtRoomTimeMs: number;
}

export type FileMediaSourceOfferV2 =
  | PeerRangeFileMediaSourceOfferV2
  | PeerRangeManifestFileMediaSourceOfferV2
  | R2WholeBlobFileMediaSourceOfferV2;

export type AnyPeerRangeFileMediaSourceOfferV2 =
  | PeerRangeFileMediaSourceOfferV2
  | PeerRangeManifestFileMediaSourceOfferV2;

export type PeerRangeFileMediaSourceOfferV2Input = Omit<
  PeerRangeFileMediaSourceOfferV2,
  'protocolVersion' | 'transport' | 'type'
>;

export type PeerRangeManifestFileMediaSourceOfferV2Input = Omit<
  PeerRangeManifestFileMediaSourceOfferV2,
  'protocolVersion' | 'transport' | 'type'
>;

export type R2WholeBlobFileMediaSourceOfferV2Input = Omit<
  R2WholeBlobFileMediaSourceOfferV2,
  'encryption' | 'protocolVersion' | 'transport' | 'type'
>;

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isIdentifier(
  value: unknown,
  maximumLength = FILE_MEDIA_SOURCE_OFFER_V2_MAX_IDENTIFIER_LENGTH,
): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value === value.trim() &&
    !containsControlCharacter(value) &&
    !hasUnpairedSurrogate(value)
  );
}

function isName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= FILE_MEDIA_SOURCE_OFFER_V2_MAX_NAME_LENGTH &&
    !containsControlCharacter(value) &&
    !hasUnpairedSurrogate(value)
  );
}

function isMime(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= FILE_MEDIA_SOURCE_OFFER_V2_MAX_MIME_LENGTH &&
    MIME_PATTERN.test(value)
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isRoomTime(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_FILE_PLAYBACK_ROOM_TIME_MS
  );
}

function isCanonicalBase64(
  value: unknown,
  encodedLength: number,
  byteLength: number,
): value is string {
  if (typeof value !== 'string' || value.length !== encodedLength) return false;
  try {
    const decoded = atob(value);
    return decoded.length === byteLength && btoa(decoded) === value;
  } catch {
    return false;
  }
}

/**
 * Derive the exact `[manifest][media]` handle size without unsafe addition.
 * Returns null for non-canonical manifest bounds or an overflowing bundle.
 */
export function derivePeerRangeManifestBundleSize(
  encodedSize: unknown,
  manifestByteLength: unknown,
): number | null {
  if (
    !isPositiveSafeInteger(encodedSize) ||
    typeof manifestByteLength !== 'number' ||
    !Number.isSafeInteger(manifestByteLength) ||
    manifestByteLength < CODEC_TIMELINE_MANIFEST_HEADER_BYTES ||
    manifestByteLength > CODEC_TIMELINE_MANIFEST_MAX_BYTES
  ) {
    return null;
  }
  const bundleSize = encodedSize + manifestByteLength;
  return Number.isSafeInteger(bundleSize) ? bundleSize : null;
}

/**
 * Creates an adapter-owned preparation occurrence ID using only a platform
 * CSPRNG. There is deliberately no timestamp or Math.random fallback.
 */
export function createFileMediaPrepareId(): string {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi) throw new Error('Secure file media prepare ID generation is unavailable');

  const randomUUID = cryptoApi.randomUUID;
  if (typeof randomUUID === 'function') {
    const prepareId = randomUUID.call(cryptoApi);
    if (!isQueueItemId(prepareId)) {
      throw new Error('Secure file media prepare ID generation returned an invalid UUID');
    }
    return prepareId;
  }

  if (typeof cryptoApi.getRandomValues !== 'function') {
    throw new Error('Secure file media prepare ID generation is unavailable');
  }
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const prepareId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16,
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  if (!isQueueItemId(prepareId)) {
    throw new Error('Secure file media prepare ID generation returned an invalid UUID');
  }
  return prepareId;
}

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function offerKeysForTransport(
  transport: unknown,
):
  | typeof PEER_RANGE_OFFER_KEYS
  | typeof PEER_RANGE_MANIFEST_OFFER_KEYS
  | typeof R2_WHOLE_BLOB_OFFER_KEYS
  | null {
  if (transport === 'peer-range') return PEER_RANGE_OFFER_KEYS;
  if (transport === 'peer-range-manifest') return PEER_RANGE_MANIFEST_OFFER_KEYS;
  if (transport === 'r2-whole-blob') return R2_WHOLE_BLOB_OFFER_KEYS;
  return null;
}

function snapshotExactOffer(value: unknown): Snapshot | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const transportDescriptor = Reflect.getOwnPropertyDescriptor(value, 'transport');
    if (
      !transportDescriptor ||
      transportDescriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(transportDescriptor, 'value')
    ) {
      return null;
    }
    const offerKeys = offerKeysForTransport(transportDescriptor.value);
    if (!offerKeys) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== offerKeys.length ||
      ownKeys.some((key) => typeof key !== 'string' || !offerKeys.includes(key as never))
    ) {
      return null;
    }

    const snapshot = Object.create(null) as Record<string, Primitive>;
    for (const key of offerKeys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (
        !descriptor ||
        descriptor.enumerable !== true ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
        (typeof descriptor.value !== 'string' && typeof descriptor.value !== 'number')
      ) {
        return null;
      }
      snapshot[key] = descriptor.value as Primitive;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function serializedByteLength(value: FileMediaSourceOfferV2): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function hasValidCommonFields(snapshot: Snapshot): snapshot is CommonSnapshot {
  return (
    snapshot.protocolVersion === FILE_MEDIA_SOURCE_OFFER_V2_PROTOCOL_VERSION &&
    snapshot.type === FILE_MEDIA_SOURCE_OFFER_V2_TYPE &&
    isIdentifier(snapshot.sessionId) &&
    isIdentifier(snapshot.connectionId, PEER_RANGE_MAX_CONNECTION_ID_LENGTH) &&
    isQueueItemId(snapshot.prepareId) &&
    isPositiveSafeInteger(snapshot.prepareRevision) &&
    isQueueItemId(snapshot.queueItemId) &&
    isIdentifier(snapshot.sourceIdentity) &&
    isIdentifier(snapshot.transferSessionId) &&
    isPositiveSafeInteger(snapshot.encodedSize) &&
    isName(snapshot.name) &&
    isMime(snapshot.mime) &&
    isRoomTime(snapshot.expiresAtRoomTimeMs)
  );
}

function hasDistinctCommonIdentities(snapshot: Snapshot, transportIdentity: string): boolean {
  const identities = [
    snapshot.sessionId,
    snapshot.connectionId,
    snapshot.prepareId,
    snapshot.queueItemId,
    snapshot.sourceIdentity,
    snapshot.transferSessionId,
    transportIdentity,
  ];
  return new Set(identities).size === identities.length;
}

function canonicalizePeerRange(
  snapshot: Snapshot,
): Readonly<PeerRangeFileMediaSourceOfferV2> | null {
  if (
    snapshot.transport !== 'peer-range' ||
    !hasValidCommonFields(snapshot) ||
    !isIdentifier(snapshot.handleId, PEER_RANGE_MAX_HANDLE_ID_LENGTH) ||
    !hasDistinctCommonIdentities(snapshot, snapshot.handleId)
  ) {
    return null;
  }

  const offer = freezeCanonical({
    protocolVersion: FILE_MEDIA_SOURCE_OFFER_V2_PROTOCOL_VERSION,
    type: FILE_MEDIA_SOURCE_OFFER_V2_TYPE,
    transport: 'peer-range' as const,
    sessionId: snapshot.sessionId,
    connectionId: snapshot.connectionId,
    prepareId: snapshot.prepareId,
    prepareRevision: snapshot.prepareRevision,
    queueItemId: snapshot.queueItemId as QueueItemId,
    sourceIdentity: snapshot.sourceIdentity,
    transferSessionId: snapshot.transferSessionId,
    handleId: snapshot.handleId,
    encodedSize: snapshot.encodedSize,
    name: snapshot.name,
    mime: snapshot.mime,
    expiresAtRoomTimeMs: snapshot.expiresAtRoomTimeMs,
  });
  return serializedByteLength(offer) <= FILE_MEDIA_SOURCE_OFFER_V2_MAX_FRAME_BYTES ? offer : null;
}

function canonicalizePeerRangeManifest(
  snapshot: Snapshot,
): Readonly<PeerRangeManifestFileMediaSourceOfferV2> | null {
  if (
    snapshot.transport !== 'peer-range-manifest' ||
    !hasValidCommonFields(snapshot) ||
    !isIdentifier(snapshot.handleId, PEER_RANGE_MAX_HANDLE_ID_LENGTH) ||
    !hasDistinctCommonIdentities(snapshot, snapshot.handleId) ||
    typeof snapshot.manifestByteLength !== 'number' ||
    derivePeerRangeManifestBundleSize(snapshot.encodedSize, snapshot.manifestByteLength) === null ||
    !isCanonicalBase64(snapshot.manifestSha256B64, SHA_256_BASE64_LENGTH, SHA_256_BYTES)
  ) {
    return null;
  }

  const offer = freezeCanonical({
    protocolVersion: FILE_MEDIA_SOURCE_OFFER_V2_PROTOCOL_VERSION,
    type: FILE_MEDIA_SOURCE_OFFER_V2_TYPE,
    transport: 'peer-range-manifest' as const,
    sessionId: snapshot.sessionId,
    connectionId: snapshot.connectionId,
    prepareId: snapshot.prepareId,
    prepareRevision: snapshot.prepareRevision,
    queueItemId: snapshot.queueItemId as QueueItemId,
    sourceIdentity: snapshot.sourceIdentity,
    transferSessionId: snapshot.transferSessionId,
    handleId: snapshot.handleId,
    encodedSize: snapshot.encodedSize,
    manifestByteLength: snapshot.manifestByteLength,
    manifestSha256B64: snapshot.manifestSha256B64,
    name: snapshot.name,
    mime: snapshot.mime,
    expiresAtRoomTimeMs: snapshot.expiresAtRoomTimeMs,
  });
  return serializedByteLength(offer) <= FILE_MEDIA_SOURCE_OFFER_V2_MAX_FRAME_BYTES ? offer : null;
}

function canonicalizeR2WholeBlob(
  snapshot: Snapshot,
): Readonly<R2WholeBlobFileMediaSourceOfferV2> | null {
  if (
    snapshot.transport !== 'r2-whole-blob' ||
    snapshot.encryption !== FILE_MEDIA_SOURCE_OFFER_V2_R2_WHOLE_BLOB_ENCRYPTION ||
    !hasValidCommonFields(snapshot) ||
    snapshot.encodedSize > REMOTE_SHARE_MAX_BYTES ||
    !isPositiveSafeInteger(snapshot.encryptedSize) ||
    snapshot.encryptedSize !== snapshot.encodedSize + REMOTE_SHARE_AES_GCM_TAG_BYTES ||
    typeof snapshot.storageRoomId !== 'string' ||
    !R2_STORAGE_ROOM_PATTERN.test(snapshot.storageRoomId) ||
    typeof snapshot.objectId !== 'string' ||
    !R2_OBJECT_ID_PATTERN.test(snapshot.objectId) ||
    !hasDistinctCommonIdentities(snapshot, snapshot.objectId) ||
    !isCanonicalBase64(snapshot.keyB64, AES_256_KEY_BASE64_LENGTH, AES_256_KEY_BYTES) ||
    !isCanonicalBase64(snapshot.ivB64, AES_GCM_IV_BASE64_LENGTH, AES_GCM_IV_BYTES)
  ) {
    return null;
  }

  const offer = freezeCanonical({
    protocolVersion: FILE_MEDIA_SOURCE_OFFER_V2_PROTOCOL_VERSION,
    type: FILE_MEDIA_SOURCE_OFFER_V2_TYPE,
    transport: 'r2-whole-blob' as const,
    encryption: FILE_MEDIA_SOURCE_OFFER_V2_R2_WHOLE_BLOB_ENCRYPTION,
    sessionId: snapshot.sessionId,
    connectionId: snapshot.connectionId,
    prepareId: snapshot.prepareId,
    prepareRevision: snapshot.prepareRevision,
    queueItemId: snapshot.queueItemId as QueueItemId,
    sourceIdentity: snapshot.sourceIdentity,
    transferSessionId: snapshot.transferSessionId,
    storageRoomId: snapshot.storageRoomId,
    objectId: snapshot.objectId,
    encodedSize: snapshot.encodedSize,
    encryptedSize: snapshot.encryptedSize,
    keyB64: snapshot.keyB64,
    ivB64: snapshot.ivB64,
    name: snapshot.name,
    mime: snapshot.mime,
    expiresAtRoomTimeMs: snapshot.expiresAtRoomTimeMs,
  });
  return serializedByteLength(offer) <= FILE_MEDIA_SOURCE_OFFER_V2_MAX_FRAME_BYTES ? offer : null;
}

function canonicalize(snapshot: Snapshot): Readonly<FileMediaSourceOfferV2> | null {
  if (snapshot.transport === 'peer-range') return canonicalizePeerRange(snapshot);
  if (snapshot.transport === 'peer-range-manifest') {
    return canonicalizePeerRangeManifest(snapshot);
  }
  if (snapshot.transport === 'r2-whole-blob') return canonicalizeR2WholeBlob(snapshot);
  return null;
}

export function createPeerRangeFileMediaSourceOfferV2(
  input: PeerRangeFileMediaSourceOfferV2Input,
): Readonly<PeerRangeFileMediaSourceOfferV2> {
  const candidate = {
    protocolVersion: FILE_MEDIA_SOURCE_OFFER_V2_PROTOCOL_VERSION,
    type: FILE_MEDIA_SOURCE_OFFER_V2_TYPE,
    transport: 'peer-range',
    ...input,
  };
  const parsed = parseFileMediaSourceOfferV2(candidate);
  if (!parsed || parsed.transport !== 'peer-range') {
    throw new TypeError('File media source offer is invalid');
  }
  return parsed;
}

export function createPeerRangeManifestFileMediaSourceOfferV2(
  input: PeerRangeManifestFileMediaSourceOfferV2Input,
): Readonly<PeerRangeManifestFileMediaSourceOfferV2> {
  const candidate = {
    protocolVersion: FILE_MEDIA_SOURCE_OFFER_V2_PROTOCOL_VERSION,
    type: FILE_MEDIA_SOURCE_OFFER_V2_TYPE,
    transport: 'peer-range-manifest',
    ...input,
  };
  const parsed = parseFileMediaSourceOfferV2(candidate);
  if (!parsed || parsed.transport !== 'peer-range-manifest') {
    throw new TypeError('Manifest file media source offer is invalid');
  }
  return parsed;
}

export function createR2WholeBlobFileMediaSourceOfferV2(
  input: R2WholeBlobFileMediaSourceOfferV2Input,
): Readonly<R2WholeBlobFileMediaSourceOfferV2> {
  const candidate = {
    protocolVersion: FILE_MEDIA_SOURCE_OFFER_V2_PROTOCOL_VERSION,
    type: FILE_MEDIA_SOURCE_OFFER_V2_TYPE,
    transport: 'r2-whole-blob',
    encryption: FILE_MEDIA_SOURCE_OFFER_V2_R2_WHOLE_BLOB_ENCRYPTION,
    ...input,
  };
  const parsed = parseFileMediaSourceOfferV2(candidate);
  if (!parsed || parsed.transport !== 'r2-whole-blob') {
    throw new TypeError('File media source offer is invalid');
  }
  return parsed;
}

export function parseFileMediaSourceOfferV2(
  value: unknown,
): Readonly<FileMediaSourceOfferV2> | null {
  const snapshot = snapshotExactOffer(value);
  return snapshot ? canonicalize(snapshot) : null;
}

export function isDirectPeerRangeFileMediaSourceOfferV2(
  value: unknown,
): value is PeerRangeFileMediaSourceOfferV2 {
  return parseFileMediaSourceOfferV2(value)?.transport === 'peer-range';
}

export function isManifestPeerRangeFileMediaSourceOfferV2(
  value: unknown,
): value is PeerRangeManifestFileMediaSourceOfferV2 {
  return parseFileMediaSourceOfferV2(value)?.transport === 'peer-range-manifest';
}

export function isAnyPeerRangeFileMediaSourceOfferV2(
  value: unknown,
): value is AnyPeerRangeFileMediaSourceOfferV2 {
  const transport = parseFileMediaSourceOfferV2(value)?.transport;
  return transport === 'peer-range' || transport === 'peer-range-manifest';
}

export function serializeFileMediaSourceOfferV2(value: unknown): string {
  const offer = parseFileMediaSourceOfferV2(value);
  if (!offer) throw new TypeError('File media source offer is invalid');
  const serialized = JSON.stringify(offer);
  if (
    new TextEncoder().encode(serialized).byteLength > FILE_MEDIA_SOURCE_OFFER_V2_MAX_FRAME_BYTES
  ) {
    throw new TypeError('File media source offer exceeds its byte budget');
  }
  return serialized;
}

function sameOffer(
  left: Readonly<FileMediaSourceOfferV2>,
  right: Readonly<FileMediaSourceOfferV2>,
): boolean {
  if (left.transport !== right.transport) return false;
  const keys = offerKeysForTransport(left.transport);
  if (!keys) return false;
  const leftRecord = left as unknown as Readonly<Record<string, Primitive>>;
  const rightRecord = right as unknown as Readonly<Record<string, Primitive>>;
  return keys.every((key) => leftRecord[key] === rightRecord[key]);
}

export class FileMediaOfferRegistryFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileMediaOfferRegistryFatalError';
  }
}

export interface FileMediaOfferRegistryOptions {
  readonly liveConnectionToken: object;
  readonly sessionId: string;
  readonly connectionId: string;
  /** Additional product ceiling applied after transport-specific wire validation. */
  readonly maxEncodedSize: number;
  readonly nowRoomTimeMs: () => number;
  readonly onFatalConnection: (token: object, error: FileMediaOfferRegistryFatalError) => void;
  readonly maxLiveQueueItems?: number;
  readonly maxActiveOffers?: number;
  /** Cumulative queue/prepare ABA tombstones retained without eviction. */
  readonly maxRetiredTombstones?: number;
}

export type FileMediaOfferAcceptResult =
  | Readonly<{
      accepted: true;
      status: 'accepted' | 'replayed' | 'superseded';
      offer: Readonly<FileMediaSourceOfferV2>;
    }>
  | Readonly<{
      accepted: false;
      reason:
        | 'closed'
        | 'wrong-connection-token'
        | 'malformed-offer'
        | 'wrong-scope'
        | 'stale-offer'
        | 'queue-item-not-live'
        | 'expired'
        | 'size-policy'
        | 'conflict'
        | 'capacity'
        | 'clock-failed'
        | 'reentrant-call';
    }>;

function acceptedOffer(
  status: 'accepted' | 'replayed' | 'superseded',
  offer: Readonly<FileMediaSourceOfferV2>,
): FileMediaOfferAcceptResult {
  return freezeCanonical({ accepted: true as const, status, offer });
}

function rejectedOffer(
  reason: Extract<FileMediaOfferAcceptResult, { accepted: false }>['reason'],
): FileMediaOfferAcceptResult {
  return freezeCanonical({ accepted: false as const, reason });
}

function configuredLimit(value: number | undefined, fallback: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > maximum) {
    throw new RangeError(`Registry capacity must be a positive safe integer up to ${maximum}`);
  }
  return selected;
}

/**
 * Exact-connection guest preparation authority.
 *
 * The adapter must use `createFileMediaPrepareId()` and the queue model's
 * CSPRNG QueueItemId factory. Its raw transport scanner must reject frames
 * above the dependency-neutral transport contract's raw byte budget before
 * materializing them; the parser independently enforces the canonical 4 KiB
 * representation.
 *
 * Removed QueueItemIds and consumed prepareIds remain retired for this
 * registry/connection lifetime, making removal and preparation ABA
 * irreversible. Tombstones retain only small UUID strings, never media, and
 * are never evicted. A high configurable cumulative limit fail-closes the
 * exact connection instead of weakening authority. This trades bounded
 * process-lifetime memory for strict ABA prevention; `close()` releases it.
 *
 * New non-replay offers occupy one reliable ordered revision lane beginning at
 * 1. Every offer must be exactly watermark + 1. Exact-next semantic rejections
 * consume that one revision so a conforming sender can advance; gaps and safe
 * integer exhaustion fail closed without accepting an untrusted watermark.
 */
export class FileMediaOfferRegistry {
  readonly #token: object;
  readonly #sessionId: string;
  readonly #connectionId: string;
  readonly #maxEncodedSize: number;
  readonly #nowRoomTimeMs: () => number;
  readonly #onFatalConnection: FileMediaOfferRegistryOptions['onFatalConnection'];
  readonly #maxLiveQueueItems: number;
  readonly #maxActiveOffers: number;
  readonly #maxRetiredTombstones: number;
  readonly #liveQueueItems = new Set<QueueItemId>();
  readonly #retiredQueueItems = new Set<QueueItemId>();
  readonly #retiredPrepareIds = new Set<string>();
  readonly #activeByQueue = new Map<QueueItemId, Readonly<FileMediaSourceOfferV2>>();
  readonly #activeByPrepare = new Map<string, Readonly<FileMediaSourceOfferV2>>();
  readonly #retiredCanonicalOffers = new WeakSet<object>();
  readonly #currentOfferLeases = new WeakMap<FileMediaCurrentOfferLease, CurrentOfferLeaseRecord>();
  #prepareRevisionWatermark = 0;
  #closed = false;
  #mutating = false;
  #fatalError: FileMediaOfferRegistryFatalError | null = null;

  constructor(options: FileMediaOfferRegistryOptions) {
    if (!options.liveConnectionToken || typeof options.liveConnectionToken !== 'object') {
      throw new TypeError('File media offer registry requires an opaque connection token');
    }
    if (
      !isIdentifier(options.sessionId) ||
      !isIdentifier(options.connectionId) ||
      options.sessionId === options.connectionId
    ) {
      throw new TypeError('File media offer registry scope is invalid');
    }
    if (!isPositiveSafeInteger(options.maxEncodedSize)) {
      throw new RangeError('maxEncodedSize must be a positive safe integer');
    }
    if (
      typeof options.nowRoomTimeMs !== 'function' ||
      typeof options.onFatalConnection !== 'function'
    ) {
      throw new TypeError('File media offer registry callbacks are required');
    }
    this.#token = options.liveConnectionToken;
    this.#sessionId = options.sessionId;
    this.#connectionId = options.connectionId;
    this.#maxEncodedSize = options.maxEncodedSize;
    this.#nowRoomTimeMs = options.nowRoomTimeMs;
    this.#onFatalConnection = options.onFatalConnection;
    this.#maxLiveQueueItems = configuredLimit(
      options.maxLiveQueueItems,
      DEFAULT_MAX_LIVE_QUEUE_ITEMS,
      MAX_LIVE_QUEUE_ITEMS,
    );
    this.#maxActiveOffers = configuredLimit(
      options.maxActiveOffers,
      DEFAULT_MAX_ACTIVE_OFFERS,
      MAX_ACTIVE_OFFERS,
    );
    this.#maxRetiredTombstones = configuredLimit(
      options.maxRetiredTombstones,
      DEFAULT_MAX_RETIRED_TOMBSTONES,
      MAX_RETIRED_TOMBSTONES,
    );
  }

  isClosed(): boolean {
    return this.#closed;
  }

  activeOfferCount(): number {
    return this.#activeByQueue.size;
  }

  liveQueueItemCount(): number {
    return this.#liveQueueItems.size;
  }

  retiredTombstoneCount(): number {
    return this.#retiredQueueItems.size + this.#retiredPrepareIds.size;
  }

  prepareRevisionWatermark(): number {
    return this.#prepareRevisionWatermark;
  }

  admitQueueItem(token: object, queueItemId: QueueItemId): boolean {
    if (token !== this.#token || this.#closed) return false;
    if (this.#mutating) {
      return this.#fatal('Queue admission re-entered offer mutation', 'reentrant-call');
    }
    if (!isQueueItemId(queueItemId))
      return this.#fatal('Queue item admission was invalid', 'conflict');
    if (this.#liveQueueItems.has(queueItemId)) return true;
    if (this.#retiredQueueItems.has(queueItemId)) {
      return this.#fatal('A removed queue occurrence was re-admitted', 'conflict');
    }
    if (this.#liveQueueItems.size >= this.#maxLiveQueueItems) {
      return this.#fatal('Live queue occurrence capacity was exhausted', 'capacity');
    }
    this.#liveQueueItems.add(queueItemId);
    return true;
  }

  removeQueueItem(token: object, queueItemId: QueueItemId): boolean {
    if (token !== this.#token || this.#closed) return false;
    if (this.#mutating)
      return this.#fatal('Queue removal re-entered offer mutation', 'reentrant-call');
    if (!isQueueItemId(queueItemId))
      return this.#fatal('Queue item removal was invalid', 'conflict');
    if (this.#retiredQueueItems.has(queueItemId)) return true;
    if (!this.#liveQueueItems.has(queueItemId)) {
      return this.#fatal('An unknown queue occurrence was removed', 'conflict');
    }
    const active = this.#activeByQueue.get(queueItemId);
    if (!this.#ensureRetirementCapacity([queueItemId], active ? [active.prepareId] : [])) {
      return false;
    }
    this.#retiredQueueItems.add(queueItemId);
    this.#liveQueueItems.delete(queueItemId);
    this.#retireActiveUnchecked(active);
    return !this.#closed;
  }

  accept(token: object, value: unknown): FileMediaOfferAcceptResult {
    if (token !== this.#token) return rejectedOffer('wrong-connection-token');
    if (this.#closed) return rejectedOffer('closed');
    if (this.#mutating) {
      this.#fatal('Offer acceptance re-entered itself', 'reentrant-call');
      return rejectedOffer('reentrant-call');
    }

    this.#mutating = true;
    try {
      const offer = parseFileMediaSourceOfferV2(value);
      if (this.#closed) return rejectedOffer('closed');
      if (!offer) return this.#fatalResult('Offer frame was malformed', 'malformed-offer');
      if (offer.sessionId !== this.#sessionId || offer.connectionId !== this.#connectionId) {
        return this.#fatalResult('Offer claimed a different connection scope', 'wrong-scope');
      }

      const now = this.#readRoomTime();
      if (now === null) return rejectedOffer(this.#closed ? 'closed' : 'clock-failed');
      this.#expireInternal(now);
      if (this.#closed) return rejectedOffer('closed');

      const samePrepare = this.#activeByPrepare.get(offer.prepareId);
      if (samePrepare) {
        if (sameOffer(samePrepare, offer)) return acceptedOffer('replayed', samePrepare);
        return this.#fatalResult(
          'An active prepareId was reused with conflicting data',
          'conflict',
        );
      }

      if (offer.prepareRevision === Number.MAX_SAFE_INTEGER) {
        return this.#fatalResult('The prepare revision lane was exhausted', 'conflict');
      }
      if (offer.prepareRevision <= this.#prepareRevisionWatermark) {
        return rejectedOffer('stale-offer');
      }
      const expectedRevision = this.#prepareRevisionWatermark + 1;
      if (offer.prepareRevision !== expectedRevision) {
        return this.#fatalResult('The prepare revision lane contained a gap', 'conflict');
      }
      if (this.#retiredPrepareIds.has(offer.prepareId)) {
        return this.#fatalResult('A retired prepareId was reused', 'conflict');
      }
      this.#prepareRevisionWatermark = expectedRevision;

      if (!this.#liveQueueItems.has(offer.queueItemId)) {
        return this.#rejectAndRetirePrepare(offer.prepareId, 'queue-item-not-live');
      }
      if (offer.expiresAtRoomTimeMs <= now) {
        return this.#rejectAndRetirePrepare(offer.prepareId, 'expired');
      }
      if (offer.encodedSize > this.#maxEncodedSize) {
        return this.#rejectAndRetirePrepare(offer.prepareId, 'size-policy');
      }

      const previous = this.#activeByQueue.get(offer.queueItemId);
      if (!previous && this.#activeByQueue.size >= this.#maxActiveOffers) {
        return this.#fatalResult('Active source offer capacity was exhausted', 'capacity');
      }
      if (previous && !this.#retireActive(previous)) return rejectedOffer('capacity');
      this.#activeByQueue.set(offer.queueItemId, offer);
      this.#activeByPrepare.set(offer.prepareId, offer);
      return acceptedOffer(previous ? 'superseded' : 'accepted', offer);
    } finally {
      this.#mutating = false;
    }
  }

  expire(token: object, nowRoomTimeMs?: number): number {
    if (token !== this.#token || this.#closed) return 0;
    if (this.#mutating) {
      this.#fatal('Offer expiry re-entered offer mutation', 'reentrant-call');
      return 0;
    }
    this.#mutating = true;
    try {
      const now = nowRoomTimeMs ?? this.#readRoomTime();
      if (!isRoomTime(now)) {
        this.#fatal('Offer expiry clock was invalid', 'clock-failed');
        return 0;
      }
      return this.#expireInternal(now);
    } finally {
      this.#mutating = false;
    }
  }

  /**
   * Returns immutable metadata for inspection only. Re-parsing a previously
   * returned offer never proves current authority; run binding must use an
   * opaque lease issued and revalidated by this registry.
   */
  activeOffer(token: object, queueItemId: QueueItemId): Readonly<FileMediaSourceOfferV2> | null {
    if (token !== this.#token || this.#closed || !isQueueItemId(queueItemId)) return null;
    if (this.#mutating) return null;
    this.#mutating = true;
    try {
      const now = this.#readRoomTime();
      if (now === null) return null;
      this.#expireInternal(now);
      if (this.#closed) return null;
      return this.#activeByQueue.get(queueItemId) ?? null;
    } finally {
      this.#mutating = false;
    }
  }

  /**
   * Retires only the exact canonical offer object previously issued by this
   * registry. Shape-compatible data is deliberately insufficient authority.
   * The queue occurrence remains live so a later monotonic offer may reuse it.
   */
  retireActiveOffer(token: object, offer: unknown): boolean {
    if (token !== this.#token || this.#closed || offer === null || typeof offer !== 'object') {
      return false;
    }
    if (this.#mutating) {
      return this.#fatal('Offer retirement re-entered offer mutation', 'reentrant-call');
    }
    this.#mutating = true;
    try {
      if (this.#retiredCanonicalOffers.has(offer)) return true;
      const exact = [...this.#activeByPrepare.values()].find((candidate) => candidate === offer);
      if (!exact) return false;
      const now = this.#readRoomTime();
      if (now === null) return false;
      this.#expireInternal(now);
      if (this.#closed) return false;
      if (this.#activeByPrepare.get(exact.prepareId) !== exact) {
        return this.#retiredPrepareIds.has(exact.prepareId);
      }
      return this.#retireActive(exact);
    } finally {
      this.#mutating = false;
    }
  }

  /** Issues an unforgeable lease for the exact offer current at this clock read. */
  issueCurrentOfferLease(
    token: object,
    queueItemId: QueueItemId,
  ): FileMediaCurrentOfferLease | null {
    if (token !== this.#token || this.#closed || !isQueueItemId(queueItemId)) return null;
    if (this.#mutating) {
      this.#fatal('Offer lease issuance re-entered offer mutation', 'reentrant-call');
      return null;
    }
    this.#mutating = true;
    try {
      const now = this.#readRoomTime();
      if (now === null) return null;
      this.#expireInternal(now);
      if (this.#closed) return null;
      const offer = this.#activeByQueue.get(queueItemId);
      if (!offer) return null;
      const lease = Object.freeze(Object.create(null)) as FileMediaCurrentOfferLease;
      this.#currentOfferLeases.set(lease, { offer });
      return lease;
    } finally {
      this.#mutating = false;
    }
  }

  /**
   * Revalidates a lease against the exact token, current clock, expiry, and
   * active offer identity. WeakMap lookup never reads properties from `lease`.
   */
  isCurrentOfferLease(token: object, lease: unknown): lease is FileMediaCurrentOfferLease {
    return this.resolveCurrentOfferLease(token, lease) !== null;
  }

  /**
   * Resolves an authentic current lease to the exact stored canonical offer.
   * Consumers must use this result for run binding instead of looking up or
   * reparsing offer-shaped data outside the registry authority boundary.
   */
  resolveCurrentOfferLease(token: object, lease: unknown): Readonly<FileMediaSourceOfferV2> | null {
    if (token !== this.#token || this.#closed || lease === null || typeof lease !== 'object') {
      return null;
    }
    const record = this.#currentOfferLeases.get(lease as FileMediaCurrentOfferLease);
    if (!record) return null;
    if (this.#mutating) {
      this.#fatal('Offer lease validation re-entered offer mutation', 'reentrant-call');
      return null;
    }
    this.#mutating = true;
    try {
      const now = this.#readRoomTime();
      if (now === null) return null;
      this.#expireInternal(now);
      return !this.#closed && this.#activeByQueue.get(record.offer.queueItemId) === record.offer
        ? record.offer
        : null;
    } finally {
      this.#mutating = false;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#liveQueueItems.clear();
    this.#retiredQueueItems.clear();
    this.#retiredPrepareIds.clear();
    this.#activeByQueue.clear();
    this.#activeByPrepare.clear();
  }

  #readRoomTime(): number | null {
    try {
      const value = this.#nowRoomTimeMs();
      if (this.#closed || !isRoomTime(value)) {
        this.#fatal('Room clock failed during offer mutation', 'clock-failed');
        return null;
      }
      return value;
    } catch {
      this.#fatal('Room clock failed during offer mutation', 'clock-failed');
      return null;
    }
  }

  #expireInternal(nowRoomTimeMs: number): number {
    let removed = 0;
    for (const offer of [...this.#activeByQueue.values()]) {
      if (offer.expiresAtRoomTimeMs <= nowRoomTimeMs) {
        if (!this.#retireActive(offer)) break;
        removed += 1;
      }
    }
    return removed;
  }

  #rejectAndRetirePrepare(
    prepareId: string,
    reason: 'queue-item-not-live' | 'expired' | 'size-policy',
  ): FileMediaOfferAcceptResult {
    return this.#retirePrepareId(prepareId) ? rejectedOffer(reason) : rejectedOffer('capacity');
  }

  #retirePrepareId(prepareId: string): boolean {
    if (this.#retiredPrepareIds.has(prepareId)) return true;
    if (!this.#ensureRetirementCapacity([], [prepareId])) return false;
    this.#retiredPrepareIds.add(prepareId);
    return true;
  }

  #retireActive(offer: Readonly<FileMediaSourceOfferV2> | undefined): boolean {
    if (!offer) return true;
    const active =
      this.#activeByQueue.get(offer.queueItemId) === offer ||
      this.#activeByPrepare.get(offer.prepareId) === offer;
    if (!active) return true;
    if (!this.#ensureRetirementCapacity([], [offer.prepareId])) return false;
    this.#retireActiveUnchecked(offer);
    return true;
  }

  #retireActiveUnchecked(offer: Readonly<FileMediaSourceOfferV2> | undefined): void {
    if (!offer) return;
    if (this.#activeByQueue.get(offer.queueItemId) === offer) {
      this.#activeByQueue.delete(offer.queueItemId);
    }
    if (this.#activeByPrepare.get(offer.prepareId) === offer) {
      this.#activeByPrepare.delete(offer.prepareId);
    }
    this.#retiredCanonicalOffers.add(offer);
    this.#retiredPrepareIds.add(offer.prepareId);
  }

  #ensureRetirementCapacity(
    queueItemIds: readonly QueueItemId[],
    prepareIds: readonly string[],
  ): boolean {
    const newQueueItems = new Set(
      queueItemIds.filter((queueItemId) => !this.#retiredQueueItems.has(queueItemId)),
    );
    const newPrepareIds = new Set(
      prepareIds.filter((prepareId) => !this.#retiredPrepareIds.has(prepareId)),
    );
    const nextCount =
      this.#retiredQueueItems.size +
      this.#retiredPrepareIds.size +
      newQueueItems.size +
      newPrepareIds.size;
    if (nextCount <= this.#maxRetiredTombstones) return true;
    return this.#fatal('Retired offer tombstone capacity was exhausted', 'capacity');
  }

  #fatalResult(
    message: string,
    reason: Extract<FileMediaOfferAcceptResult, { accepted: false }>['reason'],
  ): FileMediaOfferAcceptResult {
    this.#fatal(message, reason);
    return rejectedOffer(reason);
  }

  #fatal(
    message: string,
    _reason: Extract<FileMediaOfferAcceptResult, { accepted: false }>['reason'],
  ): false {
    if (this.#fatalError) return false;
    const error = new FileMediaOfferRegistryFatalError(message);
    this.#fatalError = error;
    this.#closed = true;
    this.#liveQueueItems.clear();
    this.#retiredQueueItems.clear();
    this.#retiredPrepareIds.clear();
    this.#activeByQueue.clear();
    this.#activeByPrepare.clear();
    try {
      this.#onFatalConnection(this.#token, error);
    } catch {
      // Exact connection authority is already quarantined.
    }
    return false;
  }
}
