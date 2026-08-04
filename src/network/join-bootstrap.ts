/**
 * Minimal standard-room join bootstrap control protocol.
 *
 * These messages bind queue-baseline application to one exact connection.
 * They deliberately do not carry playback-engine, clock, or media state.
 */

import { MSG } from '../core/constants.ts';
import type { ProtocolMsg } from '../types/index.ts';

const JOIN_BOOTSTRAP_PROTOCOL_VERSION = 1 as const;
export const JOIN_BOOTSTRAP_TIMEOUT_MS = 10_000;

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONTROL_FRAME_KEYS = Object.freeze(['type', 'version', 'bootstrapId'] as const);

type JoinBootstrapHello = Readonly<ProtocolMsg<typeof MSG.JOIN_BOOTSTRAP_HELLO>>;
type JoinBootstrapApplied = Readonly<ProtocolMsg<typeof MSG.JOIN_BOOTSTRAP_APPLIED>>;

function snapshotControlFrame(
  value: unknown,
  expectedType: typeof MSG.JOIN_BOOTSTRAP_HELLO,
): JoinBootstrapHello | null;
function snapshotControlFrame(
  value: unknown,
  expectedType: typeof MSG.JOIN_BOOTSTRAP_APPLIED,
): JoinBootstrapApplied | null;
function snapshotControlFrame(
  value: unknown,
  expectedType: typeof MSG.JOIN_BOOTSTRAP_HELLO | typeof MSG.JOIN_BOOTSTRAP_APPLIED,
): JoinBootstrapHello | JoinBootstrapApplied | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (
      ownKeys.length !== CONTROL_FRAME_KEYS.length ||
      ownKeys.some(
        (key) =>
          typeof key !== 'string' ||
          !CONTROL_FRAME_KEYS.includes(key as (typeof CONTROL_FRAME_KEYS)[number]),
      )
    ) {
      return null;
    }

    for (const key of CONTROL_FRAME_KEYS) {
      const descriptor = descriptors[key];
      if (
        !descriptor ||
        descriptor.enumerable !== true ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ) {
        return null;
      }
    }

    const type = descriptors.type?.value;
    const version = descriptors.version?.value;
    const bootstrapId = descriptors.bootstrapId?.value;
    if (
      type !== expectedType ||
      version !== JOIN_BOOTSTRAP_PROTOCOL_VERSION ||
      typeof bootstrapId !== 'string' ||
      !UUID_V4_RE.test(bootstrapId)
    ) {
      return null;
    }

    return Object.freeze({ type, version, bootstrapId }) as
      | JoinBootstrapHello
      | JoinBootstrapApplied;
  } catch {
    return null;
  }
}

function isJoinBootstrapId(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4_RE.test(value);
}

export function snapshotJoinBootstrapHello(value: unknown): JoinBootstrapHello | null {
  return snapshotControlFrame(value, MSG.JOIN_BOOTSTRAP_HELLO);
}

export function snapshotJoinBootstrapApplied(value: unknown): JoinBootstrapApplied | null {
  return snapshotControlFrame(value, MSG.JOIN_BOOTSTRAP_APPLIED);
}

export function isJoinBootstrapHello(value: unknown): value is JoinBootstrapHello {
  return snapshotJoinBootstrapHello(value) !== null;
}

export function isJoinBootstrapApplied(value: unknown): value is JoinBootstrapApplied {
  return snapshotJoinBootstrapApplied(value) !== null;
}

/**
 * Validate only the ordered bootstrap envelope. Playlist state validity and
 * successful application remain owned by the synchronous playlist bus ACK.
 */
export function isJoinBootstrapPayloadFrame(value: unknown, index: number): boolean {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const expectedKeys =
      index === 0
        ? (['type', 'list', 'revision', 'currentQueueItemId', 'bootstrap'] as const)
        : index === 1 || index === 2
          ? (['type', 'value', '_bootstrap'] as const)
          : null;
    if (!expectedKeys) return false;
    const expected = new Set<string>(expectedKeys);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (
      ownKeys.length !== expected.size ||
      ownKeys.some((key) => typeof key !== 'string' || !expected.has(key))
    ) {
      return false;
    }
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (
        !descriptor ||
        descriptor.enumerable !== true ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ) {
        return false;
      }
    }

    const type = descriptors.type?.value;
    if (index === 0) {
      return type === MSG.PLAYLIST_UPDATE && descriptors.bootstrap?.value === true;
    }
    if (descriptors._bootstrap?.value !== true) return false;
    if (index === 1) {
      const repeatMode = descriptors.value?.value;
      return type === MSG.REPEAT_MODE && (repeatMode === 0 || repeatMode === 1 || repeatMode === 2);
    }
    return type === MSG.SHUFFLE_MODE && typeof descriptors.value?.value === 'boolean';
  } catch {
    return false;
  }
}

/** Create a fail-closed, unpredictable identifier for one exact join attempt. */
export function createJoinBootstrapId(): string {
  const cryptoProvider = globalThis.crypto;
  if (typeof cryptoProvider?.randomUUID === 'function') {
    const id = cryptoProvider.randomUUID();
    if (isJoinBootstrapId(id)) return id;
  }
  if (typeof cryptoProvider?.getRandomValues !== 'function') {
    throw new Error('JOIN_BOOTSTRAP_SECURE_RANDOM_UNAVAILABLE');
  }

  const bytes = cryptoProvider.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
  if (!isJoinBootstrapId(id)) throw new Error('JOIN_BOOTSTRAP_ID_GENERATION_FAILED');
  return id;
}
