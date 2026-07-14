import {
  FILE_PLAYBACK_V2_CURRENT_SEMANTIC_COHORT_ID,
  isFilePlaybackSemanticCohortId,
} from '../player/file-playback-semantic-cohort.ts';

/**
 * File-playback application-session handshake for one exact live ordered
 * DataConnection.
 *
 * Transport adapters MUST reject a raw string/byte frame larger than
 * FILE_PLAYBACK_SESSION_MAX_MESSAGE_BYTES before JSON parsing or object
 * materialization. The object parser below can only enforce the size of its
 * detached canonical representation. Adapters must also gate delivery by the
 * exact current DataConnection object/epoch; matching a peer ID is not enough.
 *
 * Every successful create/handle transition is consumed before the caller
 * sends its returned frame. If that send fails, tear down this handshake and
 * that DataConnection. Never replay the frame or carry the instance onto a
 * replacement connection.
 */
export const FILE_PLAYBACK_SESSION_PROTOCOL_VERSION = 2 as const;
export const FILE_PLAYBACK_SESSION_HELLO_TYPE = 'FILE_PLAYBACK_SESSION_HELLO_V2' as const;
export const FILE_PLAYBACK_SESSION_WELCOME_TYPE = 'FILE_PLAYBACK_SESSION_WELCOME_V2' as const;
export const FILE_PLAYBACK_SESSION_SNAPSHOT_TYPE = 'FILE_PLAYBACK_SESSION_SNAPSHOT_V2' as const;
export const FILE_PLAYBACK_SESSION_APPLIED_TYPE = 'FILE_PLAYBACK_SESSION_APPLIED_V2' as const;

export const FILE_PLAYBACK_SESSION_SNAPSHOT_SEQUENCE = 1 as const;
export const FILE_PLAYBACK_SESSION_MAX_ID_LENGTH = 128;
export const FILE_PLAYBACK_SESSION_MAX_MESSAGE_BYTES = 768;

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~:-]*$/u;

const HELLO_KEYS = Object.freeze(
  ['guestParticipantId', 'helloId', 'semanticPlaybackCohortId', 'type', 'version'].sort(),
);
const WELCOME_KEYS = Object.freeze(
  [
    'connectionId',
    'guestParticipantId',
    'helloId',
    'hostParticipantId',
    'semanticPlaybackCohortId',
    'sessionId',
    'type',
    'version',
  ].sort(),
);
const SNAPSHOT_KEYS = Object.freeze([...WELCOME_KEYS, 'snapshotSequence'].sort());
const MESSAGE_KEYS = Object.freeze({
  [FILE_PLAYBACK_SESSION_HELLO_TYPE]: HELLO_KEYS,
  [FILE_PLAYBACK_SESSION_WELCOME_TYPE]: WELCOME_KEYS,
  [FILE_PLAYBACK_SESSION_SNAPSHOT_TYPE]: SNAPSHOT_KEYS,
  [FILE_PLAYBACK_SESSION_APPLIED_TYPE]: SNAPSHOT_KEYS,
});

const HOST_OPTION_KEYS = Object.freeze([
  'connectionId',
  'guestParticipantId',
  'hostParticipantId',
  'idIssuer',
  'sessionId',
]);
const HOST_OPTION_KEYS_WITH_COHORT = Object.freeze(
  [...HOST_OPTION_KEYS, 'semanticPlaybackCohortId'].sort(),
);
const GUEST_OPTION_KEYS = Object.freeze(['guestParticipantId', 'idIssuer']);
const GUEST_OPTION_KEYS_WITH_COHORT = Object.freeze(
  [...GUEST_OPTION_KEYS, 'semanticPlaybackCohortId'].sort(),
);
const ID_ISSUER_OPTION_KEYS = Object.freeze([
  'createConnectionId',
  'createHelloId',
  'createSessionId',
]);

const HANDSHAKE_ID_TOKEN_BRAND: unique symbol = Symbol('FilePlaybackHandshakeIdToken');

export type FilePlaybackHandshakeIdKind = 'session' | 'connection' | 'hello';

/** Opaque issuer-owned token. It cannot be forged or moved to another issuer. */
export type FilePlaybackHandshakeIdToken<Kind extends FilePlaybackHandshakeIdKind> = Readonly<{
  readonly kind: Kind;
  readonly value: string;
  readonly [HANDSHAKE_ID_TOKEN_BRAND]: true;
}>;

export interface FilePlaybackHandshakeIdIssuerOptions {
  /** Test/platform injection only; production overrides must remain CSPRNG-backed. */
  readonly createSessionId?: () => string;
  /** Test/platform injection only; production overrides must remain CSPRNG-backed. */
  readonly createConnectionId?: () => string;
  /** Test/platform injection only; production overrides must remain CSPRNG-backed. */
  readonly createHelloId?: () => string;
}

export interface FilePlaybackSessionHelloV2 {
  readonly type: typeof FILE_PLAYBACK_SESSION_HELLO_TYPE;
  readonly version: typeof FILE_PLAYBACK_SESSION_PROTOCOL_VERSION;
  readonly semanticPlaybackCohortId: string;
  readonly helloId: string;
  readonly guestParticipantId: string;
}

export interface FilePlaybackSessionWelcomeV2 {
  readonly type: typeof FILE_PLAYBACK_SESSION_WELCOME_TYPE;
  readonly version: typeof FILE_PLAYBACK_SESSION_PROTOCOL_VERSION;
  readonly semanticPlaybackCohortId: string;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly helloId: string;
  readonly hostParticipantId: string;
  readonly guestParticipantId: string;
}

