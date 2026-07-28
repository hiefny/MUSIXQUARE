import { isFilePlaybackSessionId } from '../network/file-playback-session-handshake.ts';
import { FILE_PLAYBACK_RUN_BINDING_V2_TYPE } from '../network/file-playback-transport-contract.ts';
import type { QueueItemId } from '../types/index.ts';
import { FILE_PLAYBACK_WIRE_MAX_IDENTIFIER_LENGTH } from './file-playback-wire.ts';
import type { PlaybackRevision } from './playback-identity.ts';
import { isQueueItemId } from './queue-model.ts';

export const FILE_PLAYBACK_RUN_BINDING_V2_PROTOCOL_VERSION = 2 as const;
/** Maximum detached canonical JSON size after exact object validation. */
export const FILE_PLAYBACK_RUN_BINDING_V2_MAX_FRAME_BYTES = 4 * 1024;

const RUN_BINDING_KEYS = Object.freeze([
  'connectionId',
  'playbackRevision',
  'prepareId',
  'prepareRevision',
  'protocolVersion',
  'queueItemId',
  'runId',
  'sessionId',
  'sourceIdentity',
  'transferSessionId',
  'type',
] as const);
const RUN_BINDING_INPUT_KEYS = Object.freeze([
  'connectionId',
  'playbackRevision',
  'prepareId',
  'prepareRevision',
  'queueItemId',
  'runId',
  'sessionId',
  'sourceIdentity',
  'transferSessionId',
] as const);

type Primitive = string | number;
type PrimitiveSnapshot = Readonly<Record<string, Primitive>>;

/**
 * Canonical wire correlation data only. Parsing or creating this record never
 * authorizes playback and never proves that any named authority is still
 * current. A future `src/network/file-playback-run-authority.ts` consumer must
 * own the exact accepted source offer, the exact APPLIED connection-channel
 * live token, currentness/reentry guards, and the monotonic playback-revision
 * watermark before it may admit a run or produce a media wire binding.
 */
export interface FilePlaybackRunBindingV2 {
  readonly protocolVersion: typeof FILE_PLAYBACK_RUN_BINDING_V2_PROTOCOL_VERSION;
  readonly type: typeof FILE_PLAYBACK_RUN_BINDING_V2_TYPE;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly prepareId: string;
  readonly prepareRevision: number;
  readonly queueItemId: QueueItemId;
  readonly sourceIdentity: string;
  readonly transferSessionId: string;
  readonly runId: string;
  readonly playbackRevision: PlaybackRevision;
}

/**
 * Exact controller-owned scope for one connection binding. The host generates
 * `runId` once, then supplies that same value to every connection participating
 * in the logical run; this constructor never allocates or substitutes one.
 */
export type FilePlaybackRunBindingV2Input = Omit<
  FilePlaybackRunBindingV2,
  'protocolVersion' | 'type'
>;

interface FilePlaybackRunCryptoSource {
  readonly randomUUID?: () => string;
  readonly getRandomValues?: (array: Uint8Array) => Uint8Array;
}

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

function isMediaScopeIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= FILE_PLAYBACK_WIRE_MAX_IDENTIFIER_LENGTH &&
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

function serializedByteLength(value: FilePlaybackRunBindingV2): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/**
 * Generate a run occurrence ID using only a platform CSPRNG. There is no
 * timestamp or Math.random fallback. The optional source is for platform and
 * deterministic boundary tests and must itself remain CSPRNG-backed in use.
 */
