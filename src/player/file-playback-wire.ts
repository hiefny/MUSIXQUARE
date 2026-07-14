import type { QueueItemId } from '../types/index.ts';
import { isFilePlaybackSourceSnapshot, type FilePlaybackBackend } from './file-playback-source.ts';
import {
  isPlaybackRevision,
  isPlaybackRunIdentity,
  isPlaybackStateIdentity,
  type PlaybackRevision,
  type PlaybackRevisionWatermark,
} from './playback-identity.ts';
import {
  readRendezvousArmIntent,
  readRendezvousArmReceipt,
  readRendezvousFinalizeIntent,
  readRendezvousFinalizeReceipt,
  type RendezvousArmIntent,
  type RendezvousArmReceipt,
  type RendezvousFinalizeIntent,
  type RendezvousFinalizeReceipt,
  type RevisionedPlaybackRun,
} from './rendezvous-contract.ts';
import {
  FilePlaybackWireBindingRegistry,
  type FilePlaybackWireAttemptLease,
  type FilePlaybackWireExpectedStateIdentity,
  type FilePlaybackWireMediaBinding,
  type FilePlaybackWireStateLease,
  type FilePlaybackWireStateReference,
} from './file-playback-wire-binding.ts';

export const FILE_PLAYBACK_WIRE_PROTOCOL_VERSION = 2 as const;
export const FILE_PLAYBACK_WIRE_MAX_PAYLOAD_BYTES = 4_096;
export const FILE_PLAYBACK_WIRE_MAX_IDENTIFIER_LENGTH = 256;
export const FILE_PLAYBACK_WIRE_MAX_REASON_LENGTH = 160;
export const FILE_PLAYBACK_WIRE_DEFAULT_MAX_CLOCK_SKEW_MS = 250;

const MAX_ROOM_TIME_MS = 1_000_000_000_000;
const MAX_MEDIA_DURATION_SECONDS = 31_536_000;
const MAX_READY_LEASE_MS = 120_000;
const MAX_RENDERER_LEASE_MS = 30_000;
const MAX_PLAYBACK_RATE = 16;
const MAX_COUNTER = 1_000_000_000_000;
const MAX_SAMPLE_RATE_HZ = 1_000_000;
const MAX_CHANNEL_COUNT = 8;
const MAX_CLOCK_SKEW_MS = 2_500;
const MAX_RENDEZVOUS_SCHEDULE_AHEAD_MS = 2_500;

export const FILE_PLAYBACK_WIRE_KINDS = Object.freeze([
  'source-ready',
  'source-not-ready',
  'file-playback-prepare',
  'rendezvous-arm',
  'rendezvous-armed',
  'rendezvous-finalize',
  'rendezvous-finalized',
  'file-playback-pause',
  'file-playback-seek',
  'file-playback-cancel',
  'file-playback-stop',
  'renderer-health',
] as const);

export type FilePlaybackWireKind = (typeof FILE_PLAYBACK_WIRE_KINDS)[number];

const ATTEMPT_SCOPED_WIRE_KINDS = new Set<FilePlaybackWireKind>([
  'rendezvous-arm',
  'rendezvous-armed',
  'rendezvous-finalize',
  'rendezvous-finalized',
  'file-playback-cancel',
  'renderer-health',
]);
const SUCCESSOR_SCOPED_WIRE_KINDS = new Set<FilePlaybackWireKind>([
  'file-playback-prepare',
  'file-playback-pause',
  'file-playback-seek',
  'file-playback-stop',
]);

export function isFilePlaybackAttemptScopedWireKind(kind: FilePlaybackWireKind): boolean {
  return ATTEMPT_SCOPED_WIRE_KINDS.has(kind);
}

export function isFilePlaybackSuccessorScopedWireKind(kind: FilePlaybackWireKind): boolean {
  return SUCCESSOR_SCOPED_WIRE_KINDS.has(kind);
}

/**
 * Connection-scoped identity common to every V2 file-control message.
 *
 * `sessionId` is the application session, while `transferSessionId` names the
 * independent byte-transfer lifecycle (or is null for a local source). A
 * playback run, rendezvous, and transfer must never borrow each other's IDs.
 */
interface FilePlaybackWireEnvelope {
  readonly protocolVersion: 2;
  readonly kind: FilePlaybackWireKind;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly senderParticipantId: string;
  readonly recipientParticipantId: string;
  readonly controlSequence: number;
  readonly queueItemId: QueueItemId;
  readonly runId: string;
  readonly revision: PlaybackRevision;
  readonly sourceIdentity: string;
  readonly transferSessionId: string | null;
}

export interface FileSourceReadyWireMessage extends FilePlaybackWireEnvelope {
  readonly kind: 'source-ready';
  readonly observedAtRoomTimeMs: number;
  readonly readyLeaseUntilRoomTimeMs: number;
  readonly backend: FilePlaybackBackend;
  readonly durationSeconds: number;
  readonly bufferedAheadSeconds: number;
  readonly outputSampleRateHz: number;
  readonly channelCount: number;
}

export interface FileSourceNotReadyWireMessage extends FilePlaybackWireEnvelope {
  readonly kind: 'source-not-ready';
  readonly observedAtRoomTimeMs: number;
  readonly reasonCode: string;
  readonly retryable: boolean;
}

/**
 * Prepares an exact-next state of the currently bound logical run before its
 * rendezvous attempt exists. The envelope identifies the successor while the
 * expected fields fence the current state it must replace.
 */
export interface FilePlaybackPrepareWireMessage extends FilePlaybackWireEnvelope {
  readonly kind: 'file-playback-prepare';
  readonly expectedQueueItemId: QueueItemId;
  readonly expectedRunId: string;
  readonly expectedRevision: PlaybackRevision;
  readonly positionSeconds: number;
  readonly playbackRate: number;
}

export interface RendezvousArmWireMessage extends FilePlaybackWireEnvelope {
  readonly kind: 'rendezvous-arm';
  readonly rendezvousId: string;
  readonly positionSeconds: number;
  readonly playbackRate: number;
  readonly startAtRoomTimeMs: number;
  readonly finalizeByRoomTimeMs: number;
}

export interface RendezvousArmedWireMessage extends FilePlaybackWireEnvelope {
  readonly kind: 'rendezvous-armed';
  readonly rendezvousId: string;
  readonly status: 'armed' | 'rejected';
  readonly observedAtRoomTimeMs: number;
  readonly bufferedAheadSeconds: number;
  readonly reasonCode: string | null;
}

export interface RendezvousFinalizeWireMessage extends FilePlaybackWireEnvelope {
  readonly kind: 'rendezvous-finalize';
  readonly rendezvousId: string;
  readonly startAtRoomTimeMs: number;
  readonly finalizedAtRoomTimeMs: number;
}

export interface RendezvousFinalizedWireMessage extends FilePlaybackWireEnvelope {
  readonly kind: 'rendezvous-finalized';
  readonly rendezvousId: string;
  readonly status: 'accepted' | 'missed-deadline' | 'rejected';
  readonly observedAtRoomTimeMs: number;
  readonly reasonCode: string | null;
}

