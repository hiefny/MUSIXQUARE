import type {
  FilePlaybackPeerRangeAdoptionEvent,
  FilePlaybackWireAdoptionEvent,
} from '../network/file-playback-application-session.ts';
import type { FilePlaybackApplicationControllerConnectionSnapshot } from './file-playback-application-controller.ts';
import { FilePlaybackConnectionChannel } from '../network/file-playback-connection-channel.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import type { DataConnection } from '../types/index.ts';
import {
  createFileMediaPrepareId,
  createPeerRangeFileMediaSourceOfferV2,
  createR2WholeBlobFileMediaSourceOfferV2,
  type FileMediaSourceOfferV2,
} from './file-media-source-offer.ts';
import type {
  HostPeerPlaybackPublication,
  HostPeerRangeSource,
  HostRemoteRecoveryCommit,
  RecoverHostRemoteParticipantOptions,
  ResolveHostPeerRangeSourceOptions,
} from './file-playback-host-first-file-engine.ts';
import { FilePlaybackR2WholeBlobPublisher } from './file-playback-r2-whole-blob-publisher.ts';
import {
  createFilePlaybackRunBindingV2,
  type FilePlaybackRunBindingV2,
} from './file-playback-run-binding.ts';
import type {
  FilePlaybackProductSessionRouterConnectionContext,
  FilePlaybackProductSessionRouterHostMediaOwnerPort,
} from './file-playback-product-session-router.ts';
import type { HostRendezvousAttempt } from './rendezvous-coordinator.ts';
import { RemoteRendezvousParticipant } from './remote-rendezvous-participant.ts';
import {
  ParticipantHealthMonitor,
  type ParticipantHealthAction,
  type ParticipantHealthSignal,
  type ParticipantHealthTransition,
} from './participant-health.ts';
import type {
  FilePlaybackWireAttemptLease,
  FilePlaybackWireLease,
  FilePlaybackWireStateLease,
} from './file-playback-wire-binding.ts';
import type {
  FilePlaybackWireMessageForKind,
  FilePlaybackWirePayloadByKind,
} from './file-playback-wire-sender.ts';
import {
  bindPeerRangeTrustedConnection,
  PeerRangeHostResponder,
} from './sources/peer-range-transport.ts';
import {
  parsePeerRangeControlFrame,
  type PeerRangeBulkFrame,
} from './sources/peer-range-protocol.ts';
import type { EncodedAudioSource } from './sources/encoded-audio-source.ts';

const OPTION_KEYS = Object.freeze([
  'closeConnection',
  'context',
  'hostRoom',
  'onHealthSystemMessage',
  'publisher',
  'runtimeForTests',
  'sendRequired',
  'sendWire',
] as const);
const REQUIRED_OPTION_KEYS = OPTION_KEYS.filter((key) => key !== 'runtimeForTests');
const RUNTIME_KEYS = Object.freeze([
  'cancelIntervalForTests',
  'createMediaIdForTests',
  'nowEpochMsForTests',
  'scheduleIntervalForTests',
] as const);
const CONTEXT_KEYS = Object.freeze([
  'channel',
  'connection',
  'connectionId',
  'connectionToken',
  'guestParticipantId',
  'hostParticipantId',
  'role',
  'routerToken',
  'schemaVersion',
  'sessionId',
] as const);
const WIRE_EVENT_KEYS = Object.freeze([
  'attemptLease',
  'channel',
  'connection',
  'message',
  'stateLease',
] as const);
const PEER_RANGE_EVENT_KEYS = Object.freeze([
  'channel',
  'connection',
  'connectionToken',
  'frame',
  'lane',
  'role',
] as const);
const READY_KEYS = Object.freeze([
  'baselineId',
  'baselineStatus',
  'clockReady',
  'connectionId',
  'epoch',
  'playbackRevision',
  'ready',
  'role',
  'roomGeneration',
  'schemaVersion',
  'sessionId',
] as const);
const PEER_RANGE_BUFFERED_AMOUNT_LIMIT = 256 * 1024;
const PUBLICATION_LIFETIME_MS = 15 * 60 * 1_000;
const HEALTH_LEASE_MS = 2_000;
const HEALTH_TICK_MS = 250;

type ExactRecord = Readonly<Record<string, unknown>>;
type TimerHandle = string;
let healthTimerSequence = 0;

export interface FilePlaybackProductHostMediaRoomPort {
  currentPeerPublication(): Readonly<HostPeerPlaybackPublication> | null;
  resolveCurrentPeerRangeSource(
    options: ResolveHostPeerRangeSourceOptions,
  ): Promise<HostPeerRangeSource>;
  recoverRemoteParticipant(
    options: RecoverHostRemoteParticipantOptions,
  ): Promise<Readonly<HostRemoteRecoveryCommit>>;
}

export interface FilePlaybackProductHostHealthSystemMessage {
  readonly schemaVersion: 1;
  readonly participantId: string;
  readonly messageKey: 'participant-connection-unstable-recovering';
}

export interface FilePlaybackProductHostMediaOwnerRuntimeForTests {
  readonly createMediaIdForTests?: () => string;
  readonly nowEpochMsForTests?: () => number;
  readonly scheduleIntervalForTests?: (callback: () => void, delayMs: number) => TimerHandle;
  readonly cancelIntervalForTests?: (handle: TimerHandle) => void;
}

export interface FilePlaybackProductHostMediaOwnerOptions {
  readonly context: Readonly<FilePlaybackProductSessionRouterConnectionContext>;
  readonly hostRoom: FilePlaybackProductHostMediaRoomPort;
  readonly publisher: FilePlaybackR2WholeBlobPublisher;
  readonly sendRequired: (connection: DataConnection, frame: unknown) => boolean;
  readonly sendWire: <Kind extends keyof FilePlaybackWirePayloadByKind>(
    connection: DataConnection,
    lease: FilePlaybackWireLease,
    payload: FilePlaybackWirePayloadByKind[Kind],
  ) => FilePlaybackWireMessageForKind<Kind> | null;
  readonly closeConnection: (connection: DataConnection) => void;
  readonly onHealthSystemMessage: (
    message: Readonly<FilePlaybackProductHostHealthSystemMessage>,
  ) => void;
  readonly runtimeForTests?: FilePlaybackProductHostMediaOwnerRuntimeForTests;
}

