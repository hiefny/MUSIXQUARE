import { isFilePlaybackSessionId } from '../network/file-playback-session-handshake.ts';
import {
  FileMediaOfferRegistry,
  type FileMediaCurrentOfferLease,
  type FileMediaSourceOfferV2,
} from './file-media-source-offer.ts';
import {
  parseFilePlaybackRunBindingV2,
  type FilePlaybackRunBindingV2,
} from './file-playback-run-binding.ts';
import {
  createPlaybackStateIdentity,
  isPlaybackRevisionWatermark,
  type PlaybackRevisionWatermark,
  type PlaybackStateIdentity,
} from './playback-identity.ts';

const DEFAULT_MAX_RETIRED_RUNS = 4_096;
const MAX_RETIRED_RUNS = 65_536;
const OPTION_KEYS = Object.freeze([
  'connectionId',
  'liveConnectionToken',
  'maxRetiredRuns',
  'offerRegistry',
  'onFatalConnection',
  'sessionId',
] as const);

declare const runLeaseBrand: unique symbol;

/**
 * Opaque authority for one exact staged or committed run. Runtime
 * authenticity lives only in the issuing authority's private WeakMap.
 */
export interface FilePlaybackRunLease {
  readonly [runLeaseBrand]: never;
}

export interface FilePlaybackRunSnapshot {
  readonly status: 'candidate' | 'current';
  readonly binding: Readonly<FilePlaybackRunBindingV2>;
  /** Canonical transport metadata only. No Blob, File, stream, or decoder is retained here. */
  readonly offer: Readonly<FileMediaSourceOfferV2>;
}

export interface FilePlaybackRunAuthorityOptions {
  readonly liveConnectionToken: object;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly offerRegistry: FileMediaOfferRegistry;
  readonly onFatalConnection: (token: object, error: FilePlaybackRunAuthorityFatalError) => void;
  /** Cumulative binding/prepare/run ABA records retained for this connection. */
  readonly maxRetiredRuns?: number;
}

interface RunRecord {
  readonly lease: FilePlaybackRunLease;
  readonly binding: Readonly<FilePlaybackRunBindingV2>;
  readonly bindingKey: string;
  readonly offer: Readonly<FileMediaSourceOfferV2>;
  offerLease: FileMediaCurrentOfferLease | null;
  status: 'candidate' | 'current' | 'retired';
}

interface ValidatedAdmission {
  readonly binding: Readonly<FilePlaybackRunBindingV2>;
  readonly bindingKey: string;
  readonly offer: Readonly<FileMediaSourceOfferV2>;
  readonly offerLease: FileMediaCurrentOfferLease;
}