export function createFilePlaybackRunId(
  cryptoSource: FilePlaybackRunCryptoSource | null = typeof globalThis.crypto === 'object'
    ? globalThis.crypto
    : null,
): string {
  if (cryptoSource && typeof cryptoSource.randomUUID === 'function') {
    const runId = cryptoSource.randomUUID.call(cryptoSource);
    if (!isQueueItemId(runId)) {
      throw new Error('Secure file playback run ID generation returned an invalid UUID');
    }
    return runId;
  }

  if (cryptoSource && typeof cryptoSource.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    cryptoSource.getRandomValues.call(cryptoSource, bytes);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const runId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
      16,
      20,
    )}-${hex.slice(20)}`;
    if (!isQueueItemId(runId)) {
      throw new Error('Secure file playback run ID generation returned an invalid UUID');
    }
    return runId;
  }

  throw new Error('Secure file playback run ID generation is unavailable');
}

function canonicalizeRunBinding(
  snapshot: PrimitiveSnapshot,
): Readonly<FilePlaybackRunBindingV2> | null {
  if (
    snapshot.protocolVersion !== FILE_PLAYBACK_RUN_BINDING_V2_PROTOCOL_VERSION ||
    snapshot.type !== FILE_PLAYBACK_RUN_BINDING_V2_TYPE ||
    !isFilePlaybackSessionId(snapshot.sessionId) ||
    !isFilePlaybackSessionId(snapshot.connectionId) ||
    snapshot.sessionId === snapshot.connectionId ||
    !isQueueItemId(snapshot.prepareId) ||
    !isPositiveSafeInteger(snapshot.prepareRevision) ||
    !isQueueItemId(snapshot.queueItemId) ||
    !isMediaScopeIdentifier(snapshot.sourceIdentity) ||
    !isMediaScopeIdentifier(snapshot.transferSessionId) ||
    !isQueueItemId(snapshot.runId) ||
    !isPositiveSafeInteger(snapshot.playbackRevision)
  ) {
    return null;
  }

  if (snapshot.runId === snapshot.sessionId || snapshot.runId === snapshot.connectionId) {
    return null;
  }

  // Preparation, queue occurrence, media publication, and playback run are
  // separate authorities and must not alias by exact value. Derived media IDs
  // may contain session/queue IDs; substring overlap is intentionally valid.
  const mediaAuthorities = [
    snapshot.prepareId,
    snapshot.queueItemId,
    snapshot.sourceIdentity,
    snapshot.transferSessionId,
    snapshot.runId,
  ];
  if (new Set(mediaAuthorities).size !== mediaAuthorities.length) return null;

  const binding = freezeCanonical({
    protocolVersion: FILE_PLAYBACK_RUN_BINDING_V2_PROTOCOL_VERSION,
    type: FILE_PLAYBACK_RUN_BINDING_V2_TYPE,
    sessionId: snapshot.sessionId,
    connectionId: snapshot.connectionId,
    prepareId: snapshot.prepareId,
    prepareRevision: snapshot.prepareRevision,
    queueItemId: snapshot.queueItemId as QueueItemId,
    sourceIdentity: snapshot.sourceIdentity,
    transferSessionId: snapshot.transferSessionId,
    runId: snapshot.runId,
    playbackRevision: snapshot.playbackRevision as PlaybackRevision,
  });
  return serializedByteLength(binding) <= FILE_PLAYBACK_RUN_BINDING_V2_MAX_FRAME_BYTES
    ? binding
    : null;
}

export function parseFilePlaybackRunBindingV2(
  value: unknown,
): Readonly<FilePlaybackRunBindingV2> | null {
  const snapshot = snapshotExactPrimitiveRecord(value, RUN_BINDING_KEYS);
  return snapshot ? canonicalizeRunBinding(snapshot) : null;
}

export function createFilePlaybackRunBindingV2(
  input: FilePlaybackRunBindingV2Input,
): Readonly<FilePlaybackRunBindingV2> {
  const snapshot = snapshotExactPrimitiveRecord(input, RUN_BINDING_INPUT_KEYS);
  if (!snapshot) throw new TypeError('File playback run binding input is invalid');
  const candidate = {
    protocolVersion: FILE_PLAYBACK_RUN_BINDING_V2_PROTOCOL_VERSION,
    type: FILE_PLAYBACK_RUN_BINDING_V2_TYPE,
    ...snapshot,
  };
  const parsed = parseFilePlaybackRunBindingV2(candidate);
  if (!parsed) throw new TypeError('File playback run binding is invalid');
  return parsed;
}

export function serializeFilePlaybackRunBindingV2(value: unknown): string {
  const binding = parseFilePlaybackRunBindingV2(value);
  if (!binding) throw new TypeError('File playback run binding is invalid');
  const serialized = JSON.stringify(binding);
  if (
    new TextEncoder().encode(serialized).byteLength > FILE_PLAYBACK_RUN_BINDING_V2_MAX_FRAME_BYTES
  ) {
    throw new TypeError('File playback run binding exceeds its byte budget');
  }
  return serialized;
}
