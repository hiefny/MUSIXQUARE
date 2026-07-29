/**
 * Transport-agnostic negotiation ledger for the additive bounded V1 file path.
 *
 * This module deliberately owns no room, peer, signaling, or playback
 * authority. One ledger entry is fenced by the exact connection object and the
 * complete immutable delivery scope. The caller remains responsible for
 * sending frames and for executing the existing V1 byte fallback.
 */

type DeliveryPurpose = 'current' | 'preload';
type CapabilityState = 'unknown' | 'capable' | 'legacy-only' | 'retired';
type DeliveryState = 'pending' | 'descriptor-sent' | 'ready' | 'legacy-committed' | 'retired';

interface DeliveryScope {
  readonly roomEpoch: string;
  readonly bridgeGeneration: string;
  readonly bindingId: string;
  readonly queueItemId: string;
  readonly sourceIdentity: string;
}

interface PublicationIdentity {
  readonly queueItemId: string;
  readonly sourceIdentity: string;
  readonly transferSessionId: string;
  readonly applicationSessionId: string;
}

interface CapabilityFrame {
  readonly type: 'file-bounded-v1-capability';
  readonly bridgeVersion: 1;
  readonly descriptorVersion: 1;
}

interface DescriptorFrame<Publication extends PublicationIdentity> {
  readonly type: 'file-r2-record-descriptor';
  readonly bridgeVersion: 1;
  readonly legacySessionId: number;
  readonly purpose: DeliveryPurpose;
  readonly scope: Readonly<DeliveryScope>;
  readonly descriptorId: string;
  readonly descriptorVersion: 1;
  readonly publication: Publication;
}

interface ResultFrame {
  readonly type: 'file-r2-record-result';
  readonly bridgeVersion: 1;
  readonly legacySessionId: number;
  readonly scope: Readonly<DeliveryScope>;
  readonly descriptorId: string;
  readonly descriptorVersion: 1;
  readonly outcome: 'ready' | 'fallback';
}

type LegacyCommitReason =
  | 'capability-unavailable'
  | 'capability-timeout'
  | 'descriptor-send-failed'
  | 'descriptor-result-timeout'
  | 'guest-fallback'
  | 'timeout-scheduling-failed';

interface LegacyCommit {
  readonly legacySessionId: number;
  readonly purpose: DeliveryPurpose;
  readonly scope: Readonly<DeliveryScope>;
  readonly descriptorId: string;
  readonly descriptorVersion: 1;
  readonly reason: LegacyCommitReason;
}

interface NegotiationOptions<
  Connection extends object,
  Publication extends PublicationIdentity,
  TimerHandle,
> {
  readonly capabilityTimeoutMs: number;
  readonly descriptorResultTimeoutMs: number;
  readonly scheduleTimeout: (callback: () => void, delayMs: number) => TimerHandle;
  readonly cancelTimeout: (handle: TimerHandle) => void;
  readonly onDescriptor: (
    connection: Connection,
    frame: Readonly<DescriptorFrame<Publication>>,
  ) => boolean | void;
  readonly onLegacyCommit: (connection: Connection, commit: Readonly<LegacyCommit>) => void;
  readonly onCallbackError?: (
    error: unknown,
    operation: 'descriptor' | 'legacy-commit' | 'schedule-timeout' | 'cancel-timeout',
  ) => void;
}

interface DeliveryRecord<Connection extends object, Publication extends PublicationIdentity> {
  readonly connection: Connection;
  readonly scopeKey: string;
  readonly frame: Readonly<DescriptorFrame<Publication>>;
  state: DeliveryState;
  active: boolean;
  fallbackReason: LegacyCommitReason | null;
  timeoutHandle: unknown;
  timeoutHandleOwned: boolean;
  deadlineKind: 'capability' | 'descriptor-result' | null;
  deadlineToken: object | null;
}