export interface FilePlaybackProductHostPublicationCommit {
  readonly schemaVersion: 1;
  readonly publication: Readonly<HostPeerPlaybackPublication>;
  readonly offer: Readonly<FileMediaSourceOfferV2>;
  readonly binding: Readonly<FilePlaybackRunBindingV2>;
}

interface RuntimeSnapshot {
  readonly createMediaId: () => string;
  readonly nowEpochMs: () => number;
  readonly scheduleInterval: (callback: () => void, delayMs: number) => TimerHandle;
  readonly cancelInterval: (handle: TimerHandle) => void;
}

interface PublicationRecord {
  readonly epoch: number;
  readonly publication: Readonly<HostPeerPlaybackPublication>;
  readonly offer: Readonly<FileMediaSourceOfferV2>;
  readonly binding: Readonly<FilePlaybackRunBindingV2>;
  readonly stateLease: FilePlaybackWireStateLease;
  readonly handleId: string | null;
  readonly commit: Readonly<FilePlaybackProductHostPublicationCommit>;
  participant: RemoteRendezvousParticipant | null;
  status: 'publishing' | 'published';
}

interface AttemptRecord {
  readonly publicationEpoch: number;
  readonly participant: RemoteRendezvousParticipant;
  readonly attempt: HostRendezvousAttempt;
  readonly lease: FilePlaybackWireAttemptLease;
  readonly evidence: Promise<void>;
  readonly resolveEvidence: () => void;
  readonly rejectEvidence: (error: Error) => void;
  status: 'candidate' | 'current' | 'retired';
}

class HostMediaOwnerConnectionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'HostMediaOwnerConnectionError';
  }
}

const trustedChannelRole = FilePlaybackConnectionChannel.prototype.role;
const trustedChannelBinding = FilePlaybackConnectionChannel.prototype.establishedBinding;
const trustedChannelToken = FilePlaybackConnectionChannel.prototype.liveConnectionToken;
const trustedChannelClosed = FilePlaybackConnectionChannel.prototype.isClosed;
const trustedChannelNow = FilePlaybackConnectionChannel.prototype.nowRoomTimeMs;
const trustedChannelQuality = FilePlaybackConnectionChannel.prototype.quality;
const trustedChannelClockReady = FilePlaybackConnectionChannel.prototype.clockReady;
const trustedChannelBootstrapCurrent =
  FilePlaybackConnectionChannel.prototype.bootstrapCurrentMedia;
const trustedChannelStageMedia = FilePlaybackConnectionChannel.prototype.stageMedia;
const trustedChannelCommitMedia = FilePlaybackConnectionChannel.prototype.commitMedia;
const trustedChannelStageAttempt = FilePlaybackConnectionChannel.prototype.stageAttempt;
const trustedChannelCommitAttempt = FilePlaybackConnectionChannel.prototype.commitAttempt;
const trustedChannelRetireAttempt = FilePlaybackConnectionChannel.prototype.retireAttempt;

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function snapshotExactRecord(value: unknown, expectedKeys: readonly string[]): ExactRecord | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const expected = new Set(expectedKeys);
    const ownKeys = Reflect.ownKeys(descriptors);
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

function snapshotOptions(value: unknown): ExactRecord | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const allowed = new Set<string>(OPTION_KEYS);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (
      ownKeys.some((key) => typeof key !== 'string' || !allowed.has(key)) ||
      REQUIRED_OPTION_KEYS.some((key) => !Object.hasOwn(descriptors, key))
    ) {
      return null;
    }
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of OPTION_KEYS) {
      const descriptor = descriptors[key];
      if (!descriptor) {
        snapshot[key] = undefined;
        continue;
      }
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function runtimeSnapshot(value: unknown): RuntimeSnapshot | null {
  if (value === undefined) {
    return freezeCanonical({
      createMediaId: () => createFileMediaPrepareId(),
      nowEpochMs: () => Date.now(),
      scheduleInterval: (callback: () => void, delayMs: number) => {
        const name = `file-playback-host-media-health-${++healthTimerSequence}`;
        setManagedTimer(name, callback, delayMs, { interval: true });
        return name;
      },
      cancelInterval: (handle: TimerHandle) => clearManagedTimer(handle),
    });
  }
  const snapshot = snapshotExactRecord(
    value,
    RUNTIME_KEYS.filter((key) => Object.hasOwn(value as object, key)),
  );
  if (!snapshot) return null;
  const createMediaId = snapshot.createMediaIdForTests;
  const nowEpochMs = snapshot.nowEpochMsForTests;
  const scheduleInterval = snapshot.scheduleIntervalForTests;
  const cancelInterval = snapshot.cancelIntervalForTests;
  if (
    (createMediaId !== undefined && typeof createMediaId !== 'function') ||
    (nowEpochMs !== undefined && typeof nowEpochMs !== 'function') ||
    (scheduleInterval !== undefined && typeof scheduleInterval !== 'function') ||
    (cancelInterval !== undefined && typeof cancelInterval !== 'function')
  ) {
    return null;
  }
  return freezeCanonical({
    createMediaId:
      (createMediaId as (() => string) | undefined) ?? (() => createFileMediaPrepareId()),
    nowEpochMs: (nowEpochMs as (() => number) | undefined) ?? (() => Date.now()),
    scheduleInterval:
      (scheduleInterval as RuntimeSnapshot['scheduleInterval'] | undefined) ??
      ((callback, delayMs) => {
        const name = `file-playback-host-media-health-${++healthTimerSequence}`;
        setManagedTimer(name, callback, delayMs, { interval: true });
        return name;
      }),
    cancelInterval:
      (cancelInterval as RuntimeSnapshot['cancelInterval'] | undefined) ??
      ((handle) => clearManagedTimer(handle)),
  });
}

function isEncodedSource(value: HostPeerRangeSource): value is EncodedAudioSource {
  return !(value instanceof Blob);
}

function asError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message, { cause: value });
}

