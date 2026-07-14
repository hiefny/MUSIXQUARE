import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { FilePlaybackConnectionChannel } from '../network/file-playback-connection-channel.ts';
import type { QueueItemId } from '../types/index.ts';
import {
  FileMediaOfferRegistry,
  type FileMediaOfferAcceptResult,
  type FileMediaSourceOfferV2,
} from './file-media-source-offer.ts';
import {
  fileMediaSourceRevokeMatchesOfferV2,
  parseFileMediaSourceRevokeV2,
  type FileMediaSourceRevokeV2,
} from './file-media-source-revoke.ts';
import {
  FilePlaybackRunAuthority,
  type FilePlaybackRunLease,
} from './file-playback-run-authority.ts';
import {
  parseFilePlaybackRunBindingV2,
  type FilePlaybackRunBindingV2,
} from './file-playback-run-binding.ts';
import type {
  FilePlaybackWireAttemptLease,
  FilePlaybackWireStateLease,
} from './file-playback-wire-binding.ts';
import type {
  FilePlaybackWireMessageForKind,
  FileSourceNotReadyWirePayload,
  FileSourceReadyWirePayload,
  RendererHealthWirePayload,
  RendezvousArmedWirePayload,
  RendezvousFinalizedWirePayload,
} from './file-playback-wire-sender.ts';
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
declare const mediaOfferPreparationBrand: unique symbol;
declare const mediaOfferPreparationEpochBrand: unique symbol;
declare const mediaOperationEpochBrand: unique symbol;
declare const mediaStatePreparationBrand: unique symbol;
declare const mediaStateOperationBrand: unique symbol;
declare const mediaStateOperationEpochBrand: unique symbol;
declare const mediaPreparedRunAttemptBrand: unique symbol;
declare const mediaPreparedRunAttemptEpochBrand: unique symbol;

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

/** Opaque identity for one exact revision-free source-offer preparation. */
export interface FilePlaybackConnectionMediaOfferPreparationEpoch {
  readonly [mediaOfferPreparationEpochBrand]: never;
}

/**
 * Await-safe authority for one accepted OFFER before a playback run exists.
 * It survives an exact RUN_BINDING claim, then follows that operation's
 * lifetime until handoff no longer needs preparation authority.
 */
export interface FilePlaybackConnectionMediaOfferPreparationFence {
  readonly epoch: FilePlaybackConnectionMediaOfferPreparationEpoch;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
}

/**
 * Body-free capability for one canonical OFFER. Runtime authenticity is held
 * only by the issuing session's private WeakMap.
 */
export interface FilePlaybackConnectionMediaOfferPreparation {
  readonly [mediaOfferPreparationBrand]: never;
  readonly offer: Readonly<FileMediaSourceOfferV2>;
  readonly fence: Readonly<FilePlaybackConnectionMediaOfferPreparationFence>;
}

export type FilePlaybackConnectionMediaOfferAdoptionResult =
  | Readonly<Extract<FileMediaOfferAcceptResult, { readonly accepted: false }>>
  | Readonly<
      Extract<FileMediaOfferAcceptResult, { readonly accepted: true }> & {
        readonly preparation: Readonly<FilePlaybackConnectionMediaOfferPreparation>;
      }
    >;

export type FilePlaybackConnectionMediaOfferRevocationResult =
  | Readonly<{
      accepted: true;
      status: 'retired' | 'stale';
      revoke: Readonly<FileMediaSourceRevokeV2>;
      preparation: Readonly<FilePlaybackConnectionMediaOfferPreparation> | null;
    }>
  | Readonly<{
      accepted: false;
      reason: 'malformed-revoke' | 'wrong-scope' | 'stale-revoke';
    }>;

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

/** Opaque identity for one exact same-run state/rendezvous candidate. */
export interface FilePlaybackConnectionMediaStateOperationEpoch {
  readonly [mediaStateOperationEpochBrand]: never;
}

export interface FilePlaybackConnectionMediaStateOperationFence {
  readonly epoch: FilePlaybackConnectionMediaStateOperationEpoch;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
}

/**
 * Body-free authority for an exact-next same-run state admitted by PREPARE,
 * before any rendezvous attempt exists. The issuing session privately retains
 * the receiver-issued state lease.
 */
export interface FilePlaybackConnectionMediaStatePreparation {
  readonly [mediaStatePreparationBrand]: never;
  readonly previous: Readonly<PlaybackStateIdentity>;
  readonly state: Readonly<PlaybackStateIdentity>;
  readonly fence: Readonly<FilePlaybackConnectionMediaStateOperationFence>;
}

/**
 * Body-free authority for an exact-next same-run state and the rendezvous
 * attempt which will render it. The prepared run/source remains separately
 * owned by `FilePlaybackConnectionMediaOperation`.
 */
export interface FilePlaybackConnectionMediaStateOperation {
  readonly [mediaStateOperationBrand]: never;
  readonly previous: Readonly<PlaybackStateIdentity>;
  readonly state: Readonly<PlaybackStateIdentity>;
  readonly rendezvousId: string;
  readonly fence: Readonly<FilePlaybackConnectionMediaStateOperationFence>;
}

export interface FilePlaybackConnectionMediaStateOperationSnapshot {
  readonly previous: Readonly<PlaybackStateIdentity>;
  readonly state: Readonly<PlaybackStateIdentity>;
  /** Null only while PREPARE owns the successor before ARM attaches an attempt. */
  readonly rendezvousId: string | null;
}

/** Opaque identity for one receiver-admitted attempt on a prepared new run. */
export interface FilePlaybackConnectionMediaPreparedRunAttemptEpoch {
  readonly [mediaPreparedRunAttemptEpochBrand]: never;
}

export interface FilePlaybackConnectionMediaPreparedRunAttemptFence {
  readonly epoch: FilePlaybackConnectionMediaPreparedRunAttemptEpoch;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
}

/**
 * Body-free authority joining one exact prepared run candidate to the exact
 * state/attempt lease pair admitted by an inbound rendezvous ARM. The source
 * offer and both opaque channel leases remain private to the issuing session.
 */
export interface FilePlaybackConnectionMediaPreparedRunAttempt {
  readonly [mediaPreparedRunAttemptBrand]: never;
  readonly state: Readonly<PlaybackStateIdentity>;
  readonly rendezvousId: string;
  readonly fence: Readonly<FilePlaybackConnectionMediaPreparedRunAttemptFence>;
}

type FilePlaybackConnectionMediaStateAttemptWirePayload =
  | RendezvousArmedWirePayload
  | RendezvousFinalizedWirePayload
  | RendererHealthWirePayload;

type FilePlaybackConnectionMediaStatePreparationWirePayload =
  | FileSourceReadyWirePayload
  | FileSourceNotReadyWirePayload;

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
  readonly candidateState: Readonly<FilePlaybackConnectionMediaStateOperationSnapshot> | null;
  readonly currentState: Readonly<PlaybackStateIdentity> | null;
}

type ExactOptions = Readonly<Record<(typeof OPTION_KEYS)[number], unknown>>;

interface OperationRecord {
  readonly operation: Readonly<FilePlaybackConnectionMediaOperation>;
  readonly runLease: FilePlaybackRunLease;
  channelStateLease: FilePlaybackWireStateLease;
  readonly offer: Readonly<FileMediaSourceOfferV2>;
  readonly binding: Readonly<FilePlaybackRunBindingV2>;
  readonly kind: FilePlaybackConnectionMediaBootstrapKind;
  readonly epoch: FilePlaybackConnectionMediaOperationEpoch;
  readonly abortController: AbortController;
  readonly sourcePreparation: OfferPreparationRecord | null;
  readonly expiryTimerName: string;
  expiryTimerArmed: boolean;
  status: 'candidate' | 'current' | 'retired';
}

interface ExactOperationAuthorityRecord {
  readonly operation: Readonly<FilePlaybackConnectionMediaOperation>;
  readonly epoch: FilePlaybackConnectionMediaOperationEpoch;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  checkingCurrent: boolean;
}

interface OfferPreparationRecord {
  readonly preparation: Readonly<FilePlaybackConnectionMediaOfferPreparation>;
  readonly offer: Readonly<FileMediaSourceOfferV2>;
  readonly epoch: FilePlaybackConnectionMediaOfferPreparationEpoch;
  readonly abortController: AbortController;
  readonly expiryTimerName: string;
  operation: OperationRecord | null;
  expiryTimerArmed: boolean;
  status: 'offered' | 'claimed' | 'consumed' | 'retired';
}

interface StateOperationRecord {
  readonly preparation: Readonly<FilePlaybackConnectionMediaStatePreparation>;
  operation: Readonly<FilePlaybackConnectionMediaStateOperation> | null;
  readonly prepared: OperationRecord;
  readonly stateLease: FilePlaybackWireStateLease;
  attemptLease: FilePlaybackWireAttemptLease | null;
  readonly previous: Readonly<PlaybackStateIdentity>;
  readonly state: Readonly<PlaybackStateIdentity>;
  rendezvousId: string | null;
  readonly epoch: FilePlaybackConnectionMediaStateOperationEpoch;
  readonly abortController: AbortController;
  status: 'candidate' | 'current' | 'retired';
}

interface PreparedRunAttemptRecord {
  readonly attempt: Readonly<FilePlaybackConnectionMediaPreparedRunAttempt>;
  readonly prepared: OperationRecord;
  readonly stateLease: FilePlaybackWireStateLease;
  readonly attemptLease: FilePlaybackWireAttemptLease;
  readonly state: Readonly<PlaybackStateIdentity>;
  readonly rendezvousId: string;
  readonly epoch: FilePlaybackConnectionMediaPreparedRunAttemptEpoch;
  readonly abortController: AbortController;
  status: 'candidate' | 'current' | 'retired';
}

interface CommittedStopTombstone {
  readonly expected: Readonly<PlaybackStateIdentity>;
  readonly stopped: Readonly<PlaybackStateIdentity>;
  /** Exact inbound STOP lease, or null for a locally staged stop. */
  readonly admittedStopLease: FilePlaybackWireStateLease | null;
}