export interface FilePlaybackSessionSnapshotV2 {
  readonly type: typeof FILE_PLAYBACK_SESSION_SNAPSHOT_TYPE;
  readonly version: typeof FILE_PLAYBACK_SESSION_PROTOCOL_VERSION;
  readonly semanticPlaybackCohortId: string;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly helloId: string;
  readonly hostParticipantId: string;
  readonly guestParticipantId: string;
  readonly snapshotSequence: typeof FILE_PLAYBACK_SESSION_SNAPSHOT_SEQUENCE;
}

export interface FilePlaybackSessionAppliedV2 {
  readonly type: typeof FILE_PLAYBACK_SESSION_APPLIED_TYPE;
  readonly version: typeof FILE_PLAYBACK_SESSION_PROTOCOL_VERSION;
  readonly semanticPlaybackCohortId: string;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly helloId: string;
  readonly hostParticipantId: string;
  readonly guestParticipantId: string;
  readonly snapshotSequence: typeof FILE_PLAYBACK_SESSION_SNAPSHOT_SEQUENCE;
}

export type FilePlaybackSessionMessageV2 =
  | FilePlaybackSessionHelloV2
  | FilePlaybackSessionWelcomeV2
  | FilePlaybackSessionSnapshotV2
  | FilePlaybackSessionAppliedV2;

/**
 * Transport-neutral scope established by WELCOME. The session ID must be
 * generated by the host from an unpredictable application-session nonce, and
 * the connection ID must be fresh for every physical data connection. Syntax
 * validation cannot prove either property, so their lifecycle remains an
 * adapter responsibility.
 */
export interface FilePlaybackSessionBindingV2 {
  readonly version: typeof FILE_PLAYBACK_SESSION_PROTOCOL_VERSION;
  readonly semanticPlaybackCohortId: string;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly helloId: string;
  readonly hostParticipantId: string;
  readonly guestParticipantId: string;
}

export interface FilePlaybackHostSessionHandshakeOptions {
  readonly idIssuer: FilePlaybackHandshakeIdIssuer;
  readonly sessionId: FilePlaybackHandshakeIdToken<'session'>;
  readonly connectionId: FilePlaybackHandshakeIdToken<'connection'>;
  readonly hostParticipantId: string;
  readonly guestParticipantId: string;
  /** Fixed manager/build identity; omitted only by direct current-profile callers. */
  readonly semanticPlaybackCohortId?: string;
}

export interface FilePlaybackGuestSessionHandshakeOptions {
  readonly idIssuer: FilePlaybackHandshakeIdIssuer;
  readonly guestParticipantId: string;
  /** Fixed manager/build identity; omitted only by direct current-profile callers. */
  readonly semanticPlaybackCohortId?: string;
}

export type FilePlaybackHostSessionHandshakeState =
  | 'awaiting-hello'
  | 'welcome-issued'
  | 'snapshot-issued'
  | 'applied';

export type FilePlaybackGuestSessionHandshakeState =
  | 'ready'
  | 'hello-issued'
  | 'welcome-accepted'
  | 'snapshot-accepted'
  | 'applied-issued';

export type FilePlaybackSessionHandshakeRejectionReason =
  | 'malformed-message'
  | 'message-too-large'
  | 'wrong-state'
  | 'reentrant-call'
  | 'semantic-playback-cohort-mismatch'
  | 'wrong-hello'
  | 'wrong-session'
  | 'wrong-connection'
  | 'wrong-host-participant'
  | 'wrong-guest-participant'
  | 'wrong-snapshot-sequence';

export type FilePlaybackSessionMessageResult<
  Key extends 'hello' | 'welcome' | 'snapshot' | 'applied',
  Message extends FilePlaybackSessionMessageV2,
> =
  | Readonly<{ accepted: true } & Record<Key, Readonly<Message>>>
  | Readonly<{ accepted: false; reason: FilePlaybackSessionHandshakeRejectionReason }>;

export type FilePlaybackSessionBindingResult =
  | Readonly<{ accepted: true; binding: Readonly<FilePlaybackSessionBindingV2> }>
  | Readonly<{ accepted: false; reason: FilePlaybackSessionHandshakeRejectionReason }>;

export type FilePlaybackSessionTransitionResult =
  | Readonly<{ accepted: true }>
  | Readonly<{ accepted: false; reason: FilePlaybackSessionHandshakeRejectionReason }>;

type DetachedRecord = Record<string, unknown>;

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function rejected(
  reason: FilePlaybackSessionHandshakeRejectionReason,
): Readonly<{ accepted: false; reason: FilePlaybackSessionHandshakeRejectionReason }> {
  return freezeCanonical({ accepted: false as const, reason });
}

function acceptedMessage<
  Key extends 'hello' | 'welcome' | 'snapshot' | 'applied',
  Message extends FilePlaybackSessionMessageV2,
>(key: Key, message: Readonly<Message>): FilePlaybackSessionMessageResult<Key, Message> {
  return freezeCanonical({
    accepted: true as const,
    [key]: message,
  }) as FilePlaybackSessionMessageResult<Key, Message>;
}

function acceptedBinding(
  binding: Readonly<FilePlaybackSessionBindingV2>,
): FilePlaybackSessionBindingResult {
  return freezeCanonical({ accepted: true as const, binding });
}

function acceptedTransition(): FilePlaybackSessionTransitionResult {
  return freezeCanonical({ accepted: true as const });
}

export function isFilePlaybackSessionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= FILE_PLAYBACK_SESSION_MAX_ID_LENGTH &&
    SESSION_ID_PATTERN.test(value)
  );
}

interface FilePlaybackHandshakeCryptoSource {
  readonly randomUUID?: () => string;
  readonly getRandomValues?: (array: Uint8Array) => Uint8Array;
}