interface ConnectionRecord<Connection extends object, Publication extends PublicationIdentity> {
  readonly connection: Connection;
  announced: boolean;
  capability: CapabilityState;
  retired: boolean;
  authorityKey: string | null;
  readonly deliveries: Map<string, DeliveryRecord<Connection, Publication>>;
  readonly activeByPurpose: Map<DeliveryPurpose, DeliveryRecord<Connection, Publication>>;
  readonly bindingScopes: Map<string, string>;
  readonly descriptorScopes: Map<string, string>;
}

const CAPABILITY_KEYS = Object.freeze(['type', 'bridgeVersion', 'descriptorVersion'] as const);
const DESCRIPTOR_KEYS = Object.freeze([
  'type',
  'bridgeVersion',
  'legacySessionId',
  'purpose',
  'scope',
  'descriptorId',
  'descriptorVersion',
  'publication',
] as const);
const RESULT_KEYS = Object.freeze([
  'type',
  'bridgeVersion',
  'legacySessionId',
  'scope',
  'descriptorId',
  'descriptorVersion',
  'outcome',
] as const);
const SCOPE_KEYS = Object.freeze([
  'roomEpoch',
  'bridgeGeneration',
  'bindingId',
  'queueItemId',
  'sourceIdentity',
] as const);
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const QUEUE_ITEM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const CAPABILITY_FRAME = Object.freeze({
  type: 'file-bounded-v1-capability',
  bridgeVersion: 1,
  descriptorVersion: 1,
} as const);

function freezeRecord<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
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

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER_RE.test(value);
}

function hasNoControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
}

function canonicalizeScope(value: unknown): Readonly<DeliveryScope> | null {
  const scope = exactDataRecord(value, SCOPE_KEYS);
  if (
    !scope ||
    !isIdentifier(scope.roomEpoch) ||
    !isIdentifier(scope.bridgeGeneration) ||
    !isIdentifier(scope.bindingId) ||
    typeof scope.queueItemId !== 'string' ||
    !QUEUE_ITEM_ID_RE.test(scope.queueItemId) ||
    typeof scope.sourceIdentity !== 'string' ||
    scope.sourceIdentity.length === 0 ||
    scope.sourceIdentity.length > 512 ||
    !hasNoControlCharacters(scope.sourceIdentity)
  ) {
    return null;
  }
  return freezeRecord({
    roomEpoch: scope.roomEpoch,
    bridgeGeneration: scope.bridgeGeneration,
    bindingId: scope.bindingId,
    queueItemId: scope.queueItemId,
    sourceIdentity: scope.sourceIdentity,
  });
}

function canonicalizeCapability(value: unknown): Readonly<CapabilityFrame> | null {
  const frame = exactDataRecord(value, CAPABILITY_KEYS);
  return frame?.type === CAPABILITY_FRAME.type &&
    frame.bridgeVersion === 1 &&
    frame.descriptorVersion === 1
    ? CAPABILITY_FRAME
    : null;
}

function canonicalizeDescriptor<Publication extends PublicationIdentity>(
  value: unknown,
): Readonly<DescriptorFrame<Publication>> | null {
  const frame = exactDataRecord(value, DESCRIPTOR_KEYS);
  if (
    !frame ||
    frame.type !== 'file-r2-record-descriptor' ||
    frame.bridgeVersion !== 1 ||
    !Number.isSafeInteger(frame.legacySessionId) ||
    (frame.legacySessionId as number) <= 0 ||
    (frame.purpose !== 'current' && frame.purpose !== 'preload') ||
    !isIdentifier(frame.descriptorId) ||
    frame.descriptorVersion !== 1
  ) {
    return null;
  }
  const scope = canonicalizeScope(frame.scope);
  const publication =
    frame.publication !== null && typeof frame.publication === 'object'
      ? (frame.publication as Publication)
      : null;
  if (
    !scope ||
    !publication ||
    publication.queueItemId !== scope.queueItemId ||
    publication.sourceIdentity !== scope.sourceIdentity ||
    publication.transferSessionId !== scope.bindingId ||
    publication.applicationSessionId !== scope.roomEpoch
  ) {
    return null;
  }
  return freezeRecord({
    type: 'file-r2-record-descriptor',
    bridgeVersion: 1,
    legacySessionId: frame.legacySessionId as number,
    purpose: frame.purpose,
    scope,
    descriptorId: frame.descriptorId,
    descriptorVersion: 1,
    publication,
  });
}