type OptionsSnapshot = Readonly<Record<(typeof OPTION_KEYS)[number], unknown>>;

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function snapshotOptions(value: unknown): OptionsSnapshot | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    const requiredKeys = OPTION_KEYS.filter((key) => key !== 'maxRetiredRuns');
    const allowed = new Set<string>(OPTION_KEYS);
    if (
      ownKeys.some((key) => typeof key !== 'string' || !allowed.has(key)) ||
      requiredKeys.some((key) => !ownKeys.includes(key))
    ) {
      return null;
    }
    const snapshot = Object.create(null) as Record<(typeof OPTION_KEYS)[number], unknown>;
    for (const key of OPTION_KEYS) {
      const descriptor = descriptors[key];
      if (key === 'maxRetiredRuns' && !descriptor) {
        snapshot[key] = undefined;
        continue;
      }
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function exactRegistry(value: unknown): value is FileMediaOfferRegistry {
  if (value === null || typeof value !== 'object') return false;
  try {
    if (Reflect.getPrototypeOf(value) !== FileMediaOfferRegistry.prototype) return false;
    // A Proxy or prototype lookalike cannot satisfy the class-private brand.
    FileMediaOfferRegistry.prototype.isClosed.call(value);
    return true;
  } catch {
    return false;
  }
}

function configuredRetiredRunLimit(value: unknown): number {
  const selected = value ?? DEFAULT_MAX_RETIRED_RUNS;
  if (
    typeof selected !== 'number' ||
    !Number.isSafeInteger(selected) ||
    selected <= 0 ||
    selected > MAX_RETIRED_RUNS
  ) {
    throw new RangeError(
      `maxRetiredRuns must be a positive safe integer up to ${MAX_RETIRED_RUNS}`,
    );
  }
  return selected;
}

function readExpectedState(value: unknown): Readonly<PlaybackStateIdentity> | null {
  try {
    return createPlaybackStateIdentity(value as PlaybackStateIdentity);
  } catch {
    return null;
  }
}

function sameState(
  binding: Readonly<FilePlaybackRunBindingV2>,
  expected: Readonly<PlaybackStateIdentity>,
): boolean {
  return (
    binding.queueItemId === expected.queueItemId &&
    binding.runId === expected.runId &&
    binding.playbackRevision === expected.revision
  );
}

function sameOfferCorrelation(
  binding: Readonly<FilePlaybackRunBindingV2>,
  offer: Readonly<FileMediaSourceOfferV2>,
): boolean {
  return (
    binding.sessionId === offer.sessionId &&
    binding.connectionId === offer.connectionId &&
    binding.prepareId === offer.prepareId &&
    binding.prepareRevision === offer.prepareRevision &&
    binding.queueItemId === offer.queueItemId &&
    binding.sourceIdentity === offer.sourceIdentity &&
    binding.transferSessionId === offer.transferSessionId
  );
}

function bindingKey(binding: Readonly<FilePlaybackRunBindingV2>): string {
  return JSON.stringify([
    binding.sessionId,
    binding.connectionId,
    binding.prepareId,
    binding.prepareRevision,
    binding.queueItemId,
    binding.sourceIdentity,
    binding.transferSessionId,
    binding.runId,
    binding.playbackRevision,
  ]);
}

function createRunLease(): FilePlaybackRunLease {
  return Object.freeze(Object.create(null)) as FilePlaybackRunLease;
}

function snapshotRecord(record: RunRecord): Readonly<FilePlaybackRunSnapshot> {
  if (record.status === 'retired') throw new Error('File playback run is retired');
  return freezeCanonical({
    status: record.status,
    binding: record.binding,
    offer: record.offer,
  });
}

export class FilePlaybackRunAuthorityFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilePlaybackRunAuthorityFatalError';
  }
}

/**
 * Exact DataConnection-channel authority joining one current source-offer
 * lease to one canonical playback run.
 *
 * This authority never owns source bytes or a decoder. A candidate retains
 * only the offer registry's opaque lease and canonical metadata. Commit
 * revalidates that lease immediately before the synchronous state swap, then
 * deliberately drops it: the controller has taken asset ownership and the
 * committed run must remain valid if the preparation offer later expires.
 */
export class FilePlaybackRunAuthority {
  readonly #token: object;
  readonly #sessionId: string;
  readonly #connectionId: string;
  readonly #offerRegistry: FileMediaOfferRegistry;
  readonly #onFatalConnection: FilePlaybackRunAuthorityOptions['onFatalConnection'];
  readonly #maxRetiredRuns: number;
  readonly #leases = new WeakMap<FilePlaybackRunLease, RunRecord>();
  readonly #retiredPrepareIds = new Set<string>();
  readonly #retiredRunIds = new Set<string>();
  #current: RunRecord | null = null;
  #candidate: RunRecord | null = null;
  /** Last committed source binding, or the controller-supplied stopped baseline. */
  #revisionWatermark: PlaybackRevisionWatermark = 0;
  #bootstrapped = false;
  #bootstrapKind: 'active' | 'none' | 'stopped' = 'none';
  #hasCommittedRun = false;
  #closed = false;
  #mutating = false;
  #fatalError: FilePlaybackRunAuthorityFatalError | null = null;

