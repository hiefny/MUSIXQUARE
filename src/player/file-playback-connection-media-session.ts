import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { FilePlaybackConnectionChannel } from '../network/file-playback-connection-channel.ts';
import type { QueueItemId } from '../types/index.ts';
import {
  FileMediaOfferRegistry,
  type FileMediaOfferAcceptResult,
  type FileMediaSourceOfferV2,
} from './file-media-source-offer.ts';
import {
  FilePlaybackRunAuthority,
  type FilePlaybackRunLease,
} from './file-playback-run-authority.ts';
import {
  parseFilePlaybackRunBindingV2,
  type FilePlaybackRunBindingV2,
} from './file-playback-run-binding.ts';
import type { FilePlaybackWireStateLease } from './file-playback-wire-binding.ts';
import {
  isPlaybackRevisionWatermark,
  readPlaybackStateIdentity,
  type PlaybackRevisionWatermark,
  type PlaybackStateIdentity,
} from './playback-identity.ts';

const OPTION_KEYS = Object.freeze([
  'channel',
  'connectionToken',
  'maxEncodedSize',
  'nowRoomTimeMs',
  'onFatalConnection',
] as const);

declare const mediaOperationBrand: unique symbol;
declare const mediaEpochBrand: unique symbol;
declare const mediaOperationEpochBrand: unique symbol;

export type FilePlaybackConnectionMediaBootstrapKind = 'baseline' | 'successor';

export interface FilePlaybackConnectionMediaSessionOptions {
  readonly channel: FilePlaybackConnectionChannel;
  readonly connectionToken: object;
  readonly maxEncodedSize: number;
  readonly nowRoomTimeMs: () => number;
  readonly onFatalConnection: (
    token: object,
    error: FilePlaybackConnectionMediaSessionFatalError,
  ) => void;
}

/** Opaque identity for one exact APPLIED connection-media lifetime. */
export interface FilePlaybackConnectionMediaEpoch {
  readonly [mediaEpochBrand]: never;
}

/**
 * Await-safe authority captured by renderer/source staging. `isCurrent()` is
 * deliberately side-effect free: a revoked session or changed shared channel
 * simply returns false.
 */
export interface FilePlaybackConnectionMediaFence {
  readonly epoch: FilePlaybackConnectionMediaEpoch;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
}

/** Opaque identity for one exact connection-media preparation lifetime. */
export interface FilePlaybackConnectionMediaOperationEpoch {
  readonly [mediaOperationEpochBrand]: never;
}

/**
 * Await-safe authority for one exact preparation operation. Unlike the
 * connection-wide fence, this aborts when its candidate is superseded,
 * expires, is retired, or is replaced after commit.
 */
export interface FilePlaybackConnectionMediaOperationFence {
  readonly epoch: FilePlaybackConnectionMediaOperationEpoch;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
}

/**
 * One exact, body-free preparation transaction. Runtime authenticity is held
 * by the issuing session's private WeakMap; copying these fields never copies
 * authority.
 */
export interface FilePlaybackConnectionMediaOperation {
  readonly [mediaOperationBrand]: never;
  readonly kind: FilePlaybackConnectionMediaBootstrapKind;
  readonly offer: Readonly<FileMediaSourceOfferV2>;
  readonly binding: Readonly<FilePlaybackRunBindingV2>;
  readonly fence: Readonly<FilePlaybackConnectionMediaOperationFence>;
}

export interface FilePlaybackConnectionMediaOperationSnapshot {
  readonly kind: FilePlaybackConnectionMediaBootstrapKind;
  readonly offer: Readonly<FileMediaSourceOfferV2>;
  readonly binding: Readonly<FilePlaybackRunBindingV2>;
}

export interface FilePlaybackConnectionMediaSessionSnapshot {
  readonly schemaVersion: 1;
  readonly role: 'guest';
  readonly sessionId: string;
  readonly connectionId: string;
  readonly status: 'unbootstrapped' | 'stopped' | 'candidate' | 'active' | 'revoked';
  /** Last stopped baseline or run committed on both composed authorities. */
  readonly committedRevisionWatermark: PlaybackRevisionWatermark;
  /** Includes a staged revision even when its candidate is later retired. */
  readonly admittedRevisionWatermark: PlaybackRevisionWatermark;
  readonly liveQueueItemCount: number;
  readonly activeOfferCount: number;
  readonly candidate: Readonly<FilePlaybackConnectionMediaOperationSnapshot> | null;
  readonly current: Readonly<FilePlaybackConnectionMediaOperationSnapshot> | null;
}

type ExactOptions = Readonly<Record<(typeof OPTION_KEYS)[number], unknown>>;