function canonicalizeResult(value: unknown): Readonly<ResultFrame> | null {
  const frame = exactDataRecord(value, RESULT_KEYS);
  if (
    !frame ||
    frame.type !== 'file-r2-record-result' ||
    frame.bridgeVersion !== 1 ||
    !Number.isSafeInteger(frame.legacySessionId) ||
    (frame.legacySessionId as number) <= 0 ||
    !isIdentifier(frame.descriptorId) ||
    frame.descriptorVersion !== 1 ||
    (frame.outcome !== 'ready' && frame.outcome !== 'fallback')
  ) {
    return null;
  }
  const scope = canonicalizeScope(frame.scope);
  if (!scope) return null;
  return freezeRecord({
    type: 'file-r2-record-result',
    bridgeVersion: 1,
    legacySessionId: frame.legacySessionId as number,
    scope,
    descriptorId: frame.descriptorId,
    descriptorVersion: 1,
    outcome: frame.outcome,
  });
}

function scopeKey(scope: Readonly<DeliveryScope>): string {
  return JSON.stringify([
    scope.roomEpoch,
    scope.bridgeGeneration,
    scope.bindingId,
    scope.queueItemId,
    scope.sourceIdentity,
  ]);
}

function authorityKey(scope: Readonly<DeliveryScope>): string {
  return JSON.stringify([scope.roomEpoch, scope.bridgeGeneration]);
}

function descriptorKey(frame: Readonly<DescriptorFrame<PublicationIdentity>>): string {
  return `${frame.descriptorVersion}:${frame.descriptorId}`;
}

function sameDescriptor<Publication extends PublicationIdentity>(
  left: Readonly<DescriptorFrame<Publication>>,
  right: Readonly<DescriptorFrame<Publication>>,
): boolean {
  return (
    left.legacySessionId === right.legacySessionId &&
    left.purpose === right.purpose &&
    left.descriptorId === right.descriptorId &&
    left.descriptorVersion === right.descriptorVersion
  );
}

class LegacyBoundedFileV1NegotiationLedger<
  Connection extends object,
  Publication extends PublicationIdentity,
  TimerHandle,