  constructor(options: FilePlaybackRunAuthorityOptions) {
    const snapshot = snapshotOptions(options);
    if (!snapshot) throw new TypeError('File playback run authority options are invalid');
    if (snapshot.liveConnectionToken === null || typeof snapshot.liveConnectionToken !== 'object') {
      throw new TypeError('File playback run authority requires an opaque connection token');
    }
    if (
      !isFilePlaybackSessionId(snapshot.sessionId) ||
      !isFilePlaybackSessionId(snapshot.connectionId) ||
      snapshot.sessionId === snapshot.connectionId
    ) {
      throw new TypeError('File playback run authority scope is invalid');
    }
    if (!exactRegistry(snapshot.offerRegistry)) {
      throw new TypeError('File playback run authority requires an exact offer registry');
    }
    if (typeof snapshot.onFatalConnection !== 'function') {
      throw new TypeError('File playback run authority fatal callback is required');
    }

    this.#token = snapshot.liveConnectionToken;
    this.#sessionId = snapshot.sessionId;
    this.#connectionId = snapshot.connectionId;
    this.#offerRegistry = snapshot.offerRegistry;
    this.#onFatalConnection =
      snapshot.onFatalConnection as FilePlaybackRunAuthorityOptions['onFatalConnection'];
    this.#maxRetiredRuns = configuredRetiredRunLimit(snapshot.maxRetiredRuns);
  }

  isClosed(): boolean {
    return this.#closed;
  }