interface OperationRecord {
  readonly operation: Readonly<FilePlaybackConnectionMediaOperation>;
  readonly runLease: FilePlaybackRunLease;
  readonly channelStateLease: FilePlaybackWireStateLease;
  readonly offer: Readonly<FileMediaSourceOfferV2>;
  readonly binding: Readonly<FilePlaybackRunBindingV2>;
  readonly kind: FilePlaybackConnectionMediaBootstrapKind;
  readonly epoch: FilePlaybackConnectionMediaOperationEpoch;
  readonly abortController: AbortController;
  readonly expiryTimerName: string;
  expiryTimerArmed: boolean;
  status: 'candidate' | 'current' | 'retired';
}

const channelRole = FilePlaybackConnectionChannel.prototype.role;
const channelEstablishedBinding = FilePlaybackConnectionChannel.prototype.establishedBinding;
const channelLiveConnectionToken = FilePlaybackConnectionChannel.prototype.liveConnectionToken;
const channelBootstrapStopped = FilePlaybackConnectionChannel.prototype.bootstrapStopped;
const channelStageMedia = FilePlaybackConnectionChannel.prototype.stageMedia;
const channelCommitMedia = FilePlaybackConnectionChannel.prototype.commitMedia;
const channelRetireMedia = FilePlaybackConnectionChannel.prototype.retireMedia;
const offerRegistryActiveOffer = FileMediaOfferRegistry.prototype.activeOffer;
const abortControllerAbort = AbortController.prototype.abort;
const MAX_EXPIRY_TIMER_DELAY_MS = 2_147_483_647;
const CLAIMED_MEDIA_CHANNELS = new WeakSet<FilePlaybackConnectionChannel>();

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function snapshotOptions(value: unknown): ExactOptions | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    const expected = new Set<string>(OPTION_KEYS);
    if (
      ownKeys.length !== expected.size ||
      ownKeys.some((key) => typeof key !== 'string' || !expected.has(key))
    ) {
      return null;
    }
    const snapshot = Object.create(null) as Record<(typeof OPTION_KEYS)[number], unknown>;
    for (const key of OPTION_KEYS) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function exactGuestChannel(value: unknown): value is FilePlaybackConnectionChannel {
  try {
    return (
      value !== null &&
      typeof value === 'object' &&
      Reflect.getPrototypeOf(value) === FilePlaybackConnectionChannel.prototype &&
      Reflect.apply(channelRole, value, []) === 'guest'
    );
  } catch {
    return false;
  }
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
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

function sameBinding(
  left: Readonly<FilePlaybackRunBindingV2>,
  right: Readonly<FilePlaybackRunBindingV2>,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.connectionId === right.connectionId &&
    left.prepareId === right.prepareId &&
    left.prepareRevision === right.prepareRevision &&
    left.queueItemId === right.queueItemId &&
    left.sourceIdentity === right.sourceIdentity &&
    left.transferSessionId === right.transferSessionId &&
    left.runId === right.runId &&
    left.playbackRevision === right.playbackRevision
  );
}

function operationExpiryTimerName(binding: Readonly<FilePlaybackRunBindingV2>): string {
  return `file-playback-media-expiry:${JSON.stringify([
    binding.sessionId,
    binding.connectionId,
    binding.prepareId,
    binding.runId,
  ])}`;
}

function operationSnapshot(
  record: OperationRecord,
): Readonly<FilePlaybackConnectionMediaOperationSnapshot> {
  return freezeCanonical({
    kind: record.kind,
    offer: record.offer,
    binding: record.binding,
  });
}

export class FilePlaybackConnectionMediaSessionFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilePlaybackConnectionMediaSessionFatalError';
  }
}

/**
 * Guest-side authority joining auxiliary OFFER/RUN_BINDING metadata to the
 * exact APPLIED DataConnection's outbound media-binding lane.
 *
 * This class owns no bytes, decoder, READY claim, or renderer start. An active
 * baseline is represented as a stopped N-1 watermark plus an N candidate so
 * `commitStarted()` can promote the run and channel state in one callback-free
 * critical section. If the second promotion ever fails, the exact connection
 * is fail-closed through the owner callback; this class deliberately does not
 * close the shared channel itself.
 */