const channelRole = FilePlaybackConnectionChannel.prototype.role;
const channelEstablishedBinding = FilePlaybackConnectionChannel.prototype.establishedBinding;
const channelLiveConnectionToken = FilePlaybackConnectionChannel.prototype.liveConnectionToken;
const channelBootstrapStopped = FilePlaybackConnectionChannel.prototype.bootstrapStopped;
const channelStageMedia = FilePlaybackConnectionChannel.prototype.stageMedia;
const channelCommitMedia = FilePlaybackConnectionChannel.prototype.commitMedia;
const channelCommitStop = FilePlaybackConnectionChannel.prototype.commitStop;
const channelRetireMedia = FilePlaybackConnectionChannel.prototype.retireMedia;
const channelStageAttempt = FilePlaybackConnectionChannel.prototype.stageAttempt;
const channelCommitAttempt = FilePlaybackConnectionChannel.prototype.commitAttempt;
const channelRetireAttempt = FilePlaybackConnectionChannel.prototype.retireAttempt;
const channelCreateWire = FilePlaybackConnectionChannel.prototype.createWire;
const offerRegistryActiveOffer = FileMediaOfferRegistry.prototype.activeOffer;
const offerRegistryRetireActiveOffer = FileMediaOfferRegistry.prototype.retireActiveOffer;
const offerRegistryPrepareRevisionWatermark =
  FileMediaOfferRegistry.prototype.prepareRevisionWatermark;
const abortControllerAbort = AbortController.prototype.abort;
const MAX_EXPIRY_TIMER_DELAY_MS = 2_147_483_647;
const MAX_RENDEZVOUS_ID_LENGTH = 256;
const CLAIMED_MEDIA_CHANNELS = new WeakSet<FilePlaybackConnectionChannel>();
const EXACT_OPERATION_AUTHORITIES = new WeakMap<object, ExactOperationAuthorityRecord>();

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function throwIfOperationAuthorityAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  throw new DOMException('The file playback media operation was aborted', 'AbortError');
}

/**
 * Verifies exact module-issued operation identity and its live session-owned
 * fence. Structural copies and caller-provided `isCurrent` callbacks carry no
 * authority.
 */
export function assertFilePlaybackConnectionMediaOperationCurrent(
  value: unknown,
): asserts value is Readonly<FilePlaybackConnectionMediaOperation> {
  const record =
    value !== null && typeof value === 'object'
      ? EXACT_OPERATION_AUTHORITIES.get(value)
      : undefined;
  if (!record || record.operation !== value) {
    throw new Error('File playback media operation is forged or retired');
  }
  throwIfOperationAuthorityAborted(record.signal);
  if (record.checkingCurrent) {
    throw new Error('File playback media operation currentness was re-entered');
  }
  record.checkingCurrent = true;
  let current: boolean;
  try {
    try {
      current = Reflect.apply(record.isCurrent, undefined, []) === true;
    } catch {
      throwIfOperationAuthorityAborted(record.signal);
      current = false;
    }
  } finally {
    record.checkingCurrent = false;
  }
  throwIfOperationAuthorityAborted(record.signal);
  if (!current || EXACT_OPERATION_AUTHORITIES.get(record.operation as object) !== record) {
    throw new Error('File playback media operation is stale');
  }
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

function sameStateIdentity(
  left: Readonly<PlaybackStateIdentity>,
  right: Readonly<PlaybackStateIdentity>,
): boolean {
  return (
    left.queueItemId === right.queueItemId &&
    left.runId === right.runId &&
    left.revision === right.revision
  );
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function isBoundedRendezvousId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_RENDEZVOUS_ID_LENGTH &&
    value === value.trim() &&
    !containsControlCharacter(value)
  );
}

function snapshotStateAttemptPayloadIdentity(value: unknown): Readonly<{
  kind: FilePlaybackConnectionMediaStateAttemptWirePayload['kind'];
  rendezvousId: string;
}> | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const kindDescriptor = descriptors.kind;
    const rendezvousDescriptor = descriptors.rendezvousId;
    if (
      !kindDescriptor?.enumerable ||
      !Object.hasOwn(kindDescriptor, 'value') ||
      !rendezvousDescriptor?.enumerable ||
      !Object.hasOwn(rendezvousDescriptor, 'value') ||
      (kindDescriptor.value !== 'rendezvous-armed' &&
        kindDescriptor.value !== 'rendezvous-finalized' &&
        kindDescriptor.value !== 'renderer-health') ||
      !isBoundedRendezvousId(rendezvousDescriptor.value)
    ) {
      return null;
    }
    return freezeCanonical({
      kind: kindDescriptor.value as FilePlaybackConnectionMediaStateAttemptWirePayload['kind'],
      rendezvousId: rendezvousDescriptor.value,
    });
  } catch {
    return null;
  }
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