function observe(task: Promise<unknown>): void {
  void task.catch(() => undefined);
}

function deferredEvidence(): Readonly<{
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}> {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  let settled = false;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    };
    reject = (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
  });
  observe(promise);
  return freezeCanonical({ promise, resolve, reject });
}

/**
 * One exact host->guest media owner. Room media and R2 lifetimes are injected;
 * revoking this owner can therefore isolate one peer without stopping either.
 */
export class FilePlaybackProductHostMediaOwner {
  readonly #context: Readonly<FilePlaybackProductSessionRouterConnectionContext>;
  readonly #hostRoom: FilePlaybackProductHostMediaRoomPort;
  readonly #publisher: FilePlaybackR2WholeBlobPublisher;
  readonly #sendRequired: FilePlaybackProductHostMediaOwnerOptions['sendRequired'];
  readonly #sendWire: FilePlaybackProductHostMediaOwnerOptions['sendWire'];
  readonly #closeConnection: FilePlaybackProductHostMediaOwnerOptions['closeConnection'];
  readonly #onHealthSystemMessage: FilePlaybackProductHostMediaOwnerOptions['onHealthSystemMessage'];
  readonly #runtime: RuntimeSnapshot;
  readonly #port: Readonly<FilePlaybackProductSessionRouterHostMediaOwnerPort>;
  readonly #health: ParticipantHealthMonitor;
  readonly #responder: PeerRangeHostResponder;
  readonly #healthTimer: TimerHandle;
  #publicationEpoch = 0;
  #publicationController = new AbortController();
  #prepareRevision = 0;
  #wireBootstrapped = false;
  #publication: PublicationRecord | null = null;
  #publicationTask: Promise<Readonly<FilePlaybackProductHostPublicationCommit>> | null = null;
  #publicationTaskIdentity: Readonly<HostPeerPlaybackPublication> | null = null;
  #attempt: AttemptRecord | null = null;
  readonly #attemptsById = new Map<string, AttemptRecord>();
  #closed = false;
  #fatal = false;

