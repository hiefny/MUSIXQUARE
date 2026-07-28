import {
  isPlaybackRevisionWatermark,
  readPlaybackStateIdentity,
  type PlaybackRevisionWatermark,
  type PlaybackStateIdentity,
} from './playback-identity.ts';

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_REMEMBERED_LOGICAL_RUNS = 1_024;
const MAX_REMEMBERED_REVISION_INTERVALS = 4_096;
const MAX_RETIRED_ATTEMPT_BINDINGS = 4_096;
const MEDIA_BINDING_KEYS = Object.freeze(['run', 'sourceIdentity', 'transferSessionId'] as const);
const STATE_REFERENCE_KEYS = Object.freeze([
  'queueItemId',
  'revision',
  'runId',
  'sourceIdentity',
  'transferSessionId',
] as const);

declare const stateLeaseBrand: unique symbol;
declare const attemptLeaseBrand: unique symbol;

/** Opaque exact authority for one staged or committed playback state binding. */
export interface FilePlaybackWireStateLease {
  readonly [stateLeaseBrand]: never;
}

/** Opaque exact authority for one staged or committed rendezvous attempt. */
export interface FilePlaybackWireAttemptLease {
  readonly [attemptLeaseBrand]: never;
}

export type FilePlaybackWireLease = FilePlaybackWireStateLease | FilePlaybackWireAttemptLease;

export interface FilePlaybackWireMediaBinding {
  readonly run: PlaybackStateIdentity;
  readonly sourceIdentity: string;
  readonly transferSessionId: string | null;
}

export interface FilePlaybackWireStateReference extends PlaybackStateIdentity {
  readonly sourceIdentity: string;
  readonly transferSessionId: string | null;
}

export type FilePlaybackWireExpectedStateIdentity = PlaybackStateIdentity;

export type FilePlaybackWireStateResolution =
  | Readonly<{
      status: 'active';
      stateLease: FilePlaybackWireStateLease;
    }>
  | Readonly<{ status: 'stale' | 'unknown' }>;

export type FilePlaybackWireAttemptResolution =
  | Readonly<{
      status: 'active';
      stateLease: FilePlaybackWireStateLease;
      attemptLease: FilePlaybackWireAttemptLease;
    }>
  | Readonly<{ status: 'stale' | 'unknown' }>;

interface StateEntry {
  readonly lease: FilePlaybackWireStateLease;
  readonly binding: Readonly<FilePlaybackWireMediaBinding>;
  readonly key: string;
  readonly identityKey: string;
  status: 'current' | 'candidate' | 'retired';
  purpose: 'media' | 'stop';
  currentAttempt: AttemptEntry | null;
  candidateAttempt: AttemptEntry | null;
}

interface AttemptEntry {
  readonly lease: FilePlaybackWireAttemptLease;
  readonly state: StateEntry;
  readonly rendezvousId: string;
  readonly key: string;
  status: 'current' | 'candidate' | 'retired';
}

interface LogicalRunBinding {
  readonly logicalKey: string;
  readonly bindingKey: string;
}

interface RevisionInterval extends LogicalRunBinding {
  readonly firstRevision: number;
  lastRevision: number;
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

function isBoundedIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value === value.trim() &&
    !containsControlCharacter(value)
  );
}