/** CSPRNG-only default. There is deliberately no Math.random fallback. */
export function createSecureFilePlaybackHandshakeId(
  cryptoSource: FilePlaybackHandshakeCryptoSource | null = typeof globalThis.crypto === 'object'
    ? globalThis.crypto
    : null,
): string {
  if (cryptoSource && typeof cryptoSource.randomUUID === 'function') {
    const uuid = cryptoSource.randomUUID.call(cryptoSource);
    if (typeof uuid !== 'string') {
      throw new Error('Secure random UUID source returned an invalid handshake ID');
    }
    const value = `fp-${uuid}`;
    if (!isFilePlaybackSessionId(value)) {
      throw new Error('Secure random UUID source returned an invalid handshake ID');
    }
    return value;
  }

  if (cryptoSource && typeof cryptoSource.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    cryptoSource.getRandomValues.call(cryptoSource, bytes);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `fp-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
      16,
      20,
    )}-${hex.slice(20)}`;
  }

  throw new Error('Secure randomness is unavailable for file playback handshake IDs');
}

function snapshotExactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): DetachedRecord | null {
  try {
    if (value === null || typeof value !== 'object') return null;
    const expected = new Set(expectedKeys);
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== expected.size ||
      ownKeys.some((key) => typeof key !== 'string' || !expected.has(key))
    ) {
      return null;
    }

    const snapshot = Object.create(null) as DetachedRecord;
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function snapshotIdIssuerOptions(value: unknown): DetachedRecord | null {
  try {
    if (value === null || typeof value !== 'object') return null;
    const allowed = new Set<string>(ID_ISSUER_OPTION_KEYS);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== 'string' || !allowed.has(key))) return null;

    const snapshot = Object.create(null) as DetachedRecord;
    for (const key of ownKeys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
        return null;
      }
      if (descriptor.value !== undefined && typeof descriptor.value !== 'function') return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

interface IssuedHandshakeId {
  readonly kind: FilePlaybackHandshakeIdKind;
  readonly value: string;
  claimed: boolean;
}

/**
 * Manager-lifetime freshness authority. Own exactly one issuer for the whole
 * application/session manager lifetime; do not recreate it on reconnect. Its
 * tombstones intentionally never expire, so a connection or hello epoch can
 * never be reused while that manager exists.
 */
export class FilePlaybackHandshakeIdIssuer {
  readonly #factories: Readonly<Record<FilePlaybackHandshakeIdKind, () => string>>;
  readonly #tombstones = new Set<string>();
  readonly #issued = new WeakMap<object, IssuedHandshakeId>();
  #issuing = false;

  constructor(options: FilePlaybackHandshakeIdIssuerOptions = {}) {
    const snapshot = snapshotIdIssuerOptions(options);
    if (!snapshot) throw new TypeError('File playback handshake ID issuer options are invalid');
    const secureDefault = () => createSecureFilePlaybackHandshakeId();
    this.#factories = Object.freeze({
      session: (snapshot.createSessionId as (() => string) | undefined) ?? secureDefault,
      connection: (snapshot.createConnectionId as (() => string) | undefined) ?? secureDefault,
      hello: (snapshot.createHelloId as (() => string) | undefined) ?? secureDefault,
    });
  }

  issueSessionId(): FilePlaybackHandshakeIdToken<'session'> {
    return this.#issue('session');
  }

  issueConnectionId(): FilePlaybackHandshakeIdToken<'connection'> {
    return this.#issue('connection');
  }

  issueHelloId(): FilePlaybackHandshakeIdToken<'hello'> {
    return this.#issue('hello');
  }

  resolveSessionId(token: FilePlaybackHandshakeIdToken<'session'>): string {
    return this.#resolve(token, 'session', false);
  }

  claimConnectionId(token: FilePlaybackHandshakeIdToken<'connection'>): string {
    return this.#resolve(token, 'connection', true);
  }

  claimHelloId(token: FilePlaybackHandshakeIdToken<'hello'>): string {
    return this.#resolve(token, 'hello', true);
  }

  #issue<Kind extends FilePlaybackHandshakeIdKind>(kind: Kind): FilePlaybackHandshakeIdToken<Kind> {
    if (this.#issuing) throw new Error('Handshake ID factory re-entry is not allowed');
    this.#issuing = true;
    try {
      const value = this.#factories[kind]();
      if (!isFilePlaybackSessionId(value)) {
        throw new TypeError(`File playback ${kind} ID factory returned an invalid ID`);
      }
      if (this.#tombstones.has(value)) {
        throw new Error(`File playback handshake ID ${value} must not be reused`);
      }

      const token = Object.create(null) as Record<PropertyKey, unknown>;
      Object.defineProperties(token, {
        kind: { value: kind, enumerable: true },
        value: { value, enumerable: true },
        [HANDSHAKE_ID_TOKEN_BRAND]: { value: true, enumerable: false },
      });
      Object.freeze(token);
      this.#tombstones.add(value);
      this.#issued.set(token, { kind, value, claimed: false });
      return token as FilePlaybackHandshakeIdToken<Kind>;
    } finally {
      this.#issuing = false;
    }
  }

  #resolve<Kind extends FilePlaybackHandshakeIdKind>(
    token: FilePlaybackHandshakeIdToken<Kind>,
    kind: Kind,
    claim: boolean,
  ): string {
    if (token === null || typeof token !== 'object') {
      throw new TypeError(`File playback ${kind} ID token is invalid`);
    }
    const issued = this.#issued.get(token);
    if (!issued || issued.kind !== kind) {
      throw new TypeError(`File playback ${kind} ID token does not belong to this issuer`);
    }
    if (claim) {
      if (issued.claimed) throw new Error(`File playback ${kind} ID token was already claimed`);
      issued.claimed = true;
    }
    return issued.value;
  }
}