  constructor(options: FilePlaybackProductHostMediaOwnerOptions) {
    const input = snapshotOptions(options);
    const context = snapshotExactRecord(input?.context, CONTEXT_KEYS);
    const runtime = runtimeSnapshot(input?.runtimeForTests);
    if (
      !input ||
      !context ||
      !runtime ||
      context.schemaVersion !== 1 ||
      context.role !== 'host' ||
      !(context.channel instanceof FilePlaybackConnectionChannel) ||
      context.connection === null ||
      typeof context.connection !== 'object' ||
      context.connectionToken === null ||
      typeof context.connectionToken !== 'object' ||
      context.routerToken === null ||
      typeof context.routerToken !== 'object' ||
      typeof context.sessionId !== 'string' ||
      typeof context.connectionId !== 'string' ||
      typeof context.hostParticipantId !== 'string' ||
      typeof context.guestParticipantId !== 'string' ||
      input.hostRoom === null ||
      typeof input.hostRoom !== 'object' ||
      typeof (input.hostRoom as Partial<FilePlaybackProductHostMediaRoomPort>)
        .currentPeerPublication !== 'function' ||
      typeof (input.hostRoom as Partial<FilePlaybackProductHostMediaRoomPort>)
        .resolveCurrentPeerRangeSource !== 'function' ||
      typeof (input.hostRoom as Partial<FilePlaybackProductHostMediaRoomPort>)
        .recoverRemoteParticipant !== 'function' ||
      input.publisher === null ||
      typeof input.publisher !== 'object' ||
      Reflect.getPrototypeOf(input.publisher) !== FilePlaybackR2WholeBlobPublisher.prototype ||
      typeof input.sendRequired !== 'function' ||
      typeof input.sendWire !== 'function' ||
      typeof input.closeConnection !== 'function' ||
      typeof input.onHealthSystemMessage !== 'function'
    ) {
      throw new TypeError('File playback product host media owner options are invalid');
    }
    const channel = context.channel as FilePlaybackConnectionChannel;
    const binding = Reflect.apply(trustedChannelBinding, channel, []);
    if (
      Reflect.apply(trustedChannelRole, channel, []) !== 'host' ||
      Reflect.apply(trustedChannelClosed, channel, []) ||
      Reflect.apply(trustedChannelToken, channel, []) !== context.connectionToken ||
      !binding ||
      binding.sessionId !== context.sessionId ||
      binding.connectionId !== context.connectionId ||
      binding.hostParticipantId !== context.hostParticipantId ||
      binding.guestParticipantId !== context.guestParticipantId
    ) {
      throw new Error('Host media owner connection context is stale');
    }

    this.#context = input.context as Readonly<FilePlaybackProductSessionRouterConnectionContext>;
    this.#hostRoom = input.hostRoom as FilePlaybackProductHostMediaRoomPort;
    this.#publisher = input.publisher as FilePlaybackR2WholeBlobPublisher;
    this.#sendRequired =
      input.sendRequired as FilePlaybackProductHostMediaOwnerOptions['sendRequired'];
    this.#sendWire = input.sendWire as FilePlaybackProductHostMediaOwnerOptions['sendWire'];
    this.#closeConnection =
      input.closeConnection as FilePlaybackProductHostMediaOwnerOptions['closeConnection'];
    this.#onHealthSystemMessage =
      input.onHealthSystemMessage as FilePlaybackProductHostMediaOwnerOptions['onHealthSystemMessage'];
    this.#runtime = runtime;

    const now = this.#nowRoomTimeMs();
    this.#health = new ParticipantHealthMonitor({
      participantId: this.#context.guestParticipantId,
      now: () => this.#nowRoomTimeMs(),
      initialLeaseUntilMs: now + HEALTH_LEASE_MS,
      degradationGraceMs: 1_500,
    });
    const trustedPeerContext = bindPeerRangeTrustedConnection(
      this.#context.connectionToken,
      this.#context.connectionId,
    );
    this.#responder = new PeerRangeHostResponder({
      connection: trustedPeerContext,
      sources: {
        resolve: (sourceIdentity, signal) => this.#resolvePeerSource(sourceIdentity, signal),
      },
      onFatalConnection: (_connection, error) => this.#failConnection(error),
      canSend: () => this.#canSendPeerRange(),
      sendBulk: (frame) => this.#sendPeerRangeBulk(frame),
    });
    this.#healthTimer = this.#runtime.scheduleInterval(() => this.#tickHealth(), HEALTH_TICK_MS);
    this.#port = freezeCanonical({
      onHostReady: (snapshot: Readonly<FilePlaybackApplicationControllerConnectionSnapshot>) =>
        this.#onHostReady(snapshot),
      adoptWireMessage: (event: Readonly<FilePlaybackWireAdoptionEvent>, acknowledge: () => void) =>
        this.#adoptWireMessage(event, acknowledge),
      adoptPeerRangeControl: (
        event: Readonly<FilePlaybackPeerRangeAdoptionEvent>,
        acknowledge: () => void,
      ) => this.#adoptPeerRangeControl(event, acknowledge),
      revoke: (revokeContext: Readonly<FilePlaybackProductSessionRouterConnectionContext>) =>
        this.#revoke(revokeContext),
    });
  }

  port(): Readonly<FilePlaybackProductSessionRouterHostMediaOwnerPort> {
    return this.#port;
  }

  publishCurrent(): Promise<Readonly<FilePlaybackProductHostPublicationCommit>> {
    if (this.#closed) return Promise.reject(new Error('Host media owner is closed'));
    const publication = this.#hostRoom.currentPeerPublication();
    if (!publication) {
      return Promise.reject(new Error('Host media owner has no current peer publication'));
    }
    if (this.#publication?.publication === publication) {
      return Promise.resolve(this.#publication.commit);
    }
    if (this.#publicationTask && this.#publicationTaskIdentity === publication) {
      return this.#publicationTask;
    }
    this.#publicationEpoch += 1;
    const epoch = this.#publicationEpoch;
    this.#publicationController.abort(new Error('Host media publication was superseded'));
    this.#publicationController = new AbortController();
    this.#retireAttempt(new Error('Host media publication was superseded'));
    this.#revokePublishedHandle(new Error('Host media publication was superseded'));
    this.#publication = null;
    const task = this.#publish(publication, epoch).finally(() => {
      if (this.#publicationTask === task) {
        this.#publicationTask = null;
        this.#publicationTaskIdentity = null;
      }
    });
    this.#publicationTask = task;
    this.#publicationTaskIdentity = publication;
    return task;
  }

  setDocumentHidden(hidden: boolean): void {
    if (this.#closed) return;
    this.#applyHealth(this.#health.setDocumentHidden(hidden));
  }

  #onHostReady(value: Readonly<FilePlaybackApplicationControllerConnectionSnapshot>): void {
    const snapshot = snapshotExactRecord(value, READY_KEYS);
    if (
      !snapshot ||
      snapshot.schemaVersion !== 1 ||
      snapshot.role !== 'host' ||
      snapshot.sessionId !== this.#context.sessionId ||
      snapshot.connectionId !== this.#context.connectionId ||
      snapshot.baselineStatus !== 'ready' ||
      snapshot.clockReady !== true ||
      snapshot.ready !== true
    ) {
      throw new TypeError('Host media owner READY snapshot is invalid');
    }
    queueMicrotask(() => observe(this.publishCurrent()));
  }

  async #publish(
    publication: Readonly<HostPeerPlaybackPublication>,
    epoch: number,
  ): Promise<Readonly<FilePlaybackProductHostPublicationCommit>> {
    await Promise.resolve();
    this.#assertPublicationAuthority(publication, epoch);
    const prepareRevision = this.#nextPrepareRevision();
    const prepareId = this.#freshMediaId([
      publication.state.queueItemId,
      publication.state.runId,
      publication.asset.binding.sourceIdentity,
      publication.asset.binding.transferSessionId,
    ]);
    const nowRoomTimeMs = this.#nowRoomTimeMs();
    const base = {
      sessionId: this.#context.sessionId,
      connectionId: this.#context.connectionId,
      prepareId,
      prepareRevision,
      queueItemId: publication.state.queueItemId,
      sourceIdentity: publication.asset.binding.sourceIdentity,
      transferSessionId: publication.asset.binding.transferSessionId,
      encodedSize: publication.asset.encodedSize,
      name: publication.asset.metadata.name,
      mime: publication.asset.metadata.mime,
    } as const;

    let handleId: string | null = null;
    let offer: Readonly<FileMediaSourceOfferV2>;
    if (publication.backend === 'streaming-flac') {
      handleId = this.#freshMediaId([
        prepareId,
        publication.state.queueItemId,
        publication.asset.binding.sourceIdentity,
        publication.asset.binding.transferSessionId,
      ]);
      offer = createPeerRangeFileMediaSourceOfferV2({
        ...base,
        handleId,
        expiresAtRoomTimeMs: nowRoomTimeMs + PUBLICATION_LIFETIME_MS,
      });
    } else {
      const source = await this.#hostRoom.resolveCurrentPeerRangeSource({
        publication,
        sourceIdentity: publication.asset.binding.sourceIdentity,
        signal: this.#publicationSignal(epoch),
      });
      if (!(source instanceof Blob)) {
        await source.close().catch(() => undefined);
        throw new Error('Ordinary host publication requires its exact Blob source');
      }
      this.#assertPublicationAuthority(publication, epoch);
      const published = await this.#publisher.publish({
        queueItemId: publication.state.queueItemId,
        sourceIdentity: publication.asset.binding.sourceIdentity,
        transferSessionId: publication.asset.binding.transferSessionId,
        blob: source,
        name: publication.asset.metadata.name,
        mime: publication.asset.metadata.mime,
      });
      this.#assertPublicationAuthority(publication, epoch);
      const epochNow = this.#runtime.nowEpochMs();
      if (!Number.isFinite(epochNow) || epochNow < 0) {
        throw new Error('Host media owner epoch clock is invalid');
      }
      offer = createR2WholeBlobFileMediaSourceOfferV2({
        ...base,
        storageRoomId: published.storageRoomId,
        objectId: published.objectId,
        encryptedSize: published.encryptedSize,
        keyB64: published.keyB64,
        ivB64: published.ivB64,
        expiresAtRoomTimeMs:
          this.#nowRoomTimeMs() + Math.max(0, published.expiresAtEpochMs - epochNow),
      });
    }

    this.#assertPublicationAuthority(publication, epoch);
    const binding = createFilePlaybackRunBindingV2({
      sessionId: this.#context.sessionId,
      connectionId: this.#context.connectionId,
      prepareId: offer.prepareId,
      prepareRevision: offer.prepareRevision,
      queueItemId: offer.queueItemId,
      sourceIdentity: offer.sourceIdentity,
      transferSessionId: offer.transferSessionId,
      runId: publication.state.runId,
      playbackRevision: publication.state.revision,
    });
    const stateLease = this.#installCurrentState(publication);
    const commit = freezeCanonical({
      schemaVersion: 1 as const,
      publication,
      offer,
      binding,
    });
    const record: PublicationRecord = {
      epoch,
      publication,
      offer,
      binding,
      stateLease,
      handleId,
      commit,
      participant: null,
      status: 'publishing',
    };
    this.#publication = record;
    await Promise.resolve();
    this.#assertRecord(record);
    this.#sendRequiredFrame(offer);
    await Promise.resolve();
    this.#assertRecord(record);
    this.#sendRequiredFrame(binding);
    this.#assertRecord(record);
    record.status = 'published';
    return commit;
  }

  #installCurrentState(
    publication: Readonly<HostPeerPlaybackPublication>,
  ): FilePlaybackWireStateLease {
    const binding = freezeCanonical({
      run: publication.state,
      sourceIdentity: publication.asset.binding.sourceIdentity,
      transferSessionId: publication.asset.binding.transferSessionId,
    });
    if (!this.#wireBootstrapped) {
      const lease = Reflect.apply(trustedChannelBootstrapCurrent, this.#context.channel, [binding]);
      this.#wireBootstrapped = true;
      return lease;
    }
    const lease = Reflect.apply(trustedChannelStageMedia, this.#context.channel, [binding]);
    Reflect.apply(trustedChannelCommitMedia, this.#context.channel, [lease]);
    return lease;
  }

  #adoptWireMessage(value: Readonly<FilePlaybackWireAdoptionEvent>, acknowledge: () => void): void {
    const event = snapshotExactRecord(value, WIRE_EVENT_KEYS);
    if (!event || typeof acknowledge !== 'function') {
      throw new TypeError('Host media owner wire adoption is invalid');
    }
    this.#assertEventConnection(event);
    const message = event.message as FilePlaybackWireAdoptionEvent['message'];
    const record = this.#publication;
    if (!record || record.status !== 'published') {
      throw new Error('Host media owner received wire before publication');
    }

    if (message.kind === 'source-ready' || message.kind === 'source-not-ready') {
      if (event.stateLease !== record.stateLease || event.attemptLease !== null) {
        acknowledge();
        return;
      }
      this.#assertMessagePublication(message, record.publication);
      if (message.kind === 'source-not-ready') {
        this.#reportHealth({
          dimension: 'media-readiness',
          value: 'unhealthy',
          observedAtMs: message.observedAtRoomTimeMs,
          leaseUntilMs: message.observedAtRoomTimeMs,
          reasonCode: message.reasonCode,
        });
        acknowledge();
        return;
      }
      if (message.backend !== record.publication.backend) {
        throw new Error('Guest SOURCE_READY backend does not match host publication');
      }
      this.#reportHealth({
        dimension: 'media-readiness',
        value: 'healthy',
        observedAtMs: message.observedAtRoomTimeMs,
        leaseUntilMs: message.readyLeaseUntilRoomTimeMs,
      });
      acknowledge();
      // A paused late join is already correct after the guest commits its
      // prepared paused baseline. Only an actively playing publication needs
      // a physical ARM/FINALIZE recovery attempt.
      if (record.publication.timeline.phase === 'playing') {
        queueMicrotask(() => this.#beginRecovery(record));
      }
      return;
    }

    const attempt = this.#attempt;
    if (
      !attempt ||
      event.stateLease !== record.stateLease ||
      event.attemptLease !== attempt.lease
    ) {
      acknowledge();
      return;
    }
    this.#assertMessagePublication(message, record.publication);
    if (!('rendezvousId' in message) || message.rendezvousId !== attempt.attempt.rendezvousId) {
      acknowledge();
      return;
    }
    if (message.kind === 'rendezvous-armed') {
      const accepted = attempt.participant.acceptArmReceipt({
        protocolVersion: 2,
        kind: 'rendezvous-armed',
        queueItemId: message.queueItemId,
        runId: message.runId,
        revision: message.revision,
        rendezvousId: message.rendezvousId,
        participantId: message.senderParticipantId,
        status: message.status,
        observedAtRoomTimeMs: message.observedAtRoomTimeMs,
        bufferedAheadSeconds: message.bufferedAheadSeconds,
        reasonCode: message.reasonCode,
      });
      if (!accepted) throw new Error('Guest rendezvous ARM receipt was stale or invalid');
      acknowledge();
      return;
    }
    if (message.kind === 'rendezvous-finalized') {
      const accepted = attempt.participant.acceptFinalizeReceipt({
        protocolVersion: 2,
        kind: 'rendezvous-finalized',
        queueItemId: message.queueItemId,
        runId: message.runId,
        revision: message.revision,
        rendezvousId: message.rendezvousId,
        participantId: message.senderParticipantId,
        status: message.status,
        observedAtRoomTimeMs: message.observedAtRoomTimeMs,
        reasonCode: message.reasonCode,
      });
      if (!accepted) throw new Error('Guest rendezvous FINALIZE receipt was stale or invalid');
      acknowledge();
      return;
    }
    if (message.kind === 'renderer-health') {
      const accepted = attempt.participant.acceptRendererStartEvidence(message);
      this.#reportHealth({
        dimension: 'renderer',
        value: message.value,
        observedAtMs: message.observedAtRoomTimeMs,
        leaseUntilMs:
          message.value === 'healthy' ? message.leaseUntilRoomTimeMs : message.observedAtRoomTimeMs,
        reasonCode: message.reasonCode,
      });
      if (message.value === 'healthy' && accepted) {
        attempt.resolveEvidence();
        this.#reportHealth({
          dimension: 'media-readiness',
          value: 'healthy',
          observedAtMs: message.observedAtRoomTimeMs,
          leaseUntilMs: message.leaseUntilRoomTimeMs,
        });
      }
      acknowledge();
      return;
    }
    throw new Error(`Host media owner cannot consume ${message.kind}`);
  }

  #adoptPeerRangeControl(
    value: Readonly<FilePlaybackPeerRangeAdoptionEvent>,
    acknowledge: () => void,
  ): void {
    const event = snapshotExactRecord(value, PEER_RANGE_EVENT_KEYS);
    if (!event || typeof acknowledge !== 'function') {
      throw new TypeError('Host media owner peer-range adoption is invalid');
    }
    this.#assertEventConnection(event);
    if (event.role !== 'host' || event.lane !== 'control') {
      throw new Error('Host media owner received the wrong peer-range lane');
    }
    const record = this.#publication;
    if (
      !record ||
      record.status !== 'published' ||
      !record.handleId ||
      record.offer.transport !== 'peer-range'
    ) {
      throw new Error('Host media owner has no peer-range publication');
    }
    const frame = parsePeerRangeControlFrame(event.frame);
    if (
      frame.connectionId !== this.#context.connectionId ||
      frame.sourceIdentity !== record.publication.asset.binding.sourceIdentity ||
      frame.handleId !== record.handleId
    ) {
      throw new Error('Peer-range request does not match the current publication');
    }
    this.#responder.acceptControl(this.#context.connectionToken, frame);
    acknowledge();
  }

  #beginRecovery(record: PublicationRecord, force = false): void {
    if (this.#closed || this.#publication !== record) return;
    if (
      this.#attempt?.publicationEpoch === record.epoch &&
      (this.#attempt.status === 'candidate' || (!force && this.#attempt.status === 'current'))
    ) {
      return;
    }
    const participant =
      record.participant ??
      new RemoteRendezvousParticipant({
        participantId: this.#context.guestParticipantId,
        rendererEvidenceScope: freezeCanonical({
          sessionId: this.#context.sessionId,
          connectionId: this.#context.connectionId,
          recipientParticipantId: this.#context.hostParticipantId,
          sourceIdentity: record.publication.asset.binding.sourceIdentity,
          transferSessionId: record.publication.asset.binding.transferSessionId,
        }),
        rttP95Ms: () => Reflect.apply(trustedChannelQuality, this.#context.channel, []).rttP95Ms,
        armP95Ms: 0,
        nowRoomTimeMs: () => this.#nowRoomTimeMs(),
        dispatchArm: (intent) =>
          this.#dispatchAttemptWire('rendezvous-arm', intent.rendezvousId, {
            kind: 'rendezvous-arm',
            rendezvousId: intent.rendezvousId,
            positionSeconds: intent.positionSeconds,
            playbackRate: intent.playbackRate,
            startAtRoomTimeMs: intent.startAtRoomTimeMs,
            finalizeByRoomTimeMs: intent.finalizeByRoomTimeMs,
          }),
        dispatchFinalize: (intent) =>
          this.#dispatchAttemptWire('rendezvous-finalize', intent.rendezvousId, {
            kind: 'rendezvous-finalize',
            rendezvousId: intent.rendezvousId,
            startAtRoomTimeMs: intent.startAtRoomTimeMs,
            finalizedAtRoomTimeMs: intent.finalizedAtRoomTimeMs,
          }),
        dispatchCancel: (intent) =>
          this.#dispatchAttemptWire('file-playback-cancel', intent.rendezvousId, {
            kind: 'file-playback-cancel',
            rendezvousId: intent.rendezvousId,
            reasonCode: intent.reasonCode,
          }),
      });
    record.participant = participant;
    const evidence = deferredEvidence();
    const recovery = this.#hostRoom.recoverRemoteParticipant({
      publication: record.publication,
      participant,
      signal: this.#publicationSignal(record.epoch),
      bindAttempt: (attempt) => {
        if (this.#closed || this.#publication !== record) {
          return Promise.reject(new Error('Host media recovery publication is stale'));
        }
        const lease = Reflect.apply(trustedChannelStageAttempt, this.#context.channel, [
          record.stateLease,
          attempt.rendezvousId,
        ]);
        const previous = this.#attempt;
        if (previous?.status === 'candidate') this.#retireAttemptLease(previous);
        this.#attempt = {
          publicationEpoch: record.epoch,
          participant,
          attempt,
          lease,
          evidence: evidence.promise,
          resolveEvidence: evidence.resolve,
          rejectEvidence: evidence.reject,
          status: 'candidate',
        };
        this.#attemptsById.set(attempt.rendezvousId, this.#attempt);
        return evidence.promise;
      },
    });
    observe(
      recovery.then(
        () => this.#commitRecovery(record, participant),
        (error) => this.#rejectRecovery(record, participant, error),
      ),
    );
  }

  #commitRecovery(record: PublicationRecord, participant: RemoteRendezvousParticipant): void {
    const attempt = this.#attempt;
    if (
      !attempt ||
      this.#closed ||
      this.#publication !== record ||
      attempt.participant !== participant ||
      attempt.publicationEpoch !== record.epoch ||
      attempt.status !== 'candidate'
    ) {
      return;
    }
    Reflect.apply(trustedChannelCommitAttempt, this.#context.channel, [attempt.lease]);
    attempt.status = 'current';
    for (const [rendezvousId, stale] of this.#attemptsById) {
      if (stale === attempt) continue;
      stale.status = 'retired';
      this.#attemptsById.delete(rendezvousId);
    }
    this.#applyHealth(this.#health.completeRejoin(true));
  }

  #rejectRecovery(
    record: PublicationRecord,
    participant: RemoteRendezvousParticipant,
    error: unknown,
  ): void {
    const attempt = this.#attempt;
    if (
      attempt &&
      this.#publication === record &&
      attempt.participant === participant &&
      attempt.publicationEpoch === record.epoch &&
      attempt.status === 'candidate'
    ) {
      attempt.rejectEvidence(asError(error, 'Host participant recovery failed'));
      this.#retireAttemptLease(attempt);
      this.#attemptsById.delete(attempt.attempt.rendezvousId);
      if (this.#attempt === attempt) this.#attempt = null;
    }
    this.#applyHealth(this.#health.completeRejoin(false));
  }

  #dispatchAttemptWire<
    Kind extends 'file-playback-cancel' | 'rendezvous-arm' | 'rendezvous-finalize',
  >(kind: Kind, rendezvousId: string, payload: FilePlaybackWirePayloadByKind[Kind]): Promise<void> {
    return Promise.resolve().then(() => {
      const attempt = this.#attemptsById.get(rendezvousId) ?? null;
      if (
        !attempt ||
        attempt.attempt.rendezvousId !== rendezvousId ||
        attempt.status === 'retired' ||
        this.#closed
      ) {
        throw new Error(`Host ${kind} attempt authority is stale`);
      }
      let sent: FilePlaybackWireMessageForKind<Kind> | null;
      try {
        sent = this.#sendWire(this.#context.connection, attempt.lease, payload);
      } catch (error) {
        throw this.#failConnection(error);
      }
      if (!sent) throw this.#failConnection(new Error(`Host ${kind} send failed`));
      if (kind === 'file-playback-cancel') {
        attempt.status = 'retired';
        this.#attemptsById.delete(rendezvousId);
      }
    });
  }

  async #resolvePeerSource(
    sourceIdentity: string,
    signal: AbortSignal,
  ): Promise<HostPeerRangeSource | null> {
    const record = this.#publication;
    if (
      !record ||
      record.offer.transport !== 'peer-range' ||
      sourceIdentity !== record.publication.asset.binding.sourceIdentity ||
      this.#hostRoom.currentPeerPublication() !== record.publication
    ) {
      return null;
    }
    const source = await this.#hostRoom.resolveCurrentPeerRangeSource({
      publication: record.publication,
      sourceIdentity,
      signal,
    });
    if (
      this.#closed ||
      this.#publication !== record ||
      this.#hostRoom.currentPeerPublication() !== record.publication
    ) {
      if (isEncodedSource(source)) await source.close().catch(() => undefined);
      return null;
    }
    return source;
  }

  #sendPeerRangeBulk(frame: PeerRangeBulkFrame): Promise<void> {
    return Promise.resolve().then(() => {
      if (this.#closed || !this.#canSendPeerRange()) {
        throw new HostMediaOwnerConnectionError('Peer-range bulk connection is unavailable');
      }
      if (!this.#sendRequired(this.#context.connection, frame)) {
        throw this.#failConnection(new Error('Peer-range bulk send failed'));
      }
    });
  }

  #canSendPeerRange(): boolean {
    const connection = this.#context.connection;
    const dataChannel = connection.dataChannel;
    return (
      !this.#closed &&
      connection.open === true &&
      dataChannel?.readyState === 'open' &&
      Number.isFinite(dataChannel.bufferedAmount) &&
      dataChannel.bufferedAmount <= PEER_RANGE_BUFFERED_AMOUNT_LIMIT
    );
  }

  #tickHealth(): void {
    if (this.#closed) return;
    try {
      const now = this.#nowRoomTimeMs();
      const transportHealthy =
        this.#context.connection.open === true &&
        Reflect.apply(trustedChannelToken, this.#context.channel, []) ===
          this.#context.connectionToken;
      const clockHealthy =
        transportHealthy && Reflect.apply(trustedChannelClockReady, this.#context.channel, []);
      const signals: ParticipantHealthSignal[] = [
        {
          dimension: 'transport',
          value: transportHealthy ? 'healthy' : 'unhealthy',
          observedAtMs: now,
          leaseUntilMs: transportHealthy ? now + HEALTH_LEASE_MS : now,
          reasonCode: transportHealthy ? null : 'transport-disconnected',
        },
        {
          dimension: 'clock',
          value: clockHealthy ? 'healthy' : 'unhealthy',
          observedAtMs: now,
          leaseUntilMs: clockHealthy ? now + HEALTH_LEASE_MS : now,
          reasonCode: clockHealthy ? null : 'clock-not-ready',
        },
      ];
      if (!this.#publication?.participant) {
        signals.push(
          {
            dimension: 'media-readiness',
            value: 'healthy',
            observedAtMs: now,
            leaseUntilMs: now + HEALTH_LEASE_MS,
          },
          {
            dimension: 'renderer',
            value: 'healthy',
            observedAtMs: now,
            leaseUntilMs: now + HEALTH_LEASE_MS,
          },
        );
      }
      this.#applyHealth(this.#health.reportMany(signals));
      this.#applyHealth(this.#health.tick());
    } catch (error) {
      this.#failConnection(error);
    }
  }

  #reportHealth(signal: ParticipantHealthSignal): void {
    try {
      this.#applyHealth(this.#health.report(signal));
    } catch (error) {
      this.#failConnection(error);
    }
  }

  #applyHealth(transition: ParticipantHealthTransition): void {
    for (const action of transition.actions) this.#applyHealthAction(action);
  }

  #applyHealthAction(action: ParticipantHealthAction): void {
    if (action.type === 'emit-degraded-system-message') {
      try {
        this.#onHealthSystemMessage(
          freezeCanonical({
            schemaVersion: 1 as const,
            participantId: action.participantId,
            messageKey: action.messageKey,
          }),
        );
      } catch {
        // Presentation failure cannot change participant or room authority.
      }
      return;
    }
    if (action.type === 'request-rejoin') {
      this.#health.beginRejoin();
      const record = this.#publication;
      if (record?.participant) queueMicrotask(() => this.#beginRecovery(record, true));
    }
  }

  #revoke(value: Readonly<FilePlaybackProductSessionRouterConnectionContext>): void {
    if (value !== this.#context) {
      throw new Error('Host media owner revoke context is stale');
    }
    this.#close(false, new Error('Host media owner was revoked'));
  }

  #failConnection(cause: unknown): HostMediaOwnerConnectionError {
    const error =
      cause instanceof HostMediaOwnerConnectionError
        ? cause
        : new HostMediaOwnerConnectionError('Host media connection failed', cause);
    if (this.#fatal || this.#closed) return error;
    this.#fatal = true;
    this.#close(true, error);
    return error;
  }

  #close(closeConnection: boolean, reason: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#publicationEpoch += 1;
    this.#publicationController.abort(reason);
    this.#runtime.cancelInterval(this.#healthTimer);
    this.#retireAttempt(reason);
    this.#revokePublishedHandle(reason);
    this.#responder.close(reason);
    this.#publication = null;
    this.#publicationTask = null;
    this.#publicationTaskIdentity = null;
    this.#attemptsById.clear();
    if (closeConnection) {
      try {
        this.#closeConnection(this.#context.connection);
      } catch {
        // Exact connection authority is already terminal in this owner.
      }
    }
  }

  #retireAttempt(reason: Error): void {
    const attempt = this.#attempt;
    if (!attempt) return;
    attempt.rejectEvidence(reason);
    this.#retireAttemptLease(attempt);
    this.#attemptsById.delete(attempt.attempt.rendezvousId);
    this.#attempt = null;
  }

  #retireAttemptLease(attempt: AttemptRecord): void {
    if (attempt.status === 'retired') return;
    try {
      Reflect.apply(trustedChannelRetireAttempt, this.#context.channel, [attempt.lease]);
    } catch {
      // A closing channel has already revoked this exact lease.
    }
    attempt.status = 'retired';
    this.#attemptsById.delete(attempt.attempt.rendezvousId);
  }

  #revokePublishedHandle(reason: Error): void {
    const record = this.#publication;
    if (!record?.handleId) return;
    try {
      this.#responder.revokeHandle(
        this.#context.connectionToken,
        record.handleId,
        record.publication.asset.binding.sourceIdentity,
        reason,
      );
    } catch {
      // Responder close remains the terminal ownership fence.
    }
  }

  #publicationSignal(epoch: number): AbortSignal {
    if (this.#closed || this.#publicationEpoch !== epoch) {
      const stale = new AbortController();
      stale.abort(new Error('Host media publication is stale'));
      return stale.signal;
    }
    return this.#publicationController.signal;
  }

  #assertPublicationAuthority(
    publication: Readonly<HostPeerPlaybackPublication>,
    epoch: number,
  ): void {
    this.#assertConnection();
    if (
      this.#publicationEpoch !== epoch ||
      this.#hostRoom.currentPeerPublication() !== publication
    ) {
      throw new Error('Host media publication authority is stale');
    }
  }

  #assertRecord(record: PublicationRecord): void {
    this.#assertPublicationAuthority(record.publication, record.epoch);
    if (this.#publication !== record) throw new Error('Host media publication was superseded');
  }

  #assertConnection(): void {
    if (
      this.#closed ||
      Reflect.apply(trustedChannelClosed, this.#context.channel, []) ||
      Reflect.apply(trustedChannelToken, this.#context.channel, []) !==
        this.#context.connectionToken
    ) {
      throw new Error('Host media owner connection authority is stale');
    }
  }

  #assertEventConnection(event: ExactRecord): void {
    this.#assertConnection();
    if (
      event.connection !== this.#context.connection ||
      event.channel !== this.#context.channel ||
      (Object.hasOwn(event, 'connectionToken') &&
        event.connectionToken !== this.#context.connectionToken)
    ) {
      throw new Error('Host media owner event connection is stale');
    }
  }

  #assertMessagePublication(
    message: FilePlaybackWireAdoptionEvent['message'],
    publication: Readonly<HostPeerPlaybackPublication>,
  ): void {
    if (
      message.sessionId !== this.#context.sessionId ||
      message.connectionId !== this.#context.connectionId ||
      message.senderParticipantId !== this.#context.guestParticipantId ||
      message.recipientParticipantId !== this.#context.hostParticipantId ||
      message.queueItemId !== publication.state.queueItemId ||
      message.runId !== publication.state.runId ||
      message.revision !== publication.state.revision ||
      message.sourceIdentity !== publication.asset.binding.sourceIdentity ||
      message.transferSessionId !== publication.asset.binding.transferSessionId
    ) {
      throw new Error('Host media wire does not match the current publication');
    }
  }

  #sendRequiredFrame(frame: unknown): void {
    this.#assertConnection();
    let sent: boolean;
    try {
      sent = this.#sendRequired(this.#context.connection, frame);
    } catch (error) {
      throw this.#failConnection(error);
    }
    if (!sent) {
      throw this.#failConnection(new Error('Host required media frame send failed'));
    }
  }

  #nextPrepareRevision(): number {
    if (this.#prepareRevision >= Number.MAX_SAFE_INTEGER) {
      throw this.#failConnection(new Error('Host media prepare revision exhausted'));
    }
    this.#prepareRevision += 1;
    return this.#prepareRevision;
  }

  #freshMediaId(excluded: readonly string[]): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = this.#runtime.createMediaId();
      if (typeof id === 'string' && !excluded.includes(id)) return id;
    }
    throw new Error('Host media owner could not create a distinct media ID');
  }

  #nowRoomTimeMs(): number {
    const now = Reflect.apply(trustedChannelNow, this.#context.channel, []);
    if (!Number.isFinite(now) || now < 0) throw new Error('Host media room clock is invalid');
    return now;
  }
}