  /** One-shot bootstrap for a stopped baseline, including an arbitrary late-join watermark. */
  bootstrapStopped(token: object, revisionWatermark: PlaybackRevisionWatermark): void {
    this.#mutate(token, () => {
      if (!isPlaybackRevisionWatermark(revisionWatermark)) {
        throw new TypeError('File playback stopped revision watermark is invalid');
      }
      this.#assertBootstrapAvailable();
      this.#revisionWatermark = revisionWatermark;
      this.#bootstrapped = true;
      this.#bootstrapKind = 'stopped';
    });
  }

  /**
   * One-shot active late-join bootstrap. Its arbitrary positive revision is
   * accepted only because the controller explicitly selected this API.
   */
  stageBaselineCurrent(
    token: object,
    value: unknown,
    offerLease: unknown,
    expected: unknown,
  ): FilePlaybackRunLease {
    return this.#mutate(token, () => {
      if (this.#bootstrapKind === 'active' && this.#candidate && !this.#current) {
        this.#retireCandidateIfOfferIsStale();
        const candidate = this.#candidate;
        if (!candidate) throw new Error('File playback active baseline candidate is retired');
        const replay = this.#validateAdmission(value, offerLease, expected);
        if (candidate.bindingKey === replay.bindingKey && candidate.offer === replay.offer) {
          return candidate.lease;
        }
        throw new Error('File playback active baseline conflicts with the staged candidate');
      }
      this.#assertBootstrapAvailable();
      const admission = this.#validateAdmission(value, offerLease, expected);
      this.#assertNoAbaOrActiveConflict(admission);
      const record = this.#createRecord(admission, 'candidate');
      this.#candidate = record;
      this.#bootstrapped = true;
      this.#bootstrapKind = 'active';
      return record.lease;
    });
  }

  /**
   * Stages a binding newer than the last committed binding/stopped baseline.
   * `expected` is a trusted controller projection of the authoritative
   * timeline. This authority intentionally does not duplicate timeline
   * contiguity: intervening pause/seek/resume revisions need no source binding.
   * A byte-for-byte candidate replay returns its same lease.
   */
  stageSuccessor(
    token: object,
    value: unknown,
    offerLease: unknown,
    expected: unknown,
  ): FilePlaybackRunLease {
    return this.#mutate(token, () => {
      if (!this.#bootstrapped) {
        throw new Error('File playback run authority must be bootstrapped before staging');
      }
      this.#retireCandidateIfOfferIsStale();
      if (this.#bootstrapKind === 'active' && !this.#hasCommittedRun) {
        throw new Error(
          'File playback active baseline must be committed before staging a successor',
        );
      }
      const admission = this.#validateAdmission(value, offerLease, expected);
      const existingCandidate = this.#candidate;
      if (existingCandidate) {
        if (
          existingCandidate.bindingKey === admission.bindingKey &&
          existingCandidate.offer === admission.offer
        ) {
          return existingCandidate.lease;
        }
        throw new Error('File playback run candidate conflicts with the staged candidate');
      }
      this.#assertNoAbaOrActiveConflict(admission);
      if (admission.binding.playbackRevision <= this.#revisionWatermark) {
        throw new Error('File playback run revision is not newer than committed authority');
      }
      const record = this.#createRecord(admission, 'candidate');
      this.#candidate = record;
      return record.lease;
    });
  }

  /**
   * Revalidates and atomically promotes only the exact candidate lease.
   * `expectedNow` is canonical controller state; `isStillCurrent` is its
   * minimal live authority and is checked on both sides of the offer-registry
   * callback boundary. No external callback runs after the second check and
   * before the synchronous swap.
   */
  commitCandidate(
    token: object,
    lease: FilePlaybackRunLease,
    expectedNow: unknown,
    isStillCurrent: () => boolean,
  ): Readonly<FilePlaybackRunSnapshot> {
    return this.#mutate(token, () => {
      const candidate = this.#requireRecord(lease);
      if (candidate !== this.#candidate || candidate.status !== 'candidate') {
        throw new Error('Only the exact file playback run candidate can be committed');
      }
      const safeExpected = readExpectedState(expectedNow);
      this.#assertStillOpen();
      if (
        !safeExpected ||
        !sameState(candidate.binding, safeExpected) ||
        typeof isStillCurrent !== 'function'
      ) {
        this.#retireRecord(candidate);
        throw new Error('File playback run candidate is not the controller current state');
      }
      if (!this.#readCommitAuthority(isStillCurrent)) {
        this.#retireRecord(candidate);
        throw new Error('File playback run candidate is no longer the controller current state');
      }
      const currentOffer = this.#resolveOffer(candidate.offerLease);
      this.#assertStillOpen();
      const remainsCurrent = this.#readCommitAuthority(isStillCurrent);
      if (currentOffer !== candidate.offer || !remainsCurrent) {
        this.#retireRecord(candidate);
        throw new Error(
          currentOffer !== candidate.offer
            ? 'File playback run candidate source offer is no longer current'
            : 'File playback run candidate is no longer the controller current state',
        );
      }

      const previous = this.#current;
      if (previous) this.#ensureRetirementCapacity(previous);
      if (previous) this.#retireRecordUnchecked(previous);
      candidate.status = 'current';
      // The controller now owns the asset. Offer expiry must not revoke this run.
      candidate.offerLease = null;
      this.#candidate = null;
      this.#current = candidate;
      this.#revisionWatermark = candidate.binding.playbackRevision;
      this.#hasCommittedRun = true;
      return snapshotRecord(candidate);
    });
  }

  retireCandidate(token: object, lease: FilePlaybackRunLease): void {
    this.#mutate(token, () => {
      const candidate = this.#requireRecord(lease);
      if (candidate !== this.#candidate || candidate.status !== 'candidate') {
        throw new Error('Only the exact file playback run candidate can be retired');
      }
      this.#retireRecord(candidate);
    });
  }

  retireCurrent(token: object, lease: FilePlaybackRunLease): void {
    this.#mutate(token, () => {
      const current = this.#requireRecord(lease);
      if (current !== this.#current || current.status !== 'current') {
        throw new Error('Only the exact current file playback run can be retired');
      }
      this.#retireRecord(current);
    });
  }

  currentSnapshot(token: object): Readonly<FilePlaybackRunSnapshot> | null {
    if (token !== this.#token || this.#closed || !this.#current) return null;
    return snapshotRecord(this.#current);
  }

  candidateSnapshot(token: object): Readonly<FilePlaybackRunSnapshot> | null {
    if (token !== this.#token || this.#closed) return null;
    return this.#mutate(token, () => {
      this.#retireCandidateIfOfferIsStale();
      return this.#candidate ? snapshotRecord(this.#candidate) : null;
    });
  }

  snapshotForLease(
    token: object,
    lease: FilePlaybackRunLease,
  ): Readonly<FilePlaybackRunSnapshot> | null {
    if (token !== this.#token || this.#closed) return null;
    return this.#mutate(token, () => {
      this.#retireCandidateIfOfferIsStale();
      const record =
        lease !== null && typeof lease === 'object' ? this.#leases.get(lease) : undefined;
      return record && record.status !== 'retired' ? snapshotRecord(record) : null;
    });
  }

  /** This is a committed source-binding lower bound, not the full timeline's current revision. */
  revisionWatermark(token: object): PlaybackRevisionWatermark | null {
    return token === this.#token && !this.#closed ? this.#revisionWatermark : null;
  }

  retiredRunCount(token: object): number | null {
    return token === this.#token && !this.#closed ? this.#retiredRunIds.size : null;
  }

  close(token: object): boolean {
    if (token !== this.#token) return false;
    if (this.#closed) return true;
    if (this.#mutating) {
      this.#fatal('File playback run authority close re-entered a mutation');
      return true;
    }
    this.#revokeAll();
    return true;
  }

  #mutate<T>(token: object, operation: () => T): T {
    if (token !== this.#token) throw new Error('File playback run connection token is invalid');
    this.#assertStillOpen();
    if (this.#mutating) {
      throw this.#fatal('File playback run authority mutation was re-entered');
    }
    this.#mutating = true;
    try {
      const result = operation();
      this.#assertStillOpen();
      return result;
    } finally {
      this.#mutating = false;
    }
  }

  #validateAdmission(value: unknown, offerLease: unknown, expected: unknown): ValidatedAdmission {
    const offerBefore = this.#resolveOffer(offerLease);
    this.#assertStillOpen();
    if (!offerBefore) throw new Error('File playback source offer lease is not current');

    const binding = parseFilePlaybackRunBindingV2(value);
    this.#assertStillOpen();
    if (!binding) throw new TypeError('File playback run binding is malformed');
    const safeExpected = readExpectedState(expected);
    this.#assertStillOpen();
    if (!safeExpected) throw new TypeError('Expected file playback state identity is invalid');
    if (binding.sessionId !== this.#sessionId || binding.connectionId !== this.#connectionId) {
      throw new Error('File playback run binding claimed a different connection scope');
    }
    if (!sameOfferCorrelation(binding, offerBefore)) {
      throw new Error('File playback run binding does not match its current source offer');
    }
    if (!sameState(binding, safeExpected)) {
      throw new Error('File playback run binding does not match the expected playback state');
    }

    const offerAfter = this.#resolveOffer(offerLease);
    this.#assertStillOpen();
    if (offerAfter !== offerBefore || !sameOfferCorrelation(binding, offerAfter)) {
      throw new Error('File playback source offer changed during run admission');
    }
    return Object.freeze({
      binding,
      bindingKey: bindingKey(binding),
      offer: offerAfter,
      offerLease: offerLease as FileMediaCurrentOfferLease,
    });
  }

  #resolveOffer(offerLease: unknown): Readonly<FileMediaSourceOfferV2> | null {
    try {
      return FileMediaOfferRegistry.prototype.resolveCurrentOfferLease.call(
        this.#offerRegistry,
        this.#token,
        offerLease,
      );
    } catch {
      return null;
    }
  }

  #readCommitAuthority(isStillCurrent: () => boolean): boolean {
    let current: boolean;
    try {
      current = isStillCurrent() === true;
    } catch {
      current = false;
    }
    this.#assertStillOpen();
    return current;
  }

  #assertNoAbaOrActiveConflict(admission: ValidatedAdmission): void {
    if (
      this.#retiredPrepareIds.has(admission.binding.prepareId) ||
      this.#retiredRunIds.has(admission.binding.runId)
    ) {
      throw new Error('File playback binding, preparation, or run authority is retired');
    }
    for (const active of [this.#current, this.#candidate]) {
      if (!active) continue;
      if (
        active.bindingKey === admission.bindingKey ||
        active.binding.prepareId === admission.binding.prepareId ||
        active.binding.runId === admission.binding.runId
      ) {
        throw new Error('File playback binding, preparation, or run authority is already active');
      }
    }
  }

  #createRecord(admission: ValidatedAdmission, status: 'candidate' | 'current'): RunRecord {
    const lease = createRunLease();
    const record: RunRecord = {
      lease,
      binding: admission.binding,
      bindingKey: admission.bindingKey,
      offer: admission.offer,
      offerLease: admission.offerLease,
      status,
    };
    this.#leases.set(lease, record);
    return record;
  }

  #requireRecord(lease: FilePlaybackRunLease): RunRecord {
    const record =
      lease !== null && typeof lease === 'object' ? this.#leases.get(lease) : undefined;
    if (!record || record.status === 'retired') {
      throw new Error('File playback run lease is forged or retired');
    }
    return record;
  }

  #retireCandidateIfOfferIsStale(): void {
    const candidate = this.#candidate;
    if (!candidate) return;
    const currentOffer = this.#resolveOffer(candidate.offerLease);
    this.#assertStillOpen();
    if (currentOffer !== candidate.offer) this.#retireRecord(candidate);
  }

  #ensureRetirementCapacity(record: RunRecord): void {
    if (this.#retiredRunIds.has(record.binding.runId)) return;
    if (this.#retiredRunIds.size >= this.#maxRetiredRuns) {
      throw this.#fatal('File playback run ABA tombstone capacity is exhausted');
    }
  }

  #retireRecord(record: RunRecord): void {
    if (record.status === 'retired') throw new Error('File playback run is already retired');
    this.#ensureRetirementCapacity(record);
    this.#retireRecordUnchecked(record);
  }

  #retireRecordUnchecked(record: RunRecord): void {
    this.#retiredPrepareIds.add(record.binding.prepareId);
    this.#retiredRunIds.add(record.binding.runId);
    this.#leases.delete(record.lease);
    record.offerLease = null;
    record.status = 'retired';
    if (this.#current === record) this.#current = null;
    if (this.#candidate === record) this.#candidate = null;
  }

  #assertBootstrapAvailable(): void {
    if (
      this.#bootstrapped ||
      this.#current ||
      this.#candidate ||
      this.#revisionWatermark !== 0 ||
      this.#retiredPrepareIds.size !== 0 ||
      this.#retiredRunIds.size !== 0
    ) {
      throw new Error('File playback run authority bootstrap is one-shot');
    }
  }

  #assertStillOpen(): void {
    if (!this.#closed) return;
    throw this.#fatalError ?? new Error('File playback run authority is closed');
  }

  #fatal(message: string): FilePlaybackRunAuthorityFatalError {
    if (this.#fatalError) return this.#fatalError;
    const error = new FilePlaybackRunAuthorityFatalError(message);
    this.#fatalError = error;
    this.#closed = true;
    this.#revokeAll();
    try {
      this.#onFatalConnection(this.#token, error);
    } catch {
      // The exact connection authority is already quarantined.
    }
    return error;
  }

  #revokeAll(): void {
    this.#closed = true;
    for (const record of [this.#current, this.#candidate]) {
      if (!record) continue;
      this.#leases.delete(record.lease);
      record.offerLease = null;
      record.status = 'retired';
    }
    this.#current = null;
    this.#candidate = null;
    this.#retiredPrepareIds.clear();
    this.#retiredRunIds.clear();
  }
}