export class FilePlaybackConnectionMediaSession {
  readonly #channel: FilePlaybackConnectionChannel;
  readonly #connectionToken: object;
  readonly #sessionId: string;
  readonly #connectionId: string;
  readonly #hostParticipantId: string;
  readonly #guestParticipantId: string;
  readonly #nowRoomTimeMs: () => number;
  readonly #onFatalConnection: FilePlaybackConnectionMediaSessionOptions['onFatalConnection'];
  readonly #offerRegistry: FileMediaOfferRegistry;
  readonly #runAuthority: FilePlaybackRunAuthority;
  readonly #epoch = Object.freeze(Object.create(null)) as FilePlaybackConnectionMediaEpoch;
  readonly #abortController = new AbortController();
  readonly #operations = new WeakMap<FilePlaybackConnectionMediaOperation, OperationRecord>();
  readonly #operationEpochs = new WeakMap<
    FilePlaybackConnectionMediaOperationEpoch,
    OperationRecord
  >();
  #candidate: OperationRecord | null = null;
  #current: OperationRecord | null = null;
  #bootstrapKind: 'active' | 'none' | 'stopped' = 'none';
  #committedRevisionWatermark: PlaybackRevisionWatermark = 0;
  #admittedRevisionWatermark: PlaybackRevisionWatermark = 0;
  #revoked = false;
  #mutating = false;
  #authoritiesClosed = false;
  #fatalError: FilePlaybackConnectionMediaSessionFatalError | null = null;
  #fatalCallbackPending = false;
  #fatalCallbackFlushed = false;
  #fence: Readonly<FilePlaybackConnectionMediaFence> | null = null;
  #readingFenceRoomTime = false;

