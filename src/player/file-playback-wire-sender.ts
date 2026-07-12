import type { QueueItemId } from '../types/index.ts';
import type { FilePlaybackBackend } from './file-playback-source.ts';
import type { PlaybackRevisionWatermark } from './playback-identity.ts';
import {
  FILE_PLAYBACK_WIRE_MAX_IDENTIFIER_LENGTH,
  createFilePlaybackWireMessage,
  isFilePlaybackAttemptScopedWireKind,
  isFilePlaybackSuccessorScopedWireKind,
  type FilePlaybackWireKind,
  type FilePlaybackWireMessage,
} from './file-playback-wire.ts';
import {
  FilePlaybackWireBindingRegistry,
  type FilePlaybackWireAttemptLease,
  type FilePlaybackWireExpectedStateIdentity,
  type FilePlaybackWireLease,
  type FilePlaybackWireMediaBinding,
  type FilePlaybackWireStateLease,
} from './file-playback-wire-binding.ts';

/** Immutable connection authority owned by one outbound control lane. */
export interface FilePlaybackWireSenderOptions {
  readonly sessionId: string;
  readonly connectionId: string;
  readonly senderParticipantId: string;
  readonly recipientParticipantId: string;
}

export interface FileSourceReadyWirePayload {
  readonly kind: 'source-ready';
  readonly observedAtRoomTimeMs: number;
  readonly readyLeaseUntilRoomTimeMs: number;
  readonly backend: FilePlaybackBackend;
  readonly durationSeconds: number;
  readonly bufferedAheadSeconds: number;
  readonly outputSampleRateHz: number;
  readonly channelCount: number;
}

export interface FileSourceNotReadyWirePayload {
  readonly kind: 'source-not-ready';
  readonly observedAtRoomTimeMs: number;
  readonly reasonCode: string;
  readonly retryable: boolean;
}

export interface RendezvousArmWirePayload {
  readonly kind: 'rendezvous-arm';
  readonly rendezvousId: string;
  readonly positionSeconds: number;
  readonly playbackRate: number;
  readonly startAtRoomTimeMs: number;
  readonly finalizeByRoomTimeMs: number;
}

export interface RendezvousArmedWirePayload {
  readonly kind: 'rendezvous-armed';
  readonly rendezvousId: string;
  readonly status: 'armed' | 'rejected';
  readonly observedAtRoomTimeMs: number;
  readonly bufferedAheadSeconds: number;
  readonly reasonCode: string | null;
}

export interface RendezvousFinalizeWirePayload {
  readonly kind: 'rendezvous-finalize';
  readonly rendezvousId: string;
  readonly startAtRoomTimeMs: number;
  readonly finalizedAtRoomTimeMs: number;
}

export interface RendezvousFinalizedWirePayload {
  readonly kind: 'rendezvous-finalized';
  readonly rendezvousId: string;
  readonly status: 'accepted' | 'missed-deadline' | 'rejected';
  readonly observedAtRoomTimeMs: number;
  readonly reasonCode: string | null;
}

export interface FilePlaybackPauseWirePayload {
  readonly kind: 'file-playback-pause';
  readonly expectedQueueItemId: QueueItemId;
  readonly expectedRunId: string;
  readonly expectedRevision: number;
  readonly atRoomTimeMs: number;
}

export interface FilePlaybackSeekWirePayload {
  readonly kind: 'file-playback-seek';
  readonly expectedQueueItemId: QueueItemId;
  readonly expectedRunId: string;
  readonly expectedRevision: number;
  readonly positionSeconds: number;
  readonly atRoomTimeMs: number;
}

export interface FilePlaybackCancelWirePayload {
  readonly kind: 'file-playback-cancel';
  readonly rendezvousId: string;
  readonly reasonCode: string;
}

export interface FilePlaybackStopWirePayload {
  readonly kind: 'file-playback-stop';
  readonly expectedQueueItemId: QueueItemId;
  readonly expectedRunId: string;
  readonly expectedRevision: number;
  readonly atRoomTimeMs: number;
}

export interface RendererHealthWirePayload {
  readonly kind: 'renderer-health';
  readonly rendezvousId: string;
  readonly value: 'healthy' | 'unhealthy';
  readonly observedAtRoomTimeMs: number;
  readonly leaseUntilRoomTimeMs: number;
  readonly renderedFrame: number;
  readonly underrunCount: number;
  readonly reasonCode: string | null;
}

