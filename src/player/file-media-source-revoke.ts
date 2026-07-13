import { FILE_MEDIA_SOURCE_OFFER_REVOKE_V2_TYPE } from '../network/file-playback-transport-contract.ts';
import type { QueueItemId } from '../types/index.ts';
import {
  FILE_MEDIA_SOURCE_OFFER_V2_MAX_IDENTIFIER_LENGTH,
  parseFileMediaSourceOfferV2,
  type FileMediaSourceOfferV2,
} from './file-media-source-offer.ts';
import { isQueueItemId } from './queue-model.ts';
import { PEER_RANGE_MAX_CONNECTION_ID_LENGTH } from './sources/peer-range-protocol.ts';

export const FILE_MEDIA_SOURCE_REVOKE_V2_PROTOCOL_VERSION = 2 as const;
/** Maximum detached canonical JSON size after exact object validation. */
export const FILE_MEDIA_SOURCE_REVOKE_V2_MAX_FRAME_BYTES = 4 * 1024;

const REVOKE_KEYS = Object.freeze([
  'connectionId',
  'prepareId',
  'prepareRevision',
  'protocolVersion',
  'queueItemId',
  'sessionId',
  'sourceIdentity',
  'transferSessionId',
  'type',
] as const);
const REVOKE_INPUT_KEYS = Object.freeze([
  'connectionId',
  'prepareId',
  'prepareRevision',
  'queueItemId',
  'sessionId',
  'sourceIdentity',
  'transferSessionId',
] as const);

type Primitive = string | number;
type PrimitiveSnapshot = Readonly<Record<string, Primitive>>;

/**
 * Host -> guest retirement of one exact previously offered preparation.
 * Parsing this correlation record alone does not prove current authority.
 */
export interface FileMediaSourceRevokeV2 {
  readonly protocolVersion: typeof FILE_MEDIA_SOURCE_REVOKE_V2_PROTOCOL_VERSION;
  readonly type: typeof FILE_MEDIA_SOURCE_OFFER_REVOKE_V2_TYPE;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly prepareId: string;
  readonly prepareRevision: number;
  readonly queueItemId: QueueItemId;
  readonly sourceIdentity: string;
  readonly transferSessionId: string;
}

export type FileMediaSourceRevokeV2Input = Omit<
  FileMediaSourceRevokeV2,
  'protocolVersion' | 'type'
