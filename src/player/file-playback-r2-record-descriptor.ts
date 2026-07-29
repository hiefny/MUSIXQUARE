import { REMOTE_SHARE_MAX_BYTES } from '../core/constants.ts';
import { R2RecordCryptoV2 } from '../share/r2-record-crypto-v2.ts';
import type { QueueItemId } from '../types/index.ts';
import {
  R2RecordEncodedAudioSource,
  type R2RecordEncodedAudioSourceOptions,
  type R2RecordEncodedAudioSourceRecord,
} from './sources/r2-record-encoded-audio-source.ts';
import type { EncodedAudioSource } from './sources/encoded-audio-source.ts';
import { isEncodedAudioSourceIdentity } from './sources/encoded-audio-source.ts';

export const FILE_PLAYBACK_R2_RECORD_DESCRIPTOR_VERSION = 1 as const;

export interface FilePlaybackR2RecordDeliveryScope {
  readonly roomEpoch: string;
  readonly bridgeGeneration: string;
  readonly bindingId: string;
  readonly queueItemId: QueueItemId;
  readonly sourceIdentity: string;
}

/**
 * Body-free, secret-free capability reference suitable for actor state and
 * diagnostics. The R2 key, nonce prefix, and object list never appear here.
 */
export interface FilePlaybackR2RecordDescriptorRef {
  readonly scope: Readonly<FilePlaybackR2RecordDeliveryScope>;
  readonly descriptorId: string;
  readonly descriptorVersion: typeof FILE_PLAYBACK_R2_RECORD_DESCRIPTOR_VERSION;
}

type ExactRecord = Readonly<Record<string, unknown>>;

interface PrivateDescriptorRecord {
  readonly ref: Readonly<FilePlaybackR2RecordDescriptorRef>;
  readonly sourceOptions: Readonly<R2RecordEncodedAudioSourceOptions>;
  readonly transferSessionId: string;
  readonly expiresAtEpochMs: number;
  readonly token: object;
}

interface PrivateRegistryState {
  readonly entries: Map<string, PrivateDescriptorRecord>;
  readonly retiredDescriptorKeys: Set<string>;
  readonly retiredScopeKeys: Set<string>;
  registering: boolean;
  sealed: boolean;
  disposed: boolean;
}

const REGISTRATION_KEYS = Object.freeze([
  'scope',
  'descriptorId',
  'descriptorVersion',
  'publication',
] as const);
const SCOPE_KEYS = Object.freeze([
  'roomEpoch',
  'bridgeGeneration',
  'bindingId',
  'queueItemId',
  'sourceIdentity',
] as const);
const REF_KEYS = Object.freeze(['scope', 'descriptorId', 'descriptorVersion'] as const);
const PUBLICATION_KEYS = Object.freeze([
  'schemaVersion',
  'queueItemId',
  'sourceIdentity',
  'transferSessionId',
  'applicationSessionId',
  'storageRoomId',
  'setId',
  'encodedSize',
  'recordSize',
  'recordCount',
  'cryptoSecretDescriptor',
  'records',
  'name',
  'mime',
  'expiresAtEpochMs',
] as const);
const RECORD_KEYS = Object.freeze(['index', 'objectId', 'plaintextSize', 'encryptedSize'] as const);

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const QUEUE_ITEM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const OBJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const STANDARD_STORAGE_ROOM_ID_RE = /^[1-9]\d{5}$/u;
const MIME_RE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u;
const MAX_NAME_LENGTH = 512;
const MAX_MIME_LENGTH = 128;
const MAX_PRIVATE_DESCRIPTOR_SLOTS = 1_024;
const MAX_R2_RECORD_COUNT = Math.ceil(
  REMOTE_SHARE_MAX_BYTES / R2RecordCryptoV2.RECORD_PLAINTEXT_BYTES,
);