/** Exact payload schema selected by the discriminating wire kind. */
export interface FilePlaybackWirePayloadByKind {
  readonly 'source-ready': FileSourceReadyWirePayload;
  readonly 'source-not-ready': FileSourceNotReadyWirePayload;
  readonly 'rendezvous-arm': RendezvousArmWirePayload;
  readonly 'rendezvous-armed': RendezvousArmedWirePayload;
  readonly 'rendezvous-finalize': RendezvousFinalizeWirePayload;
  readonly 'rendezvous-finalized': RendezvousFinalizedWirePayload;
  readonly 'file-playback-pause': FilePlaybackPauseWirePayload;
  readonly 'file-playback-seek': FilePlaybackSeekWirePayload;
  readonly 'file-playback-cancel': FilePlaybackCancelWirePayload;
  readonly 'file-playback-stop': FilePlaybackStopWirePayload;
  readonly 'renderer-health': RendererHealthWirePayload;
}

export type FilePlaybackWirePayload =
  FilePlaybackWirePayloadByKind[keyof FilePlaybackWirePayloadByKind];

export type FilePlaybackWireMessageForKind<Kind extends FilePlaybackWireKind> = Extract<
  FilePlaybackWireMessage,
  { readonly kind: Kind }
>;

const CONNECTION_KEYS = Object.freeze([
  'sessionId',
  'connectionId',
  'senderParticipantId',
  'recipientParticipantId',
] as const);

const PAYLOAD_KEYS: Readonly<Record<FilePlaybackWireKind, readonly string[]>> = Object.freeze({
  'source-ready': Object.freeze([
    'kind',
    'observedAtRoomTimeMs',
    'readyLeaseUntilRoomTimeMs',
    'backend',
    'durationSeconds',
    'bufferedAheadSeconds',
    'outputSampleRateHz',
    'channelCount',
  ]),
  'source-not-ready': Object.freeze(['kind', 'observedAtRoomTimeMs', 'reasonCode', 'retryable']),
  'rendezvous-arm': Object.freeze([
    'kind',
    'rendezvousId',
    'positionSeconds',
    'playbackRate',
    'startAtRoomTimeMs',
    'finalizeByRoomTimeMs',
  ]),
  'rendezvous-armed': Object.freeze([
    'kind',
    'rendezvousId',
    'status',
    'observedAtRoomTimeMs',
    'bufferedAheadSeconds',
    'reasonCode',
  ]),
  'rendezvous-finalize': Object.freeze([
    'kind',
    'rendezvousId',
    'startAtRoomTimeMs',
    'finalizedAtRoomTimeMs',
  ]),
  'rendezvous-finalized': Object.freeze([
    'kind',
    'rendezvousId',
    'status',
    'observedAtRoomTimeMs',
    'reasonCode',
  ]),
  'file-playback-pause': Object.freeze([
    'kind',
    'expectedQueueItemId',
    'expectedRunId',
    'expectedRevision',
    'atRoomTimeMs',
  ]),
  'file-playback-seek': Object.freeze([
    'kind',
    'expectedQueueItemId',
    'expectedRunId',
    'expectedRevision',
    'positionSeconds',
    'atRoomTimeMs',
  ]),
  'file-playback-cancel': Object.freeze(['kind', 'rendezvousId', 'reasonCode']),
  'file-playback-stop': Object.freeze([
    'kind',
    'expectedQueueItemId',
    'expectedRunId',
    'expectedRevision',
    'atRoomTimeMs',
  ]),
  'renderer-health': Object.freeze([
    'kind',
    'rendezvousId',
    'value',
    'observedAtRoomTimeMs',
    'leaseUntilRoomTimeMs',
    'renderedFrame',
    'underrunCount',
    'reasonCode',
  ]),
});

const RENDEZVOUS_KINDS = new Set<FilePlaybackWireKind>([
  'rendezvous-arm',
  'rendezvous-armed',
  'rendezvous-finalize',
  'rendezvous-finalized',
  'file-playback-cancel',
  'renderer-health',
]);