export interface FilePlaybackPauseWireMessage extends FilePlaybackWireEnvelope {
  readonly kind: 'file-playback-pause';
  /** State that must still be current; the envelope identifies its successor. */
  readonly expectedQueueItemId: QueueItemId;
  readonly expectedRunId: string;
  readonly expectedRevision: PlaybackRevision;
  readonly atRoomTimeMs: number;
}

export interface FilePlaybackSeekWireMessage extends FilePlaybackWireEnvelope {
  readonly kind: 'file-playback-seek';
  /** State that must still be current; the envelope identifies its successor. */
  readonly expectedQueueItemId: QueueItemId;
  readonly expectedRunId: string;
  readonly expectedRevision: PlaybackRevision;
  readonly positionSeconds: number;
  readonly atRoomTimeMs: number;
}

export interface FilePlaybackCancelWireMessage extends FilePlaybackWireEnvelope {
  readonly kind: 'file-playback-cancel';
  /** Cancels exactly one rendezvous attempt, never the logical playback state. */
  readonly rendezvousId: string;
  readonly reasonCode: string;
}

export interface FilePlaybackStopWireMessage extends FilePlaybackWireEnvelope {
  readonly kind: 'file-playback-stop';
  readonly expectedQueueItemId: QueueItemId;
  readonly expectedRunId: string;
  readonly expectedRevision: PlaybackRevision;
  readonly atRoomTimeMs: number;
}

export interface RendererHealthWireMessage extends FilePlaybackWireEnvelope {
  readonly kind: 'renderer-health';
  /** Exact renderer generation; same-run recovery allocates a new rendezvous. */
  readonly rendezvousId: string;
  readonly value: 'healthy' | 'unhealthy';
  readonly observedAtRoomTimeMs: number;
  readonly leaseUntilRoomTimeMs: number;
  readonly renderedFrame: number;
  readonly underrunCount: number;
  readonly reasonCode: string | null;
}

export type FilePlaybackWireMessage =
  | FileSourceReadyWireMessage
  | FileSourceNotReadyWireMessage
  | FilePlaybackPrepareWireMessage
  | RendezvousArmWireMessage
  | RendezvousArmedWireMessage
  | RendezvousFinalizeWireMessage
  | RendezvousFinalizedWireMessage
  | FilePlaybackPauseWireMessage
  | FilePlaybackSeekWireMessage
  | FilePlaybackCancelWireMessage
  | FilePlaybackStopWireMessage
  | RendererHealthWireMessage;

/** Optional binding checks supplied by the connection owner at receive time. */
export interface FilePlaybackWireExpectations {
  readonly sessionId?: string;
  readonly connectionId?: string;
  readonly senderParticipantId?: string;
  readonly recipientParticipantId?: string;
  /** The received sequence must be strictly greater than this value. */
  readonly lastControlSequence?: number;
  readonly run?: RevisionedPlaybackRun;
  readonly sourceIdentity?: string;
  readonly transferSessionId?: string | null;
  readonly rendezvousId?: string;
  /** Trusted local room time captured before parsing this received frame. */
  readonly receivedAtRoomTimeMs?: number;
  /** Maximum positive sender-clock skew accepted at the receive boundary. */
  readonly maxClockSkewMs?: number;
}

/** Mandatory connection scope for parsing a received, untrusted frame. */
export interface FilePlaybackWireReceiveExpectations extends FilePlaybackWireExpectations {
  readonly sessionId: string;
  readonly connectionId: string;
  readonly senderParticipantId: string;
  readonly recipientParticipantId: string;
  readonly lastControlSequence: number;
  readonly receivedAtRoomTimeMs: number;
}

export interface FilePlaybackWireReceiverOptions {
  readonly sessionId: string;
  readonly connectionId: string;
  readonly senderParticipantId: string;
  readonly recipientParticipantId: string;
  readonly nowRoomTimeMs: () => number;
  readonly maxClockSkewMs?: number;
}

export type FilePlaybackWireReceiverRejectionReason =
  | 'revoked'
  | 'malformed-frame'
  | 'wrong-scope'
  | 'unknown-binding'
  | 'replayed-sequence'
  | 'temporal-invalid';

export type FilePlaybackWireReceiverResult =
  | Readonly<{
      accepted: true;
      status: 'message';
      message: FilePlaybackWireMessage;
      stateLease: FilePlaybackWireStateLease;
      attemptLease: FilePlaybackWireAttemptLease | null;
    }>
  | Readonly<{
      accepted: true;
      status: 'stale';
      scope: 'state' | 'attempt';
      controlSequence: number;
    }>
  | Readonly<{
      accepted: false;
      reason: FilePlaybackWireReceiverRejectionReason;
    }>;

const COMMON_KEYS = [
  'protocolVersion',
  'kind',
  'sessionId',
  'connectionId',
  'senderParticipantId',
  'recipientParticipantId',
  'controlSequence',
  'queueItemId',
  'runId',
  'revision',
  'sourceIdentity',
  'transferSessionId',
] as const;

const SPECIFIC_KEYS: Readonly<Record<FilePlaybackWireKind, readonly string[]>> = Object.freeze({
  'source-ready': Object.freeze([
    'observedAtRoomTimeMs',
    'readyLeaseUntilRoomTimeMs',
    'backend',
    'durationSeconds',
    'bufferedAheadSeconds',
    'outputSampleRateHz',
    'channelCount',
  ]),
  'source-not-ready': Object.freeze(['observedAtRoomTimeMs', 'reasonCode', 'retryable']),
  'file-playback-prepare': Object.freeze([
    'expectedQueueItemId',
    'expectedRunId',
    'expectedRevision',
    'positionSeconds',
    'playbackRate',
  ]),
  'rendezvous-arm': Object.freeze([
    'rendezvousId',
    'positionSeconds',
    'playbackRate',
    'startAtRoomTimeMs',
    'finalizeByRoomTimeMs',
  ]),
  'rendezvous-armed': Object.freeze([
    'rendezvousId',
    'status',
    'observedAtRoomTimeMs',
    'bufferedAheadSeconds',
    'reasonCode',
  ]),
  'rendezvous-finalize': Object.freeze([
    'rendezvousId',
    'startAtRoomTimeMs',
    'finalizedAtRoomTimeMs',
  ]),
  'rendezvous-finalized': Object.freeze([
    'rendezvousId',
    'status',
    'observedAtRoomTimeMs',
    'reasonCode',
  ]),
  'file-playback-pause': Object.freeze([
    'expectedQueueItemId',
    'expectedRunId',
    'expectedRevision',
    'atRoomTimeMs',
  ]),
  'file-playback-seek': Object.freeze([
    'expectedQueueItemId',
    'expectedRunId',
    'expectedRevision',
    'positionSeconds',
    'atRoomTimeMs',
  ]),
  'file-playback-cancel': Object.freeze(['rendezvousId', 'reasonCode']),
  'file-playback-stop': Object.freeze([
    'expectedQueueItemId',
    'expectedRunId',
    'expectedRevision',
    'atRoomTimeMs',
  ]),
  'renderer-health': Object.freeze([
    'rendezvousId',
    'value',
    'observedAtRoomTimeMs',
    'leaseUntilRoomTimeMs',
    'renderedFrame',
    'underrunCount',
    'reasonCode',
  ]),
});

function isBoundedIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= FILE_PLAYBACK_WIRE_MAX_IDENTIFIER_LENGTH &&
    value === value.trim() &&
    !containsControlCharacter(value)
  );
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function isBoundedReason(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= FILE_PLAYBACK_WIRE_MAX_REASON_LENGTH &&
    value === value.trim() &&
    !containsControlCharacter(value)
  );
}

function isBoundedNumber(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    !Object.is(value, -0) &&
    value >= minimum &&
    value <= maximum
  );
}

function isBoundedSafeInteger(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    !Object.is(value, -0) &&
    value >= minimum &&
    value <= maximum
  );
}

function isRoomTime(value: unknown): value is number {
  return isBoundedNumber(value, 0, MAX_ROOM_TIME_MS);
}

function isMediaTime(value: unknown): value is number {
  return isBoundedNumber(value, 0, MAX_MEDIA_DURATION_SECONDS);
}

function isWireKind(value: unknown): value is FilePlaybackWireKind {
  return (
    typeof value === 'string' && (FILE_PLAYBACK_WIRE_KINDS as readonly string[]).includes(value)
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function detachExactDataRecord(value: Record<string, unknown>): Record<string, unknown> | null {
  const kindDescriptor = Object.getOwnPropertyDescriptor(value, 'kind');
  if (
    !kindDescriptor ||
    !kindDescriptor.enumerable ||
    !Object.hasOwn(kindDescriptor, 'value') ||
    !isWireKind(kindDescriptor.value)
  ) {
    return null;
  }
  const kind = kindDescriptor.value;
  const expected = new Set<string>([...COMMON_KEYS, ...SPECIFIC_KEYS[kind]]);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== expected.size) return null;
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !expected.has(key)) return null;
  }

  // Read every untrusted data descriptor exactly once. Validation, byte
  // accounting, and canonicalization use only this detached null-prototype
  // snapshot, so a Proxy cannot change values between phases or inject a
  // toJSON hook that hides the real payload size.
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of expected) {
    const descriptor =
      key === 'kind' ? kindDescriptor : Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function hasValidEnvelope(candidate: Record<string, unknown>): boolean {
  const run = {
    queueItemId: candidate.queueItemId,
    runId: candidate.runId,
  };
  return (
    candidate.protocolVersion === FILE_PLAYBACK_WIRE_PROTOCOL_VERSION &&
    isWireKind(candidate.kind) &&
    isBoundedIdentifier(candidate.sessionId) &&
    isBoundedIdentifier(candidate.connectionId) &&
    isBoundedIdentifier(candidate.senderParticipantId) &&
    isBoundedIdentifier(candidate.recipientParticipantId) &&
    candidate.senderParticipantId !== candidate.recipientParticipantId &&
    isBoundedSafeInteger(candidate.controlSequence, 1, Number.MAX_SAFE_INTEGER) &&
    isPlaybackRunIdentity(run) &&
    isPlaybackRevision(candidate.revision) &&
    !Object.is(candidate.revision, -0) &&
    isBoundedIdentifier(candidate.sourceIdentity) &&
    (candidate.transferSessionId === null || isBoundedIdentifier(candidate.transferSessionId))
  );
}

function hasBoundedPayload(candidate: Record<string, unknown>): boolean {
  const serialized = JSON.stringify(candidate);
  return (
    typeof serialized === 'string' &&
    new TextEncoder().encode(serialized).byteLength <= FILE_PLAYBACK_WIRE_MAX_PAYLOAD_BYTES
  );
}

function asRevisionedRun(candidate: Record<string, unknown>): RevisionedPlaybackRun {
  return {
    queueItemId: candidate.queueItemId as QueueItemId,
    runId: candidate.runId as string,
    revision: candidate.revision as PlaybackRevision,
  };
}

function asExpectedState(
  candidate: Record<string, unknown>,
): FilePlaybackWireExpectedStateIdentity {
  return {
    queueItemId: candidate.expectedQueueItemId as QueueItemId,
    runId: candidate.expectedRunId as string,
    revision: candidate.expectedRevision as PlaybackRevision,
  };
}

function hasValidSuccessorState(candidate: Record<string, unknown>): boolean {
  const expected = asExpectedState(candidate);
  return (
    isPlaybackStateIdentity(expected) &&
    expected.queueItemId === candidate.queueItemId &&
    expected.runId === candidate.runId &&
    expected.revision < (candidate.revision as number)
  );
}

function asArmIntent(candidate: Record<string, unknown>): RendezvousArmIntent {
  return {
    protocolVersion: 2,
    kind: 'rendezvous-arm',
    ...asRevisionedRun(candidate),
    rendezvousId: candidate.rendezvousId as string,
    recipientId: candidate.recipientParticipantId as string,
    positionSeconds: candidate.positionSeconds as number,
    playbackRate: candidate.playbackRate as number,
    startAtRoomTimeMs: candidate.startAtRoomTimeMs as number,
    finalizeByRoomTimeMs: candidate.finalizeByRoomTimeMs as number,
  };
}

function asArmReceipt(candidate: Record<string, unknown>): RendezvousArmReceipt {
  return {
    protocolVersion: 2,
    kind: 'rendezvous-armed',
    ...asRevisionedRun(candidate),
    rendezvousId: candidate.rendezvousId as string,
    participantId: candidate.senderParticipantId as string,
    status: candidate.status as RendezvousArmReceipt['status'],
    observedAtRoomTimeMs: candidate.observedAtRoomTimeMs as number,
    bufferedAheadSeconds: candidate.bufferedAheadSeconds as number,
    reasonCode: candidate.reasonCode as string | null,
  };
}

function asFinalizeIntent(candidate: Record<string, unknown>): RendezvousFinalizeIntent {
  return {
    protocolVersion: 2,
    kind: 'rendezvous-finalize',
    ...asRevisionedRun(candidate),
    rendezvousId: candidate.rendezvousId as string,
    recipientId: candidate.recipientParticipantId as string,
    startAtRoomTimeMs: candidate.startAtRoomTimeMs as number,
    finalizedAtRoomTimeMs: candidate.finalizedAtRoomTimeMs as number,
  };
}

function asFinalizeReceipt(candidate: Record<string, unknown>): RendezvousFinalizeReceipt {
  return {
    protocolVersion: 2,
    kind: 'rendezvous-finalized',
    ...asRevisionedRun(candidate),
    rendezvousId: candidate.rendezvousId as string,
    participantId: candidate.senderParticipantId as string,
    status: candidate.status as RendezvousFinalizeReceipt['status'],
    observedAtRoomTimeMs: candidate.observedAtRoomTimeMs as number,
    reasonCode: candidate.reasonCode as string | null,
  };
}

function hasValidReadySource(candidate: Record<string, unknown>): boolean {
  if (
    !isRoomTime(candidate.observedAtRoomTimeMs) ||
    !isRoomTime(candidate.readyLeaseUntilRoomTimeMs) ||
    candidate.readyLeaseUntilRoomTimeMs <= candidate.observedAtRoomTimeMs ||
    candidate.readyLeaseUntilRoomTimeMs - candidate.observedAtRoomTimeMs > MAX_READY_LEASE_MS ||
    !isBoundedNumber(candidate.durationSeconds, Number.MIN_VALUE, MAX_MEDIA_DURATION_SECONDS) ||
    !isMediaTime(candidate.bufferedAheadSeconds) ||
    candidate.bufferedAheadSeconds > candidate.durationSeconds ||
    !isBoundedSafeInteger(candidate.outputSampleRateHz, 1, MAX_SAMPLE_RATE_HZ) ||
    !isBoundedSafeInteger(candidate.channelCount, 1, MAX_CHANNEL_COUNT)
  ) {
    return false;
  }
  return isFilePlaybackSourceSnapshot({
    schemaVersion: 1,
    queueItemId: candidate.queueItemId,
    backend: candidate.backend,
    phase: 'ready',
    revision: candidate.revision,
    run: asRevisionedRun(candidate),
    durationSeconds: candidate.durationSeconds,
    positionSeconds: 0,
    bufferedAheadSeconds: candidate.bufferedAheadSeconds,
    outputSampleRateHz: candidate.outputSampleRateHz,
    channelCount: candidate.channelCount,
    underrunCount: 0,
    errorCode: null,
  });
}

function hasCoherentStatusReason(
  accepted: boolean,
  reasonCode: unknown,
): reasonCode is string | null {
  return accepted ? reasonCode === null : isBoundedReason(reasonCode);
}

function hasValidKindPayload(candidate: Record<string, unknown>): boolean {
  switch (candidate.kind) {
    case 'source-ready':
      return hasValidReadySource(candidate);
    case 'source-not-ready':
      return (
        isRoomTime(candidate.observedAtRoomTimeMs) &&
        isBoundedReason(candidate.reasonCode) &&
        typeof candidate.retryable === 'boolean'
      );
    case 'file-playback-prepare':
      return (
        hasValidSuccessorState(candidate) &&
        isMediaTime(candidate.positionSeconds) &&
        isBoundedNumber(candidate.playbackRate, Number.MIN_VALUE, MAX_PLAYBACK_RATE)
      );
    case 'rendezvous-arm':
      return (
        isBoundedIdentifier(candidate.rendezvousId) &&
        isMediaTime(candidate.positionSeconds) &&
        isBoundedNumber(candidate.playbackRate, Number.MIN_VALUE, MAX_PLAYBACK_RATE) &&
        isRoomTime(candidate.startAtRoomTimeMs) &&
        isRoomTime(candidate.finalizeByRoomTimeMs) &&
        readRendezvousArmIntent(asArmIntent(candidate)) !== null
      );
    case 'rendezvous-armed': {
      const statusIsArmed = candidate.status === 'armed';
      return (
        isBoundedIdentifier(candidate.rendezvousId) &&
        (statusIsArmed || candidate.status === 'rejected') &&
        isRoomTime(candidate.observedAtRoomTimeMs) &&
        isMediaTime(candidate.bufferedAheadSeconds) &&
        hasCoherentStatusReason(statusIsArmed, candidate.reasonCode) &&
        readRendezvousArmReceipt(asArmReceipt(candidate)) !== null
      );
    }
    case 'rendezvous-finalize':
      return (
        isBoundedIdentifier(candidate.rendezvousId) &&
        isRoomTime(candidate.startAtRoomTimeMs) &&
        isRoomTime(candidate.finalizedAtRoomTimeMs) &&
        readRendezvousFinalizeIntent(asFinalizeIntent(candidate)) !== null
      );
    case 'rendezvous-finalized': {
      const statusIsAccepted = candidate.status === 'accepted';
      return (
        isBoundedIdentifier(candidate.rendezvousId) &&
        (statusIsAccepted ||
          candidate.status === 'missed-deadline' ||
          candidate.status === 'rejected') &&
        isRoomTime(candidate.observedAtRoomTimeMs) &&
        hasCoherentStatusReason(statusIsAccepted, candidate.reasonCode) &&
        readRendezvousFinalizeReceipt(asFinalizeReceipt(candidate)) !== null
      );
    }
    case 'file-playback-pause':
      return hasValidSuccessorState(candidate) && isRoomTime(candidate.atRoomTimeMs);
    case 'file-playback-seek':
      return (
        hasValidSuccessorState(candidate) &&
        isMediaTime(candidate.positionSeconds) &&
        isRoomTime(candidate.atRoomTimeMs)
      );
    case 'file-playback-cancel':
      return isBoundedIdentifier(candidate.rendezvousId) && isBoundedReason(candidate.reasonCode);
    case 'file-playback-stop':
      return hasValidSuccessorState(candidate) && isRoomTime(candidate.atRoomTimeMs);
    case 'renderer-health': {
      const healthy = candidate.value === 'healthy';
      if (!healthy && candidate.value !== 'unhealthy') return false;
      if (
        !isBoundedIdentifier(candidate.rendezvousId) ||
        !isRoomTime(candidate.observedAtRoomTimeMs) ||
        !isRoomTime(candidate.leaseUntilRoomTimeMs) ||
        !isBoundedSafeInteger(candidate.renderedFrame, 0, MAX_COUNTER) ||
        !isBoundedSafeInteger(candidate.underrunCount, 0, MAX_COUNTER) ||
        !hasCoherentStatusReason(healthy, candidate.reasonCode)
      ) {
        return false;
      }
      return healthy
        ? candidate.leaseUntilRoomTimeMs > candidate.observedAtRoomTimeMs &&
            candidate.leaseUntilRoomTimeMs - candidate.observedAtRoomTimeMs <= MAX_RENDERER_LEASE_MS
        : candidate.leaseUntilRoomTimeMs === candidate.observedAtRoomTimeMs;
    }
  }
  return false;
}

const EXPECTATION_KEYS = new Set([
  'sessionId',
  'connectionId',
  'senderParticipantId',
  'recipientParticipantId',
  'lastControlSequence',
  'run',
  'sourceIdentity',
  'transferSessionId',
  'rendezvousId',
  'receivedAtRoomTimeMs',
  'maxClockSkewMs',
]);
const REQUIRED_RECEIVE_EXPECTATION_KEYS = [
  'sessionId',
  'connectionId',
  'senderParticipantId',
  'recipientParticipantId',
  'lastControlSequence',
  'receivedAtRoomTimeMs',
] as const;

function snapshotAllowedDataRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
  required: readonly string[] = [],
): Record<string, unknown> | null {
  try {
    if (!isPlainRecord(value)) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.some((key) => typeof key !== 'string' || !allowed.has(key)) ||
      required.some((key) => !ownKeys.includes(key))
    ) {
      return null;
    }
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of ownKeys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function snapshotExpectedRun(value: unknown): RevisionedPlaybackRun | null {
  const snapshot = snapshotAllowedDataRecord(value, new Set(['queueItemId', 'runId', 'revision']), [
    'queueItemId',
    'runId',
    'revision',
  ]);
  if (
    !snapshot ||
    !isBoundedIdentifier(snapshot.queueItemId) ||
    !isBoundedIdentifier(snapshot.runId) ||
    !isPlaybackRevision(snapshot.revision) ||
    Object.is(snapshot.revision, -0)
  ) {
    return null;
  }
  return freezeCanonical({
    queueItemId: snapshot.queueItemId as QueueItemId,
    runId: snapshot.runId,
    revision: snapshot.revision,
  });
}

function snapshotReceiveExpectations(value: unknown): FilePlaybackWireReceiveExpectations | null {
  const snapshot = snapshotAllowedDataRecord(
    value,
    EXPECTATION_KEYS,
    REQUIRED_RECEIVE_EXPECTATION_KEYS,
  );
  if (
    !snapshot ||
    !isBoundedIdentifier(snapshot.sessionId) ||
    !isBoundedIdentifier(snapshot.connectionId) ||
    !isBoundedIdentifier(snapshot.senderParticipantId) ||
    !isBoundedIdentifier(snapshot.recipientParticipantId) ||
    snapshot.senderParticipantId === snapshot.recipientParticipantId ||
    !isBoundedSafeInteger(snapshot.lastControlSequence, 0, Number.MAX_SAFE_INTEGER) ||
    !isRoomTime(snapshot.receivedAtRoomTimeMs)
  ) {
    return null;
  }
  if (
    Object.hasOwn(snapshot, 'maxClockSkewMs') &&
    snapshot.maxClockSkewMs !== undefined &&
    !isBoundedNumber(snapshot.maxClockSkewMs, 0, MAX_CLOCK_SKEW_MS)
  ) {
    return null;
  }
  const runCandidate = Object.hasOwn(snapshot, 'run')
    ? snapshotExpectedRun(snapshot.run)
    : undefined;
  if (runCandidate === null) return null;
  const run: RevisionedPlaybackRun | undefined = runCandidate;
  if (
    Object.hasOwn(snapshot, 'sourceIdentity') &&
    snapshot.sourceIdentity !== undefined &&
    !isBoundedIdentifier(snapshot.sourceIdentity)
  ) {
    return null;
  }
  if (
    Object.hasOwn(snapshot, 'transferSessionId') &&
    snapshot.transferSessionId !== undefined &&
    snapshot.transferSessionId !== null &&
    !isBoundedIdentifier(snapshot.transferSessionId)
  ) {
    return null;
  }
  if (
    Object.hasOwn(snapshot, 'rendezvousId') &&
    snapshot.rendezvousId !== undefined &&
    !isBoundedIdentifier(snapshot.rendezvousId)
  ) {
    return null;
  }

  return freezeCanonical({
    sessionId: snapshot.sessionId as string,
    connectionId: snapshot.connectionId as string,
    senderParticipantId: snapshot.senderParticipantId as string,
    recipientParticipantId: snapshot.recipientParticipantId as string,
    lastControlSequence: snapshot.lastControlSequence as number,
    receivedAtRoomTimeMs: snapshot.receivedAtRoomTimeMs as number,
    ...(snapshot.maxClockSkewMs === undefined
      ? {}
      : { maxClockSkewMs: snapshot.maxClockSkewMs as number }),
    ...(run === undefined ? {} : { run }),
    ...(snapshot.sourceIdentity === undefined
      ? {}
      : { sourceIdentity: snapshot.sourceIdentity as string }),
    ...(snapshot.transferSessionId === undefined
      ? {}
      : { transferSessionId: snapshot.transferSessionId as string | null }),
    ...(snapshot.rendezvousId === undefined
      ? {}
      : { rendezvousId: snapshot.rendezvousId as string }),
  });
}

function hasValidExpectationBindings(
  message: FilePlaybackWireMessage,
  expectations: FilePlaybackWireExpectations,
): boolean {
  if (expectations.sessionId !== undefined && message.sessionId !== expectations.sessionId) {
    return false;
  }
  if (
    expectations.connectionId !== undefined &&
    message.connectionId !== expectations.connectionId
  ) {
    return false;
  }
  if (
    expectations.senderParticipantId !== undefined &&
    message.senderParticipantId !== expectations.senderParticipantId
  ) {
    return false;
  }
  if (
    expectations.recipientParticipantId !== undefined &&
    message.recipientParticipantId !== expectations.recipientParticipantId
  ) {
    return false;
  }
  if (expectations.lastControlSequence !== undefined) {
    if (
      !isBoundedSafeInteger(expectations.lastControlSequence, 0, Number.MAX_SAFE_INTEGER) ||
      message.controlSequence <= expectations.lastControlSequence
    ) {
      return false;
    }
  }
  if (expectations.run !== undefined) {
    if (
      !isPlaybackStateIdentity(expectations.run) ||
      !isPlaybackRevision(expectations.run.revision) ||
      Object.is(expectations.run.revision, -0) ||
      message.queueItemId !== expectations.run.queueItemId ||
      message.runId !== expectations.run.runId ||
      message.revision !== expectations.run.revision
    ) {
      return false;
    }
  }
  if (
    expectations.sourceIdentity !== undefined &&
    message.sourceIdentity !== expectations.sourceIdentity
  ) {
    return false;
  }
  if (
    expectations.transferSessionId !== undefined &&
    message.transferSessionId !== expectations.transferSessionId
  ) {
    return false;
  }
  if (expectations.rendezvousId !== undefined) {
    if ('rendezvousId' in message && message.rendezvousId !== expectations.rendezvousId) {
      return false;
    }
  }
  if (message.kind === 'renderer-health' && expectations.rendezvousId === undefined) {
    return false;
  }
  return hasValidTemporalBindings(message, expectations);
}

function observedAtRoomTimeMs(message: FilePlaybackWireMessage): number | null {
  return 'observedAtRoomTimeMs' in message ? message.observedAtRoomTimeMs : null;
}

function hasValidTemporalBindings(
  message: FilePlaybackWireMessage,
  expectations: FilePlaybackWireExpectations,
): boolean {
  const receivedAt = expectations.receivedAtRoomTimeMs;
  const configuredSkew = expectations.maxClockSkewMs;
  if (receivedAt === undefined) return configuredSkew === undefined;
  if (!isRoomTime(receivedAt)) return false;
  const skew =
    configuredSkew === undefined ? FILE_PLAYBACK_WIRE_DEFAULT_MAX_CLOCK_SKEW_MS : configuredSkew;
  if (!isBoundedNumber(skew, 0, MAX_CLOCK_SKEW_MS)) return false;

  const observedAt = observedAtRoomTimeMs(message);
  if (observedAt !== null && observedAt > receivedAt + skew) return false;

  switch (message.kind) {
    case 'source-ready':
      return message.readyLeaseUntilRoomTimeMs > receivedAt;
    case 'renderer-health':
      return message.value === 'unhealthy' || message.leaseUntilRoomTimeMs > receivedAt;
    case 'rendezvous-arm':
      return (
        message.finalizeByRoomTimeMs >= receivedAt - skew &&
        message.startAtRoomTimeMs >= receivedAt - skew &&
        message.startAtRoomTimeMs <= receivedAt + MAX_RENDEZVOUS_SCHEDULE_AHEAD_MS + skew
      );
    case 'rendezvous-finalize':
      return (
        message.finalizedAtRoomTimeMs <= receivedAt + skew &&
        message.startAtRoomTimeMs >= receivedAt - skew &&
        message.startAtRoomTimeMs <= receivedAt + MAX_RENDEZVOUS_SCHEDULE_AHEAD_MS + skew
      );
    case 'file-playback-pause':
    case 'file-playback-seek':
    case 'file-playback-stop':
      // Current-renderer transitions use the same bounded future room-clock
      // window as ARM/FINALIZE. The product lead floor is 450 ms, so limiting
      // these frames to clock skew alone would reject every healthy scheduled
      // pause/seek/stop before the renderer can reach its exact target frame.
      return (
        message.atRoomTimeMs >= receivedAt - skew &&
        message.atRoomTimeMs <= receivedAt + MAX_RENDEZVOUS_SCHEDULE_AHEAD_MS + skew
      );
    default:
      return true;
  }
}

function freezeCanonical<T extends object>(value: T): T {
  return Object.freeze(Object.assign(Object.create(null), value)) as T;
}

function canonicalEnvelope(candidate: Record<string, unknown>): FilePlaybackWireEnvelope {
  return freezeCanonical({
    protocolVersion: 2,
    kind: candidate.kind as FilePlaybackWireKind,
    sessionId: candidate.sessionId as string,
    connectionId: candidate.connectionId as string,
    senderParticipantId: candidate.senderParticipantId as string,
    recipientParticipantId: candidate.recipientParticipantId as string,
    controlSequence: candidate.controlSequence as number,
    queueItemId: candidate.queueItemId as QueueItemId,
    runId: candidate.runId as string,
    revision: candidate.revision as PlaybackRevision,
    sourceIdentity: candidate.sourceIdentity as string,
    transferSessionId: candidate.transferSessionId as string | null,
  });
}

function canonicalMessage(candidate: Record<string, unknown>): FilePlaybackWireMessage {
  const envelope = canonicalEnvelope(candidate);
  switch (candidate.kind) {
    case 'source-ready':
      return freezeCanonical({
        ...envelope,
        kind: 'source-ready',
        observedAtRoomTimeMs: candidate.observedAtRoomTimeMs as number,
        readyLeaseUntilRoomTimeMs: candidate.readyLeaseUntilRoomTimeMs as number,
        backend: candidate.backend as FilePlaybackBackend,
        durationSeconds: candidate.durationSeconds as number,
        bufferedAheadSeconds: candidate.bufferedAheadSeconds as number,
        outputSampleRateHz: candidate.outputSampleRateHz as number,
        channelCount: candidate.channelCount as number,
      });
    case 'source-not-ready':
      return freezeCanonical({
        ...envelope,
        kind: 'source-not-ready',
        observedAtRoomTimeMs: candidate.observedAtRoomTimeMs as number,
        reasonCode: candidate.reasonCode as string,
        retryable: candidate.retryable as boolean,
      });
    case 'file-playback-prepare':
      return freezeCanonical({
        ...envelope,
        kind: 'file-playback-prepare',
        expectedQueueItemId: candidate.expectedQueueItemId as QueueItemId,
        expectedRunId: candidate.expectedRunId as string,
        expectedRevision: candidate.expectedRevision as PlaybackRevision,
        positionSeconds: candidate.positionSeconds as number,
        playbackRate: candidate.playbackRate as number,
      });
    case 'rendezvous-arm':
      return freezeCanonical({
        ...envelope,
        kind: 'rendezvous-arm',
        rendezvousId: candidate.rendezvousId as string,
        positionSeconds: candidate.positionSeconds as number,
        playbackRate: candidate.playbackRate as number,
        startAtRoomTimeMs: candidate.startAtRoomTimeMs as number,
        finalizeByRoomTimeMs: candidate.finalizeByRoomTimeMs as number,
      });
    case 'rendezvous-armed':
      return freezeCanonical({
        ...envelope,
        kind: 'rendezvous-armed',
        rendezvousId: candidate.rendezvousId as string,
        status: candidate.status as RendezvousArmedWireMessage['status'],
        observedAtRoomTimeMs: candidate.observedAtRoomTimeMs as number,
        bufferedAheadSeconds: candidate.bufferedAheadSeconds as number,
        reasonCode: candidate.reasonCode as string | null,
      });
    case 'rendezvous-finalize':
      return freezeCanonical({
        ...envelope,
        kind: 'rendezvous-finalize',
        rendezvousId: candidate.rendezvousId as string,
        startAtRoomTimeMs: candidate.startAtRoomTimeMs as number,
        finalizedAtRoomTimeMs: candidate.finalizedAtRoomTimeMs as number,
      });
    case 'rendezvous-finalized':
      return freezeCanonical({
        ...envelope,
        kind: 'rendezvous-finalized',
        rendezvousId: candidate.rendezvousId as string,
        status: candidate.status as RendezvousFinalizedWireMessage['status'],
        observedAtRoomTimeMs: candidate.observedAtRoomTimeMs as number,
        reasonCode: candidate.reasonCode as string | null,
      });
    case 'file-playback-pause':
      return freezeCanonical({
        ...envelope,
        kind: 'file-playback-pause',
        expectedQueueItemId: candidate.expectedQueueItemId as QueueItemId,
        expectedRunId: candidate.expectedRunId as string,
        expectedRevision: candidate.expectedRevision as PlaybackRevision,
        atRoomTimeMs: candidate.atRoomTimeMs as number,
      });
    case 'file-playback-seek':
      return freezeCanonical({
        ...envelope,
        kind: 'file-playback-seek',
        expectedQueueItemId: candidate.expectedQueueItemId as QueueItemId,
        expectedRunId: candidate.expectedRunId as string,
        expectedRevision: candidate.expectedRevision as PlaybackRevision,
        positionSeconds: candidate.positionSeconds as number,
        atRoomTimeMs: candidate.atRoomTimeMs as number,
      });
    case 'file-playback-cancel':
      return freezeCanonical({
        ...envelope,
        kind: 'file-playback-cancel',
        rendezvousId: candidate.rendezvousId as string,
        reasonCode: candidate.reasonCode as string,
      });
    case 'file-playback-stop':
      return freezeCanonical({
        ...envelope,
        kind: 'file-playback-stop',
        expectedQueueItemId: candidate.expectedQueueItemId as QueueItemId,
        expectedRunId: candidate.expectedRunId as string,
        expectedRevision: candidate.expectedRevision as PlaybackRevision,
        atRoomTimeMs: candidate.atRoomTimeMs as number,
      });
    case 'renderer-health':
      return freezeCanonical({
        ...envelope,
        kind: 'renderer-health',
        rendezvousId: candidate.rendezvousId as string,
        value: candidate.value as RendererHealthWireMessage['value'],
        observedAtRoomTimeMs: candidate.observedAtRoomTimeMs as number,
        leaseUntilRoomTimeMs: candidate.leaseUntilRoomTimeMs as number,
        renderedFrame: candidate.renderedFrame as number,
        underrunCount: candidate.underrunCount as number,
        reasonCode: candidate.reasonCode as string | null,
      });
    default:
      throw new TypeError('Unsupported file playback wire message kind');
  }
}

function canonicalizeFilePlaybackWireMessage(value: unknown): FilePlaybackWireMessage | null {
  try {
    if (!isPlainRecord(value)) return null;
    const snapshot = detachExactDataRecord(value);
    if (!snapshot) return null;
    if (
      !hasValidEnvelope(snapshot) ||
      !hasValidKindPayload(snapshot) ||
      !hasBoundedPayload(snapshot)
    ) {
      return null;
    }
    return canonicalMessage(snapshot);
  } catch {
    return null;
  }
}

/**
 * Stateless strict receive parser. Every call must supply the complete trusted
 * connection scope and capture time. Product dispatch should prefer
 * FilePlaybackWireReceiver, which advances the sequence watermark in the same
 * synchronous commit as validation.
 */
export function parseFilePlaybackWireMessage(
  value: unknown,
  expectations: FilePlaybackWireReceiveExpectations,
): FilePlaybackWireMessage | null {
  const message = canonicalizeFilePlaybackWireMessage(value);
  if (!message) return null;
  const trusted = snapshotReceiveExpectations(expectations);
  return trusted && hasValidExpectationBindings(message, trusted) ? message : null;
}

/** Validates and canonicalizes a locally constructed frame. */
export function createFilePlaybackWireMessage(
  value: FilePlaybackWireMessage,
): FilePlaybackWireMessage {
  const message = canonicalizeFilePlaybackWireMessage(value);
  if (!message) throw new TypeError('File playback wire message is invalid');
  return message;
}

function stateReferenceFromMessage(
  message: FilePlaybackWireMessage,
): Readonly<FilePlaybackWireStateReference> {
  return freezeCanonical({
    queueItemId: message.queueItemId,
    runId: message.runId,
    revision: message.revision,
    sourceIdentity: message.sourceIdentity,
    transferSessionId: message.transferSessionId,
  });
}

function expectedStateFromMessage(
  message:
    | FilePlaybackPrepareWireMessage
    | FilePlaybackPauseWireMessage
    | FilePlaybackSeekWireMessage
    | FilePlaybackStopWireMessage,
): Readonly<FilePlaybackWireExpectedStateIdentity> {
  return freezeCanonical({
    queueItemId: message.expectedQueueItemId,
    runId: message.expectedRunId,
    revision: message.expectedRevision,
  });
}

function receiverResult<T extends object>(value: T): Readonly<T> {
  return freezeCanonical(value);
}

/**
 * Connection-owned receive gate with an atomic inbound sequence watermark.
 * Untrusted structural detachment happens before the latest media binding and
 * watermark are read, so a re-entrant Proxy cannot make an older outer frame
 * overwrite a newer inner commit.
 */
export class FilePlaybackWireReceiver {
  readonly #sessionId: string;
  readonly #connectionId: string;
  readonly #senderParticipantId: string;
  readonly #recipientParticipantId: string;
  readonly #nowRoomTimeMs: () => number;
  readonly #maxClockSkewMs: number;
  readonly #bindings: FilePlaybackWireBindingRegistry;
  #lastControlSequence = 0;

  constructor(
    options: FilePlaybackWireReceiverOptions,
    bindings: FilePlaybackWireBindingRegistry = new FilePlaybackWireBindingRegistry(),
  ) {
    const snapshot = snapshotAllowedDataRecord(
      options,
      new Set([
        'sessionId',
        'connectionId',
        'senderParticipantId',
        'recipientParticipantId',
        'nowRoomTimeMs',
        'maxClockSkewMs',
      ]),
      [
        'sessionId',
        'connectionId',
        'senderParticipantId',
        'recipientParticipantId',
        'nowRoomTimeMs',
      ],
    );
    if (
      !snapshot ||
      !isBoundedIdentifier(snapshot.sessionId) ||
      !isBoundedIdentifier(snapshot.connectionId) ||
      !isBoundedIdentifier(snapshot.senderParticipantId) ||
      !isBoundedIdentifier(snapshot.recipientParticipantId) ||
      snapshot.senderParticipantId === snapshot.recipientParticipantId ||
      typeof snapshot.nowRoomTimeMs !== 'function'
    ) {
      throw new TypeError('File playback receiver scope is invalid');
    }
    const maxClockSkewMs =
      snapshot.maxClockSkewMs === undefined
        ? FILE_PLAYBACK_WIRE_DEFAULT_MAX_CLOCK_SKEW_MS
        : snapshot.maxClockSkewMs;
    if (!isBoundedNumber(maxClockSkewMs, 0, MAX_CLOCK_SKEW_MS)) {
      throw new RangeError('File playback receiver clock skew is invalid');
    }
    this.#sessionId = snapshot.sessionId;
    this.#connectionId = snapshot.connectionId;
    this.#senderParticipantId = snapshot.senderParticipantId;
    this.#recipientParticipantId = snapshot.recipientParticipantId;
    this.#nowRoomTimeMs = snapshot.nowRoomTimeMs as () => number;
    this.#maxClockSkewMs = maxClockSkewMs;
    if (!(bindings instanceof FilePlaybackWireBindingRegistry)) {
      throw new TypeError('File playback receiver binding registry is invalid');
    }
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

  receive(value: unknown): FilePlaybackWireReceiverResult {
    if (this.#bindings.isRevoked()) {
      return receiverResult({ accepted: false as const, reason: 'revoked' as const });
    }
    // Capture ingress time before hostile Proxy traps can consume main-thread
    // time. Mutable media authority and the watermark are still read after
    // detachment, so a re-entrant trap cannot make an older outer frame win.
    let receivedAtRoomTimeMs: number;
    try {
      receivedAtRoomTimeMs = this.#nowRoomTimeMs();
    } catch {
      return receiverResult({ accepted: false as const, reason: 'temporal-invalid' as const });
    }
    const message = canonicalizeFilePlaybackWireMessage(value);
    if (!message) {
      return receiverResult({ accepted: false as const, reason: 'malformed-frame' as const });
    }
    if (
      message.sessionId !== this.#sessionId ||
      message.connectionId !== this.#connectionId ||
      message.senderParticipantId !== this.#senderParticipantId ||
      message.recipientParticipantId !== this.#recipientParticipantId
    ) {
      return receiverResult({ accepted: false as const, reason: 'wrong-scope' as const });
    }

    const reference = stateReferenceFromMessage(message);
    let stateLease: FilePlaybackWireStateLease | null = null;
    let attemptLease: FilePlaybackWireAttemptLease | null = null;
    let staleScope: 'state' | 'attempt' | null = null;
    let remoteSuccessorAdmission: Readonly<{
      expected: Readonly<FilePlaybackWireExpectedStateIdentity>;
      purpose: 'media' | 'stop';
    }> | null = null;
    let remoteAttemptAdmission: Readonly<{ rendezvousId: string }> | null = null;
    let remoteRendezvousSuccessorAdmission: Readonly<{ rendezvousId: string }> | null = null;
    if (isFilePlaybackAttemptScopedWireKind(message.kind)) {
      if (!('rendezvousId' in message)) {
        return receiverResult({ accepted: false as const, reason: 'malformed-frame' as const });
      }
      const resolved =
        message.kind === 'rendezvous-arm'
          ? this.#bindings.resolveArmAttempt(reference, message.rendezvousId)
          : message.kind === 'file-playback-cancel'
            ? this.#bindings.resolveCandidateAttempt(reference, message.rendezvousId)
            : this.#bindings.resolveAttempt(reference, message.rendezvousId);
      if (resolved.status === 'active') {
        stateLease = resolved.stateLease;
        attemptLease = resolved.attemptLease;
      } else if (resolved.status === 'stale') {
        staleScope = 'attempt';
      } else if (message.kind === 'rendezvous-arm') {
        const state = this.#bindings.resolveState(reference);
        if (state.status === 'active') {
          stateLease = state.stateLease;
          remoteAttemptAdmission = freezeCanonical({ rendezvousId: message.rendezvousId });
        } else if (state.status === 'stale') {
          return receiverResult({ accepted: false as const, reason: 'unknown-binding' as const });
        } else {
          remoteRendezvousSuccessorAdmission = freezeCanonical({
            rendezvousId: message.rendezvousId,
          });
        }
      } else {
        return receiverResult({ accepted: false as const, reason: 'unknown-binding' as const });
      }
    } else if (isFilePlaybackSuccessorScopedWireKind(message.kind)) {
      if (
        message.kind !== 'file-playback-prepare' &&
        message.kind !== 'file-playback-pause' &&
        message.kind !== 'file-playback-seek' &&
        message.kind !== 'file-playback-stop'
      ) {
        return receiverResult({ accepted: false as const, reason: 'malformed-frame' as const });
      }
      const expected = expectedStateFromMessage(message);
      const resolved =
        message.kind === 'file-playback-stop'
          ? this.#bindings.resolveStopSuccessor(reference, expected)
          : this.#bindings.resolveSuccessor(reference, expected);
      if (resolved.status === 'active') stateLease = resolved.stateLease;
      else if (resolved.status === 'stale') staleScope = 'state';
      else {
        remoteSuccessorAdmission = freezeCanonical({
          expected,
          purpose: message.kind === 'file-playback-stop' ? ('stop' as const) : ('media' as const),
        });
      }
    } else {
      const resolved = this.#bindings.resolveState(reference);
      if (resolved.status === 'active') stateLease = resolved.stateLease;
      else if (resolved.status === 'stale') staleScope = 'state';
      else {
        return receiverResult({ accepted: false as const, reason: 'unknown-binding' as const });
      }
    }

    const currentWatermark = this.#lastControlSequence;
    if (message.controlSequence <= currentWatermark) {
      return receiverResult({ accepted: false as const, reason: 'replayed-sequence' as const });
    }
    const expectations: FilePlaybackWireReceiveExpectations = freezeCanonical({
      sessionId: this.#sessionId,
      connectionId: this.#connectionId,
      senderParticipantId: this.#senderParticipantId,
      recipientParticipantId: this.#recipientParticipantId,
      lastControlSequence: currentWatermark,
      receivedAtRoomTimeMs,
      maxClockSkewMs: this.#maxClockSkewMs,
      ...((attemptLease ||
        staleScope === 'attempt' ||
        remoteAttemptAdmission ||
        remoteRendezvousSuccessorAdmission) &&
      'rendezvousId' in message
        ? { rendezvousId: message.rendezvousId }
        : {}),
    });
    if (!hasValidExpectationBindings(message, expectations)) {
      return receiverResult({ accepted: false as const, reason: 'temporal-invalid' as const });
    }

    if (staleScope) {
      this.#lastControlSequence = message.controlSequence;
      return receiverResult({
        accepted: true as const,
        status: 'stale' as const,
        scope: staleScope,
        controlSequence: message.controlSequence,
      });
    }

    if (remoteAttemptAdmission) {
      try {
        const admitted = this.#bindings.admitRemoteAttempt(
          reference,
          remoteAttemptAdmission.rendezvousId,
        );
        stateLease = admitted.stateLease;
        attemptLease = admitted.attemptLease;
      } catch {
        return receiverResult({ accepted: false as const, reason: 'unknown-binding' as const });
      }
    }

    if (remoteRendezvousSuccessorAdmission) {
      try {
        const admitted = this.#bindings.admitRemoteRendezvousSuccessor(
          reference,
          remoteRendezvousSuccessorAdmission.rendezvousId,
        );
        stateLease = admitted.stateLease;
        attemptLease = admitted.attemptLease;
      } catch {
        return receiverResult({ accepted: false as const, reason: 'unknown-binding' as const });
      }
    }

    if (remoteSuccessorAdmission) {
      try {
        stateLease = this.#bindings.admitRemoteSuccessor(
          reference,
          remoteSuccessorAdmission.expected,
          remoteSuccessorAdmission.purpose,
        );
      } catch {
        return receiverResult({ accepted: false as const, reason: 'unknown-binding' as const });
      }
    }

    // No untrusted callback occurs between the final current-watermark check
    // and this commit. Dispatch may safely become async only after receive().
    if (message.controlSequence <= this.#lastControlSequence) {
      return receiverResult({ accepted: false as const, reason: 'replayed-sequence' as const });
    }
    if (message.kind === 'file-playback-stop') {
      this.#bindings.markStopSuccessorLease(stateLease!, expectedStateFromMessage(message));
    }
    this.#lastControlSequence = message.controlSequence;
    return receiverResult({
      accepted: true as const,
      status: 'message' as const,
      message,
      stateLease: stateLease!,
      attemptLease,
    });
  }
}

/** Serializes only a validated canonical frame within the wire byte budget. */
export function serializeFilePlaybackWireMessage(value: FilePlaybackWireMessage): string {
  const serialized = JSON.stringify(createFilePlaybackWireMessage(value));
  if (new TextEncoder().encode(serialized).byteLength > FILE_PLAYBACK_WIRE_MAX_PAYLOAD_BYTES) {
    throw new TypeError('File playback wire message exceeds the byte budget');
  }
  return serialized;
}