> {
  readonly #options: NegotiationOptions<Connection, Publication, TimerHandle>;
  readonly #connections = new WeakMap<Connection, ConnectionRecord<Connection, Publication>>();

  constructor(options: NegotiationOptions<Connection, Publication, TimerHandle>) {
    if (
      !Number.isSafeInteger(options.capabilityTimeoutMs) ||
      options.capabilityTimeoutMs <= 0 ||
      options.capabilityTimeoutMs > 10_000 ||
      !Number.isSafeInteger(options.descriptorResultTimeoutMs) ||
      options.descriptorResultTimeoutMs <= 0 ||
      options.descriptorResultTimeoutMs > 60_000
    ) {
      throw new Error('Legacy bounded negotiation deadlines are invalid');
    }
    this.#options = options;
  }

  announceCapability(connection: Connection): Readonly<CapabilityFrame> | null {
    const record = this.#connection(connection);
    if (record.retired || record.announced) return null;
    record.announced = true;
    return CAPABILITY_FRAME;
  }

  recordCapability(
    connection: Connection,
    value: unknown,
  ): Readonly<{
    status: 'accepted' | 'duplicate' | 'invalid' | 'legacy-committed' | 'retired';
    descriptorsDispatched: number;
  }> {
    if (!canonicalizeCapability(value)) {
      return freezeRecord({ status: 'invalid', descriptorsDispatched: 0 });
    }
    const connectionRecord = this.#connection(connection);
    if (connectionRecord.retired) {
      return freezeRecord({ status: 'retired', descriptorsDispatched: 0 });
    }
    if (connectionRecord.capability === 'legacy-only') {
      return freezeRecord({ status: 'legacy-committed', descriptorsDispatched: 0 });
    }
    if (connectionRecord.capability === 'capable') {
      return freezeRecord({ status: 'duplicate', descriptorsDispatched: 0 });
    }
    connectionRecord.capability = 'capable';
    let descriptorsDispatched = 0;
    for (const record of connectionRecord.activeByPurpose.values()) {
      if (record.state !== 'pending') continue;
      if (this.#armAndDispatchDescriptor(record)) descriptorsDispatched += 1;
    }
    return freezeRecord({ status: 'accepted', descriptorsDispatched });
  }

  offerDescriptor(
    connection: Connection,
    value: unknown,
  ): Readonly<{
    status:
      | 'pending'
      | 'descriptor-sent'
      | 'ready'
      | 'legacy-committed'
      | 'retired'
      | 'invalid'
      | 'authority-mismatch'
      | 'identity-conflict';
    duplicate: boolean;
  }> {
    const frame = canonicalizeDescriptor<Publication>(value);
    if (!frame) return freezeRecord({ status: 'invalid', duplicate: false });
    const connectionRecord = this.#connection(connection);
    if (connectionRecord.retired) {
      return freezeRecord({ status: 'retired', duplicate: false });
    }
    const nextAuthorityKey = authorityKey(frame.scope);
    if (
      connectionRecord.authorityKey !== null &&
      connectionRecord.authorityKey !== nextAuthorityKey
    ) {
      return freezeRecord({ status: 'authority-mismatch', duplicate: false });
    }

    const nextScopeKey = scopeKey(frame.scope);
    const existing = connectionRecord.deliveries.get(nextScopeKey);
    if (existing) {
      if (!sameDescriptor(existing.frame, frame)) {
        return freezeRecord({ status: 'identity-conflict', duplicate: false });
      }
      return freezeRecord({ status: existing.state, duplicate: true });
    }

    const priorBindingScope = connectionRecord.bindingScopes.get(frame.scope.bindingId);
    const priorDescriptorScope = connectionRecord.descriptorScopes.get(descriptorKey(frame));
    if (
      (priorBindingScope !== undefined && priorBindingScope !== nextScopeKey) ||
      (priorDescriptorScope !== undefined && priorDescriptorScope !== nextScopeKey)
    ) {
      return freezeRecord({ status: 'identity-conflict', duplicate: false });
    }

    connectionRecord.authorityKey = nextAuthorityKey;
    const previous = connectionRecord.activeByPurpose.get(frame.purpose);
    if (previous) this.#retireDelivery(previous);

    const record: DeliveryRecord<Connection, Publication> = {
      connection,
      scopeKey: nextScopeKey,
      frame,
      state: 'pending',
      active: true,
      fallbackReason: null,
      timeoutHandle: undefined,
      timeoutHandleOwned: false,
      deadlineKind: null,
      deadlineToken: null,
    };
    connectionRecord.deliveries.set(nextScopeKey, record);
    connectionRecord.activeByPurpose.set(frame.purpose, record);
    connectionRecord.bindingScopes.set(frame.scope.bindingId, nextScopeKey);
    connectionRecord.descriptorScopes.set(descriptorKey(frame), nextScopeKey);

    if (connectionRecord.capability === 'legacy-only') {
      this.#commitLegacy(record, 'capability-unavailable');
      return freezeRecord({ status: record.state, duplicate: false });
    }

    if (
      connectionRecord.capability === 'unknown' &&
      !this.#scheduleDeadline(record, 'capability')
    ) {
      this.#commitLegacy(record, 'timeout-scheduling-failed');
      return freezeRecord({ status: record.state, duplicate: false });
    }
    if (connectionRecord.capability === 'capable') this.#armAndDispatchDescriptor(record);
    return freezeRecord({ status: record.state, duplicate: false });
  }

  recordResult(
    connection: Connection,
    value: unknown,
  ): Readonly<{
    status: 'ready' | 'legacy-committed' | 'duplicate' | 'stale' | 'invalid' | 'retired';
  }> {
    const frame = canonicalizeResult(value);
    if (!frame) return freezeRecord({ status: 'invalid' });
    const connectionRecord = this.#connections.get(connection);
    if (!connectionRecord) return freezeRecord({ status: 'stale' });
    if (connectionRecord.retired) return freezeRecord({ status: 'retired' });
    const record = connectionRecord.deliveries.get(scopeKey(frame.scope));
    if (
      !record ||
      !record.active ||
      record.frame.legacySessionId !== frame.legacySessionId ||
      record.frame.descriptorId !== frame.descriptorId ||
      record.frame.descriptorVersion !== frame.descriptorVersion
    ) {
      return freezeRecord({ status: 'stale' });
    }
    if (record.state === 'ready') {
      return freezeRecord({
        status: frame.outcome === 'ready' ? 'duplicate' : 'ready',
      });
    }
    if (record.state === 'legacy-committed') {
      return freezeRecord({ status: 'legacy-committed' });
    }
    if (record.state !== 'descriptor-sent') {
      return freezeRecord({ status: record.state === 'retired' ? 'retired' : 'invalid' });
    }
    if (frame.outcome === 'fallback') {
      this.#commitLegacy(record, 'guest-fallback');
      return freezeRecord({ status: 'legacy-committed' });
    }
    record.state = 'ready';
    this.#cancelDeadline(record);
    return freezeRecord({ status: 'ready' });
  }

  commitConnectionToLegacy(connection: Connection): Readonly<{
    status: 'committed' | 'duplicate' | 'capable' | 'retired';
    deliveriesCommitted: number;
  }> {
    const connectionRecord = this.#connection(connection);
    if (connectionRecord.retired) {
      return freezeRecord({ status: 'retired', deliveriesCommitted: 0 });
    }
    if (connectionRecord.capability === 'capable') {
      return freezeRecord({ status: 'capable', deliveriesCommitted: 0 });
    }
    const duplicate = connectionRecord.capability === 'legacy-only';
    connectionRecord.capability = 'legacy-only';
    const deliveriesCommitted = this.#commitActiveDeliveries(
      connectionRecord,
      'capability-unavailable',
    );
    return freezeRecord({
      status: duplicate && deliveriesCommitted === 0 ? 'duplicate' : 'committed',
      deliveriesCommitted,
    });
  }

  retireScope(connection: Connection, value: unknown): boolean {
    const scope = canonicalizeScope(value);
    const connectionRecord = this.#connections.get(connection);
    if (!scope || !connectionRecord || connectionRecord.retired) return false;
    const record = connectionRecord.deliveries.get(scopeKey(scope));
    if (!record) return false;
    this.#retireDelivery(record);
    return true;
  }

  retireConnection(connection: Connection): boolean {
    const connectionRecord = this.#connections.get(connection);
    if (!connectionRecord || connectionRecord.retired) return false;
    connectionRecord.retired = true;
    connectionRecord.capability = 'retired';
    for (const record of connectionRecord.deliveries.values()) {
      this.#retireDelivery(record);
    }
    connectionRecord.activeByPurpose.clear();
    return true;
  }

  snapshot(connection: Connection): Readonly<{
    announced: boolean;
    capability: CapabilityState;
    retired: boolean;
    authority: Readonly<{ roomEpoch: string; bridgeGeneration: string }> | null;
    deliveries: readonly Readonly<{
      legacySessionId: number;
      purpose: DeliveryPurpose;
      scope: Readonly<DeliveryScope>;
      descriptorId: string;
      descriptorVersion: 1;
      state: DeliveryState;
      active: boolean;
      fallbackReason: LegacyCommitReason | null;
    }>[];
  }> | null {
    const connectionRecord = this.#connections.get(connection);
    if (!connectionRecord) return null;
    const first = connectionRecord.deliveries.values().next().value as
      | DeliveryRecord<Connection, Publication>
      | undefined;
    const authority = first
      ? freezeRecord({
          roomEpoch: first.frame.scope.roomEpoch,
          bridgeGeneration: first.frame.scope.bridgeGeneration,
        })
      : null;
    const deliveries = Array.from(connectionRecord.deliveries.values(), (record) =>
      freezeRecord({
        legacySessionId: record.frame.legacySessionId,
        purpose: record.frame.purpose,
        scope: record.frame.scope,
        descriptorId: record.frame.descriptorId,
        descriptorVersion: record.frame.descriptorVersion,
        state: record.state,
        active: record.active,
        fallbackReason: record.fallbackReason,
      }),
    );
    return freezeRecord({
      announced: connectionRecord.announced,
      capability: connectionRecord.capability,
      retired: connectionRecord.retired,
      authority,
      deliveries: Object.freeze(deliveries),
    });
  }

  #connection(connection: Connection): ConnectionRecord<Connection, Publication> {
    const existing = this.#connections.get(connection);
    if (existing) return existing;
    const created: ConnectionRecord<Connection, Publication> = {
      connection,
      announced: false,
      capability: 'unknown',
      retired: false,
      authorityKey: null,
      deliveries: new Map(),
      activeByPurpose: new Map(),
      bindingScopes: new Map(),
      descriptorScopes: new Map(),
    };
    this.#connections.set(connection, created);
    return created;
  }

  #scheduleDeadline(
    record: DeliveryRecord<Connection, Publication>,
    kind: 'capability' | 'descriptor-result',
  ): boolean {
    this.#cancelDeadline(record);
    const token = Object.freeze({});
    record.deadlineKind = kind;
    record.deadlineToken = token;
    try {
      const delayMs =
        kind === 'capability'
          ? this.#options.capabilityTimeoutMs
          : this.#options.descriptorResultTimeoutMs;
      const handle = this.#options.scheduleTimeout(
        () => this.#handleDeadline(record, kind, token),
        delayMs,
      );
      if (record.deadlineToken !== token) {
        this.#cancelTimerHandle(handle);
        return true;
      }
      record.timeoutHandle = handle;
      record.timeoutHandleOwned = true;
      if (
        record.state === 'ready' ||
        record.state === 'legacy-committed' ||
        record.state === 'retired'
      ) {
        this.#cancelDeadline(record);
      }
      return true;
    } catch (error) {
      if (record.deadlineToken === token) {
        record.deadlineKind = null;
        record.deadlineToken = null;
      }
      this.#reportCallbackError(error, 'schedule-timeout');
      return false;
    }
  }

  #handleDeadline(
    record: DeliveryRecord<Connection, Publication>,
    kind: 'capability' | 'descriptor-result',
    token: object,
  ): void {
    if (record.deadlineToken !== token || record.deadlineKind !== kind) return;
    record.timeoutHandleOwned = false;
    record.timeoutHandle = undefined;
    record.deadlineKind = null;
    record.deadlineToken = null;
    if (!record.active || (record.state !== 'pending' && record.state !== 'descriptor-sent')) {
      return;
    }
    const connectionRecord = this.#connections.get(record.connection);
    if (!connectionRecord || connectionRecord.retired) return;
    if (
      kind === 'capability' &&
      record.state === 'pending' &&
      connectionRecord.capability === 'unknown'
    ) {
      connectionRecord.capability = 'legacy-only';
      this.#commitActiveDeliveries(connectionRecord, 'capability-timeout');
      return;
    }
    if (kind === 'descriptor-result' && record.state === 'descriptor-sent') {
      this.#commitLegacy(record, 'descriptor-result-timeout');
    }
  }

  #armAndDispatchDescriptor(record: DeliveryRecord<Connection, Publication>): boolean {
    if (!record.active || record.state !== 'pending') return false;
    record.state = 'descriptor-sent';
    if (!this.#scheduleDeadline(record, 'descriptor-result')) {
      this.#commitLegacy(record, 'timeout-scheduling-failed');
      return false;
    }
    if (!record.active || record.state !== 'descriptor-sent') return false;
    this.#dispatchDescriptor(record);
    return true;
  }

  #dispatchDescriptor(record: DeliveryRecord<Connection, Publication>): void {
    if (!record.active || record.state !== 'descriptor-sent') return;
    let sent = false;
    try {
      sent = this.#options.onDescriptor(record.connection, record.frame) !== false;
    } catch (error) {
      this.#reportCallbackError(error, 'descriptor');
    }
    if (!sent && record.state === 'descriptor-sent') {
      this.#commitLegacy(record, 'descriptor-send-failed');
    }
  }

  #commitActiveDeliveries(
    connectionRecord: ConnectionRecord<Connection, Publication>,
    reason: LegacyCommitReason,
  ): number {
    let committed = 0;
    for (const record of connectionRecord.activeByPurpose.values()) {
      if (this.#commitLegacy(record, reason)) committed += 1;
    }
    return committed;
  }

  #commitLegacy(
    record: DeliveryRecord<Connection, Publication>,
    reason: LegacyCommitReason,
  ): boolean {
    if (
      !record.active ||
      record.state === 'legacy-committed' ||
      record.state === 'ready' ||
      record.state === 'retired'
    ) {
      return false;
    }
    record.state = 'legacy-committed';
    record.fallbackReason = reason;
    this.#cancelDeadline(record);
    const commit = freezeRecord({
      legacySessionId: record.frame.legacySessionId,
      purpose: record.frame.purpose,
      scope: record.frame.scope,
      descriptorId: record.frame.descriptorId,
      descriptorVersion: record.frame.descriptorVersion,
      reason,
    });
    try {
      this.#options.onLegacyCommit(record.connection, commit);
    } catch (error) {
      this.#reportCallbackError(error, 'legacy-commit');
    }
    return true;
  }

  #retireDelivery(record: DeliveryRecord<Connection, Publication>): void {
    if (!record.active) return;
    record.active = false;
    this.#cancelDeadline(record);
    if (record.state !== 'legacy-committed') record.state = 'retired';
    const connectionRecord = this.#connections.get(record.connection);
    if (connectionRecord?.activeByPurpose.get(record.frame.purpose) === record) {
      connectionRecord.activeByPurpose.delete(record.frame.purpose);
    }
  }

  #cancelDeadline(record: DeliveryRecord<Connection, Publication>): void {
    record.deadlineKind = null;
    record.deadlineToken = null;
    if (!record.timeoutHandleOwned) {
      record.timeoutHandle = undefined;
      return;
    }
    const handle = record.timeoutHandle as TimerHandle;
    record.timeoutHandleOwned = false;
    record.timeoutHandle = undefined;
    this.#cancelTimerHandle(handle);
  }

  #cancelTimerHandle(handle: TimerHandle): void {
    try {
      this.#options.cancelTimeout(handle);
    } catch (error) {
      this.#reportCallbackError(error, 'cancel-timeout');
    }
  }

  #reportCallbackError(
    error: unknown,
    operation: 'descriptor' | 'legacy-commit' | 'schedule-timeout' | 'cancel-timeout',
  ): void {
    try {
      this.#options.onCallbackError?.(error, operation);
    } catch {
      // Diagnostics are non-authoritative and may never break fallback state.
    }
  }
}

/**
 * Creates one exact-connection negotiation ledger. Reconnects must use a new
 * connection object; a peer ID is intentionally absent from this API.
 */
export function createLegacyBoundedFileV1NegotiationLedger<
  Connection extends object,
  Publication extends PublicationIdentity,
  TimerHandle,
>(options: NegotiationOptions<Connection, Publication, TimerHandle>) {
  return new LegacyBoundedFileV1NegotiationLedger(options);
}