type ConnectionSnapshot = FilePlaybackWireSenderOptions;

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
    value.length <= FILE_PLAYBACK_WIRE_MAX_IDENTIFIER_LENGTH &&
    value === value.trim() &&
    !containsControlCharacter(value)
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Takes one own-data descriptor snapshot. Accessors are never invoked and all
 * later validation reads the detached null-prototype record only.
 */
function snapshotExactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | null {
  try {
    if (!isPlainRecord(value)) return null;
    const expected = new Set(expectedKeys);
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== expected.size ||
      ownKeys.some((key) => typeof key !== 'string' || !expected.has(key))
    ) {
      return null;
    }

    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function freezeCanonical<T extends object>(value: T): T {
  return Object.freeze(Object.assign(Object.create(null), value)) as T;
}

function snapshotConnection(value: unknown): ConnectionSnapshot | null {
  const snapshot = snapshotExactDataRecord(value, CONNECTION_KEYS);
  if (
    !snapshot ||
    !isBoundedIdentifier(snapshot.sessionId) ||
    !isBoundedIdentifier(snapshot.connectionId) ||
    !isBoundedIdentifier(snapshot.senderParticipantId) ||
    !isBoundedIdentifier(snapshot.recipientParticipantId) ||
    snapshot.senderParticipantId === snapshot.recipientParticipantId
  ) {
    return null;
  }
  return freezeCanonical({
    sessionId: snapshot.sessionId,
    connectionId: snapshot.connectionId,
    senderParticipantId: snapshot.senderParticipantId,
    recipientParticipantId: snapshot.recipientParticipantId,
  });
}

function isWireKind(value: unknown): value is FilePlaybackWireKind {
  return typeof value === 'string' && Object.hasOwn(PAYLOAD_KEYS, value);
}

function snapshotPayload(value: unknown): Record<string, unknown> | null {
  try {
    if (!isPlainRecord(value)) return null;
    const kindDescriptor = Object.getOwnPropertyDescriptor(value, 'kind');
    if (
      !kindDescriptor ||
      !kindDescriptor.enumerable ||
      !Object.hasOwn(kindDescriptor, 'value') ||
      !isWireKind(kindDescriptor.value)
    ) {
      return null;
    }
    const expectedKeys = PAYLOAD_KEYS[kindDescriptor.value];
    const expected = new Set(expectedKeys);
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== expected.size ||
      ownKeys.some((key) => typeof key !== 'string' || !expected.has(key))
    ) {
      return null;
    }

    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor =
        key === 'kind' ? kindDescriptor : Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function payloadRendezvousId(payload: Record<string, unknown>): string | null {
  return RENDEZVOUS_KINDS.has(payload.kind as FilePlaybackWireKind)
    ? (payload.rendezvousId as string)
    : null;
}

/**
 * Connection-owned outbound gate.
 *
 * A successful create permanently consumes its sequence even if the caller
 * later drops the frame, so gaps are valid. A rejected create does not advance
 * state. Payload detachment completes before the latest media authority and
 * sequence are read; hostile Proxy re-entry therefore cannot roll a watermark
 * back or make two successful creates reuse a sequence.
 */
export class FilePlaybackWireSender {
  readonly #connection: ConnectionSnapshot;
  readonly #bindings: FilePlaybackWireBindingRegistry;
  #lastControlSequence = 0;

  constructor(
    options: FilePlaybackWireSenderOptions,
    bindings: FilePlaybackWireBindingRegistry = new FilePlaybackWireBindingRegistry(),
  ) {
    const connection = snapshotConnection(options);
    if (!connection) throw new TypeError('File playback sender scope is invalid');
    if (!(bindings instanceof FilePlaybackWireBindingRegistry)) {
      throw new TypeError('File playback sender binding registry is invalid');
    }
    this.#connection = connection;
    this.#bindings = bindings;
  }

  lastControlSequence(): number {
    return this.#lastControlSequence;
  }

  bootstrapStopped(revisionWatermark: PlaybackRevisionWatermark): void {
    this.#bindings.bootstrapStopped(revisionWatermark);
  }

  bootstrapCurrentMedia(binding: FilePlaybackWireMediaBinding): FilePlaybackWireStateLease {
    return this.#bindings.bootstrapCurrentMedia(binding);
  }

  stageMedia(binding: FilePlaybackWireMediaBinding): FilePlaybackWireStateLease {
    return this.#bindings.stageMedia(binding);
  }

  commitMedia(lease: FilePlaybackWireStateLease): void {
    this.#bindings.commitMedia(lease);
  }

  commitStop(
    successorLease: FilePlaybackWireStateLease,
    expected: FilePlaybackWireExpectedStateIdentity,
  ): void {
    this.#bindings.commitStop(successorLease, expected);
  }

  retireMedia(lease: FilePlaybackWireStateLease): void {
    this.#bindings.retireMedia(lease);
  }

  stageAttempt(
    stateLease: FilePlaybackWireStateLease,
    rendezvousId: string,
  ): FilePlaybackWireAttemptLease {
    return this.#bindings.stageAttempt(stateLease, rendezvousId);
  }

  commitAttempt(lease: FilePlaybackWireAttemptLease): void {
    this.#bindings.commitAttempt(lease);
  }

  retireAttempt(lease: FilePlaybackWireAttemptLease): void {
    this.#bindings.retireAttempt(lease);
  }

  revokeAll(): void {
    this.#bindings.revokeAll();
  }

  create<const Kind extends FilePlaybackWireKind>(
    lease: FilePlaybackWireLease,
    payload: FilePlaybackWirePayloadByKind[Kind],
  ): FilePlaybackWireMessageForKind<Kind> {
    // Detach first. Proxy traps may re-enter create(), stageMedia(), or
    // retireMedia(); the outer operation intentionally observes their latest
    // committed state only after every hostile trap has finished.
    const detached = snapshotPayload(payload);
    if (!detached) throw new TypeError('File playback wire payload is invalid');

    const rendezvousId = payloadRendezvousId(detached);
    let stateLease: FilePlaybackWireStateLease;
    if (isFilePlaybackAttemptScopedWireKind(detached.kind as FilePlaybackWireKind)) {
      const attempt = this.#bindings.authorityForAttemptLease(
        lease as FilePlaybackWireAttemptLease,
      );
      if (detached.kind === 'file-playback-cancel') {
        this.#bindings.assertCandidateAttemptLease(lease as FilePlaybackWireAttemptLease);
      }
      stateLease = attempt.stateLease;
      if (rendezvousId === null || rendezvousId !== attempt.rendezvousId) {
        throw new TypeError('File playback payload rendezvous does not match its exact lease');
      }
    } else {
      stateLease = lease as FilePlaybackWireStateLease;
    }
    const isStop = detached.kind === 'file-playback-stop';
    if (isFilePlaybackSuccessorScopedWireKind(detached.kind as FilePlaybackWireKind)) {
      const expected = {
        queueItemId: detached.expectedQueueItemId as QueueItemId,
        runId: detached.expectedRunId as string,
        revision: detached.expectedRevision as number,
      } satisfies FilePlaybackWireExpectedStateIdentity;
      if (isStop) this.#bindings.assertStopSuccessorLease(stateLease, expected);
      else this.#bindings.assertSuccessorLease(stateLease, expected);
    }
    const media = this.#bindings.bindingForStateLease(stateLease, isStop ? 'either' : 'media');

    // Read only after detachment so a nested successful create always wins
    // before the outer operation allocates its own strictly greater value.
    const currentSequence = this.#lastControlSequence;
    if (currentSequence >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError('File playback sender sequence space is exhausted');
    }
    const controlSequence = currentSequence + 1;

    const message = createFilePlaybackWireMessage({
      protocolVersion: 2,
      ...this.#connection,
      controlSequence,
      queueItemId: media.run.queueItemId,
      runId: media.run.runId,
      revision: media.run.revision,
      sourceIdentity: media.sourceIdentity,
      transferSessionId: media.transferSessionId,
      ...detached,
    } as FilePlaybackWireMessage);

    if (isStop) {
      this.#bindings.markStopSuccessorLease(stateLease, {
        queueItemId: detached.expectedQueueItemId as QueueItemId,
        runId: detached.expectedRunId as string,
        revision: detached.expectedRevision as number,
      });
    }

    // Canonicalization above operates exclusively on detached primitive data.
    // No hostile callback exists between this commit and returning the frame.
    this.#lastControlSequence = controlSequence;
    return message as FilePlaybackWireMessageForKind<Kind>;
  }
}