/**
 * Takes one exact own-data snapshot of an untrusted frame. No field is read
 * through [[Get]], accessors never run, and a Proxy gets at most one descriptor
 * read for each admitted key.
 */
function snapshotSessionMessage(value: unknown): DetachedRecord | null {
  try {
    if (value === null || typeof value !== 'object') return null;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length < HELLO_KEYS.length ||
      ownKeys.length > SNAPSHOT_KEYS.length ||
      ownKeys.some((key) => typeof key !== 'string')
    ) {
      return null;
    }

    const typeDescriptor = Object.getOwnPropertyDescriptor(value, 'type');
    if (
      !typeDescriptor ||
      typeDescriptor.enumerable !== true ||
      !Object.hasOwn(typeDescriptor, 'value') ||
      typeof typeDescriptor.value !== 'string' ||
      !Object.hasOwn(MESSAGE_KEYS, typeDescriptor.value)
    ) {
      return null;
    }

    const expectedKeys = MESSAGE_KEYS[typeDescriptor.value as keyof typeof MESSAGE_KEYS];
    const expected = new Set<string>(expectedKeys);
    if (
      ownKeys.length !== expected.size ||
      ownKeys.some((key) => typeof key !== 'string' || !expected.has(key))
    ) {
      return null;
    }

    const snapshot = Object.create(null) as DetachedRecord;
    for (const key of expectedKeys) {
      const descriptor =
        key === 'type' ? typeDescriptor : Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function hasValidSharedEnvelope(record: DetachedRecord): boolean {
  return (
    record.version === FILE_PLAYBACK_SESSION_PROTOCOL_VERSION &&
    isFilePlaybackSemanticCohortId(record.semanticPlaybackCohortId) &&
    isFilePlaybackSessionId(record.sessionId) &&
    isFilePlaybackSessionId(record.connectionId) &&
    record.sessionId !== record.connectionId &&
    isFilePlaybackSessionId(record.helloId) &&
    isFilePlaybackSessionId(record.hostParticipantId) &&
    isFilePlaybackSessionId(record.guestParticipantId) &&
    record.hostParticipantId !== record.guestParticipantId
  );
}

function canonicalHello(record: DetachedRecord): Readonly<FilePlaybackSessionHelloV2> | null {
  if (
    record.type !== FILE_PLAYBACK_SESSION_HELLO_TYPE ||
    record.version !== FILE_PLAYBACK_SESSION_PROTOCOL_VERSION ||
    !isFilePlaybackSemanticCohortId(record.semanticPlaybackCohortId) ||
    !isFilePlaybackSessionId(record.helloId) ||
    !isFilePlaybackSessionId(record.guestParticipantId)
  ) {
    return null;
  }
  return freezeCanonical({
    type: FILE_PLAYBACK_SESSION_HELLO_TYPE,
    version: FILE_PLAYBACK_SESSION_PROTOCOL_VERSION,
    semanticPlaybackCohortId: record.semanticPlaybackCohortId,
    helloId: record.helloId,
    guestParticipantId: record.guestParticipantId,
  });
}

function canonicalWelcome(record: DetachedRecord): Readonly<FilePlaybackSessionWelcomeV2> | null {
  if (record.type !== FILE_PLAYBACK_SESSION_WELCOME_TYPE || !hasValidSharedEnvelope(record)) {
    return null;
  }
  return freezeCanonical({
    type: FILE_PLAYBACK_SESSION_WELCOME_TYPE,
    version: FILE_PLAYBACK_SESSION_PROTOCOL_VERSION,
    semanticPlaybackCohortId: record.semanticPlaybackCohortId as string,
    sessionId: record.sessionId as string,
    connectionId: record.connectionId as string,
    helloId: record.helloId as string,
    hostParticipantId: record.hostParticipantId as string,
    guestParticipantId: record.guestParticipantId as string,
  });
}

function canonicalSnapshot(record: DetachedRecord): Readonly<FilePlaybackSessionSnapshotV2> | null {
  if (
    record.type !== FILE_PLAYBACK_SESSION_SNAPSHOT_TYPE ||
    !hasValidSharedEnvelope(record) ||
    record.snapshotSequence !== FILE_PLAYBACK_SESSION_SNAPSHOT_SEQUENCE
  ) {
    return null;
  }
  return freezeCanonical({
    type: FILE_PLAYBACK_SESSION_SNAPSHOT_TYPE,
    version: FILE_PLAYBACK_SESSION_PROTOCOL_VERSION,
    semanticPlaybackCohortId: record.semanticPlaybackCohortId as string,
    sessionId: record.sessionId as string,
    connectionId: record.connectionId as string,
    helloId: record.helloId as string,
    hostParticipantId: record.hostParticipantId as string,
    guestParticipantId: record.guestParticipantId as string,
    snapshotSequence: FILE_PLAYBACK_SESSION_SNAPSHOT_SEQUENCE,
  });
}

function canonicalApplied(record: DetachedRecord): Readonly<FilePlaybackSessionAppliedV2> | null {
  if (
    record.type !== FILE_PLAYBACK_SESSION_APPLIED_TYPE ||
    !hasValidSharedEnvelope(record) ||
    record.snapshotSequence !== FILE_PLAYBACK_SESSION_SNAPSHOT_SEQUENCE
  ) {
    return null;
  }
  return freezeCanonical({
    type: FILE_PLAYBACK_SESSION_APPLIED_TYPE,
    version: FILE_PLAYBACK_SESSION_PROTOCOL_VERSION,
    semanticPlaybackCohortId: record.semanticPlaybackCohortId as string,
    sessionId: record.sessionId as string,
    connectionId: record.connectionId as string,
    helloId: record.helloId as string,
    hostParticipantId: record.hostParticipantId as string,
    guestParticipantId: record.guestParticipantId as string,
    snapshotSequence: FILE_PLAYBACK_SESSION_SNAPSHOT_SEQUENCE,
  });
}

/**
 * Recognizes only the exact pre-cohort V2 schema. This lets a newly deployed
 * peer report an update boundary instead of collapsing a genuine predecessor
 * into the generic malformed-frame bucket. No legacy frame is ever accepted.
 */
function snapshotExactPreCohortV2Frame(
  value: unknown,
  expectedType: string,
): DetachedRecord | null {
  const currentKeys = MESSAGE_KEYS[expectedType as keyof typeof MESSAGE_KEYS];
  if (!currentKeys) return null;
  const legacyKeys = currentKeys.filter((key) => key !== 'semanticPlaybackCohortId');
  const record = snapshotExactDataRecord(value, legacyKeys);
  if (!record || record.type !== expectedType) return null;

  if (expectedType === FILE_PLAYBACK_SESSION_HELLO_TYPE) {
    return record.version === FILE_PLAYBACK_SESSION_PROTOCOL_VERSION &&
      isFilePlaybackSessionId(record.helloId) &&
      isFilePlaybackSessionId(record.guestParticipantId)
      ? record
      : null;
  }

  const validSharedEnvelope =
    record.version === FILE_PLAYBACK_SESSION_PROTOCOL_VERSION &&
    isFilePlaybackSessionId(record.sessionId) &&
    isFilePlaybackSessionId(record.connectionId) &&
    record.sessionId !== record.connectionId &&
    isFilePlaybackSessionId(record.helloId) &&
    isFilePlaybackSessionId(record.hostParticipantId) &&
    isFilePlaybackSessionId(record.guestParticipantId) &&
    record.hostParticipantId !== record.guestParticipantId;
  if (!validSharedEnvelope) return null;
  if (expectedType === FILE_PLAYBACK_SESSION_WELCOME_TYPE) return record;
  return record.snapshotSequence === FILE_PLAYBACK_SESSION_SNAPSHOT_SEQUENCE ? record : null;
}

function isExactPreCohortV2Frame(value: unknown, expectedType: string): boolean {
  return snapshotExactPreCohortV2Frame(value, expectedType) !== null;
}

function serializedByteLength(message: Readonly<FilePlaybackSessionMessageV2>): number {
  return new TextEncoder().encode(JSON.stringify(message)).byteLength;
}

function withinMessageBudget(message: Readonly<FilePlaybackSessionMessageV2>): boolean {
  return serializedByteLength(message) <= FILE_PLAYBACK_SESSION_MAX_MESSAGE_BYTES;
}

export function parseFilePlaybackSessionMessageV2(
  value: unknown,
): Readonly<FilePlaybackSessionMessageV2> | null {
  const record = snapshotSessionMessage(value);
  if (!record) return null;

  switch (record.type) {
    case FILE_PLAYBACK_SESSION_HELLO_TYPE: {
      const message = canonicalHello(record);
      return message && withinMessageBudget(message) ? message : null;
    }
    case FILE_PLAYBACK_SESSION_WELCOME_TYPE: {
      const message = canonicalWelcome(record);
      return message && withinMessageBudget(message) ? message : null;
    }
    case FILE_PLAYBACK_SESSION_SNAPSHOT_TYPE: {
      const message = canonicalSnapshot(record);
      return message && withinMessageBudget(message) ? message : null;
    }
    case FILE_PLAYBACK_SESSION_APPLIED_TYPE: {
      const message = canonicalApplied(record);
      return message && withinMessageBudget(message) ? message : null;
    }
    default:
      return null;
  }
}

export function parseFilePlaybackSessionHelloV2(
  value: unknown,
): Readonly<FilePlaybackSessionHelloV2> | null {
  const message = parseFilePlaybackSessionMessageV2(value);
  return message?.type === FILE_PLAYBACK_SESSION_HELLO_TYPE ? message : null;
}

/**
 * Detaches the only two HELLO shapes that may cross the host's pre-open queue:
 * the exact current frame, or the exact pre-cohort V2 predecessor. The latter
 * remains invalid to the handshake and is retained solely so the manager can
 * classify its update boundary after binding the exact connection.
 */
export function snapshotFilePlaybackSessionHelloCandidateV2(
  value: unknown,
): Readonly<Record<string, unknown>> | null {
  const current = parseFilePlaybackSessionHelloV2(value);
  if (current) return current as unknown as Readonly<Record<string, unknown>>;
  return snapshotExactPreCohortV2Frame(value, FILE_PLAYBACK_SESSION_HELLO_TYPE);
}

/**
 * Returns true only for an exact V2 session frame whose semantic cohort is
 * different from this build, including the exact pre-cohort predecessor.
 * Arbitrary malformed or accessor-shaped frames are never reclassified as an
 * update boundary.
 */
export function isFilePlaybackSessionSemanticCohortMismatchV2(
  value: unknown,
  expectedSemanticPlaybackCohortId: string,
): boolean {
  if (!isFilePlaybackSemanticCohortId(expectedSemanticPlaybackCohortId)) return false;
  const current = parseFilePlaybackSessionMessageV2(value);
  if (current) {
    return current.semanticPlaybackCohortId !== expectedSemanticPlaybackCohortId;
  }
  for (const type of Object.keys(MESSAGE_KEYS)) {
    if (isExactPreCohortV2Frame(value, type)) return true;
  }
  return false;
}

export function parseFilePlaybackSessionWelcomeV2(
  value: unknown,
): Readonly<FilePlaybackSessionWelcomeV2> | null {
  const message = parseFilePlaybackSessionMessageV2(value);
  return message?.type === FILE_PLAYBACK_SESSION_WELCOME_TYPE ? message : null;
}

export function parseFilePlaybackSessionSnapshotV2(
  value: unknown,
): Readonly<FilePlaybackSessionSnapshotV2> | null {
  const message = parseFilePlaybackSessionMessageV2(value);
  return message?.type === FILE_PLAYBACK_SESSION_SNAPSHOT_TYPE ? message : null;
}

export function parseFilePlaybackSessionAppliedV2(
  value: unknown,
): Readonly<FilePlaybackSessionAppliedV2> | null {
  const message = parseFilePlaybackSessionMessageV2(value);
  return message?.type === FILE_PLAYBACK_SESSION_APPLIED_TYPE ? message : null;
}

export function serializeFilePlaybackSessionMessageV2(value: unknown): string {
  const message = parseFilePlaybackSessionMessageV2(value);
  if (!message) throw new TypeError('File playback session message is invalid');
  return JSON.stringify(message);
}

function createBinding(
  semanticPlaybackCohortId: string,
  sessionId: string,
  connectionId: string,
  helloId: string,
  hostParticipantId: string,
  guestParticipantId: string,
): Readonly<FilePlaybackSessionBindingV2> {
  return freezeCanonical({
    version: FILE_PLAYBACK_SESSION_PROTOCOL_VERSION,
    semanticPlaybackCohortId,
    sessionId,
    connectionId,
    helloId,
    hostParticipantId,
    guestParticipantId,
  });
}

function correlationMismatch(
  message: Readonly<FilePlaybackSessionSnapshotV2 | FilePlaybackSessionAppliedV2>,
  binding: Readonly<FilePlaybackSessionBindingV2>,
): FilePlaybackSessionHandshakeRejectionReason | null {
  if (message.semanticPlaybackCohortId !== binding.semanticPlaybackCohortId) {
    return 'semantic-playback-cohort-mismatch';
  }
  if (message.helloId !== binding.helloId) return 'wrong-hello';
  if (message.sessionId !== binding.sessionId) return 'wrong-session';
  if (message.connectionId !== binding.connectionId) return 'wrong-connection';
  if (message.hostParticipantId !== binding.hostParticipantId) return 'wrong-host-participant';
  if (message.guestParticipantId !== binding.guestParticipantId) return 'wrong-guest-participant';
  if (message.snapshotSequence !== FILE_PLAYBACK_SESSION_SNAPSHOT_SEQUENCE) {
    return 'wrong-snapshot-sequence';
  }
  return null;
}

function snapshotFromBinding(
  binding: Readonly<FilePlaybackSessionBindingV2>,
): Readonly<FilePlaybackSessionSnapshotV2> {
  return freezeCanonical({
    type: FILE_PLAYBACK_SESSION_SNAPSHOT_TYPE,
    version: FILE_PLAYBACK_SESSION_PROTOCOL_VERSION,
    semanticPlaybackCohortId: binding.semanticPlaybackCohortId,
    sessionId: binding.sessionId,
    connectionId: binding.connectionId,
    helloId: binding.helloId,
    hostParticipantId: binding.hostParticipantId,
    guestParticipantId: binding.guestParticipantId,
    snapshotSequence: FILE_PLAYBACK_SESSION_SNAPSHOT_SEQUENCE,
  });
}

function appliedFromSnapshot(
  snapshot: Readonly<FilePlaybackSessionSnapshotV2>,
): Readonly<FilePlaybackSessionAppliedV2> {
  return freezeCanonical({
    type: FILE_PLAYBACK_SESSION_APPLIED_TYPE,
    version: FILE_PLAYBACK_SESSION_PROTOCOL_VERSION,
    semanticPlaybackCohortId: snapshot.semanticPlaybackCohortId,
    sessionId: snapshot.sessionId,
    connectionId: snapshot.connectionId,
    helloId: snapshot.helloId,
    hostParticipantId: snapshot.hostParticipantId,
    guestParticipantId: snapshot.guestParticipantId,
    snapshotSequence: snapshot.snapshotSequence,
  });
}

/**
 * Host side of the reliable, ordered application-session handshake. Route
 * inbound frames only from the exact live DataConnection captured for the
 * issuer-owned connection ID token.
 */
export class FilePlaybackHostSessionHandshake {
  readonly #semanticPlaybackCohortId: string;
  readonly #sessionId: string;
  readonly #connectionId: string;
  readonly #hostParticipantId: string;
  readonly #guestParticipantId: string;
  #state: FilePlaybackHostSessionHandshakeState = 'awaiting-hello';
  #binding: Readonly<FilePlaybackSessionBindingV2> | null = null;
  #handlingInbound = false;

  constructor(options: FilePlaybackHostSessionHandshakeOptions) {
    const snapshot =
      snapshotExactDataRecord(options, HOST_OPTION_KEYS_WITH_COHORT) ??
      snapshotExactDataRecord(options, HOST_OPTION_KEYS);
    const semanticPlaybackCohortId =
      snapshot?.semanticPlaybackCohortId ?? FILE_PLAYBACK_V2_CURRENT_SEMANTIC_COHORT_ID;
    if (
      !snapshot ||
      !(snapshot.idIssuer instanceof FilePlaybackHandshakeIdIssuer) ||
      !isFilePlaybackSemanticCohortId(semanticPlaybackCohortId) ||
      !isFilePlaybackSessionId(snapshot.hostParticipantId) ||
      !isFilePlaybackSessionId(snapshot.guestParticipantId) ||
      snapshot.hostParticipantId === snapshot.guestParticipantId
    ) {
      throw new TypeError('File playback host session scope is invalid');
    }
    this.#semanticPlaybackCohortId = semanticPlaybackCohortId;

    try {
      this.#sessionId = snapshot.idIssuer.resolveSessionId(
        snapshot.sessionId as FilePlaybackHandshakeIdToken<'session'>,
      );
      this.#connectionId = snapshot.idIssuer.claimConnectionId(
        snapshot.connectionId as FilePlaybackHandshakeIdToken<'connection'>,
      );
    } catch {
      throw new TypeError('File playback host session ID authority is invalid');
    }
    this.#hostParticipantId = snapshot.hostParticipantId;
    this.#guestParticipantId = snapshot.guestParticipantId;
  }

  state(): FilePlaybackHostSessionHandshakeState {
    return this.#state;
  }

  /** Clock calibration only. This value MUST NOT authorize playback wire traffic. */
  provisionalBinding(): Readonly<FilePlaybackSessionBindingV2> | null {
    return this.#binding;
  }

  /** Playback wire authority exists only after the exact APPLIED receipt. */
  establishedBinding(): Readonly<FilePlaybackSessionBindingV2> | null {
    return this.#state === 'applied' ? this.#binding : null;
  }

  handleHello(
    value: unknown,
  ): FilePlaybackSessionMessageResult<'welcome', FilePlaybackSessionWelcomeV2> {
    if (this.#handlingInbound) return rejected('reentrant-call');
    if (this.#state !== 'awaiting-hello') return rejected('wrong-state');
    this.#handlingInbound = true;
    try {
      const hello = parseFilePlaybackSessionHelloV2(value);
      if (!hello) {
        return rejected(
          isExactPreCohortV2Frame(value, FILE_PLAYBACK_SESSION_HELLO_TYPE)
            ? 'semantic-playback-cohort-mismatch'
            : 'malformed-message',
        );
      }
      if (hello.semanticPlaybackCohortId !== this.#semanticPlaybackCohortId) {
        return rejected('semantic-playback-cohort-mismatch');
      }
      if (hello.guestParticipantId !== this.#guestParticipantId) {
        return rejected('wrong-guest-participant');
      }

      const binding = createBinding(
        this.#semanticPlaybackCohortId,
        this.#sessionId,
        this.#connectionId,
        hello.helloId,
        this.#hostParticipantId,
        this.#guestParticipantId,
      );
      const welcome = freezeCanonical({
        type: FILE_PLAYBACK_SESSION_WELCOME_TYPE,
        version: FILE_PLAYBACK_SESSION_PROTOCOL_VERSION,
        semanticPlaybackCohortId: binding.semanticPlaybackCohortId,
        sessionId: binding.sessionId,
        connectionId: binding.connectionId,
        helloId: binding.helloId,
        hostParticipantId: binding.hostParticipantId,
        guestParticipantId: binding.guestParticipantId,
      });
      // Validate the entire locally generated remainder before publishing the
      // binding. This prevents a long-but-individually-valid ID combination
      // from entering a state whose ordered marker cannot fit on the wire.
      if (!withinMessageBudget(welcome) || !withinMessageBudget(snapshotFromBinding(binding))) {
        return rejected('message-too-large');
      }
      this.#binding = binding;
      this.#state = 'welcome-issued';
      return acceptedMessage('welcome', welcome);
    } finally {
      this.#handlingInbound = false;
    }
  }

  /**
   * Call only after the existing queue bootstrap has been sent on the same
   * reliable ordered lane. The marker carries no queue payload: receiving it
   * proves every earlier bootstrap frame on that lane has already arrived.
   */
  createSnapshot(): FilePlaybackSessionMessageResult<'snapshot', FilePlaybackSessionSnapshotV2> {
    if (this.#state !== 'welcome-issued' || !this.#binding) return rejected('wrong-state');
    const snapshot = snapshotFromBinding(this.#binding);
    this.#state = 'snapshot-issued';
    return acceptedMessage('snapshot', snapshot);
  }

  handleApplied(value: unknown): FilePlaybackSessionBindingResult {
    if (this.#handlingInbound) return rejected('reentrant-call');
    if (this.#state !== 'snapshot-issued' || !this.#binding) return rejected('wrong-state');
    this.#handlingInbound = true;
    try {
      const applied = parseFilePlaybackSessionAppliedV2(value);
      if (!applied) {
        return rejected(
          isExactPreCohortV2Frame(value, FILE_PLAYBACK_SESSION_APPLIED_TYPE)
            ? 'semantic-playback-cohort-mismatch'
            : 'malformed-message',
        );
      }
      const mismatch = correlationMismatch(applied, this.#binding);
      if (mismatch) return rejected(mismatch);
      this.#state = 'applied';
      return acceptedBinding(this.#binding);
    } finally {
      this.#handlingInbound = false;
    }
  }
}

/**
 * Guest side of the reliable, ordered application-session handshake. Route
 * inbound frames only from the exact currently live host DataConnection.
 */
export class FilePlaybackGuestSessionHandshake {
  readonly #semanticPlaybackCohortId: string;
  readonly #helloId: string;
  readonly #guestParticipantId: string;
  #state: FilePlaybackGuestSessionHandshakeState = 'ready';
  #binding: Readonly<FilePlaybackSessionBindingV2> | null = null;
  #acceptedSnapshot: Readonly<FilePlaybackSessionSnapshotV2> | null = null;
  #handlingInbound = false;

  constructor(options: FilePlaybackGuestSessionHandshakeOptions) {
    const snapshot =
      snapshotExactDataRecord(options, GUEST_OPTION_KEYS_WITH_COHORT) ??
      snapshotExactDataRecord(options, GUEST_OPTION_KEYS);
    const semanticPlaybackCohortId =
      snapshot?.semanticPlaybackCohortId ?? FILE_PLAYBACK_V2_CURRENT_SEMANTIC_COHORT_ID;
    if (
      !snapshot ||
      !(snapshot.idIssuer instanceof FilePlaybackHandshakeIdIssuer) ||
      !isFilePlaybackSemanticCohortId(semanticPlaybackCohortId) ||
      !isFilePlaybackSessionId(snapshot.guestParticipantId)
    ) {
      throw new TypeError('File playback guest session scope is invalid');
    }
    this.#semanticPlaybackCohortId = semanticPlaybackCohortId;

    try {
      const helloId = snapshot.idIssuer.issueHelloId();
      this.#helloId = snapshot.idIssuer.claimHelloId(helloId);
    } catch {
      throw new TypeError('File playback guest hello ID authority is invalid');
    }
    this.#guestParticipantId = snapshot.guestParticipantId;
  }

  state(): FilePlaybackGuestSessionHandshakeState {
    return this.#state;
  }

  /** Clock calibration only. This value MUST NOT authorize playback wire traffic. */
  provisionalBinding(): Readonly<FilePlaybackSessionBindingV2> | null {
    return this.#binding;
  }

  /** Available only after createApplied confirms the adapter finished queue apply. */
  establishedBinding(): Readonly<FilePlaybackSessionBindingV2> | null {
    return this.#state === 'applied-issued' ? this.#binding : null;
  }

  createHello(): FilePlaybackSessionMessageResult<'hello', FilePlaybackSessionHelloV2> {
    if (this.#state !== 'ready') return rejected('wrong-state');
    const hello = freezeCanonical({
      type: FILE_PLAYBACK_SESSION_HELLO_TYPE,
      version: FILE_PLAYBACK_SESSION_PROTOCOL_VERSION,
      semanticPlaybackCohortId: this.#semanticPlaybackCohortId,
      helloId: this.#helloId,
      guestParticipantId: this.#guestParticipantId,
    });
    this.#state = 'hello-issued';
    return acceptedMessage('hello', hello);
  }

  handleWelcome(value: unknown): FilePlaybackSessionTransitionResult {
    if (this.#handlingInbound) return rejected('reentrant-call');
    if (this.#state !== 'hello-issued') return rejected('wrong-state');
    this.#handlingInbound = true;
    try {
      const welcome = parseFilePlaybackSessionWelcomeV2(value);
      if (!welcome) {
        return rejected(
          isExactPreCohortV2Frame(value, FILE_PLAYBACK_SESSION_WELCOME_TYPE)
            ? 'semantic-playback-cohort-mismatch'
            : 'malformed-message',
        );
      }
      if (welcome.semanticPlaybackCohortId !== this.#semanticPlaybackCohortId) {
        return rejected('semantic-playback-cohort-mismatch');
      }
      if (welcome.helloId !== this.#helloId) return rejected('wrong-hello');
      if (welcome.guestParticipantId !== this.#guestParticipantId) {
        return rejected('wrong-guest-participant');
      }
      const binding = createBinding(
        this.#semanticPlaybackCohortId,
        welcome.sessionId,
        welcome.connectionId,
        welcome.helloId,
        welcome.hostParticipantId,
        welcome.guestParticipantId,
      );
      if (!withinMessageBudget(snapshotFromBinding(binding))) {
        return rejected('message-too-large');
      }
      this.#binding = binding;
      this.#state = 'welcome-accepted';
      return acceptedTransition();
    } finally {
      this.#handlingInbound = false;
    }
  }

  /**
   * Validates and remembers the ordered marker, but deliberately emits no
   * APPLIED receipt. The adapter must first finish its entire queue-authority
   * apply chain, then call createApplied explicitly.
   */
  acceptSnapshot(value: unknown): FilePlaybackSessionTransitionResult {
    if (this.#handlingInbound) return rejected('reentrant-call');
    if (this.#state !== 'welcome-accepted' || !this.#binding) return rejected('wrong-state');
    this.#handlingInbound = true;
    try {
      const snapshot = parseFilePlaybackSessionSnapshotV2(value);
      if (!snapshot) {
        return rejected(
          isExactPreCohortV2Frame(value, FILE_PLAYBACK_SESSION_SNAPSHOT_TYPE)
            ? 'semantic-playback-cohort-mismatch'
            : 'malformed-message',
        );
      }
      const mismatch = correlationMismatch(snapshot, this.#binding);
      if (mismatch) return rejected(mismatch);
      const applied = appliedFromSnapshot(snapshot);
      if (!withinMessageBudget(applied)) return rejected('message-too-large');
      this.#acceptedSnapshot = snapshot;
      this.#state = 'snapshot-accepted';
      return acceptedTransition();
    } finally {
      this.#handlingInbound = false;
    }
  }

  /**
   * Call only after queue authority and every dependent apply step complete.
   * A failed send requires teardown of this handshake and DataConnection.
   */
  createApplied(): FilePlaybackSessionMessageResult<'applied', FilePlaybackSessionAppliedV2> {
    if (this.#state !== 'snapshot-accepted' || !this.#acceptedSnapshot || !this.#binding) {
      return rejected('wrong-state');
    }
    const applied = appliedFromSnapshot(this.#acceptedSnapshot);
    if (!withinMessageBudget(applied)) return rejected('message-too-large');
    this.#state = 'applied-issued';
    return acceptedMessage('applied', applied);
  }
}