function offerPreparationExpiryTimerName(offer: Readonly<FileMediaSourceOfferV2>): string {
  return `file-playback-offer-preparation-expiry:${JSON.stringify([
    offer.sessionId,
    offer.connectionId,
    offer.prepareId,
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

function stateOperationSnapshot(
  record: StateOperationRecord,
): Readonly<FilePlaybackConnectionMediaStateOperationSnapshot> {
  return freezeCanonical({
    previous: record.previous,
    state: record.state,
    rendezvousId: record.rendezvousId,
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
 * `commitStarted()` can promote the prepared run/source and initial channel
 * state in one callback-free critical section. Later same-run revisions own
 * separate state/attempt leases and never restage the OFFER or RUN_BINDING. If
 * a split promotion ever fails, the exact connection is fail-closed through
 * the owner callback; this class deliberately does not close the shared
 * channel itself.
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
  readonly #offerPreparations = new WeakMap<
    FilePlaybackConnectionMediaOfferPreparation,
    OfferPreparationRecord
  >();
  readonly #offerPreparationEpochs = new WeakMap<
    FilePlaybackConnectionMediaOfferPreparationEpoch,
    OfferPreparationRecord
  >();
  readonly #offerPreparationsByQueue = new Map<QueueItemId, OfferPreparationRecord>();
  readonly #operationEpochs = new WeakMap<
    FilePlaybackConnectionMediaOperationEpoch,
    OperationRecord
  >();
  readonly #stateOperations = new WeakMap<
    FilePlaybackConnectionMediaStateOperation,
    StateOperationRecord
  >();
  readonly #statePreparations = new WeakMap<
    FilePlaybackConnectionMediaStatePreparation,
    StateOperationRecord
  >();
  readonly #stateOperationEpochs = new WeakMap<
    FilePlaybackConnectionMediaStateOperationEpoch,
    StateOperationRecord
  >();
  readonly #preparedRunAttempts = new WeakMap<
    FilePlaybackConnectionMediaPreparedRunAttempt,
    PreparedRunAttemptRecord
  >();
  readonly #preparedRunAttemptEpochs = new WeakMap<
    FilePlaybackConnectionMediaPreparedRunAttemptEpoch,
    PreparedRunAttemptRecord
  >();
  readonly #retiredOperations = new WeakSet<FilePlaybackConnectionMediaOperation>();
  readonly #retiredStatePreparations =
    new WeakSet<FilePlaybackConnectionMediaStatePreparation>();
  readonly #retiredStateOperations = new WeakSet<FilePlaybackConnectionMediaStateOperation>();
  readonly #retiredPreparedRunAttempts =
    new WeakSet<FilePlaybackConnectionMediaPreparedRunAttempt>();
  readonly #retiredPreparedRunAttemptLeases = new WeakSet<object>();
  /** Weak keys preserve exact retry without retaining offer/fence/source snapshots. */
  readonly #committedStops = new WeakMap<
    FilePlaybackConnectionMediaOperation,
    Readonly<CommittedStopTombstone>
  >();
  #candidate: OperationRecord | null = null;
  #current: OperationRecord | null = null;
  #candidateState: StateOperationRecord | null = null;
  #currentStateOperation: StateOperationRecord | null = null;
  #candidatePreparedRunAttempt: PreparedRunAttemptRecord | null = null;
  #currentPreparedRunAttempt: PreparedRunAttemptRecord | null = null;
  #currentState: Readonly<PlaybackStateIdentity> | null = null;
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
      const preparation = this.#offerPreparationsByQueue.get(queueItemId);
      if (preparation) this.#retireOfferPreparationLocally(preparation);
      for (const record of [this.#candidate, this.#current]) {
        if (record?.binding.queueItemId === queueItemId) this.#retireRecord(record);
      }
      return this.#offerRegistry.removeQueueItem(this.#connectionToken, queueItemId);
    });
  }

  adoptSourceOffer(value: unknown): FilePlaybackConnectionMediaOfferAdoptionResult {
    return this.#mutate(() => {
      const result = this.#offerRegistry.accept(this.#connectionToken, value);
      if (result.accepted) {
        const previous = this.#offerPreparationsByQueue.get(result.offer.queueItemId);
        if (previous && previous.offer !== result.offer) {
          this.#retireOfferPreparationLocally(previous);
        }
      }
      if (this.#candidate) this.#cleanupCandidateIfRunRetired(this.#candidate);
      if (!result.accepted) return result;
      const preparation = this.#offerPreparationFor(result.offer);
      return freezeCanonical({ ...result, preparation });
    });
  }

  revokeSourceOffer(value: unknown): FilePlaybackConnectionMediaOfferRevocationResult {
    return this.#mutate(() => {
      const revoke = parseFileMediaSourceRevokeV2(value);
      if (!revoke) {
        return freezeCanonical({ accepted: false as const, reason: 'malformed-revoke' as const });
      }
      if (revoke.sessionId !== this.#sessionId || revoke.connectionId !== this.#connectionId) {
        return freezeCanonical({ accepted: false as const, reason: 'wrong-scope' as const });
      }
      const records = [...this.#offerPreparationsByQueue.values()];
      const record = records.find((candidate) =>
        fileMediaSourceRevokeMatchesOfferV2(revoke, candidate.offer),
      );
      if (record) {
        if (record.status !== 'offered' || record.operation !== null) {
          throw this.#fatal('A source offer revoke arrived after its RUN was claimed');
        }
        const retired = Reflect.apply(offerRegistryRetireActiveOffer, this.#offerRegistry, [
          this.#connectionToken,
          record.offer,
        ]) as boolean;
        if (!retired) {
          throw this.#fatal('The exact source offer could not be retired');
        }
        const preparation = record.preparation;
        this.#retireOfferPreparationLocally(record);
        return freezeCanonical({
          accepted: true as const,
          status: 'retired' as const,
          revoke,
          preparation,
        });
      }
      const conflictingIdentity = records.find(
        (candidate) =>
          candidate.offer.prepareId === revoke.prepareId ||
          candidate.offer.prepareRevision === revoke.prepareRevision,
      );
      if (conflictingIdentity) {
        return freezeCanonical({ accepted: false as const, reason: 'stale-revoke' as const });
      }
      const conflictingQueue = this.#offerPreparationsByQueue.get(revoke.queueItemId);
      if (conflictingQueue && revoke.prepareRevision >= conflictingQueue.offer.prepareRevision) {
        return freezeCanonical({ accepted: false as const, reason: 'stale-revoke' as const });
      }
      const watermark = Reflect.apply(
        offerRegistryPrepareRevisionWatermark,
        this.#offerRegistry,
        [],
      ) as number;
      if (revoke.prepareRevision <= watermark) {
        return freezeCanonical({
          accepted: true as const,
          status: 'stale' as const,
          revoke,
          preparation: null,
        });
      }
      return freezeCanonical({ accepted: false as const, reason: 'stale-revoke' as const });
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
      const offeredPreparation = this.#offerPreparationsByQueue.get(binding.queueItemId);
      const sourcePreparation =
        offeredPreparation?.status === 'offered' && offeredPreparation.offer === runSnapshot.offer
          ? offeredPreparation
          : null;
      const isCurrent = () => this.#isOperationEpochCurrent(epoch);
      const fence = freezeCanonical({
        epoch,
        signal: abortController.signal,
        isCurrent,
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
        sourcePreparation,
        expiryTimerName: operationExpiryTimerName(runSnapshot.binding),
        expiryTimerArmed: false,
        status: 'candidate',
      };
      this.#operations.set(operation, record);
      this.#operationEpochs.set(epoch, record);
      if (sourcePreparation) {
        this.#clearOfferPreparationExpiry(sourcePreparation);
        sourcePreparation.status = 'claimed';
        sourcePreparation.operation = record;
      }
      this.#candidate = record;
      this.#scheduleCandidateExpiry(record);
      if (record.status !== 'candidate') {
        throw this.#fatalError ?? new Error('File playback source offer expired during staging');
      }
      EXACT_OPERATION_AUTHORITIES.set(operation as object, {
        operation,
        epoch,
        signal: abortController.signal,
        isCurrent,
        checkingCurrent: false,
      });
      return operation;
    });
  }

  commitStarted(
    operation: FilePlaybackConnectionMediaOperation,
    expectedNow: PlaybackStateIdentity,
    isStillCurrent: () => boolean,
  ): FilePlaybackConnectionMediaSessionSnapshot {
    return this.#mutate(() =>
      this.#commitPreparedUnchecked(operation, expectedNow, isStillCurrent, 'started'),
    );
  }

  /**
   * Commits an active late-join baseline after its source is fully prepared,
   * without claiming that a renderer started or making any renderer audible.
   */
  commitPreparedPausedBaseline(
    operation: FilePlaybackConnectionMediaOperation,
    expectedNow: PlaybackStateIdentity,
    isStillCurrent: () => boolean,
  ): FilePlaybackConnectionMediaSessionSnapshot {
    return this.#mutate(() => {
      const record = this.#requireCandidate(operation);
      if (record.kind !== 'baseline') {
        throw new Error('Only an active baseline can commit as prepared and paused');
      }
      return this.#commitPreparedUnchecked(operation, expectedNow, isStillCurrent, 'paused');
    });
  }

  /**
   * Creates SOURCE_READY while the exact run/source is still a candidate.
   * This deliberately does not promote either the run authority or its shared
   * channel state: the owner may publish readiness before renderer evidence is
   * sufficient to commit the baseline.
   */
  createCandidateSourceReadyWire(
    operation: FilePlaybackConnectionMediaOperation,
    payload: FileSourceReadyWirePayload,
  ): FilePlaybackWireMessageForKind<'source-ready'> {
    return this.#mutate(() => {
      const record = this.#requireCandidate(operation);
      return Reflect.apply(channelCreateWire, this.#channel, [
        record.channelStateLease,
        payload,
      ]) as FilePlaybackWireMessageForKind<'source-ready'>;
    });
  }

  /**
   * Creates SOURCE_READY from the exact committed prepared-run lease without
   * exposing the shared channel's mutable binding registry to its owner.
   */
  createPreparedSourceReadyWire(
    operation: FilePlaybackConnectionMediaOperation,
    payload: FileSourceReadyWirePayload,
  ): FilePlaybackWireMessageForKind<'source-ready'> {
    return this.#mutate(() => {
      const record = this.#requireCurrent(operation);
      return Reflect.apply(channelCreateWire, this.#channel, [
        record.channelStateLease,
        payload,
      ]) as FilePlaybackWireMessageForKind<'source-ready'>;
    });
  }

  /**
   * Adopts the exact attempt first introduced by an inbound ARM for an
   * already-staged new run. `stageRunBinding()` owns the state lease, so this
   * boundary must capture the receiver's matching lease instead of staging
   * either the media state or rendezvous attempt again.
   */
  adoptAdmittedPreparedRunAttempt(
    preparedOperation: FilePlaybackConnectionMediaOperation,
    expected: PlaybackStateIdentity,
    rendezvousId: string,
    stateLease: FilePlaybackWireStateLease,
    attemptLease: FilePlaybackWireAttemptLease,
  ): Readonly<FilePlaybackConnectionMediaPreparedRunAttempt> {
    return this.#mutate(() => {
      const state = readPlaybackStateIdentity(expected);
      if (
        !state ||
        !isBoundedRendezvousId(rendezvousId) ||
        stateLease === null ||
        typeof stateLease !== 'object' ||
        attemptLease === null ||
        typeof attemptLease !== 'object'
      ) {
        throw new TypeError('File playback admitted prepared-run attempt authority is invalid');
      }

      const prepared = this.#requireAdmittedPreparedRunCandidate(preparedOperation);
      const existing = this.#candidatePreparedRunAttempt;
      if (existing) {
        if (
          existing.prepared === prepared &&
          sameStateIdentity(existing.state, state) &&
          existing.rendezvousId === rendezvousId &&
          existing.stateLease === stateLease &&
          existing.attemptLease === attemptLease
        ) {
          return existing.attempt;
        }
        throw this.#fatal(
          'Inbound rendezvous replay disagreed with the exact prepared-run attempt authority',
        );
      }
      if (this.#retiredPreparedRunAttemptLeases.has(attemptLease)) {
        throw new Error('File playback admitted prepared-run attempt is retired');
      }
      if (
        this.#candidateState ||
        !sameState(prepared.binding, state) ||
        prepared.channelStateLease !== stateLease
      ) {
        throw this.#fatal('Inbound rendezvous did not target the exact prepared new run');
      }

      return this.#createPreparedRunAttempt(
        prepared,
        state,
        rendezvousId,
        stateLease,
        attemptLease,
      );
    });
  }

  /**
   * Serializes ARMED/FINALIZED/health from the exact privately held inbound
   * attempt lease. ARMED is candidate-only, health is committed-only, and
   * FINALIZED may be retried across the commit boundary.
   */
  createPreparedRunAttemptWire<
    const Payload extends FilePlaybackConnectionMediaStateAttemptWirePayload,
  >(
    attempt: FilePlaybackConnectionMediaPreparedRunAttempt,
    payload: Payload,
  ): FilePlaybackWireMessageForKind<Payload['kind']> {
    return this.#mutate(() => {
      const record = this.#requirePreparedRunAttempt(attempt);
      const identity = snapshotStateAttemptPayloadIdentity(payload);
      this.#assertPreparedRunAttemptLive(record);
      if (!identity) {
        throw new TypeError('File playback prepared-run attempt wire payload is invalid');
      }
      if (identity.rendezvousId !== record.rendezvousId) {
        throw new TypeError('File playback prepared-run attempt wire claimed another rendezvous');
      }
      if (
        (identity.kind === 'rendezvous-armed' && record.status !== 'candidate') ||
        (identity.kind === 'renderer-health' && record.status !== 'current')
      ) {
        throw new Error('File playback prepared-run attempt wire is invalid for its status');
      }

      let wire: FilePlaybackWireMessageForKind<Payload['kind']>;
      try {
        wire = Reflect.apply(channelCreateWire, this.#channel, [
          record.attemptLease,
          payload,
        ]) as FilePlaybackWireMessageForKind<Payload['kind']>;
      } catch {
        throw this.#fatal('The shared channel rejected the exact prepared-run attempt authority');
      }
      this.#assertPreparedRunAttemptLive(record);
      return wire;
    });
  }

  /**
   * Promotes the inbound attempt, run authority, and prepared media state only
   * after the owner proves that the exact renderer physically started.
   */
  commitPreparedRunAttemptStarted(
    attempt: FilePlaybackConnectionMediaPreparedRunAttempt,
    expectedNow: PlaybackStateIdentity,
    hasPhysicalStartEvidence: () => boolean,
  ): FilePlaybackConnectionMediaSessionSnapshot {
    return this.#mutate(() => {
      const expected = readPlaybackStateIdentity(expectedNow);
      if (!expected || typeof hasPhysicalStartEvidence !== 'function') {
        throw new TypeError('File playback prepared-run start evidence is invalid');
      }
      const record = this.#requirePreparedRunAttempt(attempt);
      if (
        record.status === 'current' &&
        record === this.#currentPreparedRunAttempt &&
        sameStateIdentity(record.state, expected)
      ) {
        return this.#snapshotUnchecked();
      }
      if (record.status !== 'candidate' || record !== this.#candidatePreparedRunAttempt) {
        throw new Error('Only the exact prepared-run attempt candidate can be committed');
      }
      if (!sameStateIdentity(record.state, expected)) {
        this.#retirePreparedRunAttemptRecord(record);
        throw new Error('File playback prepared-run attempt is not the expected current state');
      }
      return this.#commitPreparedRunAttemptUnchecked(record, expected, hasPhysicalStartEvidence);
    });
  }

  /** Retires only the candidate rendezvous attempt; the prepared source stays staged. */
  retirePreparedRunAttempt(attempt: FilePlaybackConnectionMediaPreparedRunAttempt): void {
    this.#mutate(() => {
      const record = this.#requirePreparedRunAttempt(attempt);
      if (record.status !== 'candidate' || record !== this.#candidatePreparedRunAttempt) {
        throw new Error('Only the exact prepared-run attempt candidate can be retired');
      }
      this.#retirePreparedRunAttemptRecord(record);
    });
  }

  /**
   * Stages the exact-next state of the already prepared logical run together
   * with its exact rendezvous attempt. No OFFER or RUN_BINDING is consumed.
   */
  stageSameRunStateSuccessor(
    preparedOperation: FilePlaybackConnectionMediaOperation,
    expectedCurrent: PlaybackStateIdentity,
    successor: PlaybackStateIdentity,
    rendezvousId: string,
  ): Readonly<FilePlaybackConnectionMediaStateOperation> {
    return this.#mutate(() => {
      const prepared = this.#requireCurrent(preparedOperation);
      const expected = readPlaybackStateIdentity(expectedCurrent);
      const next = readPlaybackStateIdentity(successor);
      if (!expected || !next || !isBoundedRendezvousId(rendezvousId)) {
        throw new TypeError('File playback same-run state successor authority is invalid');
      }
      const existing = this.#candidateState;
      if (existing) {
        if (
          existing.prepared === prepared &&
          sameStateIdentity(existing.previous, expected) &&
          sameStateIdentity(existing.state, next) &&
          existing.rendezvousId === rendezvousId &&
          existing.operation
        ) {
          return existing.operation;
        }
        throw new Error('File playback same-run state candidate conflicts with active authority');
      }
      if (
        !this.#currentState ||
        !sameStateIdentity(this.#currentState, expected) ||
        next.queueItemId !== expected.queueItemId ||
        next.runId !== expected.runId ||
        next.revision !== this.#admittedRevisionWatermark + 1 ||
        expected.queueItemId !== prepared.binding.queueItemId ||
        expected.runId !== prepared.binding.runId
      ) {
        throw new Error('File playback same-run state is not the exact current successor');
      }

      const stateLease: FilePlaybackWireStateLease = Reflect.apply(
        channelStageMedia,
        this.#channel,
        [
          freezeCanonical({
            run: next,
            sourceIdentity: prepared.binding.sourceIdentity,
            transferSessionId: prepared.binding.transferSessionId,
          }),
        ],
      );
      this.#admittedRevisionWatermark = next.revision;

      let attemptLease: FilePlaybackWireAttemptLease;
      try {
        attemptLease = Reflect.apply(channelStageAttempt, this.#channel, [
          stateLease,
          rendezvousId,
        ]);
      } catch {
        try {
          Reflect.apply(channelRetireMedia, this.#channel, [stateLease]);
        } catch {
          // The fatal teardown below owns the exact connection scope.
        }
        throw this.#fatal('The shared channel could not atomically stage a state rendezvous');
      }

      return this.#createStateOperation(
        prepared,
        expected,
        next,
        rendezvousId,
        stateLease,
        attemptLease,
      );
    });
  }

  /**
   * Mirrors the exact successor state lease already admitted by an inbound
   * PREPARE. No attempt exists yet and neither channel authority is restaged.
   */
  adoptAdmittedSameRunStatePreparation(
    preparedOperation: FilePlaybackConnectionMediaOperation,
    expectedCurrent: PlaybackStateIdentity,
    successor: PlaybackStateIdentity,
    stateLease: FilePlaybackWireStateLease,
  ): Readonly<FilePlaybackConnectionMediaStatePreparation> {
    return this.#mutate(() => {
      const prepared = this.#requireCurrent(preparedOperation);
      const expected = readPlaybackStateIdentity(expectedCurrent);
      const next = readPlaybackStateIdentity(successor);
      if (!expected || !next || stateLease === null || typeof stateLease !== 'object') {
        throw new TypeError('File playback admitted state preparation authority is invalid');
      }
      return this.#adoptAdmittedStatePreparationUnchecked(
        prepared,
        expected,
        next,
        stateLease,
      ).preparation;
    });
  }

  /** Creates SOURCE_READY/NOT_READY from the exact PREPARE state lease. */
  createStatePreparationSourceWire<
    const Payload extends FilePlaybackConnectionMediaStatePreparationWirePayload,
  >(
    preparation: FilePlaybackConnectionMediaStatePreparation,
    payload: Payload,
  ): FilePlaybackWireMessageForKind<Payload['kind']> {
    return this.#mutate(() => {
      const record = this.#requireStatePreparation(preparation);
      this.#assertStatePreparationCurrent(record);
      if (record.attemptLease || record.rendezvousId || record.operation) {
        throw new Error('File playback state preparation already owns a rendezvous attempt');
      }
      let wire: FilePlaybackWireMessageForKind<Payload['kind']>;
      try {
        wire = Reflect.apply(channelCreateWire, this.#channel, [
          record.stateLease,
          payload,
        ]) as FilePlaybackWireMessageForKind<Payload['kind']>;
      } catch {
        throw this.#fatal('The shared channel rejected the exact state preparation authority');
      }
      this.#assertStatePreparationCurrent(record);
      return wire;
    });
  }

  /**
   * Attaches the exact attempt lease admitted by a later ARM to a PREPARE
   * capability. Equal-looking or foreign leases cannot cross this boundary.
   */
  attachAdmittedSameRunStateAttempt(
    preparation: FilePlaybackConnectionMediaStatePreparation,
    rendezvousId: string,
    stateLease: FilePlaybackWireStateLease,
    attemptLease: FilePlaybackWireAttemptLease,
  ): Readonly<FilePlaybackConnectionMediaStateOperation> {
    return this.#mutate(() => {
      const record = this.#requireStatePreparation(preparation);
      if (
        !isBoundedRendezvousId(rendezvousId) ||
        stateLease === null ||
        typeof stateLease !== 'object' ||
        attemptLease === null ||
        typeof attemptLease !== 'object'
      ) {
        throw new TypeError('File playback admitted state attempt authority is invalid');
      }
      return this.#attachAdmittedStateAttemptUnchecked(
        record,
        rendezvousId,
        stateLease,
        attemptLease,
      );
    });
  }

  /** Retires a PREPARE successor which never reached ARM. */
  retireStatePreparation(preparation: FilePlaybackConnectionMediaStatePreparation): void {
    this.#mutate(() => {
      const record = this.#requireStatePreparation(preparation);
      if (record.operation || record.attemptLease || record.rendezvousId) {
        throw new Error('An attached state preparation must retire through its state operation');
      }
      this.#retireStateRecord(record);
    });
  }

  /**
   * Adopts the exact state/attempt lease pair already admitted by an inbound
   * rendezvous ARM. The shared channel has consumed the successor revision, so
   * this boundary must never stage either authority a second time.
   *
   * The returned operation remains body-free and keeps both opaque leases in
   * this session's private WeakMaps. A different lease pair cannot replay an
   * equal-looking descriptor; forged or foreign authority fails closed at the
   * channel commit boundary.
   */
  adoptAdmittedSameRunStateSuccessor(
    preparedOperation: FilePlaybackConnectionMediaOperation,
    expectedCurrent: PlaybackStateIdentity,
    successor: PlaybackStateIdentity,
    rendezvousId: string,
    stateLease: FilePlaybackWireStateLease,
    attemptLease: FilePlaybackWireAttemptLease,
  ): Readonly<FilePlaybackConnectionMediaStateOperation> {
    return this.#mutate(() => {
      const prepared = this.#requireCurrent(preparedOperation);
      const expected = readPlaybackStateIdentity(expectedCurrent);
      const next = readPlaybackStateIdentity(successor);
      if (
        !expected ||
        !next ||
        !isBoundedRendezvousId(rendezvousId) ||
        stateLease === null ||
        typeof stateLease !== 'object' ||
        attemptLease === null ||
        typeof attemptLease !== 'object'
      ) {
        throw new TypeError('File playback admitted rendezvous successor authority is invalid');
      }

      const preparation = this.#adoptAdmittedStatePreparationUnchecked(
        prepared,
        expected,
        next,
        stateLease,
      );
      return this.#attachAdmittedStateAttemptUnchecked(
        preparation,
        rendezvousId,
        stateLease,
        attemptLease,
      );
    });
  }

  /**
   * Serializes a guest response from the attempt lease privately owned by an
   * exact state operation. ARMED is candidate-only, health is current-only,
   * and FINALIZED may be retried on either side of the local commit boundary.
   */
  createStateAttemptWire<const Payload extends FilePlaybackConnectionMediaStateAttemptWirePayload>(
    operation: FilePlaybackConnectionMediaStateOperation,
    payload: Payload,
  ): FilePlaybackWireMessageForKind<Payload['kind']> {
    return this.#mutate(() => {
      const record = this.#requireStateOperation(operation);
      const identity = snapshotStateAttemptPayloadIdentity(payload);
      this.#assertStateOperationLive(record);
      if (!identity) {
        throw new TypeError('File playback state attempt wire payload is invalid');
      }
      if (identity.rendezvousId !== record.rendezvousId) {
        throw new TypeError('File playback state attempt wire claimed a different rendezvous');
      }
      if (
        (identity.kind === 'rendezvous-armed' && record.status !== 'candidate') ||
        (identity.kind === 'renderer-health' && record.status !== 'current')
      ) {
        throw new Error('File playback state attempt wire is invalid for its operation status');
      }

      let wire: FilePlaybackWireMessageForKind<Payload['kind']>;
      try {
        wire = Reflect.apply(channelCreateWire, this.#channel, [
          record.attemptLease,
          payload,
        ]) as FilePlaybackWireMessageForKind<Payload['kind']>;
      } catch {
        throw this.#fatal('The shared channel rejected the exact state attempt authority');
      }
      this.#assertStateOperationLive(record);
      return wire;
    });
  }

  commitStateSuccessor(
    operation: FilePlaybackConnectionMediaStateOperation,
    expectedNow: PlaybackStateIdentity,
    isStillCurrent: () => boolean,
  ): FilePlaybackConnectionMediaSessionSnapshot {
    return this.#mutate(() => {
      const record = this.#requireStateCandidate(operation);
      const expected = readPlaybackStateIdentity(expectedNow);
      if (
        !expected ||
        !sameStateIdentity(record.state, expected) ||
        typeof isStillCurrent !== 'function'
      ) {
        this.#retireStateRecord(record);
        throw new Error('File playback state successor is not the expected current state');
      }
      if (!this.#readStateCommitAuthority(record, isStillCurrent)) {
        this.#retireStateRecord(record);
        throw new Error('File playback state successor is no longer controller-current');
      }
      if (!this.#readStateCommitAuthority(record, isStillCurrent)) {
        this.#retireStateRecord(record);
        throw new Error('File playback state successor is no longer controller-current');
      }

      try {
        Reflect.apply(channelCommitAttempt, this.#channel, [record.attemptLease]);
        Reflect.apply(channelCommitMedia, this.#channel, [record.stateLease]);
      } catch {
        throw this.#fatal('The shared channel failed while committing a state rendezvous');
      }

      if (this.#currentPreparedRunAttempt) {
        this.#retirePreparedRunAttemptLocally(this.#currentPreparedRunAttempt);
      }
      const previousStateOperation = this.#currentStateOperation;
      if (previousStateOperation) this.#retireStateRecordLocally(previousStateOperation);
      record.status = 'current';
      this.#candidateState = null;
      this.#currentStateOperation = record;
      record.prepared.channelStateLease = record.stateLease;
      this.#currentState = record.state;
      this.#committedRevisionWatermark = record.state.revision;
      this.#admittedRevisionWatermark = record.state.revision;
      return this.#snapshotUnchecked();
    });
  }

  /**
   * Commits a pause or paused-seek successor already admitted by the shared
   * inbound wire receiver. The exact receiver-issued lease is the only object
   * which can cross the channel commit boundary. The prepared source/run stays
   * current while its state revision advances.
   */
  commitAdmittedStateSuccessor(
    preparedOperation: FilePlaybackConnectionMediaOperation,
    expectedCurrent: PlaybackStateIdentity,
    successor: PlaybackStateIdentity,
    stateLease: FilePlaybackWireStateLease,
    isStillCurrent: () => boolean,
  ): FilePlaybackConnectionMediaSessionSnapshot {
    return this.#mutate(() => {
      const prepared = this.#requireCurrent(preparedOperation);
      const expected = readPlaybackStateIdentity(expectedCurrent);
      const next = readPlaybackStateIdentity(successor);
      if (!expected || !next || typeof isStillCurrent !== 'function') {
        throw new TypeError('File playback admitted state successor authority is invalid');
      }
      if (
        this.#candidateState ||
        !this.#currentState ||
        !sameStateIdentity(this.#currentState, expected) ||
        expected.queueItemId !== prepared.binding.queueItemId ||
        expected.runId !== prepared.binding.runId ||
        next.queueItemId !== expected.queueItemId ||
        next.runId !== expected.runId ||
        next.revision !== this.#admittedRevisionWatermark + 1
      ) {
        throw new Error('File playback admitted state is not the exact current successor');
      }
      if (!this.#readPreparedCommitAuthority(prepared, isStillCurrent)) {
        this.#retireAdmittedSuccessorLease(stateLease, next.revision);
        throw new Error('File playback admitted state is no longer controller-current');
      }
      if (!this.#readPreparedCommitAuthority(prepared, isStillCurrent)) {
        this.#retireAdmittedSuccessorLease(stateLease, next.revision);
        throw new Error('File playback admitted state is no longer controller-current');
      }

      try {
        Reflect.apply(channelCommitMedia, this.#channel, [stateLease]);
      } catch {
        throw this.#fatal('The shared channel rejected the exact admitted state successor');
      }

      if (this.#currentPreparedRunAttempt) {
        this.#retirePreparedRunAttemptLocally(this.#currentPreparedRunAttempt);
      }
      if (this.#currentStateOperation) {
        this.#retireStateRecordLocally(this.#currentStateOperation);
      }
      prepared.channelStateLease = stateLease;
      this.#currentState = next;
      this.#committedRevisionWatermark = next.revision;
      this.#admittedRevisionWatermark = next.revision;
      return this.#snapshotUnchecked();
    });
  }

  retireStateSuccessor(operation: FilePlaybackConnectionMediaStateOperation): void {
    this.#mutate(() => this.#retireStateRecord(this.#requireStateOperation(operation)));
  }

  /**
   * Commits an exact-next STOP state and retires both the prepared run and its
   * current state. The exact retry is idempotent and returns the stopped
   * projection; no source body or renderer is retained.
   */
  commitStop(
    preparedOperation: FilePlaybackConnectionMediaOperation,
    expectedCurrent: PlaybackStateIdentity,
    stopped: PlaybackStateIdentity,
    isStillCurrent: () => boolean,
  ): FilePlaybackConnectionMediaSessionSnapshot {
    return this.#mutate(() => {
      const expected = readPlaybackStateIdentity(expectedCurrent);
      const next = readPlaybackStateIdentity(stopped);
      if (!expected || !next || typeof isStillCurrent !== 'function') {
        throw new TypeError('File playback stop authority is invalid');
      }
      if (this.#isExactStopReplay(preparedOperation, expected, next)) {
        return this.#snapshotUnchecked();
      }
      const prepared = this.#requireCurrent(preparedOperation);
      if (
        this.#candidateState ||
        !this.#currentState ||
        !sameStateIdentity(this.#currentState, expected) ||
        expected.queueItemId !== prepared.binding.queueItemId ||
        expected.runId !== prepared.binding.runId ||
        next.queueItemId !== expected.queueItemId ||
        next.runId !== expected.runId ||
        next.revision !== this.#admittedRevisionWatermark + 1
      ) {
        throw new Error('File playback stop is not the exact current successor');
      }
      if (!this.#readPreparedCommitAuthority(prepared, isStillCurrent)) {
        throw new Error('File playback stop is no longer controller-current');
      }
      if (!this.#readPreparedCommitAuthority(prepared, isStillCurrent)) {
        throw new Error('File playback stop is no longer controller-current');
      }

      const stopLease: FilePlaybackWireStateLease = Reflect.apply(
        channelStageMedia,
        this.#channel,
        [
          freezeCanonical({
            run: next,
            sourceIdentity: prepared.binding.sourceIdentity,
            transferSessionId: prepared.binding.transferSessionId,
          }),
        ],
      );
      this.#admittedRevisionWatermark = next.revision;
      try {
        // This metadata owner does not serialize the already-defined STOP
        // wire message, so its sender-side mirror has no mark-stop step. The
        // same exact result is obtained by retiring the validated current and
        // exact-next leases after the successor consumed its revision.
        Reflect.apply(channelRetireMedia, this.#channel, [prepared.channelStateLease]);
        Reflect.apply(channelRetireMedia, this.#channel, [stopLease]);
      } catch {
        throw this.#fatal('The shared channel failed while committing file playback stop');
      }
      try {
        this.#runAuthority.retireCurrent(this.#connectionToken, prepared.runLease);
      } catch {
        throw this.#fatal('Run authority failed after the shared channel committed stop');
      }

      const stopTombstone = freezeCanonical({
        expected,
        stopped: next,
        admittedStopLease: null,
      });
      if (this.#currentStateOperation) {
        this.#retireStateRecordLocally(this.#currentStateOperation);
      }
      this.#retireRecordLocally(prepared);
      this.#currentState = null;
      this.#bootstrapKind = 'stopped';
      this.#committedRevisionWatermark = next.revision;
      this.#admittedRevisionWatermark = next.revision;
      this.#committedStops.set(prepared.operation, stopTombstone);
      return this.#snapshotUnchecked();
    });
  }

  /**
   * Commits an exact STOP successor already admitted by the inbound receiver.
   * A successful retry is accepted only with the same opaque stop lease; an
   * equal-looking replacement cannot recover the retired run authority.
   */
  commitAdmittedStop(
    preparedOperation: FilePlaybackConnectionMediaOperation,
    expectedCurrent: PlaybackStateIdentity,
    stopped: PlaybackStateIdentity,
    stopLease: FilePlaybackWireStateLease,
    isStillCurrent: () => boolean,
  ): FilePlaybackConnectionMediaSessionSnapshot {
    return this.#mutate(() => {
      const expected = readPlaybackStateIdentity(expectedCurrent);
      const next = readPlaybackStateIdentity(stopped);
      if (!expected || !next || typeof isStillCurrent !== 'function') {
        throw new TypeError('File playback admitted stop authority is invalid');
      }
      if (this.#isExactAdmittedStopReplay(preparedOperation, expected, next, stopLease)) {
        return this.#snapshotUnchecked();
      }
      const prepared = this.#requireCurrent(preparedOperation);
      if (
        this.#candidateState ||
        !this.#currentState ||
        !sameStateIdentity(this.#currentState, expected) ||
        expected.queueItemId !== prepared.binding.queueItemId ||
        expected.runId !== prepared.binding.runId ||
        next.queueItemId !== expected.queueItemId ||
        next.runId !== expected.runId ||
        next.revision !== this.#admittedRevisionWatermark + 1
      ) {
        throw new Error('File playback admitted stop is not the exact current successor');
      }
      if (!this.#readPreparedCommitAuthority(prepared, isStillCurrent)) {
        this.#retireAdmittedSuccessorLease(stopLease, next.revision);
        throw new Error('File playback admitted stop is no longer controller-current');
      }
      if (!this.#readPreparedCommitAuthority(prepared, isStillCurrent)) {
        this.#retireAdmittedSuccessorLease(stopLease, next.revision);
        throw new Error('File playback admitted stop is no longer controller-current');
      }

      try {
        Reflect.apply(channelCommitStop, this.#channel, [stopLease, expected]);
      } catch {
        throw this.#fatal('The shared channel rejected the exact admitted stop successor');
      }
      try {
        this.#runAuthority.retireCurrent(this.#connectionToken, prepared.runLease);
      } catch {
        throw this.#fatal('Run authority failed after the shared channel committed admitted stop');
      }

      const stopTombstone = freezeCanonical({
        expected,
        stopped: next,
        admittedStopLease: stopLease,
      });
      if (this.#currentStateOperation) {
        this.#retireStateRecordLocally(this.#currentStateOperation);
      }
      this.#retireRecordLocally(prepared);
      this.#currentState = null;
      this.#bootstrapKind = 'stopped';
      this.#committedRevisionWatermark = next.revision;
      this.#admittedRevisionWatermark = next.revision;
      this.#committedStops.set(prepared.operation, stopTombstone);
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
    this.#retireAllOfferPreparations();
    const stateRecords = this.#liveStateRecords();
    for (const record of stateRecords) this.#abortStateOperationFence(record);
    if (this.#candidateState) this.#retireStateChannelBestEffort(this.#candidateState);
    for (const record of stateRecords) this.#retireStateRecordLocally(record);
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

  #commitPreparedUnchecked(
    operation: FilePlaybackConnectionMediaOperation,
    expectedNow: PlaybackStateIdentity,
    isStillCurrent: () => boolean,
    mode: 'paused' | 'started',
  ): FilePlaybackConnectionMediaSessionSnapshot {
    const record = this.#requireCandidate(operation);
    if (this.#candidatePreparedRunAttempt?.prepared === record) {
      throw new Error(
        'A receiver-admitted prepared-run attempt must be committed with its exact attempt',
      );
    }
    const expected = readPlaybackStateIdentity(expectedNow);
    if (!expected || !sameState(record.binding, expected) || typeof isStillCurrent !== 'function') {
      this.#retireRecord(record);
      throw new Error(
        mode === 'paused'
          ? 'File playback prepared baseline is not the expected current state'
          : 'File playback started operation is not the expected current state',
      );
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
    if (this.#currentStateOperation) {
      this.#retireStateRecordLocally(this.#currentStateOperation);
    }
    this.#clearCandidateExpiry(record);
    record.status = 'current';
    this.#candidate = null;
    this.#current = record;
    this.#currentState = expected;
    this.#committedRevisionWatermark = record.binding.playbackRevision;
    this.#admittedRevisionWatermark = record.binding.playbackRevision;
    if (record.sourcePreparation) {
      this.#consumeOfferPreparation(record.sourcePreparation);
    }
    return this.#snapshotUnchecked();
  }

  #commitPreparedRunAttemptUnchecked(
    attempt: PreparedRunAttemptRecord,
    expected: Readonly<PlaybackStateIdentity>,
    hasPhysicalStartEvidence: () => boolean,
  ): FilePlaybackConnectionMediaSessionSnapshot {
    const prepared = attempt.prepared;
    this.#assertPreparedRunAttemptCandidate(attempt);
    if (
      !sameState(prepared.binding, expected) ||
      attempt.stateLease !== prepared.channelStateLease
    ) {
      throw this.#fatal('Prepared-run attempt lost its exact staged media authority');
    }

    const guardedEvidence = (): boolean => {
      this.#assertPreparedRunAttemptCandidate(attempt);
      let accepted: boolean;
      try {
        accepted = Reflect.apply(hasPhysicalStartEvidence, undefined, []) === true;
      } catch {
        accepted = false;
      }
      this.#assertPreparedRunAttemptCandidate(attempt);
      return accepted;
    };

    try {
      this.#runAuthority.commitCandidate(
        this.#connectionToken,
        prepared.runLease,
        expected,
        guardedEvidence,
      );
    } catch (error) {
      this.#cleanupFailedCandidate(prepared);
      if (this.#revoked) throw this.#fatalError ?? error;
      throw error;
    }

    // The only owner callback completed above. These three promotions form
    // one callback-free critical section; any split failure quarantines this
    // exact connection rather than publishing partial authority.
    try {
      Reflect.apply(channelCommitAttempt, this.#channel, [attempt.attemptLease]);
      Reflect.apply(channelCommitMedia, this.#channel, [prepared.channelStateLease]);
    } catch {
      throw this.#fatal('The shared channel failed while committing the prepared-run rendezvous');
    }

    const previous = this.#current;
    if (previous) this.#retireRecordLocally(previous);
    if (this.#currentStateOperation) {
      this.#retireStateRecordLocally(this.#currentStateOperation);
    }
    this.#clearCandidateExpiry(prepared);
    prepared.status = 'current';
    attempt.status = 'current';
    this.#candidate = null;
    this.#candidatePreparedRunAttempt = null;
    this.#current = prepared;
    this.#currentPreparedRunAttempt = attempt;
    this.#currentState = expected;
    this.#committedRevisionWatermark = expected.revision;
    this.#admittedRevisionWatermark = expected.revision;
    if (prepared.sourcePreparation) {
      this.#consumeOfferPreparation(prepared.sourcePreparation);
    }
    return this.#snapshotUnchecked();
  }

  #readStateCommitAuthority(record: StateOperationRecord, isStillCurrent: () => boolean): boolean {
    this.#assertStateOperationCurrent(record);
    let accepted: boolean;
    try {
      accepted = Reflect.apply(isStillCurrent, undefined, []) === true;
    } catch {
      accepted = false;
    }
    this.#assertStateOperationCurrent(record);
    return accepted;
  }

  #createStateOperation(
    prepared: OperationRecord,
    previous: Readonly<PlaybackStateIdentity>,
    state: Readonly<PlaybackStateIdentity>,
    rendezvousId: string,
    stateLease: FilePlaybackWireStateLease,
    attemptLease: FilePlaybackWireAttemptLease,
  ): Readonly<FilePlaybackConnectionMediaStateOperation> {
    const record = this.#createStatePreparation(
      prepared,
      previous,
      state,
      stateLease,
    );
    return this.#attachAdmittedStateAttemptUnchecked(
      record,
      rendezvousId,
      stateLease,
      attemptLease,
    );
  }

  #createStatePreparation(
    prepared: OperationRecord,
    previous: Readonly<PlaybackStateIdentity>,
    state: Readonly<PlaybackStateIdentity>,
    stateLease: FilePlaybackWireStateLease,
  ): StateOperationRecord {
    const epoch = Object.freeze(
      Object.create(null),
    ) as FilePlaybackConnectionMediaStateOperationEpoch;
    const abortController = new AbortController();
    const fence = freezeCanonical({
      epoch,
      signal: abortController.signal,
      isCurrent: () => this.#isStateOperationEpochCurrent(epoch),
    });
    const preparation = freezeCanonical({
      previous,
      state,
      fence,
    }) as Readonly<FilePlaybackConnectionMediaStatePreparation>;
    const record: StateOperationRecord = {
      preparation,
      operation: null,
      prepared,
      stateLease,
      attemptLease: null,
      previous,
      state,
      rendezvousId: null,
      epoch,
      abortController,
      status: 'candidate',
    };
    this.#statePreparations.set(preparation, record);
    this.#stateOperationEpochs.set(epoch, record);
    this.#candidateState = record;
    return record;
  }

  #adoptAdmittedStatePreparationUnchecked(
    prepared: OperationRecord,
    expected: Readonly<PlaybackStateIdentity>,
    next: Readonly<PlaybackStateIdentity>,
    stateLease: FilePlaybackWireStateLease,
  ): StateOperationRecord {
    const existing = this.#candidateState;
    if (existing) {
      if (
        existing.prepared === prepared &&
        sameStateIdentity(existing.previous, expected) &&
        sameStateIdentity(existing.state, next) &&
        existing.stateLease === stateLease
      ) {
        return existing;
      }
      throw this.#fatal(
        'Inbound state preparation replay disagreed with the exact admitted authority',
      );
    }
    if (
      !this.#currentState ||
      !sameStateIdentity(this.#currentState, expected) ||
      next.queueItemId !== expected.queueItemId ||
      next.runId !== expected.runId ||
      next.revision !== this.#admittedRevisionWatermark + 1 ||
      expected.queueItemId !== prepared.binding.queueItemId ||
      expected.runId !== prepared.binding.runId
    ) {
      throw this.#fatal('Inbound preparation is not the exact current same-run state successor');
    }

    // The receiver already consumed the successor revision atomically. Mirror
    // that admission without restaging either media state or an attempt.
    this.#admittedRevisionWatermark = next.revision;
    return this.#createStatePreparation(prepared, expected, next, stateLease);
  }

  #attachAdmittedStateAttemptUnchecked(
    record: StateOperationRecord,
    rendezvousId: string,
    stateLease: FilePlaybackWireStateLease,
    attemptLease: FilePlaybackWireAttemptLease,
  ): Readonly<FilePlaybackConnectionMediaStateOperation> {
    this.#assertStatePreparationCurrent(record);
    if (record.stateLease !== stateLease) {
      throw this.#fatal('Inbound ARM did not target the exact prepared state lease');
    }
    if (record.operation) {
      if (
        record.rendezvousId === rendezvousId &&
        record.attemptLease === attemptLease
      ) {
        return record.operation;
      }
      throw this.#fatal('Inbound ARM replay disagreed with the exact prepared state attempt');
    }
    if (record.rendezvousId || record.attemptLease) {
      throw this.#fatal('Prepared state attempt authority became partially attached');
    }

    const operation = freezeCanonical({
      previous: record.previous,
      state: record.state,
      rendezvousId,
      fence: record.preparation.fence,
    }) as Readonly<FilePlaybackConnectionMediaStateOperation>;
    record.rendezvousId = rendezvousId;
    record.attemptLease = attemptLease;
    record.operation = operation;
    this.#stateOperations.set(operation, record);
    return operation;
  }

  #createPreparedRunAttempt(
    prepared: OperationRecord,
    state: Readonly<PlaybackStateIdentity>,
    rendezvousId: string,
    stateLease: FilePlaybackWireStateLease,
    attemptLease: FilePlaybackWireAttemptLease,
  ): Readonly<FilePlaybackConnectionMediaPreparedRunAttempt> {
    const epoch = Object.freeze(
      Object.create(null),
    ) as FilePlaybackConnectionMediaPreparedRunAttemptEpoch;
    const abortController = new AbortController();
    const fence = freezeCanonical({
      epoch,
      signal: abortController.signal,
      isCurrent: () => this.#isPreparedRunAttemptEpochCurrent(epoch),
    });
    const attempt = freezeCanonical({
      state,
      rendezvousId,
      fence,
    }) as Readonly<FilePlaybackConnectionMediaPreparedRunAttempt>;
    const record: PreparedRunAttemptRecord = {
      attempt,
      prepared,
      stateLease,
      attemptLease,
      state,
      rendezvousId,
      epoch,
      abortController,
      status: 'candidate',
    };
    this.#preparedRunAttempts.set(attempt, record);
    this.#preparedRunAttemptEpochs.set(epoch, record);
    this.#candidatePreparedRunAttempt = record;
    return attempt;
  }

  #readPreparedCommitAuthority(record: OperationRecord, isStillCurrent: () => boolean): boolean {
    this.#assertPreparedCurrent(record);
    let accepted: boolean;
    try {
      accepted = Reflect.apply(isStillCurrent, undefined, []) === true;
    } catch {
      accepted = false;
    }
    this.#assertPreparedCurrent(record);
    return accepted;
  }

  #retireAdmittedSuccessorLease(
    lease: FilePlaybackWireStateLease,
    admittedRevision: PlaybackRevisionWatermark,
  ): void {
    try {
      Reflect.apply(channelRetireMedia, this.#channel, [lease]);
    } catch {
      throw this.#fatal('The shared channel rejected admitted successor retirement');
    }
    this.#admittedRevisionWatermark = admittedRevision;
  }

  #isExactStopReplay(
    operation: FilePlaybackConnectionMediaOperation,
    expected: Readonly<PlaybackStateIdentity>,
    stopped: Readonly<PlaybackStateIdentity>,
  ): boolean {
    const committed =
      operation !== null && typeof operation === 'object'
        ? this.#committedStops.get(operation)
        : undefined;
    return (
      committed !== undefined &&
      committed.admittedStopLease === null &&
      this.#bootstrapKind === 'stopped' &&
      this.#candidate === null &&
      this.#current === null &&
      this.#candidateState === null &&
      this.#currentState === null &&
      this.#committedRevisionWatermark === committed.stopped.revision &&
      this.#admittedRevisionWatermark === committed.stopped.revision &&
      sameStateIdentity(committed.expected, expected) &&
      sameStateIdentity(committed.stopped, stopped)
    );
  }

  #isExactAdmittedStopReplay(
    operation: FilePlaybackConnectionMediaOperation,
    expected: Readonly<PlaybackStateIdentity>,
    stopped: Readonly<PlaybackStateIdentity>,
    stopLease: FilePlaybackWireStateLease,
  ): boolean {
    const committed =
      operation !== null && typeof operation === 'object'
        ? this.#committedStops.get(operation)
        : undefined;
    return (
      committed !== undefined &&
      committed.admittedStopLease === stopLease &&
      this.#bootstrapKind === 'stopped' &&
      this.#candidate === null &&
      this.#current === null &&
      this.#candidateState === null &&
      this.#currentState === null &&
      this.#committedRevisionWatermark === committed.stopped.revision &&
      this.#admittedRevisionWatermark === committed.stopped.revision &&
      sameStateIdentity(committed.expected, expected) &&
      sameStateIdentity(committed.stopped, stopped)
    );
  }

  #assertOperationCurrent(record: OperationRecord): void {
    this.#assertLiveChannel();
    if (record !== this.#candidate || record.status !== 'candidate') {
      throw new Error('File playback media operation is no longer the exact candidate');
    }
  }

  #assertPreparedCurrent(record: OperationRecord): void {
    this.#assertLiveChannel();
    if (record !== this.#current || record.status !== 'current') {
      throw new Error('File playback prepared run is no longer exact current authority');
    }
  }

  #assertStateOperationCurrent(record: StateOperationRecord): void {
    this.#assertStateOperationLive(record);
    if (record !== this.#candidateState || record.status !== 'candidate') {
      throw new Error('File playback state operation is no longer the exact candidate');
    }
  }

  #assertStatePreparationCurrent(record: StateOperationRecord): void {
    this.#assertPreparedCurrent(record.prepared);
    if (record.status !== 'candidate' || record !== this.#candidateState) {
      throw new Error('File playback state preparation is no longer the exact candidate');
    }
  }

  #assertStateOperationLive(record: StateOperationRecord): void {
    this.#assertPreparedCurrent(record.prepared);
    if (
      !record.operation ||
      !record.attemptLease ||
      !record.rendezvousId ||
      record.status === 'retired' ||
      (record.status === 'candidate' && record !== this.#candidateState) ||
      (record.status === 'current' && record !== this.#currentStateOperation)
    ) {
      throw new Error('File playback state operation is no longer exact live authority');
    }
  }

  #assertPreparedRunAttemptCandidate(record: PreparedRunAttemptRecord): void {
    this.#assertPreparedRunAttemptLive(record);
    if (record.status !== 'candidate' || record !== this.#candidatePreparedRunAttempt) {
      throw new Error('File playback prepared-run attempt is no longer the exact candidate');
    }
  }

  #assertPreparedRunAttemptLive(record: PreparedRunAttemptRecord): void {
    this.#assertLiveChannel();
    const ownsPrepared =
      (record.status === 'candidate' &&
        record === this.#candidatePreparedRunAttempt &&
        record.prepared === this.#candidate &&
        record.prepared.status === 'candidate') ||
      (record.status === 'current' &&
        record === this.#currentPreparedRunAttempt &&
        record.prepared === this.#current &&
        record.prepared.status === 'current');
    if (
      !ownsPrepared ||
      record.status === 'retired' ||
      record.prepared.channelStateLease !== record.stateLease
    ) {
      throw new Error('File playback prepared-run attempt is no longer exact live authority');
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

  #requireCurrent(value: FilePlaybackConnectionMediaOperation): OperationRecord {
    const record = this.#requireOperation(value);
    if (record !== this.#current || record.status !== 'current') {
      throw new Error('Only the exact prepared file playback run can change state');
    }
    return record;
  }

  #requireAdmittedPreparedRunCandidate(
    value: FilePlaybackConnectionMediaOperation,
  ): OperationRecord {
    const record =
      value !== null && typeof value === 'object' ? this.#operations.get(value) : undefined;
    if (!record) {
      if (value !== null && typeof value === 'object' && this.#retiredOperations.has(value)) {
        throw new Error('File playback prepared new run is retired');
      }
      throw this.#fatal('Inbound rendezvous targeted a forged or foreign prepared run');
    }
    if (record.status === 'retired') {
      throw new Error('File playback prepared new run is retired');
    }
    if (record !== this.#candidate || record.status !== 'candidate') {
      throw this.#fatal('Inbound rendezvous did not target the exact prepared new-run candidate');
    }
    return record;
  }

  #requirePreparedRunAttempt(
    value: FilePlaybackConnectionMediaPreparedRunAttempt,
  ): PreparedRunAttemptRecord {
    const record =
      value !== null && typeof value === 'object'
        ? this.#preparedRunAttempts.get(value)
        : undefined;
    if (!record) {
      if (
        value !== null &&
        typeof value === 'object' &&
        this.#retiredPreparedRunAttempts.has(value)
      ) {
        throw new Error('File playback prepared-run attempt is retired');
      }
      throw this.#fatal('File playback prepared-run attempt is forged or foreign');
    }
    if (record.status === 'retired') {
      throw new Error('File playback prepared-run attempt is retired');
    }
    return record;
  }

  #requireStateOperation(value: FilePlaybackConnectionMediaStateOperation): StateOperationRecord {
    const record =
      value !== null && typeof value === 'object' ? this.#stateOperations.get(value) : undefined;
    if (!record || record.status === 'retired') {
      if (
        value !== null &&
        typeof value === 'object' &&
        this.#retiredStateOperations.has(value)
      ) {
        throw new Error('File playback state operation is retired');
      }
      throw new Error('File playback state operation is forged or retired');
    }
    return record;
  }

  #requireStatePreparation(
    value: FilePlaybackConnectionMediaStatePreparation,
  ): StateOperationRecord {
    const record =
      value !== null && typeof value === 'object' ? this.#statePreparations.get(value) : undefined;
    if (!record || record.status === 'retired') {
      if (
        value !== null &&
        typeof value === 'object' &&
        this.#retiredStatePreparations.has(value)
      ) {
        throw new Error('File playback state preparation is retired');
      }
      throw new Error('File playback state preparation is forged or retired');
    }
    return record;
  }

  #requireStateCandidate(value: FilePlaybackConnectionMediaStateOperation): StateOperationRecord {
    const record = this.#requireStateOperation(value);
    if (record !== this.#candidateState || record.status !== 'candidate') {
      throw new Error('Only the exact staged file playback state can be committed');
    }
    return record;
  }

  #retireRecord(record: OperationRecord): void {
    const abandonsActiveBaseline = record.status === 'candidate' && record.kind === 'baseline';
    if (this.#candidateState?.prepared === record) {
      this.#retireStateRecord(this.#candidateState);
    }
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
    if (this.#currentStateOperation?.prepared === record) {
      this.#retireStateRecordLocally(this.#currentStateOperation);
    }
    if (this.#current === record) this.#currentState = null;
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

  #offerPreparationFor(
    offer: Readonly<FileMediaSourceOfferV2>,
  ): Readonly<FilePlaybackConnectionMediaOfferPreparation> {
    const existing = this.#offerPreparationsByQueue.get(offer.queueItemId);
    if (existing?.offer === offer && existing.status !== 'retired') {
      return existing.preparation;
    }
    if (existing) this.#retireOfferPreparationLocally(existing);

    const epoch = Object.freeze(
      Object.create(null),
    ) as FilePlaybackConnectionMediaOfferPreparationEpoch;
    const abortController = new AbortController();
    const fence = freezeCanonical({
      epoch,
      signal: abortController.signal,
      isCurrent: () => this.#isOfferPreparationEpochCurrent(epoch),
    });
    const preparation = freezeCanonical({
      offer,
      fence,
    }) as Readonly<FilePlaybackConnectionMediaOfferPreparation>;
    const record: OfferPreparationRecord = {
      preparation,
      offer,
      epoch,
      abortController,
      expiryTimerName: offerPreparationExpiryTimerName(offer),
      operation: null,
      expiryTimerArmed: false,
      status: 'offered',
    };
    this.#offerPreparations.set(preparation, record);
    this.#offerPreparationEpochs.set(epoch, record);
    this.#offerPreparationsByQueue.set(offer.queueItemId, record);
    this.#scheduleOfferPreparationExpiry(record);
    if (record.status === 'retired') {
      throw new Error('File playback source offer expired during preparation admission');
    }
    return preparation;
  }

  #scheduleOfferPreparationExpiry(record: OfferPreparationRecord): void {
    this.#clearOfferPreparationExpiry(record);
    if (
      this.#revoked ||
      record.status !== 'offered' ||
      this.#offerPreparationsByQueue.get(record.offer.queueItemId) !== record
    ) {
      return;
    }
    const nowRoomTimeMs = this.#readRoomTime();
    const remainingMs = record.offer.expiresAtRoomTimeMs - nowRoomTimeMs;
    if (remainingMs <= 0) {
      this.#offerRegistry.expire(this.#connectionToken, nowRoomTimeMs);
      this.#retireOfferPreparationLocally(record);
      return;
    }
    const delayMs = Math.max(1, Math.ceil(Math.min(remainingMs, MAX_EXPIRY_TIMER_DELAY_MS)));
    record.expiryTimerArmed = true;
    try {
      setManagedTimer(
        record.expiryTimerName,
        () => this.#handleOfferPreparationExpiryTimer(record),
        delayMs,
      );
    } catch {
      record.expiryTimerArmed = false;
      this.#retireOfferPreparationLocally(record);
      throw this.#fatal('The source-offer preparation expiry timer is unavailable');
    }
  }

  #handleOfferPreparationExpiryTimer(record: OfferPreparationRecord): void {
    record.expiryTimerArmed = false;
    if (
      this.#revoked ||
      record.status !== 'offered' ||
      this.#offerPreparationsByQueue.get(record.offer.queueItemId) !== record
    ) {
      return;
    }
    try {
      this.#mutate(() => this.#scheduleOfferPreparationExpiry(record));
    } catch {
      // Expiry is non-fatal; a broken clock or connection authority already fail-closes.
    }
  }

  #clearOfferPreparationExpiry(record: OfferPreparationRecord): void {
    if (!record.expiryTimerArmed) return;
    record.expiryTimerArmed = false;
    try {
      clearManagedTimer(record.expiryTimerName);
    } catch {
      // The exact record and fence remain authority-checked if the timer cannot be cleared.
    }
  }

  #retireOfferPreparationLocally(record: OfferPreparationRecord): void {
    if (record.status === 'retired') return;
    this.#clearOfferPreparationExpiry(record);
    if (!record.abortController.signal.aborted) {
      try {
        Reflect.apply(abortControllerAbort, record.abortController, []);
      } catch {
        // Record retirement remains authoritative if the platform is broken.
      }
    }
    record.status = 'retired';
    record.operation = null;
    this.#offerPreparations.delete(record.preparation);
    this.#offerPreparationEpochs.delete(record.epoch);
    if (this.#offerPreparationsByQueue.get(record.offer.queueItemId) === record) {
      this.#offerPreparationsByQueue.delete(record.offer.queueItemId);
    }
  }

  #consumeOfferPreparation(record: OfferPreparationRecord): void {
    if (record.status === 'consumed' || record.status === 'retired') return;
    this.#clearOfferPreparationExpiry(record);
    if (!record.abortController.signal.aborted) {
      try {
        Reflect.apply(abortControllerAbort, record.abortController, []);
      } catch {
        // Consumed identity remains inert even if the platform signal is broken.
      }
    }
    record.status = 'consumed';
    record.operation = null;
  }

  #retireAllOfferPreparations(): void {
    for (const record of [...this.#offerPreparationsByQueue.values()]) {
      this.#retireOfferPreparationLocally(record);
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

  #liveStateRecords(): StateOperationRecord[] {
    const records: StateOperationRecord[] = [];
    if (this.#candidateState) records.push(this.#candidateState);
    if (this.#currentStateOperation && this.#currentStateOperation !== this.#candidateState) {
      records.push(this.#currentStateOperation);
    }
    return records;
  }

  #retirePreparedRunAttemptRecord(record: PreparedRunAttemptRecord): void {
    if (record.status !== 'candidate' || record !== this.#candidatePreparedRunAttempt) {
      throw new Error('File playback prepared-run attempt is not the exact candidate');
    }
    try {
      Reflect.apply(channelRetireAttempt, this.#channel, [record.attemptLease]);
    } catch {
      throw this.#fatal('The shared channel rejected prepared-run attempt retirement');
    }
    this.#retirePreparedRunAttemptLocally(record);
  }

  #retirePreparedRunAttemptLocally(record: PreparedRunAttemptRecord | null): void {
    if (!record || record.status === 'retired') return;
    if (!record.abortController.signal.aborted) {
      try {
        Reflect.apply(abortControllerAbort, record.abortController, []);
      } catch {
        // Record retirement remains authoritative if the platform is broken.
      }
    }
    record.status = 'retired';
    this.#retiredPreparedRunAttempts.add(record.attempt);
    this.#retiredPreparedRunAttemptLeases.add(record.attemptLease);
    this.#preparedRunAttempts.delete(record.attempt);
    this.#preparedRunAttemptEpochs.delete(record.epoch);
    if (this.#candidatePreparedRunAttempt === record) {
      this.#candidatePreparedRunAttempt = null;
    }
    if (this.#currentPreparedRunAttempt === record) {
      this.#currentPreparedRunAttempt = null;
    }
  }

  #retireStateRecord(record: StateOperationRecord): void {
    if (record.status === 'retired') {
      throw new Error('File playback state operation is already retired');
    }
    if (record.status === 'candidate') {
      try {
        Reflect.apply(channelRetireMedia, this.#channel, [record.stateLease]);
      } catch {
        throw this.#fatal('The shared channel rejected exact state candidate retirement');
      }
    } else if (record.prepared !== this.#current) {
      throw this.#fatal('Committed state operation lost its prepared run authority');
    } else {
      throw new Error('The current state remains owned by its prepared run');
    }
    this.#retireStateRecordLocally(record);
  }

  #retireStateChannelBestEffort(record: StateOperationRecord): void {
    if (record.status !== 'candidate') return;
    try {
      Reflect.apply(channelRetireMedia, this.#channel, [record.stateLease]);
    } catch {
      // Revocation/fatal teardown still closes the exact internal authorities.
    }
  }

  #abortStateOperationFence(record: StateOperationRecord): void {
    if (record.abortController.signal.aborted) return;
    try {
      Reflect.apply(abortControllerAbort, record.abortController, []);
    } catch {
      // Record retirement remains authoritative if the platform is broken.
    }
  }

  #retireStateRecordLocally(record: StateOperationRecord | null): void {
    if (!record || record.status === 'retired') return;
    this.#abortStateOperationFence(record);
    record.status = 'retired';
    this.#retiredStatePreparations.add(record.preparation);
    this.#statePreparations.delete(record.preparation);
    if (record.operation) {
      this.#retiredStateOperations.add(record.operation);
      this.#stateOperations.delete(record.operation);
    }
    this.#stateOperationEpochs.delete(record.epoch);
    if (this.#candidateState === record) this.#candidateState = null;
    if (this.#currentStateOperation === record) this.#currentStateOperation = null;
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
    if (record.sourcePreparation) {
      this.#consumeOfferPreparation(record.sourcePreparation);
    }
    if (this.#candidatePreparedRunAttempt?.prepared === record) {
      this.#retirePreparedRunAttemptLocally(this.#candidatePreparedRunAttempt);
    }
    if (this.#currentPreparedRunAttempt?.prepared === record) {
      this.#retirePreparedRunAttemptLocally(this.#currentPreparedRunAttempt);
    }
    if (this.#candidateState?.prepared === record) {
      this.#retireStateRecordLocally(this.#candidateState);
    }
    if (this.#currentStateOperation?.prepared === record) {
      this.#retireStateRecordLocally(this.#currentStateOperation);
    }
    EXACT_OPERATION_AUTHORITIES.delete(record.operation as object);
    this.#abortOperationFence(record);
    record.status = 'retired';
    this.#retiredOperations.add(record.operation);
    this.#operations.delete(record.operation);
    this.#operationEpochs.delete(record.epoch);
    if (this.#candidate === record) this.#candidate = null;
    if (this.#current === record) {
      this.#current = null;
      this.#currentState = null;
    }
  }

  #fatal(message: string): FilePlaybackConnectionMediaSessionFatalError {
    if (this.#fatalError) return this.#fatalError;
    const error = new FilePlaybackConnectionMediaSessionFatalError(message);
    this.#fatalError = error;
    this.#fatalCallbackPending = true;
    this.#revoked = true;
    this.#abortFence();
    this.#retireAllOfferPreparations();
    const stateRecords = this.#liveStateRecords();
    for (const record of stateRecords) this.#abortStateOperationFence(record);
    if (this.#candidateState) this.#retireStateChannelBestEffort(this.#candidateState);
    for (const record of stateRecords) this.#retireStateRecordLocally(record);
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
    this.#retireAllOfferPreparations();
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

  #isOfferPreparationEpochCurrent(
    epoch: FilePlaybackConnectionMediaOfferPreparationEpoch,
  ): boolean {
    if (this.#revoked || this.#authoritiesClosed || this.#abortController.signal.aborted) {
      return false;
    }
    const record = this.#offerPreparationEpochs.get(epoch);
    if (
      !record ||
      record.epoch !== epoch ||
      record.status === 'consumed' ||
      record.status === 'retired' ||
      record.abortController.signal.aborted ||
      this.#offerPreparationsByQueue.get(record.offer.queueItemId) !== record
    ) {
      return false;
    }
    if (record.status === 'claimed') {
      const operation = record.operation;
      if (
        !operation ||
        operation.sourcePreparation !== record ||
        operation.status === 'retired' ||
        operation.abortController.signal.aborted ||
        (operation !== this.#candidate && operation !== this.#current)
      ) {
        return false;
      }
      if (operation.status === 'current') return this.#isEpochCurrent(this.#epoch);
    }
    const nowRoomTimeMs = this.#readFenceRoomTime();
    if (nowRoomTimeMs === null || nowRoomTimeMs >= record.offer.expiresAtRoomTimeMs) {
      return false;
    }
    return this.#isEpochCurrent(this.#epoch);
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

  #isStateOperationEpochCurrent(epoch: FilePlaybackConnectionMediaStateOperationEpoch): boolean {
    if (this.#revoked || this.#authoritiesClosed || this.#abortController.signal.aborted) {
      return false;
    }
    const record = this.#stateOperationEpochs.get(epoch);
    if (
      !record ||
      record.epoch !== epoch ||
      record.status === 'retired' ||
      record.abortController.signal.aborted ||
      record.prepared !== this.#current ||
      record.prepared.status !== 'current' ||
      (record !== this.#candidateState && record !== this.#currentStateOperation)
    ) {
      return false;
    }
    return this.#isEpochCurrent(this.#epoch);
  }

  #isPreparedRunAttemptEpochCurrent(
    epoch: FilePlaybackConnectionMediaPreparedRunAttemptEpoch,
  ): boolean {
    if (this.#revoked || this.#authoritiesClosed || this.#abortController.signal.aborted) {
      return false;
    }
    const record = this.#preparedRunAttemptEpochs.get(epoch);
    if (
      !record ||
      record.epoch !== epoch ||
      record.status === 'retired' ||
      record.abortController.signal.aborted ||
      record.prepared.channelStateLease !== record.stateLease ||
      (record.status === 'candidate' &&
        (record !== this.#candidatePreparedRunAttempt || record.prepared !== this.#candidate)) ||
      (record.status === 'current' &&
        (record !== this.#currentPreparedRunAttempt || record.prepared !== this.#current))
    ) {
      return false;
    }
    return this.#isEpochCurrent(this.#epoch);
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
      candidateState: this.#candidateState ? stateOperationSnapshot(this.#candidateState) : null,
      currentState: this.#currentState,
    });
  }
}