>;

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function isIdentifier(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value === value.trim() &&
    !containsControlCharacter(value)
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function snapshotExactPrimitiveRecord(
  value: unknown,
  expectedKeys: readonly string[],
): PrimitiveSnapshot | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const expected = new Set(expectedKeys);
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== expected.size ||
      ownKeys.some((key) => typeof key !== 'string' || !expected.has(key))
    ) {
      return null;
    }

    const snapshot = Object.create(null) as Record<string, Primitive>;
    for (const key of expectedKeys) {
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

function serializedByteLength(value: FileMediaSourceRevokeV2): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function canonicalizeRevoke(snapshot: PrimitiveSnapshot): Readonly<FileMediaSourceRevokeV2> | null {
  if (
    snapshot.protocolVersion !== FILE_MEDIA_SOURCE_REVOKE_V2_PROTOCOL_VERSION ||
    snapshot.type !== FILE_MEDIA_SOURCE_OFFER_REVOKE_V2_TYPE ||
    !isIdentifier(snapshot.sessionId, FILE_MEDIA_SOURCE_OFFER_V2_MAX_IDENTIFIER_LENGTH) ||
    !isIdentifier(snapshot.connectionId, PEER_RANGE_MAX_CONNECTION_ID_LENGTH) ||
    snapshot.sessionId === snapshot.connectionId ||
    !isQueueItemId(snapshot.prepareId) ||
    !isPositiveSafeInteger(snapshot.prepareRevision) ||
    !isQueueItemId(snapshot.queueItemId) ||
    !isIdentifier(snapshot.sourceIdentity, FILE_MEDIA_SOURCE_OFFER_V2_MAX_IDENTIFIER_LENGTH) ||
    !isIdentifier(snapshot.transferSessionId, FILE_MEDIA_SOURCE_OFFER_V2_MAX_IDENTIFIER_LENGTH)
  ) {
    return null;
  }

  const identities = [
    snapshot.sessionId,
    snapshot.connectionId,
    snapshot.prepareId,
    snapshot.queueItemId,
    snapshot.sourceIdentity,
    snapshot.transferSessionId,
  ];
  if (new Set(identities).size !== identities.length) return null;

  const revoke = freezeCanonical({
    protocolVersion: FILE_MEDIA_SOURCE_REVOKE_V2_PROTOCOL_VERSION,
    type: FILE_MEDIA_SOURCE_OFFER_REVOKE_V2_TYPE,
    sessionId: snapshot.sessionId,
    connectionId: snapshot.connectionId,
    prepareId: snapshot.prepareId,
    prepareRevision: snapshot.prepareRevision,
    queueItemId: snapshot.queueItemId as QueueItemId,
    sourceIdentity: snapshot.sourceIdentity,
    transferSessionId: snapshot.transferSessionId,
  });
  return serializedByteLength(revoke) <= FILE_MEDIA_SOURCE_REVOKE_V2_MAX_FRAME_BYTES
    ? revoke
    : null;
}

export function parseFileMediaSourceRevokeV2(
  value: unknown,
): Readonly<FileMediaSourceRevokeV2> | null {
  const snapshot = snapshotExactPrimitiveRecord(value, REVOKE_KEYS);
  return snapshot ? canonicalizeRevoke(snapshot) : null;
}

export function createFileMediaSourceRevokeV2(
  input: FileMediaSourceRevokeV2Input,
): Readonly<FileMediaSourceRevokeV2> {
  const snapshot = snapshotExactPrimitiveRecord(input, REVOKE_INPUT_KEYS);
  if (!snapshot) throw new TypeError('File media source revoke input is invalid');
  const candidate = {
    protocolVersion: FILE_MEDIA_SOURCE_REVOKE_V2_PROTOCOL_VERSION,
    type: FILE_MEDIA_SOURCE_OFFER_REVOKE_V2_TYPE,
    ...snapshot,
  };
  const parsed = parseFileMediaSourceRevokeV2(candidate);
  if (!parsed) throw new TypeError('File media source revoke is invalid');
  return parsed;
}

export function serializeFileMediaSourceRevokeV2(value: unknown): string {
  const revoke = parseFileMediaSourceRevokeV2(value);
  if (!revoke) throw new TypeError('File media source revoke is invalid');
  const serialized = JSON.stringify(revoke);
  if (
    new TextEncoder().encode(serialized).byteLength > FILE_MEDIA_SOURCE_REVOKE_V2_MAX_FRAME_BYTES
  ) {
    throw new TypeError('File media source revoke exceeds its byte budget');
  }
  return serialized;
}

function revokeMatchesOffer(
  revoke: Readonly<FileMediaSourceRevokeV2>,
  offer: Readonly<FileMediaSourceOfferV2>,
): boolean {
  return (
    revoke.sessionId === offer.sessionId &&
    revoke.connectionId === offer.connectionId &&
    revoke.prepareId === offer.prepareId &&
    revoke.prepareRevision === offer.prepareRevision &&
    revoke.queueItemId === offer.queueItemId &&
    revoke.sourceIdentity === offer.sourceIdentity &&
    revoke.transferSessionId === offer.transferSessionId
  );
}

/** Exact transport-independent preparation identity match. */
export function fileMediaSourceRevokeMatchesOfferV2(
  revokeValue: unknown,
  offerValue: unknown,
): boolean {
  const revoke = parseFileMediaSourceRevokeV2(revokeValue);
  const offer = parseFileMediaSourceOfferV2(offerValue);
  return revoke !== null && offer !== null && revokeMatchesOffer(revoke, offer);
}