  constructor(options: FilePlaybackConnectionMediaSessionOptions) {
    const input = snapshotOptions(options);
    if (!input) throw new TypeError('File playback connection media session options are invalid');
    if (!exactGuestChannel(input.channel)) {
      throw new TypeError('An exact APPLIED guest file playback channel is required');
    }
    if (input.connectionToken === null || typeof input.connectionToken !== 'object') {
      throw new TypeError('An opaque file playback connection token is required');
    }
    if (!isPositiveSafeInteger(input.maxEncodedSize)) {
      throw new RangeError('maxEncodedSize must be a positive safe integer');
    }
    if (
      typeof input.nowRoomTimeMs !== 'function' ||
      typeof input.onFatalConnection !== 'function'
    ) {
      throw new TypeError('File playback connection media callbacks are required');
    }

    const channel = input.channel;
    const binding = Reflect.apply(channelEstablishedBinding, channel, []);
    const channelToken = Reflect.apply(channelLiveConnectionToken, channel, []);
    if (!binding || channelToken === null || channelToken !== input.connectionToken) {
      throw new Error('File playback connection media authority is not live');
    }
    if (CLAIMED_MEDIA_CHANNELS.has(channel)) {
      throw new Error('File playback connection media authority was already claimed');
    }
    CLAIMED_MEDIA_CHANNELS.add(channel);

    this.#channel = channel;
    this.#connectionToken = input.connectionToken;
    this.#sessionId = binding.sessionId;
    this.#connectionId = binding.connectionId;
    this.#hostParticipantId = binding.hostParticipantId;
    this.#guestParticipantId = binding.guestParticipantId;
    this.#nowRoomTimeMs = input.nowRoomTimeMs as () => number;
    this.#onFatalConnection =
      input.onFatalConnection as FilePlaybackConnectionMediaSessionOptions['onFatalConnection'];

    const nestedFatal = (token: object, error: Error): void => {
      if (token !== this.#connectionToken) return;
      this.#fatal(`Nested file playback media authority failed: ${error.message}`);
    };
    this.#offerRegistry = new FileMediaOfferRegistry({
      liveConnectionToken: this.#connectionToken,
      sessionId: this.#sessionId,
      connectionId: this.#connectionId,
      maxEncodedSize: input.maxEncodedSize,
      nowRoomTimeMs: () => this.#readRoomTime(),
      onFatalConnection: nestedFatal,
    });
    this.#runAuthority = new FilePlaybackRunAuthority({
      liveConnectionToken: this.#connectionToken,
      sessionId: this.#sessionId,
      connectionId: this.#connectionId,
      offerRegistry: this.#offerRegistry,
      onFatalConnection: nestedFatal,
    });
  }

  /** The exact await-safe session fence; revoke aborts it synchronously. */
  captureFence(): Readonly<FilePlaybackConnectionMediaFence> {
    if (this.#fence) return this.#fence;
    const epoch = this.#epoch;
    this.#fence = freezeCanonical({
      epoch,
      signal: this.#abortController.signal,
      isCurrent: () => this.#isEpochCurrent(epoch),
    });
    return this.#fence;
  }

  bootstrapStopped(
    revision: PlaybackRevisionWatermark,
  ): FilePlaybackConnectionMediaSessionSnapshot {
    return this.#mutate(() => {
      if (!isPlaybackRevisionWatermark(revision)) {
        throw new TypeError('File playback stopped revision watermark is invalid');
      }
      if (
        this.#bootstrapKind === 'stopped' &&
        this.#committedRevisionWatermark === revision &&
        this.#admittedRevisionWatermark === revision
      ) {
        return this.#snapshotUnchecked();
      }
      if (this.#bootstrapKind !== 'none') {
        throw new Error('File playback connection media bootstrap is one-shot');
      }
      this.#runAuthority.bootstrapStopped(this.#connectionToken, revision);
      try {
        Reflect.apply(channelBootstrapStopped, this.#channel, [revision]);
      } catch {
        throw this.#fatal('The shared channel rejected the stopped media bootstrap');
      }
      this.#bootstrapKind = 'stopped';
      this.#committedRevisionWatermark = revision;
      this.#admittedRevisionWatermark = revision;
      return this.#snapshotUnchecked();
    });
  }

  admitQueueItem(queueItemId: QueueItemId): boolean {
    return this.#mutate(() =>
      this.#offerRegistry.admitQueueItem(this.#connectionToken, queueItemId),
    );
  }

  removeQueueItem(queueItemId: QueueItemId): boolean {
    return this.#mutate(() => {
      for (const record of [this.#candidate, this.#current]) {
        if (record?.binding.queueItemId === queueItemId) this.#retireRecord(record);
      }
      return this.#offerRegistry.removeQueueItem(this.#connectionToken, queueItemId);
    });
  }

  adoptSourceOffer(value: unknown): FileMediaOfferAcceptResult {
    return this.#mutate(() => {
      const result = this.#offerRegistry.accept(this.#connectionToken, value);
      if (this.#candidate) this.#cleanupCandidateIfRunRetired(this.#candidate);
      return result;
    });
  }

  stageRunBinding(
    value: unknown,
    expected: PlaybackStateIdentity,
    kind: FilePlaybackConnectionMediaBootstrapKind,
  ): Readonly<FilePlaybackConnectionMediaOperation> {
    return this.#mutate(() => {
      if (kind !== 'baseline' && kind !== 'successor') {
        throw new TypeError('File playback run binding stage kind is invalid');
      }
      const binding = parseFilePlaybackRunBindingV2(value);
      const expectedState = readPlaybackStateIdentity(expected);
      if (!binding) throw new TypeError('File playback run binding is malformed');
      if (!expectedState || !sameState(binding, expectedState)) {
        throw new Error('File playback run binding does not match expected playback state');
      }
      if (binding.sessionId !== this.#sessionId || binding.connectionId !== this.#connectionId) {
        throw new Error('File playback run binding claimed a different connection scope');
      }
      const exactBaselineReplay =
        kind === 'baseline' &&
        this.#bootstrapKind === 'active' &&
        this.#candidate?.kind === 'baseline';
      if (kind === 'baseline' && this.#bootstrapKind !== 'none' && !exactBaselineReplay) {
        throw new Error('Active file playback baseline must be the one-shot bootstrap');
      }
      if (kind === 'successor' && this.#bootstrapKind === 'none') {
        throw new Error('File playback connection media must be bootstrapped before a successor');
      }

      const offerLease = this.#offerRegistry.issueCurrentOfferLease(
        this.#connectionToken,
        binding.queueItemId,
      );
      if (!offerLease) {
        if (this.#candidate) this.#cleanupCandidateIfRunRetired(this.#candidate);
        throw new Error('File playback RUN_BINDING requires a preceding current OFFER');
      }

      let runLease: FilePlaybackRunLease;
      try {
        runLease =
          kind === 'baseline'
            ? this.#runAuthority.stageBaselineCurrent(
                this.#connectionToken,
                binding,
                offerLease,
                expectedState,
              )
            : this.#runAuthority.stageSuccessor(
                this.#connectionToken,
                binding,
                offerLease,
                expectedState,
              );
      } catch (error) {
        if (this.#candidate) this.#cleanupCandidateIfRunRetired(this.#candidate);
        throw error;
      }
      this.#assertLiveChannel();

      const existing = this.#candidate;
      if (existing?.runLease === runLease) {
        if (existing.kind === kind && sameBinding(existing.binding, binding)) {
          return existing.operation;
        }
        throw this.#fatal('Run authority replay disagreed with the connection media candidate');
      }

      const runSnapshot = this.#runAuthority.snapshotForLease(this.#connectionToken, runLease);
      if (
        !runSnapshot ||
        runSnapshot.status !== 'candidate' ||
        !sameBinding(runSnapshot.binding, binding)
      ) {
        this.#suppressRunCandidateRetirement(runLease);
        if (kind === 'baseline') {
          throw this.#fatal('The active baseline run became stale during its bootstrap');
        }
        throw new Error('File playback run candidate became stale during staging');
      }

      if (kind === 'baseline') {
        try {
          Reflect.apply(channelBootstrapStopped, this.#channel, [binding.playbackRevision - 1]);
        } catch {
          this.#suppressRunCandidateRetirement(runLease);
          throw this.#fatal('The shared channel rejected the active media bootstrap');
        }
        this.#bootstrapKind = 'active';
        this.#committedRevisionWatermark = binding.playbackRevision - 1;
        this.#admittedRevisionWatermark = binding.playbackRevision - 1;
      }

      let channelStateLease: FilePlaybackWireStateLease;
      try {
        channelStateLease = Reflect.apply(channelStageMedia, this.#channel, [
          freezeCanonical({
            run: expectedState,
            sourceIdentity: binding.sourceIdentity,
            transferSessionId: binding.transferSessionId,
          }),
        ]);
      } catch (error) {
        this.#suppressRunCandidateRetirement(runLease);
        if (kind === 'baseline') {
          throw this.#fatal('The shared channel could not stage the active media bootstrap');
        }
        throw error;
      }
      this.#admittedRevisionWatermark = binding.playbackRevision;

      const epoch = Object.freeze(Object.create(null)) as FilePlaybackConnectionMediaOperationEpoch;
      const abortController = new AbortController();
      const fence = freezeCanonical({
        epoch,
        signal: abortController.signal,
        isCurrent: () => this.#isOperationEpochCurrent(epoch),
      });
      const operation = freezeCanonical({
        kind,
        offer: runSnapshot.offer,
        binding: runSnapshot.binding,
        fence,
      }) as Readonly<FilePlaybackConnectionMediaOperation>;
      const record: OperationRecord = {
        operation,
        runLease,
        channelStateLease,
        offer: runSnapshot.offer,
        binding: runSnapshot.binding,
        kind,
        epoch,
        abortController,
        expiryTimerName: operationExpiryTimerName(runSnapshot.binding),
        expiryTimerArmed: false,
        status: 'candidate',
      };
      this.#operations.set(operation, record);
      this.#operationEpochs.set(epoch, record);
      this.#candidate = record;
      this.#scheduleCandidateExpiry(record);
      if (record.status !== 'candidate') {
        throw this.#fatalError ?? new Error('File playback source offer expired during staging');
      }
      return operation;
    });
  }

  commitStarted(
    operation: FilePlaybackConnectionMediaOperation,
    expectedNow: PlaybackStateIdentity,
    isStillCurrent: () => boolean,
  ): FilePlaybackConnectionMediaSessionSnapshot {
    return this.#mutate(() => {
      const record = this.#requireCandidate(operation);
      const expected = readPlaybackStateIdentity(expectedNow);
      if (
        !expected ||
        !sameState(record.binding, expected) ||
        typeof isStillCurrent !== 'function'
      ) {
        this.#retireRecord(record);
        throw new Error('File playback started operation is not the expected current state');
      }

      const guardedCurrent = (): boolean => {
        this.#assertOperationCurrent(record);
        let accepted: boolean;
        try {
          accepted = Reflect.apply(isStillCurrent, undefined, []) === true;
        } catch {
          accepted = false;
        }
        this.#assertOperationCurrent(record);
        return accepted;
      };

      try {
        this.#runAuthority.commitCandidate(
          this.#connectionToken,
          record.runLease,
          expected,
          guardedCurrent,
        );
      } catch (error) {
        this.#cleanupFailedCandidate(record);
        if (this.#revoked) throw this.#fatalError ?? error;
        throw error;
      }

      // No callback or await is permitted between these promotions. The run
      // authority has already performed all fallible external revalidation.
      try {
        Reflect.apply(channelCommitMedia, this.#channel, [record.channelStateLease]);
      } catch {
        throw this.#fatal('The shared channel failed after the file playback run was committed');
      }

      const previous = this.#current;
      if (previous) this.#retireRecordLocally(previous);
      this.#clearCandidateExpiry(record);
      record.status = 'current';
      this.#candidate = null;
      this.#current = record;
      this.#committedRevisionWatermark = record.binding.playbackRevision;
      this.#admittedRevisionWatermark = record.binding.playbackRevision;
      return this.#snapshotUnchecked();
    });
  }

  retire(operation: FilePlaybackConnectionMediaOperation): void {
    this.#mutate(() => this.#retireRecord(this.#requireOperation(operation)));
  }

  /** Idempotent local teardown. The shared connection channel remains owner-controlled. */
  revoke(): void {
    if (this.#revoked) return;
    this.#revoked = true;
    this.#abortFence();
    const records = this.#liveRecords();
    for (const record of records) this.#abortOperationFence(record);
    for (const record of records) this.#retireChannelRecordBestEffort(record);
    for (const record of records) this.#retireRecordLocally(record);
    if (!this.#mutating) this.#closeAuthorities();
  }

  snapshot(): FilePlaybackConnectionMediaSessionSnapshot {
    if (this.#revoked) return this.#snapshotUnchecked();
    return this.#mutate(() => this.#snapshotUnchecked());
  }

  /** Test-only observation for deferred owner-effect ordering. */
  authoritiesClosedForTests(): boolean {
    return this.#authoritiesClosed;
  }

  #mutate<T>(operation: () => T): T {
    if (this.#revoked)
      throw this.#fatalError ?? new Error('File playback media session is revoked');
    if (this.#mutating) {
      throw this.#fatal('File playback connection media mutation was re-entered');
    }
    this.#mutating = true;
    try {
      this.#assertLiveChannel();
      const result = operation();
      this.#assertLiveChannel();
      return result;
    } finally {
      this.#mutating = false;
      if (this.#revoked) {
        this.#closeAuthorities();
        this.#flushFatalCallback();
      }
    }
  }

  #assertLiveChannel(): void {
    if (this.#revoked) {
      throw this.#fatalError ?? new Error('File playback media session is revoked');
    }
    try {
      const binding = Reflect.apply(channelEstablishedBinding, this.#channel, []);
      const token = Reflect.apply(channelLiveConnectionToken, this.#channel, []);
      const role = Reflect.apply(channelRole, this.#channel, []);
      if (
        role !== 'guest' ||
        token !== this.#connectionToken ||
        !binding ||
        binding.sessionId !== this.#sessionId ||
        binding.connectionId !== this.#connectionId ||
        binding.hostParticipantId !== this.#hostParticipantId ||
        binding.guestParticipantId !== this.#guestParticipantId
      ) {
        throw new Error('stale channel');
      }
    } catch {
      throw this.#fatal('The exact file playback connection channel is no longer live');
    }
  }

  #readRoomTime(): number {
    this.#assertLiveChannel();
    let value: number;
    try {
      value = Reflect.apply(this.#nowRoomTimeMs, undefined, []);
    } catch {
      throw this.#fatal('The file playback room clock callback failed');
    }
    this.#assertLiveChannel();
    return value;
  }

  #assertOperationCurrent(record: OperationRecord): void {
    this.#assertLiveChannel();
    if (record !== this.#candidate || record.status !== 'candidate') {
      throw new Error('File playback media operation is no longer the exact candidate');
    }
  }

  #requireOperation(value: FilePlaybackConnectionMediaOperation): OperationRecord {
    const record =
      value !== null && typeof value === 'object' ? this.#operations.get(value) : undefined;
    if (!record || record.status === 'retired') {
      throw new Error('File playback media operation is forged or retired');
    }
    return record;
  }

  #requireCandidate(value: FilePlaybackConnectionMediaOperation): OperationRecord {
    const record = this.#requireOperation(value);
    if (record !== this.#candidate || record.status !== 'candidate') {
      throw new Error('Only the exact staged file playback media operation can be committed');
    }
    return record;
  }

  #retireRecord(record: OperationRecord): void {
    const abandonsActiveBaseline = record.status === 'candidate' && record.kind === 'baseline';
    if (record.status === 'candidate') {
      this.#runAuthority.retireCandidate(this.#connectionToken, record.runLease);
    } else if (record.status === 'current') {
      this.#runAuthority.retireCurrent(this.#connectionToken, record.runLease);
    } else {
      throw new Error('File playback media operation is already retired');
    }
    try {
      Reflect.apply(channelRetireMedia, this.#channel, [record.channelStateLease]);
    } catch {
      throw this.#fatal('The shared channel rejected exact media operation retirement');
    }
    this.#retireRecordLocally(record);
    if (abandonsActiveBaseline) {
      throw this.#fatal('An uncommitted active baseline was retired and cannot be recovered');
    }
  }

  #cleanupFailedCandidate(record: OperationRecord): void {
    if (record.status !== 'candidate') return;
    const abandonsActiveBaseline = record.kind === 'baseline';
    const sourceOfferIsCurrent = this.#recordOfferIsCurrent(record);
    try {
      const snapshot = this.#runAuthority.snapshotForLease(this.#connectionToken, record.runLease);
      if (snapshot?.status === 'candidate') {
        this.#runAuthority.retireCandidate(this.#connectionToken, record.runLease);
      }
    } catch {
      // A nested fatal callback already revoked this exact connection scope.
    }
    try {
      Reflect.apply(channelRetireMedia, this.#channel, [record.channelStateLease]);
    } catch {
      if (!this.#revoked) this.#fatal('The shared channel retained a failed media candidate');
    }
    this.#retireRecordLocally(record);
    if (!this.#revoked && (abandonsActiveBaseline || !sourceOfferIsCurrent)) {
      this.#fatal(
        abandonsActiveBaseline
          ? 'An uncommitted active baseline lost its run authority'
          : 'An uncommitted successor lost its source offer authority',
      );
    }
  }

  #cleanupCandidateIfRunRetired(record: OperationRecord): void {
    if (record.status !== 'candidate') return;
    let snapshot = null;
    try {
      snapshot = this.#runAuthority.snapshotForLease(this.#connectionToken, record.runLease);
    } catch {
      // A nested fatal callback will make the outer mutation fail closed.
    }
    if (snapshot?.status === 'candidate') return;
    try {
      Reflect.apply(channelRetireMedia, this.#channel, [record.channelStateLease]);
    } catch {
      if (!this.#revoked) this.#fatal('The shared channel retained a stale media candidate');
    }
    this.#retireRecordLocally(record);
    if (!this.#revoked) {
      throw this.#fatal(
        record.kind === 'baseline'
          ? 'An uncommitted active baseline source offer is no longer current'
          : 'An uncommitted successor source offer is no longer current',
      );
    }
  }

  #recordOfferIsCurrent(record: OperationRecord): boolean {
    if (this.#revoked) return false;
    try {
      return (
        Reflect.apply(offerRegistryActiveOffer, this.#offerRegistry, [
          this.#connectionToken,
          record.binding.queueItemId,
        ]) === record.offer
      );
    } catch {
      return false;
    }
  }

  #suppressRunCandidateRetirement(runLease: FilePlaybackRunLease): void {
    try {
      this.#runAuthority.retireCandidate(this.#connectionToken, runLease);
    } catch {
      // The caller will either reject staging or fail-close an irreversible bootstrap.
    }
  }

  #scheduleCandidateExpiry(record: OperationRecord): void {
    this.#clearCandidateExpiry(record);
    if (this.#revoked || record.status !== 'candidate' || record !== this.#candidate) {
      return;
    }
    const remainingMs = record.offer.expiresAtRoomTimeMs - this.#readRoomTime();
    if (remainingMs <= 0) {
      this.#cleanupCandidateIfRunRetired(record);
      if (record.status === 'candidate' && !this.#revoked) {
        throw this.#fatal('The candidate source offer expiry authority became inconsistent');
      }
      return;
    }
    const delayMs = Math.max(1, Math.ceil(Math.min(remainingMs, MAX_EXPIRY_TIMER_DELAY_MS)));
    record.expiryTimerArmed = true;
    try {
      setManagedTimer(
        record.expiryTimerName,
        () => this.#handleCandidateExpiryTimer(record),
        delayMs,
      );
    } catch {
      record.expiryTimerArmed = false;
      throw this.#fatal('The candidate source offer expiry timer is unavailable');
    }
  }

  #handleCandidateExpiryTimer(record: OperationRecord): void {
    record.expiryTimerArmed = false;
    if (this.#revoked || record.status !== 'candidate' || record !== this.#candidate) return;
    try {
      this.#mutate(() => {
        if (record.status !== 'candidate' || record !== this.#candidate) return;
        this.#scheduleCandidateExpiry(record);
      });
    } catch {
      // Expiry may deliberately fail-close an uncommitted active baseline.
    }
  }

  #clearCandidateExpiry(record: OperationRecord): void {
    if (!record.expiryTimerArmed) return;
    record.expiryTimerArmed = false;
    try {
      clearManagedTimer(record.expiryTimerName);
    } catch {
      // The record fence is still aborted and the timer callback is authority-checked.
    }
  }

  #abortOperationFence(record: OperationRecord): void {
    this.#clearCandidateExpiry(record);
    if (record.abortController.signal.aborted) return;
    try {
      Reflect.apply(abortControllerAbort, record.abortController, []);
    } catch {
      // Record retirement remains authoritative if the platform is broken.
    }
  }

  #liveRecords(): OperationRecord[] {
    const records: OperationRecord[] = [];
    if (this.#candidate) records.push(this.#candidate);
    if (this.#current && this.#current !== this.#candidate) records.push(this.#current);
    return records;
  }

  #retireChannelRecordBestEffort(record: OperationRecord): void {
    try {
      Reflect.apply(channelRetireMedia, this.#channel, [record.channelStateLease]);
    } catch {
      // Revocation/fatal teardown still closes the exact internal authorities.
    }
  }

  #retireRecordLocally(record: OperationRecord | null): void {
    if (!record || record.status === 'retired') return;
    this.#abortOperationFence(record);
    record.status = 'retired';
    this.#operations.delete(record.operation);
    this.#operationEpochs.delete(record.epoch);
    if (this.#candidate === record) this.#candidate = null;
    if (this.#current === record) this.#current = null;
  }

  #fatal(message: string): FilePlaybackConnectionMediaSessionFatalError {
    if (this.#fatalError) return this.#fatalError;
    const error = new FilePlaybackConnectionMediaSessionFatalError(message);
    this.#fatalError = error;
    this.#fatalCallbackPending = true;
    this.#revoked = true;
    this.#abortFence();
    const records = this.#liveRecords();
    for (const record of records) this.#abortOperationFence(record);
    for (const record of records) this.#retireChannelRecordBestEffort(record);
    for (const record of records) this.#retireRecordLocally(record);
    if (!this.#mutating) {
      this.#closeAuthorities();
      this.#flushFatalCallback();
    }
    return error;
  }

  #flushFatalCallback(): void {
    if (!this.#fatalCallbackPending || this.#fatalCallbackFlushed || !this.#fatalError) return;
    this.#fatalCallbackPending = false;
    this.#fatalCallbackFlushed = true;
    try {
      Reflect.apply(this.#onFatalConnection, undefined, [this.#connectionToken, this.#fatalError]);
    } catch {
      // The owner callback cannot revive this exact connection scope.
    }
  }

  #abortFence(): void {
    if (this.#abortController.signal.aborted) return;
    try {
      Reflect.apply(abortControllerAbort, this.#abortController, []);
    } catch {
      // Revocation remains authoritative even if the host platform is broken.
    }
  }

  #closeAuthorities(): void {
    if (this.#authoritiesClosed) return;
    this.#authoritiesClosed = true;
    try {
      this.#runAuthority.close(this.#connectionToken);
    } catch {
      // The session fence is already aborted and no authority can be returned.
    }
    try {
      this.#offerRegistry.close();
    } catch {
      // The session fence is already aborted and no authority can be returned.
    }
  }

  #isEpochCurrent(epoch: FilePlaybackConnectionMediaEpoch): boolean {
    if (
      epoch !== this.#epoch ||
      this.#revoked ||
      this.#abortController.signal.aborted ||
      this.#authoritiesClosed
    ) {
      return false;
    }
    try {
      const binding = Reflect.apply(channelEstablishedBinding, this.#channel, []);
      return (
        Reflect.apply(channelRole, this.#channel, []) === 'guest' &&
        Reflect.apply(channelLiveConnectionToken, this.#channel, []) === this.#connectionToken &&
        binding !== null &&
        binding.sessionId === this.#sessionId &&
        binding.connectionId === this.#connectionId &&
        binding.hostParticipantId === this.#hostParticipantId &&
        binding.guestParticipantId === this.#guestParticipantId
      );
    } catch {
      return false;
    }
  }

  #isOperationEpochCurrent(epoch: FilePlaybackConnectionMediaOperationEpoch): boolean {
    if (this.#revoked || this.#authoritiesClosed || this.#abortController.signal.aborted) {
      return false;
    }
    const record = this.#operationEpochs.get(epoch);
    if (
      !record ||
      record.epoch !== epoch ||
      record.status === 'retired' ||
      record.abortController.signal.aborted ||
      (record !== this.#candidate && record !== this.#current)
    ) {
      return false;
    }
    if (record.status === 'candidate') {
      const nowRoomTimeMs = this.#readFenceRoomTime();
      if (
        nowRoomTimeMs === null ||
        nowRoomTimeMs >= record.offer.expiresAtRoomTimeMs ||
        this.#revoked ||
        record.status !== 'candidate' ||
        record !== this.#candidate ||
        record.abortController.signal.aborted
      ) {
        return false;
      }
    }
    try {
      const binding = Reflect.apply(channelEstablishedBinding, this.#channel, []);
      return (
        Reflect.apply(channelRole, this.#channel, []) === 'guest' &&
        Reflect.apply(channelLiveConnectionToken, this.#channel, []) === this.#connectionToken &&
        binding !== null &&
        binding.sessionId === this.#sessionId &&
        binding.connectionId === this.#connectionId &&
        binding.hostParticipantId === this.#hostParticipantId &&
        binding.guestParticipantId === this.#guestParticipantId
      );
    } catch {
      return false;
    }
  }

  #readFenceRoomTime(): number | null {
    if (this.#readingFenceRoomTime) return null;
    this.#readingFenceRoomTime = true;
    try {
      const value = Reflect.apply(this.#nowRoomTimeMs, undefined, []);
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    } catch {
      return null;
    } finally {
      this.#readingFenceRoomTime = false;
    }
  }

  #snapshotUnchecked(): Readonly<FilePlaybackConnectionMediaSessionSnapshot> {
    const status = this.#revoked
      ? ('revoked' as const)
      : this.#candidate
        ? ('candidate' as const)
        : this.#current
          ? ('active' as const)
          : this.#bootstrapKind === 'none'
            ? ('unbootstrapped' as const)
            : ('stopped' as const);
    return freezeCanonical({
      schemaVersion: 1 as const,
      role: 'guest' as const,
      sessionId: this.#sessionId,
      connectionId: this.#connectionId,
      status,
      committedRevisionWatermark: this.#committedRevisionWatermark,
      admittedRevisionWatermark: this.#admittedRevisionWatermark,
      liveQueueItemCount: this.#revoked ? 0 : this.#offerRegistry.liveQueueItemCount(),
      activeOfferCount: this.#revoked ? 0 : this.#offerRegistry.activeOfferCount(),
      candidate: this.#candidate ? operationSnapshot(this.#candidate) : null,
      current: this.#current ? operationSnapshot(this.#current) : null,
    });
  }
}