function snapshotExactDataRecord(
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
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

export function readFilePlaybackWireMediaBinding(
  value: unknown,
): Readonly<FilePlaybackWireMediaBinding> | null {
  const snapshot = snapshotExactDataRecord(value, MEDIA_BINDING_KEYS);
  const run = snapshot ? readPlaybackStateIdentity(snapshot.run) : null;
  if (
    !snapshot ||
    !run ||
    !isBoundedIdentifier(snapshot.sourceIdentity) ||
    (snapshot.transferSessionId !== null && !isBoundedIdentifier(snapshot.transferSessionId))
  ) {
    return null;
  }
  return freezeCanonical({
    run,
    sourceIdentity: snapshot.sourceIdentity,
    transferSessionId: snapshot.transferSessionId as string | null,
  });
}

function readStateReference(value: unknown): Readonly<FilePlaybackWireStateReference> | null {
  const snapshot = snapshotExactDataRecord(value, STATE_REFERENCE_KEYS);
  const identity = snapshot ? readPlaybackStateIdentity(snapshot) : null;
  if (
    !snapshot ||
    !identity ||
    !isBoundedIdentifier(snapshot.sourceIdentity) ||
    (snapshot.transferSessionId !== null && !isBoundedIdentifier(snapshot.transferSessionId))
  ) {
    return null;
  }
  return freezeCanonical({
    ...identity,
    sourceIdentity: snapshot.sourceIdentity,
    transferSessionId: snapshot.transferSessionId as string | null,
  });
}

function createStateLease(): FilePlaybackWireStateLease {
  return Object.freeze(Object.create(null)) as FilePlaybackWireStateLease;
}

function createAttemptLease(): FilePlaybackWireAttemptLease {
  return Object.freeze(Object.create(null)) as FilePlaybackWireAttemptLease;
}

function stateKey(value: FilePlaybackWireStateReference): string {
  return JSON.stringify([
    value.queueItemId,
    value.runId,
    value.revision,
    value.sourceIdentity,
    value.transferSessionId,
  ]);
}

function stateIdentityKey(value: PlaybackStateIdentity): string {
  return JSON.stringify([value.queueItemId, value.runId, value.revision]);
}

function logicalRunKey(value: PlaybackStateIdentity): string {
  return JSON.stringify([value.queueItemId, value.runId]);
}

function runBindingKey(value: FilePlaybackWireStateReference): string {
  return JSON.stringify([
    value.queueItemId,
    value.runId,
    value.sourceIdentity,
    value.transferSessionId,
  ]);
}

function bindingReference(
  binding: Readonly<FilePlaybackWireMediaBinding>,
): Readonly<FilePlaybackWireStateReference> {
  return freezeCanonical({
    ...binding.run,
    sourceIdentity: binding.sourceIdentity,
    transferSessionId: binding.transferSessionId,
  });
}

function sameExpectedState(
  binding: Readonly<FilePlaybackWireMediaBinding>,
  expected: FilePlaybackWireExpectedStateIdentity,
): boolean {
  return (
    binding.run.queueItemId === expected.queueItemId &&
    binding.run.runId === expected.runId &&
    binding.run.revision === expected.revision
  );
}

function attemptKey(stateBindingKey: string, rendezvousId: string): string {
  return `${stateBindingKey}\u0000${rendezvousId}`;
}

/**
 * One connection-local bounded authority registry. It owns at most one current
 * and one candidate state, and each state owns at most one current and one
 * candidate rendezvous attempt. State revisions are a contiguous admitted
 * sequence: cancelling a candidate consumes its revision, so later applied
 * state may skip it. Contiguous admissions for one logical run collapse into a
 * compact revision interval instead of one tombstone per pause/seek. A bounded
 * number of intervals preserves exact holes when admissions alternate between
 * runs. Attempt IDs use exact bounded tombstones because they have no numeric
 * watermark.
 */
export class FilePlaybackWireBindingRegistry {
  readonly #states = new WeakMap<object, StateEntry>();
  readonly #attempts = new WeakMap<object, AttemptEntry>();
  readonly #unpreparedStopCandidates = new WeakSet<object>();
  readonly #runs = new Map<string, LogicalRunBinding>();
  readonly #revisionIntervals: RevisionInterval[] = [];
  readonly #retiredAttempts = new Set<string>();
  #current: StateEntry | null = null;
  #candidate: StateEntry | null = null;
  #revisionWatermark = 0;
  #bootstrapped = false;
  #poisoned = false;

  bootstrapStopped(revisionWatermark: PlaybackRevisionWatermark): void {
    if (!isPlaybackRevisionWatermark(revisionWatermark)) {
      throw new TypeError('File playback stopped revision watermark is invalid');
    }
    this.#assertUsable();
    this.#assertBootstrapAvailable();
    this.#revisionWatermark = revisionWatermark;
    this.#bootstrapped = true;
  }

  bootstrapCurrentMedia(value: FilePlaybackWireMediaBinding): FilePlaybackWireStateLease {
    const binding = readFilePlaybackWireMediaBinding(value);
    if (!binding) throw new TypeError('File playback media binding is invalid');
    this.#assertUsable();
    this.#assertBootstrapAvailable();
    const reference = bindingReference(binding);
    const key = stateKey(reference);
    const identityKey = stateIdentityKey(binding.run);
    const logicalKey = logicalRunKey(binding.run);
    this.#runs.set(logicalKey, {
      logicalKey,
      bindingKey: runBindingKey(reference),
    });
    this.#revisionIntervals.push({
      logicalKey,
      bindingKey: runBindingKey(reference),
      firstRevision: binding.run.revision,
      lastRevision: binding.run.revision,
    });
    this.#revisionWatermark = binding.run.revision;
    this.#bootstrapped = true;
    const lease = createStateLease();
    const entry: StateEntry = {
      lease,
      binding,
      key,
      identityKey,
      status: 'current',
      purpose: 'media',
      currentAttempt: null,
      candidateAttempt: null,
    };
    this.#states.set(lease as object, entry);
    this.#current = entry;
    return lease;
  }

  stageMedia(value: FilePlaybackWireMediaBinding): FilePlaybackWireStateLease {
    const binding = readFilePlaybackWireMediaBinding(value);
    if (!binding) throw new TypeError('File playback media binding is invalid');
    this.#assertUsable();
    if (!this.#bootstrapped) {
      throw new Error('File playback current media must be bootstrapped before staging');
    }
    if (this.#candidate) throw new RangeError('File playback candidate state already exists');
    const key = stateKey(bindingReference(binding));
    const identityKey = stateIdentityKey(binding.run);
    const logicalKey = logicalRunKey(binding.run);
    const bindingKey = runBindingKey(bindingReference(binding));
    const knownRun = this.#runs.get(logicalKey);
    if (this.#current?.identityKey === identityKey) {
      throw new Error('File playback state binding is active or retired');
    }
    if (binding.run.revision !== this.#revisionWatermark + 1) {
      throw new Error('File playback state revision is not the exact next admitted revision');
    }
    if (knownRun && knownRun.bindingKey !== bindingKey) {
      throw new Error('File playback logical run cannot change source binding');
    }
    if (!knownRun && this.#runs.size >= MAX_REMEMBERED_LOGICAL_RUNS) {
      this.#poison();
      throw new Error('File playback logical-run tombstone capacity is exhausted');
    }
    if (!knownRun) {
      this.#runs.set(logicalKey, {
        logicalKey,
        bindingKey,
      });
    }
    this.#admitRevisionInterval(logicalKey, bindingKey, binding.run.revision);
    this.#revisionWatermark = binding.run.revision;
    const lease = createStateLease();
    const entry: StateEntry = {
      lease,
      binding,
      key,
      identityKey,
      status: 'candidate',
      purpose: 'media',
      currentAttempt: null,
      candidateAttempt: null,
    };
    this.#states.set(lease as object, entry);
    this.#candidate = entry;
    return lease;
  }

  /**
   * Stages the one active late-join baseline before renderer readiness.
   *
   * A host may legitimately STOP while that baseline is still waiting for an
   * AudioContext. Marking this exact opaque lease lets the inbound STOP gate
   * promote only that baseline long enough to consume its exact successor;
   * ordinary staged successors remain ineligible.
   */
  stageUnpreparedBaselineMedia(value: FilePlaybackWireMediaBinding): FilePlaybackWireStateLease {
    this.#assertUsable();
    if (this.#current || this.#candidate) {
      throw new Error('Unprepared baseline media requires an empty staged state');
    }
    const lease = this.stageMedia(value);
    this.#unpreparedStopCandidates.add(lease as object);
    return lease;
  }

  commitMedia(lease: FilePlaybackWireStateLease): void {
    const candidate = this.#requireState(lease);
    if (
      candidate !== this.#candidate ||
      candidate.status !== 'candidate' ||
      candidate.purpose !== 'media'
    ) {
      throw new Error('Only the exact candidate state lease can be committed');
    }
    const previous = this.#current;
    if (previous) this.#retireState(previous);
    candidate.status = 'current';
    this.#current = candidate;
    this.#candidate = null;
  }

  commitStop(
    successorLease: FilePlaybackWireStateLease,
    expected: FilePlaybackWireExpectedStateIdentity,
  ): void {
    const candidate = this.#requireState(successorLease);
    const safeExpected = readPlaybackStateIdentity(expected);
    if (
      !safeExpected ||
      candidate !== this.#candidate ||
      candidate.status !== 'candidate' ||
      candidate.purpose !== 'stop' ||
      !this.#current ||
      !this.#successorMatchesCurrent(candidate, safeExpected)
    ) {
      throw new Error('Only the exact stop successor lease can be committed');
    }
    this.#retireStates([this.#current, candidate]);
  }

  retireMedia(lease: FilePlaybackWireStateLease): void {
    this.#retireState(this.#requireState(lease));
  }

  stageAttempt(
    stateLease: FilePlaybackWireStateLease,
    rendezvousId: string,
  ): FilePlaybackWireAttemptLease {
    const state = this.#requireState(stateLease);
    if (!isBoundedIdentifier(rendezvousId)) {
      throw new TypeError('File playback rendezvous ID is invalid');
    }
    if (state.candidateAttempt) {
      throw new RangeError('File playback candidate rendezvous already exists');
    }
    if (state.purpose === 'stop') {
      throw new Error('File playback stop successor cannot own a rendezvous attempt');
    }
    const key = attemptKey(state.key, rendezvousId);
    if (state.currentAttempt?.key === key || this.#retiredAttempts.has(key)) {
      throw new Error('File playback rendezvous binding is active or retired');
    }
    return this.#stageAttemptUnchecked(state, rendezvousId, key);
  }

  commitAttempt(lease: FilePlaybackWireAttemptLease): void {
    const candidate = this.#requireAttempt(lease);
    const state = candidate.state;
    if (candidate !== state.candidateAttempt || candidate.status !== 'candidate') {
      throw new Error('Only the exact candidate rendezvous lease can be committed');
    }
    if (state.currentAttempt) this.#retireAttempt(state.currentAttempt);
    candidate.status = 'current';
    state.currentAttempt = candidate;
    state.candidateAttempt = null;
  }

  retireAttempt(lease: FilePlaybackWireAttemptLease): void {
    this.#retireAttempt(this.#requireAttempt(lease));
  }

  bindingForStateLease(
    lease: FilePlaybackWireStateLease,
    purpose: 'media' | 'stop' | 'either' = 'media',
  ): Readonly<FilePlaybackWireMediaBinding> {
    const state = this.#requireState(lease);
    if (purpose !== 'either' && state.purpose !== purpose) {
      throw new Error(`File playback ${purpose} state authority is invalid`);
    }
    return state.binding;
  }

  authorityForAttemptLease(lease: FilePlaybackWireAttemptLease): Readonly<{
    stateLease: FilePlaybackWireStateLease;
    rendezvousId: string;
  }> {
    const attempt = this.#requireAttempt(lease);
    return freezeCanonical({
      stateLease: attempt.state.lease,
      rendezvousId: attempt.rendezvousId,
    });
  }

  assertCandidateAttemptLease(lease: FilePlaybackWireAttemptLease): void {
    const attempt = this.#requireAttempt(lease);
    if (attempt !== attempt.state.candidateAttempt || attempt.status !== 'candidate') {
      throw new Error('File playback cancel requires the exact candidate rendezvous lease');
    }
  }

  assertSuccessorLease(
    successorLease: FilePlaybackWireStateLease,
    expected: FilePlaybackWireExpectedStateIdentity,
  ): void {
    const successor = this.#requireState(successorLease);
    const safeExpected = readPlaybackStateIdentity(expected);
    if (
      !safeExpected ||
      successor !== this.#candidate ||
      successor.status !== 'candidate' ||
      successor.purpose !== 'media' ||
      !this.#current ||
      !this.#successorMatchesCurrent(successor, safeExpected)
    ) {
      throw new Error('File playback successor state authority is invalid');
    }
  }

  assertStopSuccessorLease(
    successorLease: FilePlaybackWireStateLease,
    expected: FilePlaybackWireExpectedStateIdentity,
  ): void {
    const successor = this.#requireState(successorLease);
    const safeExpected = readPlaybackStateIdentity(expected);
    if (
      !safeExpected ||
      successor !== this.#candidate ||
      successor.status !== 'candidate' ||
      !this.#current ||
      !this.#successorMatchesCurrent(successor, safeExpected) ||
      successor.currentAttempt ||
      successor.candidateAttempt
    ) {
      throw new Error('File playback stop successor state authority is invalid');
    }
  }

  markStopSuccessorLease(
    successorLease: FilePlaybackWireStateLease,
    expected: FilePlaybackWireExpectedStateIdentity,
  ): void {
    this.assertStopSuccessorLease(successorLease, expected);
    this.#requireState(successorLease).purpose = 'stop';
  }

  resolveState(reference: FilePlaybackWireStateReference): FilePlaybackWireStateResolution {
    if (this.#poisoned) return freezeCanonical({ status: 'unknown' as const });
    const key = stateKey(reference);
    const matches = [this.#current, this.#candidate].filter((entry) => entry?.key === key);
    if (matches.length === 1) {
      return matches[0]!.purpose === 'media'
        ? freezeCanonical({ status: 'active' as const, stateLease: matches[0]!.lease })
        : freezeCanonical({ status: 'unknown' as const });
    }
    return freezeCanonical({
      status: this.#isKnownRetiredState(reference) ? ('stale' as const) : ('unknown' as const),
    });
  }

  resolveAttempt(
    reference: FilePlaybackWireStateReference,
    rendezvousId: string,
  ): FilePlaybackWireAttemptResolution {
    if (this.#poisoned || !isBoundedIdentifier(rendezvousId)) {
      return freezeCanonical({ status: 'unknown' as const });
    }
    const stateBindingKey = stateKey(reference);
    const key = attemptKey(stateBindingKey, rendezvousId);
    const state = [this.#current, this.#candidate].find((entry) => entry?.key === stateBindingKey);
    if (state) {
      const matches = [state.currentAttempt, state.candidateAttempt].filter(
        (entry) => entry?.key === key,
      );
      if (matches.length === 1) {
        return freezeCanonical({
          status: 'active' as const,
          stateLease: state.lease,
          attemptLease: matches[0]!.lease,
        });
      }
    }
    return freezeCanonical({
      status: this.#retiredAttempts.has(key) ? ('stale' as const) : ('unknown' as const),
    });
  }

  resolveCandidateAttempt(
    reference: FilePlaybackWireStateReference,
    rendezvousId: string,
  ): FilePlaybackWireAttemptResolution {
    const resolved = this.resolveAttempt(reference, rendezvousId);
    if (resolved.status !== 'active') return resolved;
    const attempt = this.#attempts.get(resolved.attemptLease as object);
    return attempt?.status === 'candidate' && attempt.state.candidateAttempt === attempt
      ? resolved
      : freezeCanonical({ status: 'stale' as const });
  }

  /** Candidate-only resolution for a newly dispatched ARM. */
  resolveArmAttempt(
    reference: FilePlaybackWireStateReference,
    rendezvousId: string,
  ): FilePlaybackWireAttemptResolution {
    const resolved = this.resolveAttempt(reference, rendezvousId);
    if (resolved.status !== 'active') return resolved;
    const attempt = this.#attempts.get(resolved.attemptLease as object);
    return attempt?.status === 'candidate' && attempt.state.candidateAttempt === attempt
      ? resolved
      : freezeCanonical({ status: 'unknown' as const });
  }

  resolveSuccessor(
    reference: FilePlaybackWireStateReference,
    expected: FilePlaybackWireExpectedStateIdentity,
  ): FilePlaybackWireStateResolution {
    const safeExpected = readPlaybackStateIdentity(expected);
    if (!safeExpected) return freezeCanonical({ status: 'unknown' as const });
    const state = this.#resolveStateRaw(reference);
    if (state.status !== 'active') return state;
    const successor = this.#states.get(state.stateLease as object);
    if (!successor || successor.status === 'retired') {
      return freezeCanonical({ status: 'unknown' as const });
    }
    if (
      successor === this.#candidate &&
      successor.purpose === 'media' &&
      this.#current &&
      this.#successorMatchesCurrent(successor, safeExpected)
    ) {
      return state;
    }
    return freezeCanonical({ status: 'unknown' as const });
  }

  resolveStopSuccessor(
    reference: FilePlaybackWireStateReference,
    expected: FilePlaybackWireExpectedStateIdentity,
  ): FilePlaybackWireStateResolution {
    const safeExpected = readPlaybackStateIdentity(expected);
    if (!safeExpected) return freezeCanonical({ status: 'unknown' as const });
    const state = this.#resolveStateRaw(reference);
    if (state.status !== 'active') return state;
    const successor = this.#states.get(state.stateLease as object);
    if (
      successor === this.#candidate &&
      successor.status === 'candidate' &&
      successor.purpose === 'stop' &&
      this.#current &&
      this.#successorMatchesCurrent(successor, safeExpected) &&
      !successor.currentAttempt &&
      !successor.candidateAttempt
    ) {
      return state;
    }
    return freezeCanonical({ status: 'unknown' as const });
  }

  /**
   * Admits a successor learned from a validated remote frame. Connection
   * scope, sequence freshness, and temporal validity must already be proven by
   * the receiver; this boundary atomically consumes only the exact next state.
   */
  admitRemoteSuccessor(
    reference: FilePlaybackWireStateReference,
    expected: FilePlaybackWireExpectedStateIdentity,
    purpose: 'media' | 'stop',
  ): FilePlaybackWireStateLease {
    const safeReference = readStateReference(reference);
    const safeExpected = readPlaybackStateIdentity(expected);
    this.#assertUsable();
    if (!safeReference || !safeExpected || (purpose !== 'media' && purpose !== 'stop')) {
      throw new TypeError('File playback remote successor authority is invalid');
    }
    const candidate = this.#candidate;
    const unpreparedBaseline =
      purpose === 'stop' &&
      this.#current === null &&
      candidate?.status === 'candidate' &&
      candidate.purpose === 'media' &&
      candidate.currentAttempt === null &&
      candidate.candidateAttempt === null &&
      this.#unpreparedStopCandidates.has(candidate.lease as object) &&
      sameExpectedState(candidate.binding, safeExpected)
        ? candidate
        : null;
    const current = this.#current ?? unpreparedBaseline;
    if (
      (this.#candidate && this.#candidate !== unpreparedBaseline) ||
      !current ||
      current.purpose !== 'media' ||
      !sameExpectedState(current.binding, safeExpected) ||
      safeReference.queueItemId !== safeExpected.queueItemId ||
      safeReference.runId !== safeExpected.runId ||
      safeReference.revision !== this.#revisionWatermark + 1 ||
      safeReference.sourceIdentity !== current.binding.sourceIdentity ||
      safeReference.transferSessionId !== current.binding.transferSessionId
    ) {
      throw new Error('File playback remote successor conflicts with current authority');
    }
    if (unpreparedBaseline) {
      unpreparedBaseline.status = 'current';
      this.#current = unpreparedBaseline;
      this.#candidate = null;
    }
    const lease = this.stageMedia({
      run: {
        queueItemId: safeReference.queueItemId,
        runId: safeReference.runId,
        revision: safeReference.revision,
      },
      sourceIdentity: safeReference.sourceIdentity,
      transferSessionId: safeReference.transferSessionId,
    });
    if (purpose === 'stop') this.#requireState(lease).purpose = 'stop';
    return lease;
  }

  /** Atomically stages the exact candidate rendezvous first learned by ARM. */
  admitRemoteAttempt(
    reference: FilePlaybackWireStateReference,
    rendezvousId: string,
  ): Readonly<{
    stateLease: FilePlaybackWireStateLease;
    attemptLease: FilePlaybackWireAttemptLease;
  }> {
    const safeReference = readStateReference(reference);
    this.#assertUsable();
    if (!safeReference || !isBoundedIdentifier(rendezvousId)) {
      throw new TypeError('File playback remote rendezvous authority is invalid');
    }
    const key = stateKey(safeReference);
    const state = [this.#current, this.#candidate].find((entry) => entry?.key === key);
    if (!state || state.purpose !== 'media' || state.candidateAttempt) {
      throw new Error('File playback remote rendezvous conflicts with current authority');
    }
    const attemptLease = this.stageAttempt(state.lease, rendezvousId);
    return freezeCanonical({ stateLease: state.lease, attemptLease });
  }

  /**
   * Atomically admits an exact-next same-run state and the rendezvous attempt
   * that first introduced it. An exact retry may recover only the still-staged
   * pair; partial, conflicting, committed, or retired authority fails closed.
   */
  admitRemoteRendezvousSuccessor(
    reference: FilePlaybackWireStateReference,
    rendezvousId: string,
  ): Readonly<{
    stateLease: FilePlaybackWireStateLease;
    attemptLease: FilePlaybackWireAttemptLease;
  }> {
    const safeReference = readStateReference(reference);
    this.#assertUsable();
    if (!safeReference || !isBoundedIdentifier(rendezvousId)) {
      throw new TypeError('File playback remote rendezvous successor authority is invalid');
    }

    const key = stateKey(safeReference);
    const candidate = this.#candidate;
    if (candidate) {
      const attempt = candidate.candidateAttempt;
      const current = this.#current;
      if (
        current?.status === 'current' &&
        current.purpose === 'media' &&
        candidate.key === key &&
        candidate.status === 'candidate' &&
        candidate.purpose === 'media' &&
        candidate.binding.run.queueItemId === current.binding.run.queueItemId &&
        candidate.binding.run.runId === current.binding.run.runId &&
        candidate.binding.run.revision === this.#revisionWatermark &&
        candidate.binding.sourceIdentity === current.binding.sourceIdentity &&
        candidate.binding.transferSessionId === current.binding.transferSessionId &&
        attempt?.status === 'candidate' &&
        attempt.rendezvousId === rendezvousId
      ) {
        return freezeCanonical({
          stateLease: candidate.lease,
          attemptLease: attempt.lease,
        });
      }
      throw new Error('File playback remote rendezvous successor conflicts with current authority');
    }

    const current = this.#current;
    if (
      !current ||
      current.status !== 'current' ||
      current.purpose !== 'media' ||
      safeReference.queueItemId !== current.binding.run.queueItemId ||
      safeReference.runId !== current.binding.run.runId ||
      safeReference.revision !== this.#revisionWatermark + 1 ||
      safeReference.sourceIdentity !== current.binding.sourceIdentity ||
      safeReference.transferSessionId !== current.binding.transferSessionId
    ) {
      throw new Error('File playback remote rendezvous successor conflicts with current authority');
    }

    const successorAttemptKey = attemptKey(key, rendezvousId);
    if (
      this.#retiredAttempts.has(successorAttemptKey) ||
      current.currentAttempt?.key === successorAttemptKey ||
      current.candidateAttempt?.key === successorAttemptKey
    ) {
      throw new Error('File playback remote rendezvous successor conflicts with current authority');
    }

    const stateLease = this.stageMedia({
      run: {
        queueItemId: safeReference.queueItemId,
        runId: safeReference.runId,
        revision: safeReference.revision,
      },
      sourceIdentity: safeReference.sourceIdentity,
      transferSessionId: safeReference.transferSessionId,
    });
    // Every fallible attempt-authority check is complete before stageMedia()
    // consumes the revision. The fresh exact-next state has no attempt slots,
    // so the remaining construction cannot leave a semantic half-admission.
    const attemptLease = this.#stageAttemptUnchecked(
      this.#candidate!,
      rendezvousId,
      successorAttemptKey,
    );
    return freezeCanonical({ stateLease, attemptLease });
  }

  revokeAll(): void {
    this.#poison();
  }

  isRevoked(): boolean {
    return this.#poisoned;
  }

  #stageAttemptUnchecked(
    state: StateEntry,
    rendezvousId: string,
    key: string,
  ): FilePlaybackWireAttemptLease {
    const lease = createAttemptLease();
    const entry: AttemptEntry = {
      lease,
      state,
      rendezvousId,
      key,
      status: 'candidate',
    };
    this.#attempts.set(lease as object, entry);
    state.candidateAttempt = entry;
    return lease;
  }

  #requireState(lease: FilePlaybackWireStateLease): StateEntry {
    this.#assertUsable();
    const entry =
      lease !== null && typeof lease === 'object' ? this.#states.get(lease as object) : undefined;
    if (!entry || entry.status === 'retired') {
      throw new Error('File playback state lease is forged or retired');
    }
    return entry;
  }

  #requireAttempt(lease: FilePlaybackWireAttemptLease): AttemptEntry {
    this.#assertUsable();
    const entry =
      lease !== null && typeof lease === 'object' ? this.#attempts.get(lease as object) : undefined;
    if (!entry || entry.status === 'retired' || entry.state.status === 'retired') {
      throw new Error('File playback rendezvous lease is forged or retired');
    }
    return entry;
  }

  #retireState(entry: StateEntry): void {
    if (entry.status === 'retired') throw new Error('File playback state lease is retired');
    this.#retireStates([entry]);
  }

  #retireStates(entries: readonly StateEntry[]): void {
    const activeEntries = [...new Set(entries)];
    if (activeEntries.some((entry) => entry.status === 'retired')) {
      throw new Error('File playback state lease is retired');
    }
    const attemptEntries = activeEntries.flatMap((entry) =>
      [entry.currentAttempt, entry.candidateAttempt].filter(
        (value): value is AttemptEntry => value !== null && value.status !== 'retired',
      ),
    );
    const newAttemptKeys = new Set(
      attemptEntries.map((attempt) => attempt.key).filter((key) => !this.#retiredAttempts.has(key)),
    ).size;
    if (this.#retiredAttempts.size + newAttemptKeys > MAX_RETIRED_ATTEMPT_BINDINGS) {
      this.#poison();
      throw new Error('File playback binding tombstone capacity is exhausted');
    }
    for (const entry of activeEntries) this.#retireStateUnchecked(entry);
  }

  #retireStateUnchecked(entry: StateEntry): void {
    for (const attempt of [entry.currentAttempt, entry.candidateAttempt]) {
      if (!attempt || attempt.status === 'retired') continue;
      this.#retiredAttempts.add(attempt.key);
      attempt.status = 'retired';
    }
    entry.currentAttempt = null;
    entry.candidateAttempt = null;
    entry.status = 'retired';
    if (this.#current === entry) this.#current = null;
    if (this.#candidate === entry) this.#candidate = null;
  }

  #retireAttempt(entry: AttemptEntry): void {
    if (entry.status === 'retired') throw new Error('File playback rendezvous lease is retired');
    if (
      !this.#retiredAttempts.has(entry.key) &&
      this.#retiredAttempts.size >= MAX_RETIRED_ATTEMPT_BINDINGS
    ) {
      this.#poison();
      throw new Error('File playback rendezvous tombstone capacity is exhausted');
    }
    this.#retiredAttempts.add(entry.key);
    entry.status = 'retired';
    if (entry.state.currentAttempt === entry) entry.state.currentAttempt = null;
    if (entry.state.candidateAttempt === entry) entry.state.candidateAttempt = null;
  }

  #assertUsable(): void {
    if (this.#poisoned) throw new Error('File playback binding registry is revoked');
  }

  #assertBootstrapAvailable(): void {
    if (
      this.#bootstrapped ||
      this.#current ||
      this.#candidate ||
      this.#runs.size !== 0 ||
      this.#revisionIntervals.length !== 0 ||
      this.#revisionWatermark !== 0
    ) {
      throw new Error('File playback binding bootstrap is one-shot');
    }
  }

  #resolveStateRaw(reference: FilePlaybackWireStateReference): FilePlaybackWireStateResolution {
    if (this.#poisoned) return freezeCanonical({ status: 'unknown' as const });
    const key = stateKey(reference);
    const matches = [this.#current, this.#candidate].filter((entry) => entry?.key === key);
    if (matches.length === 1) {
      return freezeCanonical({ status: 'active' as const, stateLease: matches[0]!.lease });
    }
    return freezeCanonical({
      status: this.#isKnownRetiredState(reference) ? ('stale' as const) : ('unknown' as const),
    });
  }

  #successorMatchesCurrent(
    successor: StateEntry,
    expected: Readonly<PlaybackStateIdentity>,
  ): boolean {
    return (
      !!this.#current &&
      sameExpectedState(this.#current.binding, expected) &&
      successor.binding.run.queueItemId === expected.queueItemId &&
      successor.binding.run.runId === expected.runId &&
      successor.binding.run.revision > expected.revision &&
      successor.binding.sourceIdentity === this.#current.binding.sourceIdentity &&
      successor.binding.transferSessionId === this.#current.binding.transferSessionId
    );
  }

  #isKnownRetiredState(reference: FilePlaybackWireStateReference): boolean {
    let low = 0;
    let high = this.#revisionIntervals.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const interval = this.#revisionIntervals[middle]!;
      if (reference.revision < interval.firstRevision) high = middle - 1;
      else if (reference.revision > interval.lastRevision) low = middle + 1;
      else {
        return (
          interval.logicalKey === logicalRunKey(reference) &&
          interval.bindingKey === runBindingKey(reference)
        );
      }
    }
    return false;
  }

  #admitRevisionInterval(logicalKey: string, bindingKey: string, revision: number): void {
    const latest = this.#revisionIntervals.at(-1);
    if (
      latest?.logicalKey === logicalKey &&
      latest.bindingKey === bindingKey &&
      latest.lastRevision + 1 === revision
    ) {
      latest.lastRevision = revision;
      return;
    }
    if (this.#revisionIntervals.length >= MAX_REMEMBERED_REVISION_INTERVALS) {
      this.#poison();
      throw new Error('File playback revision-interval capacity is exhausted');
    }
    this.#revisionIntervals.push({
      logicalKey,
      bindingKey,
      firstRevision: revision,
      lastRevision: revision,
    });
  }

  #poison(): void {
    if (this.#poisoned) return;
    this.#poisoned = true;
    for (const state of [this.#current, this.#candidate]) {
      if (!state) continue;
      state.status = 'retired';
      if (state.currentAttempt) state.currentAttempt.status = 'retired';
      if (state.candidateAttempt) state.candidateAttempt.status = 'retired';
      state.currentAttempt = null;
      state.candidateAttempt = null;
    }
    this.#current = null;
    this.#candidate = null;
  }
}