/**
 * Raw delivery material is held only in this module-private registry. Keeping
 * the state outside the class instance prevents accidental spreading or
 * serialization of keys through a registry object.
 */
const PRIVATE_REGISTRIES = new WeakMap<
  FilePlaybackR2RecordDescriptorRegistry,
  PrivateRegistryState
>();

function fail(code: string, cause?: unknown): never {
  throw new Error(code, cause === undefined ? undefined : { cause });
}

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function snapshotExactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): ExactRecord | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    const expected = new Set(expectedKeys);
    if (
      ownKeys.length !== expected.size ||
      ownKeys.some((key) => typeof key !== 'string' || !expected.has(key))
    ) {
      return null;
    }
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function snapshotExactArray(value: unknown, expectedLength: number): readonly unknown[] | null {
  try {
    if (!Array.isArray(value) || Reflect.getPrototypeOf(value) !== Array.prototype) return null;
    if (!Number.isSafeInteger(expectedLength) || expectedLength < 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const descriptorMap = descriptors as unknown as PropertyDescriptorMap;
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.length !== expectedLength + 1) return null;
    const lengthDescriptor = descriptorMap['length'];
    if (
      !lengthDescriptor ||
      !Object.hasOwn(lengthDescriptor, 'value') ||
      lengthDescriptor.value !== expectedLength
    ) {
      return null;
    }
    const snapshot: unknown[] = [];
    for (let index = 0; index < expectedLength; index += 1) {
      const descriptor = descriptorMap[String(index)];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      snapshot.push(descriptor.value);
    }
    if (
      ownKeys.some(
        (key) =>
          typeof key !== 'string' ||
          (key !== 'length' && (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= expectedLength)),
      )
    ) {
      return null;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER_RE.test(value);
}

function isQueueItemId(value: unknown): value is QueueItemId {
  return typeof value === 'string' && QUEUE_ITEM_ID_RE.test(value);
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

export function canonicalizeFilePlaybackR2RecordDeliveryScope(
  value: unknown,
): Readonly<FilePlaybackR2RecordDeliveryScope> {
  const snapshot = snapshotExactDataRecord(value, SCOPE_KEYS);
  if (
    !snapshot ||
    !isIdentifier(snapshot.roomEpoch) ||
    !isIdentifier(snapshot.bridgeGeneration) ||
    !isIdentifier(snapshot.bindingId) ||
    !isQueueItemId(snapshot.queueItemId) ||
    !isEncodedAudioSourceIdentity(snapshot.sourceIdentity)
  ) {
    fail('FILE_PLAYBACK_R2_RECORD_SCOPE_INVALID');
  }
  return freezeCanonical({
    roomEpoch: snapshot.roomEpoch,
    bridgeGeneration: snapshot.bridgeGeneration,
    bindingId: snapshot.bindingId,
    queueItemId: snapshot.queueItemId,
    sourceIdentity: snapshot.sourceIdentity,
  });
}

export function canonicalizeFilePlaybackR2RecordDescriptorRef(
  value: unknown,
): Readonly<FilePlaybackR2RecordDescriptorRef> {
  const snapshot = snapshotExactDataRecord(value, REF_KEYS);
  if (
    !snapshot ||
    !isIdentifier(snapshot.descriptorId) ||
    snapshot.descriptorVersion !== FILE_PLAYBACK_R2_RECORD_DESCRIPTOR_VERSION
  ) {
    fail('FILE_PLAYBACK_R2_RECORD_DESCRIPTOR_REF_INVALID');
  }
  return freezeCanonical({
    scope: canonicalizeFilePlaybackR2RecordDeliveryScope(snapshot.scope),
    descriptorId: snapshot.descriptorId,
    descriptorVersion: FILE_PLAYBACK_R2_RECORD_DESCRIPTOR_VERSION,
  });
}

export function sameFilePlaybackR2RecordDeliveryScope(
  left: Readonly<FilePlaybackR2RecordDeliveryScope>,
  right: Readonly<FilePlaybackR2RecordDeliveryScope>,
): boolean {
  return (
    left.roomEpoch === right.roomEpoch &&
    left.bridgeGeneration === right.bridgeGeneration &&
    left.bindingId === right.bindingId &&
    left.queueItemId === right.queueItemId &&
    left.sourceIdentity === right.sourceIdentity
  );
}

export function sameFilePlaybackR2RecordDescriptorRef(
  left: Readonly<FilePlaybackR2RecordDescriptorRef>,
  right: Readonly<FilePlaybackR2RecordDescriptorRef>,
): boolean {
  return (
    left.descriptorId === right.descriptorId &&
    left.descriptorVersion === right.descriptorVersion &&
    sameFilePlaybackR2RecordDeliveryScope(left.scope, right.scope)
  );
}

function scopeKey(scope: Readonly<FilePlaybackR2RecordDeliveryScope>): string {
  return JSON.stringify([
    scope.roomEpoch,
    scope.bridgeGeneration,
    scope.bindingId,
    scope.queueItemId,
    scope.sourceIdentity,
  ]);
}

function descriptorKey(ref: Readonly<FilePlaybackR2RecordDescriptorRef>): string {
  return `${scopeKey(ref.scope)}:${ref.descriptorVersion}:${ref.descriptorId}`;
}

function snapshotPublication(
  value: unknown,
  scope: Readonly<FilePlaybackR2RecordDeliveryScope>,
): {
  readonly sourceOptions: Readonly<R2RecordEncodedAudioSourceOptions>;
  readonly transferSessionId: string;
} {
  const snapshot = snapshotExactDataRecord(value, PUBLICATION_KEYS);
  if (
    !snapshot ||
    snapshot.schemaVersion !== 1 ||
    snapshot.queueItemId !== scope.queueItemId ||
    snapshot.applicationSessionId !== scope.roomEpoch ||
    !isEncodedAudioSourceIdentity(snapshot.sourceIdentity) ||
    snapshot.sourceIdentity !== scope.sourceIdentity ||
    !isIdentifier(snapshot.transferSessionId) ||
    snapshot.transferSessionId !== scope.bindingId ||
    typeof snapshot.storageRoomId !== 'string' ||
    !STANDARD_STORAGE_ROOM_ID_RE.test(snapshot.storageRoomId) ||
    typeof snapshot.setId !== 'string' ||
    !OBJECT_ID_RE.test(snapshot.setId) ||
    !Number.isSafeInteger(snapshot.encodedSize) ||
    (snapshot.encodedSize as number) <= 0 ||
    (snapshot.encodedSize as number) > REMOTE_SHARE_MAX_BYTES ||
    snapshot.recordSize !== R2RecordCryptoV2.RECORD_PLAINTEXT_BYTES ||
    !Number.isSafeInteger(snapshot.recordCount) ||
    (snapshot.recordCount as number) <= 0 ||
    (snapshot.recordCount as number) > MAX_R2_RECORD_COUNT ||
    typeof snapshot.name !== 'string' ||
    snapshot.name.length === 0 ||
    snapshot.name.length > MAX_NAME_LENGTH ||
    containsControlCharacter(snapshot.name) ||
    typeof snapshot.mime !== 'string' ||
    snapshot.mime.length === 0 ||
    snapshot.mime.length > MAX_MIME_LENGTH ||
    !MIME_RE.test(snapshot.mime) ||
    !Number.isSafeInteger(snapshot.expiresAtEpochMs) ||
    (snapshot.expiresAtEpochMs as number) <= Date.now()
  ) {
    fail('FILE_PLAYBACK_R2_RECORD_PUBLICATION_INVALID');
  }

  let secretDescriptor: ReturnType<typeof R2RecordCryptoV2.canonicalizeSecretDescriptor>;
  try {
    secretDescriptor = R2RecordCryptoV2.canonicalizeSecretDescriptor(
      snapshot.cryptoSecretDescriptor,
    );
  } catch (cause) {
    fail('FILE_PLAYBACK_R2_RECORD_PUBLICATION_INVALID', cause);
  }
  if (
    secretDescriptor.objectId !== snapshot.setId ||
    secretDescriptor.plaintextSize !== snapshot.encodedSize ||
    secretDescriptor.recordSize !== snapshot.recordSize ||
    secretDescriptor.recordCount !== snapshot.recordCount
  ) {
    fail('FILE_PLAYBACK_R2_RECORD_PUBLICATION_MISMATCH');
  }

  const rawRecords = snapshotExactArray(snapshot.records, snapshot.recordCount as number);
  if (!rawRecords) fail('FILE_PLAYBACK_R2_RECORD_PUBLICATION_INVALID');
  const cryptoMetadata = R2RecordCryptoV2.canonicalizeMetadata({
    formatVersion: secretDescriptor.formatVersion,
    objectId: secretDescriptor.objectId,
    plaintextSize: secretDescriptor.plaintextSize,
    recordSize: secretDescriptor.recordSize,
    recordCount: secretDescriptor.recordCount,
    noncePrefixB64: secretDescriptor.noncePrefixB64,
  });
  const records: Readonly<R2RecordEncodedAudioSourceRecord>[] = rawRecords.map(
    (rawRecord, index) => {
      const record = snapshotExactDataRecord(rawRecord, RECORD_KEYS);
      const layout = R2RecordCryptoV2.getRecordLayout(cryptoMetadata, index);
      if (
        !record ||
        record.index !== index ||
        typeof record.objectId !== 'string' ||
        !OBJECT_ID_RE.test(record.objectId) ||
        record.plaintextSize !== layout.plaintextLength ||
        record.encryptedSize !== layout.ciphertextLength
      ) {
        fail('FILE_PLAYBACK_R2_RECORD_PUBLICATION_LAYOUT_INVALID');
      }
      return freezeCanonical({
        index,
        objectId: record.objectId,
        plaintextSize: layout.plaintextLength,
        encryptedSize: layout.ciphertextLength,
      });
    },
  );
  if (new Set(records.map((record) => record.objectId)).size !== records.length) {
    fail('FILE_PLAYBACK_R2_RECORD_PUBLICATION_OBJECT_ID_DUPLICATE');
  }
  const expiresAtEpochMs = snapshot.expiresAtEpochMs as number;

  return freezeCanonical({
    sourceOptions: freezeCanonical({
      storageRoomId: snapshot.storageRoomId,
      setId: snapshot.setId,
      identity: snapshot.sourceIdentity,
      metadata: freezeCanonical({ name: snapshot.name, mime: snapshot.mime }),
      secretDescriptor,
      records: Object.freeze(records),
      expiresAtEpochMs,
    }),
    transferSessionId: snapshot.transferSessionId,
  });
}

function samePublication(
  left: Pick<PrivateDescriptorRecord, 'sourceOptions' | 'transferSessionId'>,
  right: Pick<PrivateDescriptorRecord, 'sourceOptions' | 'transferSessionId'>,
): boolean {
  const leftOptions = left.sourceOptions;
  const rightOptions = right.sourceOptions;
  const leftSecret = leftOptions.secretDescriptor as ReturnType<
    typeof R2RecordCryptoV2.canonicalizeSecretDescriptor
  >;
  const rightSecret = rightOptions.secretDescriptor as ReturnType<
    typeof R2RecordCryptoV2.canonicalizeSecretDescriptor
  >;
  return (
    left.transferSessionId === right.transferSessionId &&
    leftOptions.storageRoomId === rightOptions.storageRoomId &&
    leftOptions.setId === rightOptions.setId &&
    leftOptions.identity === rightOptions.identity &&
    leftOptions.metadata.name === rightOptions.metadata.name &&
    leftOptions.metadata.mime === rightOptions.metadata.mime &&
    leftOptions.expiresAtEpochMs === rightOptions.expiresAtEpochMs &&
    leftSecret.formatVersion === rightSecret.formatVersion &&
    leftSecret.objectId === rightSecret.objectId &&
    leftSecret.plaintextSize === rightSecret.plaintextSize &&
    leftSecret.recordSize === rightSecret.recordSize &&
    leftSecret.recordCount === rightSecret.recordCount &&
    leftSecret.noncePrefixB64 === rightSecret.noncePrefixB64 &&
    leftSecret.keyB64 === rightSecret.keyB64 &&
    leftOptions.records.length === rightOptions.records.length &&
    leftOptions.records.every((record, index) => {
      const other = rightOptions.records[index];
      return (
        !!other &&
        record.index === other.index &&
        record.objectId === other.objectId &&
        record.plaintextSize === other.plaintextSize &&
        record.encryptedSize === other.encryptedSize
      );
    })
  );
}

function addTombstone(state: PrivateRegistryState, key: string): void {
  if (state.retiredDescriptorKeys.has(key)) return;
  state.retiredDescriptorKeys.add(key);
}

function occupiedRegistrySlots(state: PrivateRegistryState): number {
  return state.entries.size + state.retiredDescriptorKeys.size + state.retiredScopeKeys.size;
}

function sealRegistry(state: PrivateRegistryState): void {
  state.entries.clear();
  state.retiredDescriptorKeys.clear();
  state.retiredScopeKeys.clear();
  state.sealed = true;
}

function retireEntry(state: PrivateRegistryState, key: string): void {
  if (!state.entries.delete(key)) return;
  addTombstone(state, key);
}

function pruneExpiredEntries(
  state: PrivateRegistryState,
  nowEpochMs: number,
  exceptKey?: string,
): void {
  for (const [key, record] of state.entries) {
    if (key !== exceptKey && nowEpochMs >= record.expiresAtEpochMs) {
      retireEntry(state, key);
    }
  }
}

function retireScope(
  state: PrivateRegistryState,
  scope: Readonly<FilePlaybackR2RecordDeliveryScope>,
): void {
  if (state.sealed) return;
  const key = scopeKey(scope);
  if (state.retiredScopeKeys.has(key)) return;

  for (const [descriptorEntryKey, record] of state.entries) {
    if (sameFilePlaybackR2RecordDeliveryScope(record.ref.scope, scope)) {
      state.entries.delete(descriptorEntryKey);
    }
  }
  const descriptorPrefix = `${key}:`;
  for (const descriptorTombstone of state.retiredDescriptorKeys) {
    if (descriptorTombstone.startsWith(descriptorPrefix)) {
      state.retiredDescriptorKeys.delete(descriptorTombstone);
    }
  }

  if (occupiedRegistrySlots(state) >= MAX_PRIVATE_DESCRIPTOR_SLOTS) {
    // An exact retirement fence must never be dropped. If the bounded
    // registry cannot retain one more scope tombstone, seal the whole
    // registry and release every secret instead of permitting resurrection.
    sealRegistry(state);
    return;
  }
  state.retiredScopeKeys.add(key);
}

async function closeSourceQuietly(source: EncodedAudioSource): Promise<void> {
  try {
    await source.close();
  } catch {
    // Stale source cleanup must not replace the authoritative scope error.
  }
}

function privateState(registry: FilePlaybackR2RecordDescriptorRegistry): PrivateRegistryState {
  const state = PRIVATE_REGISTRIES.get(registry);
  if (!state) fail('FILE_PLAYBACK_R2_RECORD_REGISTRY_INVALID');
  return state;
}

/**
 * Secret-holding descriptor boundary. Callers receive only a frozen reference;
 * source construction is the sole operation allowed to observe private R2
 * material.
 */
export class FilePlaybackR2RecordDescriptorRegistry {
  constructor() {
    PRIVATE_REGISTRIES.set(this, {
      entries: new Map(),
      retiredDescriptorKeys: new Set(),
      retiredScopeKeys: new Set(),
      registering: false,
      sealed: false,
      disposed: false,
    });
  }

  register(value: unknown): Readonly<FilePlaybackR2RecordDescriptorRef> {
    const state = privateState(this);
    if (state.disposed) fail('FILE_PLAYBACK_R2_RECORD_REGISTRY_DISPOSED');
    if (state.sealed) fail('FILE_PLAYBACK_R2_RECORD_REGISTRY_CAPACITY');
    if (state.registering) fail('FILE_PLAYBACK_R2_RECORD_DESCRIPTOR_REENTRANT');
    state.registering = true;
    try {
      const registration = snapshotExactDataRecord(value, REGISTRATION_KEYS);
      if (
        !registration ||
        !isIdentifier(registration.descriptorId) ||
        registration.descriptorVersion !== FILE_PLAYBACK_R2_RECORD_DESCRIPTOR_VERSION
      ) {
        fail('FILE_PLAYBACK_R2_RECORD_DESCRIPTOR_INVALID');
      }
      const scope = canonicalizeFilePlaybackR2RecordDeliveryScope(registration.scope);
      const ref = freezeCanonical({
        scope,
        descriptorId: registration.descriptorId,
        descriptorVersion: FILE_PLAYBACK_R2_RECORD_DESCRIPTOR_VERSION,
      });
      const key = descriptorKey(ref);
      pruneExpiredEntries(state, Date.now());
      if (state.sealed) fail('FILE_PLAYBACK_R2_RECORD_REGISTRY_CAPACITY');
      if (state.retiredScopeKeys.has(scopeKey(scope))) {
        fail('FILE_PLAYBACK_R2_RECORD_SCOPE_RETIRED');
      }
      if (state.retiredDescriptorKeys.has(key)) {
        fail('FILE_PLAYBACK_R2_RECORD_DESCRIPTOR_RETIRED');
      }
      const publication = snapshotPublication(registration.publication, scope);
      const existing = state.entries.get(key);
      if (existing) {
        if (
          sameFilePlaybackR2RecordDescriptorRef(existing.ref, ref) &&
          samePublication(existing, publication)
        ) {
          return existing.ref;
        }
        fail('FILE_PLAYBACK_R2_RECORD_DESCRIPTOR_CONFLICT');
      }
      if (occupiedRegistrySlots(state) >= MAX_PRIVATE_DESCRIPTOR_SLOTS) {
        fail('FILE_PLAYBACK_R2_RECORD_REGISTRY_CAPACITY');
      }
      const record: PrivateDescriptorRecord = {
        ref,
        sourceOptions: publication.sourceOptions,
        transferSessionId: publication.transferSessionId,
        expiresAtEpochMs: publication.sourceOptions.expiresAtEpochMs,
        token: Object.freeze(Object.create(null) as object),
      };
      Object.freeze(record);
      state.entries.set(key, record);
      return ref;
    } finally {
      state.registering = false;
    }
  }

  assertUsable(
    scopeValue: unknown,
    refValue: unknown,
  ): {
    readonly scope: Readonly<FilePlaybackR2RecordDeliveryScope>;
    readonly ref: Readonly<FilePlaybackR2RecordDescriptorRef>;
  } {
    const scope = canonicalizeFilePlaybackR2RecordDeliveryScope(scopeValue);
    const ref = canonicalizeFilePlaybackR2RecordDescriptorRef(refValue);
    if (!sameFilePlaybackR2RecordDeliveryScope(scope, ref.scope)) {
      fail('FILE_PLAYBACK_R2_RECORD_DESCRIPTOR_SCOPE_MISMATCH');
    }
    const state = privateState(this);
    if (state.disposed) fail('FILE_PLAYBACK_R2_RECORD_REGISTRY_DISPOSED');
    if (state.sealed) fail('FILE_PLAYBACK_R2_RECORD_REGISTRY_CAPACITY');
    if (state.retiredScopeKeys.has(scopeKey(scope))) {
      fail('FILE_PLAYBACK_R2_RECORD_SCOPE_RETIRED');
    }
    const key = descriptorKey(ref);
    pruneExpiredEntries(state, Date.now(), key);
    const record = state.entries.get(key);
    if (!record || !sameFilePlaybackR2RecordDescriptorRef(record.ref, ref)) {
      fail('FILE_PLAYBACK_R2_RECORD_DESCRIPTOR_UNAVAILABLE');
    }
    if (Date.now() >= record.expiresAtEpochMs) {
      retireEntry(state, key);
      fail('FILE_PLAYBACK_R2_RECORD_DESCRIPTOR_EXPIRED');
    }
    return freezeCanonical({ scope, ref });
  }

  async createSource(
    scopeValue: unknown,
    refValue: unknown,
    signal: AbortSignal,
  ): Promise<EncodedAudioSource> {
    const { ref } = this.assertUsable(scopeValue, refValue);
    const state = privateState(this);
    const key = descriptorKey(ref);
    let token: object;
    let expiresAtEpochMs: number;
    let createPromise: Promise<EncodedAudioSource>;
    {
      const record = state.entries.get(key);
      if (!record) fail('FILE_PLAYBACK_R2_RECORD_DESCRIPTOR_UNAVAILABLE');
      token = record.token;
      expiresAtEpochMs = record.expiresAtEpochMs;
      createPromise = R2RecordEncodedAudioSource.create(record.sourceOptions, signal);
    }
    // The secret-bearing registry record is no longer in this async frame's live
    // lexical scope while an abort-ignoring constructor is pending. The opaque
    // token is sufficient to reject a retired or replaced incarnation later.
    let source: EncodedAudioSource | null = null;
    try {
      source = await createPromise;
      const current = state.entries.get(key);
      if (signal.aborted || current?.token !== token || Date.now() >= expiresAtEpochMs) {
        await closeSourceQuietly(source);
        source = null;
        if (signal.aborted) {
          signal.throwIfAborted();
        }
        fail('FILE_PLAYBACK_R2_RECORD_DESCRIPTOR_SUPERSEDED');
      }
      return source;
    } catch (error) {
      if (source) await closeSourceQuietly(source);
      throw error;
    }
  }

  retire(scopeValue: unknown): Promise<void> {
    const scope = canonicalizeFilePlaybackR2RecordDeliveryScope(scopeValue);
    const state = privateState(this);
    if (state.disposed) return Promise.resolve();
    retireScope(state, scope);
    return Promise.resolve();
  }

  has(refValue: unknown): boolean {
    try {
      const ref = canonicalizeFilePlaybackR2RecordDescriptorRef(refValue);
      const state = privateState(this);
      if (state.disposed || state.sealed || state.retiredScopeKeys.has(scopeKey(ref.scope))) {
        return false;
      }
      pruneExpiredEntries(state, Date.now());
      const record = state.entries.get(descriptorKey(ref));
      return !!record && sameFilePlaybackR2RecordDescriptorRef(record.ref, ref);
    } catch {
      return false;
    }
  }

  scopeKey(scopeValue: unknown): string {
    return scopeKey(canonicalizeFilePlaybackR2RecordDeliveryScope(scopeValue));
  }

  clear(): Promise<void> {
    const state = privateState(this);
    if (state.disposed) return Promise.resolve();
    for (const key of [...state.entries.keys()]) retireEntry(state, key);
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    const state = privateState(this);
    if (state.disposed) return Promise.resolve();
    state.entries.clear();
    state.retiredDescriptorKeys.clear();
    state.retiredScopeKeys.clear();
    state.sealed = true;
    state.disposed = true;
    return Promise.resolve();
  }
}
